/* AnantPlay Sinhala Subtitle Bridge — v3 zero-fork subtitle pipeline.
 *
 * Powers the standalone Companion app (repo: anantplay-si-companion) end to end:
 *
 *   /api/resolve?title=Clayface            → Cinemeta IMDb id + clean title/year
 *   /subtitles/movie/tt34890576.json       → human Sinhala first (OpenSubtitles sin,
 *                                             SubDL si), else an AI-translate job:
 *                                             the FULL English .srt is fetched once and
 *                                             translated in 4–6 large context batches by
 *                                             Gemini Flash (worker secret GEMINI_API_KEY —
 *                                             zero key typing on the phone), with a strict
 *                                             cue-count + byte-identical-timestamp validator.
 *   /api/paired/<jobId>.json               → THE <10 ms CUE-LOCK WEAPON: one compact JSON
 *                                             array of {i,t0,t1,en,enf,si} cues. The
 *                                             Companion matches AnantPlay's live English
 *                                             subtitle TextView against `en`/`enf` in RAM
 *                                             (O(1) sequential window) and shows `si` —
 *                                             frame-exact sync, zero per-line network.
 *   /sub/<token>.srt                       → real HTTP 200 UTF-8 SRT; while a job is still
 *                                             translating the SAME deterministic URL answers
 *                                             202 with {status, progress, eta_sec}.
 *
 * Jobs are keyed deterministically (type:imdb:season:episode), so the finished Sinhala .srt
 * is a PERMANENT cache: the second fetch of the same movie is a KV read away (<200 ms).
 *
 * Storage: KV (recommended) for permanent jobs; without KV a per-isolate Map keeps jobs
 * alive for dev/self-host parity (artifacts still go to the Cache API). Zero Node APIs.
 */

import {
  sha256Hex, publishSrt, parseSrtCues, reassembleSrt, toCleanSrt,
  openSubsSearch, stremioOsSearch, subdlSearch, pirateLkSearch, fetchUpstreamSub, SUBDL_UA,
} from './lib.js';

const PIPELINE_VERSION = '3.0.0';
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = 120000;   // one big batch can legitimately take a while
const SINHALA_RE = /[\u0D80-\u0DFF]/;
const MIN_CUES = 8;                 // below this the file is not a real subtitle track
const MAX_CUES = 6000;              // a 4-hour movie has ~4000 cues; refuse anything absurd
const MIN_BATCHES = 4, MAX_BATCHES = 6, TARGET_CUES_PER_BATCH = 520;
const SPLIT_MIN_CUES = 16;          // below this a failed batch is an error, not a split
const STALLED_MS = 150000;          // a translating job with no progress update for 2.5 min → resume
const RESTART_ERROR_AFTER_MS = 60000;
const CONCURRENCY = 2;              // batches translated in parallel (rate-limit friendly)

// ─────────────────────────────────────────────────────────────────────────────
// job store — KV when bound, per-isolate Map fallback otherwise (dev / no-KV parity)
// ─────────────────────────────────────────────────────────────────────────────

function memStore() {
  const k = '__anantplay_si_jobs';
  if (!globalThis[k]) globalThis[k] = new Map();
  return globalThis[k];
}

async function kvGet(env, key) {
  if (env && env.SUBS_KV) return env.SUBS_KV.get(key);
  const v = memStore().get(key);
  return v === undefined ? null : v;
}

async function kvPut(env, key, value) {
  if (env && env.SUBS_KV) { await env.SUBS_KV.put(key, value); return; }
  memStore().set(key, value);
}

/** `${type}:${imdb}:${season}:${episode}` — stable across requests, restarts and devices. */
function jobIdOf(type, imdb, season, episode) {
  return type + ':' + imdb + ':' + (season || 0) + ':' + (episode || 0);
}

const JOB_ID_RE = /^(movie|series):tt\d{4,10}:\d{1,4}:\d{1,5}$/;

async function deterministicToken(prefix, jobId) {
  return (await sha256Hex(prefix + '|' + jobId)).slice(0, 16);
}

async function getJob(env, jobId) {
  const raw = await kvGet(env, 'job:' + jobId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function putJob(env, job) {
  job.updatedAt = Date.now();
  await kvPut(env, 'job:' + job.id, JSON.stringify(job));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cinemeta (the same metadata service official AnantPlay resolves titles through)
// ─────────────────────────────────────────────────────────────────────────────

async function cinemetaFetch(path, timeoutMs) {
  const res = await fetch('https://v3-cinemeta.strem.io' + path, {
    headers: { 'User-Agent': SUBDL_UA, 'Accept': 'application/json' },
    redirect: 'manual',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || 10000) : undefined,
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/** Title (and optional season/episode) → {imdb, name, year} via Cinemeta search. */
async function cinemetaResolve(title, type) {
  const q = String(title || '').trim();
  if (q.length < 2) return null;
  const j = await cinemetaFetch('/catalog/' + type + '/top/search=' + encodeURIComponent(q.slice(0, 120)) + '.json');
  const metas = j && Array.isArray(j.metas) ? j.metas : [];
  for (const m of metas) {
    const id = String(m.imdb_id || m.id || '');
    if (/^tt\d{4,10}$/.test(id)) {
      return { imdb: id, name: String(m.name || q), year: String(m.releaseInfo || '') };
    }
  }
  return null;
}

/** IMDb id → {imdb, name, year} via the Cinemeta meta detail endpoint. */
async function cinemetaMeta(type, imdb) {
  const j = await cinemetaFetch('/meta/' + type + '/' + encodeURIComponent(imdb) + '.json');
  const m = j && j.meta ? j.meta : null;
  if (!m) return { imdb, name: imdb, year: '' };
  return { imdb, name: String(m.name || imdb), year: String(m.releaseInfo || m.year || '') };
}

// ─────────────────────────────────────────────────────────────────────────────
// AnantPlay parity helpers
// ─────────────────────────────────────────────────────────────────────────────

/** EXACT flattening rule of AnantPlay's showCues() (PlayerActivity.java:356-358):
 * every inner '\n' becomes a space, EXCEPT when the next line starts with '-' or '–'
 * (a second speaker). The Companion sees this exact string in the subtitle TextView. */
function flattenLikeAnantPlay(text) {
  const s = String(text || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n' && i + 1 < s.length && s[i + 1] !== '-' && s[i + 1] !== '\u2013') out += ' ';
    else out += s[i];
  }
  return out;
}

/** "00:00:01,000 --> 00:00:03,500" → {t0: 1000, t1: 3500} (ms) or null. Accepts the same
 * shapes AnantPlay's SubSync.java:26-48 accepts (',' or '.' fraction, 1-3 digits). */
function parseTsMs(tsLine) {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(String(tsLine || ''));
  if (!m) return null;
  const ms = (h, mi, s, frac) => ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(String(frac).padEnd(3, '0'));
  return { t0: ms(m[1], m[2], m[3], m[4]), t1: ms(m[5], m[6], m[7], m[8]) };
}

/** Build the compact paired-cue payload for /api/paired/<jobId>.json. */
function buildPairedCues(enCues, siTexts) {
  const cues = [];
  for (let i = 0; i < enCues.length; i++) {
    const c = enCues[i];
    const t = parseTsMs(c.ts);
    const en = c.lines.join('\n');
    cues.push({
      i,
      t0: t ? t.t0 : 0,
      t1: t ? t.t1 : 0,
      en,
      enf: flattenLikeAnantPlay(en),
      si: siTexts ? (siTexts[i] || '') : '',
    });
  }
  return cues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Flash translation (server-side, worker secret — nothing typed on the phone)
// ─────────────────────────────────────────────────────────────────────────────

function geminiKeyOf(env, headers) {
  const h = headers || {};
  const fromHeader = typeof h.get === 'function' ? String(h.get('X-Gemini-Key') || '').trim() : '';
  return fromHeader || String((env && env.GEMINI_API_KEY) || '').trim();
}

function geminiModelOf(env, headers) {
  const h = headers || {};
  const raw = (typeof h.get === 'function' ? String(h.get('X-Gemini-Model') || '').trim() : '')
    || String((env && env.GEMINI_MODEL) || '').trim() || DEFAULT_GEMINI_MODEL;
  return /^[\w.-]{1,64}$/.test(raw) ? raw : DEFAULT_GEMINI_MODEL;
}

/** API base override for the Live Verification Lab (mock Gemini). Production default is
 * Google's endpoint; a loopback base is allowed ONLY for local dev/testing. */
function geminiBaseOf(env) {
  const raw = String((env && env.GEMINI_API_BASE) || '').trim() || DEFAULT_GEMINI_BASE;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !loopback) return DEFAULT_GEMINI_BASE;
    if (u.username || u.password) return DEFAULT_GEMINI_BASE;
    return u.origin;
  } catch (e) {
    return DEFAULT_GEMINI_BASE;
  }
}

function buildTranslatePrompt(count, retryNote) {
  return 'You are a professional movie subtitle translator. Translate English subtitles into natural, fluent, spoken Sinhala (සිංහල).\n'
    + 'STRICT output rules:\n'
    + '- Output EXACTLY one line per input line, in the format: <number>|<Sinhala translation>\n'
    + '- Keep the <number> unchanged. Never merge, split, reorder or skip lines.\n'
    + '- Translate meaning and tone, not word-for-word. Use everyday spoken Sinhala a Sri Lankan audience reads instantly.\n'
    + '- Keep proper names (people, places, brands) in their common Sinhala transliteration when one exists, otherwise keep them in Latin script.\n'
    + '- If a line starts with "- " (a speaker dash), keep the dash: "- <translation>".\n'
    + '- Lines that are only music notes (#), punctuation or sound cues may be kept as-is.\n'
    + '- Never add quotes, explanations, notes or English duplicates.\n'
    + '- Never answer in English; every translated line must be Sinhala script.\n'
    + (retryNote ? '\nIMPORTANT: your previous answer was rejected. ' + retryNote + '\n' : '')
    + '\nNow translate these ' + count + ' numbered subtitle lines:\n';
}

/** One Gemini call for one batch of numbered cues.
 * items: [{i, text}] → array of Sinhala strings aligned with items.
 * Throws {code:'truncated'} when the model hit its output limit (caller splits the batch). */
async function geminiTranslateBatch(env, key, model, items) {
  const prompt = buildTranslatePrompt(items.length)
    + items.map((it) => it.i + '|' + it.text).join('\n');
  const url = geminiBaseOf(env) + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'User-Agent': SUBDL_UA },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(GEMINI_TIMEOUT_MS) : undefined,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15, topP: 0.9, maxOutputTokens: 65536 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('gemini ' + res.status + ' ' + body.slice(0, 200));
  }
  const j = await res.json().catch(() => null);
  const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const text = parts.map((p) => p && p.text ? p.text : '').join('');
  if (!text) throw new Error('gemini empty answer (finishReason ' + (cand && cand.finishReason) + ')');

  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s*\|\s?(.*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (!map.has(n)) map.set(n, m[2].trim());
    }
  }
  // every input number present exactly once, non-empty for non-empty input
  const missing = [];
  for (const it of items) {
    const v = map.get(it.i);
    if (v === undefined || v === '') missing.push(it.i);
  }
  if (missing.length) {
    const truncated = cand && String(cand.finishReason || '') === 'MAX_TOKENS';
    if (truncated || map.size < items.length) {
      const err = new Error('gemini answer incomplete: ' + missing.length + ' lines missing');
      err.code = 'truncated';
      throw err;
    }
    throw new Error('gemini answer missing lines: ' + missing.slice(0, 8).join(',') + (missing.length > 8 ? '…' : ''));
  }
  // Sinhala-script sanity: ≥60% of meaningful lines must contain Sinhala characters
  let meaningful = 0, si = 0;
  for (const it of items) {
    const v = map.get(it.i);
    if (v && v.replace(/[-–#\s.,!?'"…:;]/g, '').length >= 2) {
      meaningful++;
      if (SINHALA_RE.test(v)) si++;
    }
  }
  if (meaningful > 0 && si / meaningful < 0.6) {
    throw new Error('gemini answered in the wrong language (Sinhala script in only ' + si + '/' + meaningful + ' lines)');
  }
  return items.map((it) => map.get(it.i));
}

/** A batch with retry + adaptive splitting: a truncated/failed batch is retried once with
 * a corrective note, then split in half until it fits the model's output limit. */
async function translateBatchRobust(env, key, model, items) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await geminiTranslateBatch(env, key, model, items);
    } catch (e) {
      lastErr = e;
      if (e && e.code === 'truncated') break; // splitting is better than retrying a truncation
    }
  }
  if (items.length >= SPLIT_MIN_CUES * 2) {
    const mid = Math.floor(items.length / 2);
    const a = await translateBatchRobust(env, key, model, items.slice(0, mid));
    const b = await translateBatchRobust(env, key, model, items.slice(mid));
    return a.concat(b);
  }
  if (lastErr && lastErr.code === 'truncated' && items.length >= SPLIT_MIN_CUES) {
    // one last halving even below the comfortable split floor
    const mid = Math.floor(items.length / 2);
    const a = await translateBatchRobust(env, key, model, items.slice(0, mid));
    const b = await translateBatchRobust(env, key, model, items.slice(mid));
    return a.concat(b);
  }
  throw lastErr || new Error('gemini translation failed');
}

/** Deterministic batch boundaries from the cue count alone → 4–6 batches, so a resumed
 * run splits identically and per-batch progress flags stay valid. */
function makeBatches(cueCount) {
  if (cueCount <= 0) return [];
  if (cueCount < MIN_BATCHES * SPLIT_MIN_CUES) return [Array.from({ length: cueCount }, (_, i) => i)];
  const n = Math.max(MIN_BATCHES, Math.min(MAX_BATCHES, Math.ceil(cueCount / TARGET_CUES_PER_BATCH)));
  const per = Math.ceil(cueCount / n);
  const batches = [];
  for (let s = 0; s < cueCount; s += per) {
    const end = Math.min(cueCount, s + per);
    const idx = [];
    for (let i = s; i < end; i++) idx.push(i);
    batches.push(idx);
  }
  return batches;
}

/** Small promise pool — keeps CONCURRENCY batches in flight. */
async function runPool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────────────────────
// the orchestrator
// ─────────────────────────────────────────────────────────────────────────────

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

function pickHumanSub(results, lang) {
  const same = results.filter((r) => r.lang === lang);
  return same.length ? same[0] : null; // openSubsSearch already sorts by downloads
}

/**
 * The one call behind GET /subtitles/:type/:id.json.
 * Returns {job} (done | translating | error), or {needsKey} / {notFound, hints}.
 * `started` is the background promise when a new translation job was kicked off —
 * the route passes it to ctx.waitUntil().
 */
async function ensureSubtitleJob(env, ctx, params) {
  const type = params.type === 'series' ? 'series' : 'movie';
  const imdb = /^tt\d{4,10}$/.test(params.imdb || '') ? params.imdb : null;
  if (!imdb) return { badRequest: 'id must be an IMDb id like tt34890576 (use /api/resolve?title=… first)' };
  const season = type === 'series' ? clampInt(params.season, 0, 999) : 0;
  const episode = type === 'series' ? clampInt(params.episode, 0, 9999) : 0;
  const titleHint = String(params.title || '').slice(0, 200);
  const jobId = jobIdOf(type, imdb, season, episode);
  const now = Date.now();
  const siToken = await deterministicToken('si', jobId);
  const enToken = await deterministicToken('en', jobId);
  const key0 = geminiKeyOf(env, params.headers); // NOTE: never persisted into the job record

  // 1. cached job?
  const existing = await getJob(env, jobId);
  if (existing && !params.fresh) {
    if (existing.status === 'done') return { job: existing };
    if (existing.status === 'translating') {
      if (now - (existing.updatedAt || 0) > STALLED_MS) {
        // stalled (isolate died mid-job): resume it in the background, answer now.
        // NOTE: the API key is NEVER persisted — the resume uses this request's key.
        const p = resumeTranslationJob(env, key0, existing.model, jobId).catch(() => {});
        return { job: existing, started: p };
      }
      return { job: existing };
    }
    if (existing.status === 'error' && now - (existing.updatedAt || 0) < RESTART_ERROR_AFTER_MS) {
      return { job: existing }; // don't hot-loop a failing upstream
    }
  }

  // 2. human Sinhala first — the richest Sinhala index is the legacy OpenSubtitles REST
  //    (ChameE/Baiscope uploads); the Stremio addon and SubDL si are the fallbacks.
  //    Any of them can be rate-limited (403) at any moment; every leg degrades cleanly.
  const subdlKey = String((env && env.SUBDL_API_KEY) || '').trim() || String(params.subdlKey || '').trim();
  const [osSi, stremioSi, subdlSi] = await Promise.all([
    openSubsSearch(imdb, season, episode, null, ['sin'], env).catch(() => []),
    stremioOsSearch(type, imdb, season, episode, ['sin']).catch(() => []),
    subdlSearch(imdb, season, episode, null, subdlKey).catch(() => []),
  ]);
  const humanCandidates = [];
  const osBest = pickHumanSub(osSi, 'sin');
  if (osBest) humanCandidates.push(osBest);
  const stremioBest = pickHumanSub(stremioSi, 'sin');
  if (stremioBest) humanCandidates.push(stremioBest);
  const sdBest = pickHumanSub(subdlSi, 'si');
  if (sdBest) humanCandidates.push(sdBest);

  for (const cand of humanCandidates) {
    try {
      const siText = await fetchUpstreamSub(cand.url, {
        extraHosts: env && env.ALLOWED_SUB_HOSTS ? String(env.ALLOWED_SUB_HOSTS).split(',') : [],
      });
      const cues = parseSrtCues(siText);
      if (cues.length < MIN_CUES) continue; // a stub file — try the next provider
      await publishSrt(env, siText, { token: siToken, permanent: true });
      await kvPut(env, 'subjob:' + siToken, jobId); // /sub/<siToken>.srt 202-progress map
      const job = {
        id: jobId, type, imdb, season, episode, status: 'done', source: 'human',
        provider: cand.provider, release: cand.release || '', cues: cues.length,
        siToken, enToken: null, model: null, createdAt: now,
      };
      await putJob(env, job);
      await kvPut(env, 'paired:' + jobId, JSON.stringify({
        jobId, status: 'done', source: 'human', cues: buildPairedCues(cues, null),
      }));
      return { job };
    } catch (e) { /* try the next provider */ }
  }

  // 3. no human Sinhala → AI-translate the best English file (Clayface path).
  //    English source: legacy OpenSubtitles REST first, the Stremio addon as fallback
  //    (the same pair official AnantPlay tries). A specific file can be captcha-gated
  //    (302 → www.opensubtitles.org/captcha2) or rate-limited, so try up to 3 candidates.
  const [osEn, stremioEn] = await Promise.all([
    openSubsSearch(imdb, season, episode, null, ['eng'], env).catch(() => []),
    stremioOsSearch(type, imdb, season, episode, ['eng']).catch(() => []),
  ]);
  const enCandidates = [];
  for (const r of osEn) { if (enCandidates.length < 3) enCandidates.push(r); }
  for (const r of stremioEn) { if (enCandidates.length < 4) enCandidates.push(r); }
  const enCand = enCandidates[0] || null;
  const key = key0;
  if (!enCand) {
    const hints = [];
    if (titleHint) hints.push({ provider: 'piratelk', url: 'https://piratelk.com/?s=' + encodeURIComponent(titleHint) });
    hints.push({ provider: 'opensubtitles', url: 'https://rest.opensubtitles.org/search/imdbid-' + imdb.replace(/^tt/, '') + '/sublanguageid-sin' });
    return { notFound: true, hints };
  }
  if (!key) {
    return { needsKey: 'No human Sinhala subtitle exists for this title yet. Set the GEMINI_API_KEY worker secret (wrangler secret put GEMINI_API_KEY) to let the bridge translate the English file with Gemini Flash.' };
  }
  const model = geminiModelOf(env, params.headers);

  // fetch the COMPLETE synced English .srt once (cached in entext:<jobId>);
  // a captcha-gated or rate-limited file falls through to the next candidate
  let enText = null;
  let chosen = enCand;
  const cachedEn = await kvGet(env, 'entext:' + jobId);
  if (cachedEn && !params.fresh) {
    enText = cachedEn;
  } else {
    let lastErr = null;
    for (const cand of enCandidates) {
      try {
        enText = await fetchUpstreamSub(cand.url, {
          extraHosts: env && env.ALLOWED_SUB_HOSTS ? String(env.ALLOWED_SUB_HOSTS).split(',') : [],
        });
        chosen = cand;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!enText) {
      return { notFound: true, error: 'English source file could not be fetched: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown') };
    }
  }
  const enCues = parseSrtCues(enText);
  if (enCues.length < MIN_CUES || enCues.length > MAX_CUES) {
    return { notFound: true, error: 'English source file unusable (' + enCues.length + ' cues)' };
  }
  await publishSrt(env, enText, { token: enToken, permanent: true });
  await kvPut(env, 'entext:' + jobId, enText);
  await kvPut(env, 'subjob:' + siToken, jobId); // /sub/<siToken>.srt → 202 progress
  await kvPut(env, 'subjob:' + enToken, jobId); // /sub/<enToken>.srt → 200 now, always valid

  const batches = makeBatches(enCues.length);
  const job = existing && existing.status === 'translating'
    ? existing
    : {
        id: jobId, type, imdb, season, episode, status: 'translating', source: 'gemini',
        provider: chosen.provider, release: chosen.release || '', cues: enCues.length,
        siToken, enToken, model, done: 0, total: batches.length,
        batchDone: batches.map(() => false), startedAt: now, createdAt: now, error: null,
      };
  if (params.fresh || !existing || existing.status !== 'translating') {
    job.done = 0;
    job.total = batches.length;
    job.batchDone = batches.map(() => false);
    job.startedAt = now;
    job.error = null;
    job.model = model;
    await kvPut(env, 'sidone:' + jobId, JSON.stringify(new Array(enCues.length).fill('')));
  }
  job.status = 'translating';
  await putJob(env, job);
  const started = resumeTranslationJob(env, key, model, jobId).catch(() => {});
  return { job, started };
}

/** Translate every unfinished batch, then validate + publish the finished pair.
 * Idempotent: safe to call again after a stall — finished batches are skipped. */
async function resumeTranslationJob(env, key, model, jobId) {
  const job = await getJob(env, jobId);
  if (!job || job.status !== 'translating') return;
  const enText = await kvGet(env, 'entext:' + jobId);
  if (!enText) {
    job.status = 'error';
    job.error = 'cached English source vanished (re-request with ?fresh=1)';
    await putJob(env, job);
    return;
  }
  const enCues = parseSrtCues(enText);
  const batches = makeBatches(enCues.length); // deterministic → same boundaries as the job record
  let siTexts = [];
  try {
    siTexts = JSON.parse((await kvGet(env, 'sidone:' + jobId)) || '[]');
  } catch (e) { siTexts = []; }
  if (!Array.isArray(siTexts) || siTexts.length !== enCues.length) {
    siTexts = new Array(enCues.length).fill('');
  }
  if (!Array.isArray(job.batchDone) || job.batchDone.length !== batches.length) {
    job.batchDone = batches.map(() => false);
  }

  const pending = [];
  for (let b = 0; b < batches.length; b++) if (!job.batchDone[b]) pending.push(b);

  try {
    await runPool(pending, CONCURRENCY, async (b) => {
      const idxs = batches[b];
      const items = idxs.map((i) => ({ i, text: enCues[i].lines.join('\n') }));
      const translated = await translateBatchRobust(env, key, model, items);
      for (let k = 0; k < idxs.length; k++) siTexts[idxs[k]] = translated[k];
      job.batchDone[b] = true;
      job.done = job.batchDone.filter(Boolean).length;
      await putJob(env, job);
      await kvPut(env, 'sidone:' + jobId, JSON.stringify(siTexts));
    });

    // ── final validator: cue count identical + every timestamp byte-identical ──
    const siCues = enCues.map((c, i) => ({ ts: c.ts, lines: (siTexts[i] || c.lines.join('\n')).split('\n') }));
    const siSrt = reassembleSrt(siCues);
    const reEn = parseSrtCues(enText);
    const reSi = parseSrtCues(siSrt);
    if (reSi.length !== reEn.length) throw new Error('validator: cue count changed (' + reEn.length + ' → ' + reSi.length + ')');
    for (let i = 0; i < reEn.length; i++) {
      if (reEn[i].ts !== reSi[i].ts) throw new Error('validator: timestamp changed at cue ' + (i + 1));
    }
    let meaningful = 0, siCount = 0;
    for (const t of siTexts) {
      if (t && t.replace(/[-–#\s.,!?'"…:;]/g, '').length >= 2) {
        meaningful++;
        if (SINHALA_RE.test(t)) siCount++;
      }
    }
    if (meaningful > 0 && siCount / meaningful < 0.6) throw new Error('validator: Sinhala script in only ' + siCount + '/' + meaningful + ' cues');

    // ── publish the permanent pair + the compact cue-lock payload ──
    const cleanSi = toCleanSrt(siSrt).text;
    await publishSrt(env, cleanSi, { token: job.siToken, permanent: true });
    await publishSrt(env, enText, { token: job.enToken, permanent: true });
    await kvPut(env, 'paired:' + jobId, JSON.stringify({
      jobId, status: 'done', source: 'gemini', cues: buildPairedCues(enCues, siTexts),
    }));
    job.status = 'done';
    job.done = job.total;
    job.error = null;
    await putJob(env, job);
  } catch (e) {
    job.status = 'error';
    job.error = String((e && e.message) || e);
    await putJob(env, job);
  }
}

/** The /api/paired/:jobId.json payload (plus status shaping for the routes). */
async function getPaired(env, jobId) {
  const job = await getJob(env, jobId);
  if (!job) return null;
  if (job.status === 'done') {
    const raw = await kvGet(env, 'paired:' + jobId);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        return { status: 200, body: { ok: true, jobId, status: 'done', source: p.source || job.source, cues: p.cues } };
      } catch (e) { /* fall through to rebuild */ }
      // rebuild from the stored pair (paired blob evicted but subs remain)
      const enText = await kvGet(env, 'entext:' + jobId);
      if (enText && job.source === 'gemini') {
        const enCues = parseSrtCues(enText);
        const siTexts = JSON.parse((await kvGet(env, 'sidone:' + jobId)) || '[]');
        const body = { ok: true, jobId, status: 'done', source: 'gemini', cues: buildPairedCues(enCues, Array.isArray(siTexts) ? siTexts : null) };
        return { status: 200, body };
      }
    }
    return { status: 200, body: { ok: false, jobId, status: 'done', error: 'paired payload not cached (request /subtitles again with ?fresh=1)' } };
  }
  if (job.status === 'translating') {
    const done = job.done || 0, total = job.total || 1;
    const eta = job.startedAt && done > 0 ? Math.max(1, Math.round(((Date.now() - job.startedAt) / done) * (total - done) / 1000)) : null;
    return {
      status: 202,
      body: { ok: true, jobId, status: 'translating', progress: +(done / total).toFixed(3), done, total, eta_sec: eta },
    };
  }
  return { status: 200, body: { ok: false, jobId, status: 'error', error: job.error || 'job failed' } };
}

/** Map a /sub/<token>.srt token to its job (for the 202-progress contract). */
async function jobForToken(env, token) {
  const jobId = await kvGet(env, 'subjob:' + token);
  if (!jobId) return null;
  return getJob(env, jobId);
}

export {
  PIPELINE_VERSION, DEFAULT_GEMINI_MODEL,
  jobIdOf, JOB_ID_RE, deterministicToken, getJob, putJob, kvGet, kvPut,
  cinemetaResolve, cinemetaMeta, flattenLikeAnantPlay, parseTsMs, buildPairedCues,
  geminiKeyOf, geminiModelOf, geminiBaseOf, geminiTranslateBatch, translateBatchRobust,
  makeBatches, runPool, ensureSubtitleJob, resumeTranslationJob, getPaired, jobForToken,
};
