/* AnantPlay Sinhala Subtitle Bridge — v4 zero-fork multi-provider subtitle pipeline.
 *
 * Powers the Sinhala Player app (repo: anantplay-sinhala-player) end to end:
 *
 *   /api/resolve?title=Clayface            → Cinemeta IMDb id + clean title/year
 *   /subtitles/movie/tt34890576.json       → human Sinhala first (OpenSubtitles sin,
 *                                             SubDL si), else an AI-translate job
 *   /api/paired/<jobId>.json               → compact {i,t0,t1,en,enf,si} cue array
 *   /sub/<token>.srt                       → real HTTP 200 UTF-8 SRT; 202 progress
 *   POST /api/subs-direct                  → NEW v4: translate a cast-supplied
 *                                             English .srt (AnantPlay's own subs
 *                                             extra / a side-loaded file) — the
 *                                             player hands over what the cast
 *                                             already carried.
 *
 * ── v4 (this upgrade) — the zero-429 architecture ─────────────────────────────
 *   · MULTI-PROVIDER FAILOVER (providers.js): azure → google_v3 → gemini →
 *     workers_ai. Any 429 trips a 10-minute per-provider KV circuit breaker and
 *     the batch seamlessly continues on the next provider. One legitimate key
 *     per provider; NO multi-account farming (Google ToS risk documented).
 *   · COMPACT PACED BATCHING: the numbered `n|text` protocol, 400–500 cues per
 *     batch and max 2 in flight → a 1,500-cue movie is 3–4 total requests on
 *     EVERY provider (verified by lab/verify_worker_v4_e2e.mjs).
 *   · SINGLE-FLIGHT JOB LOCK (`lock:<jobId>` in KV with a 90 s heartbeat TTL):
 *     a second poll during a translating job can NEVER spawn a duplicate
 *     translation run — the isolate-miss restart storm that burned the v3
 *     quota is structurally impossible now.
 *   · RESUME, DON'T RESTART: with KV bound, a stalled job (dead isolate) resumes
 *     from `sidone:<jobId>` batch flags — finished batches are never re-billed.
 *     Without KV the worker says so LOUDLY in /health + /api/status
 *     (storageWarn) so nobody wonders where a job went.
 *   · TRANSLATION CACHE: once done, the finished .srt lives in KV permanently
 *     (re-watch / seek / second device = zero quota, <50 ms).
 *
 * Jobs are keyed deterministically (type:imdb:season:episode); artifacts use
 * SHA-derived deterministic tokens. Storage: KV when bound (recommended,
 * 100,000 reads/day + 1,000 writes/day free forever), per-isolate Map fallback
 * otherwise (dev parity only). Zero Node APIs.
 */

import {
  sha256Hex, publishSrt, parseSrtCues, reassembleSrt, toCleanSrt,
  openSubsSearch, stremioOsSearch, subdlSearch, pirateLkSearch, fetchUpstreamSub, SUBDL_UA,
} from './lib.js';
import {
  chainOf, providerStatus, translateWithFailover, ProviderError,
} from './providers.js';
import { DEFAULT_LANG, LANGUAGES, langOf, isKnownLang, scriptReOf, maxCharsOf } from './languages.js';
import {
  cinemetaContext, registerForGenres, flagCuesForPolish, buildPolishPrompt, validPolishedCue,
} from './cinema.js';

const PIPELINE_VERSION = '4.1.0';
const SINHALA_RE = /[\u0D80-\u0DFF]/;
const MIN_CUES = 8;                 // below this the file is not a real subtitle track
const MAX_CUES = 6000;              // a 4-hour movie has ~4000 cues; refuse anything absurd
// v4 compact pacing: 3–4 requests per movie on every provider.
const MIN_BATCHES = 3, MAX_BATCHES = 4, TARGET_CUES_PER_BATCH = 500;
const SPLIT_MIN_CUES = 16;          // below this a failed batch is an error, not a split
const STALLED_MS = 150000;          // translating + no progress update for 2.5 min → resume
const RESTART_ERROR_AFTER_MS = 60000;
const CONCURRENCY = 2;              // ≤2 batches in flight — RPM-safe on every free tier
const LOCK_TTL_MS = 90000;          // single-flight heartbeat window

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
/** v4.1: the per-language job id — movie:tt123:0:0:si. The v4 bare id stays the
 * 'si' job (default language), so every existing v4 test and cached KV entry
 * keeps working unchanged. */
function langJobIdOf(type, imdb, season, episode, lang) {
  const l = isKnownLang(lang) ? String(lang) : DEFAULT_LANG;
  const base = jobIdOf(type, imdb, season, episode);
  return l === DEFAULT_LANG ? base : base + ':' + l;
}
function parseLangOf(jobId) {
  const parts = String(jobId || '').split(':');
  // movie:tt123:0:0[:lang] / direct:<hash>[:lang]
  if (parts[0] === 'direct') return parts.length > 2 && isKnownLang(parts[2]) ? parts[2] : DEFAULT_LANG;
  return parts.length > 4 && isKnownLang(parts[4]) ? parts[4] : DEFAULT_LANG;
}

function jobIdOf(type, imdb, season, episode) {
  return type + ':' + imdb + ':' + (season || 0) + ':' + (episode || 0);
}

const JOB_ID_RE = /^(movie|series):tt\d{4,10}:\d{1,4}:\d{1,5}(:[a-z]{2}(-CN)?)?$/;

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

// ── the single-flight lock ──────────────────────────────────────────────────

/** Try to become the one translating runner for this job. A KV-held lock with a
 * 90 s TTL (heartbeat-refreshed while the run is alive): another poll that
 * lands mid-run sees the lock, does NOT start a second runner, and just answers
 * progress. Without KV the Map gives the same guarantee inside one isolate. */
async function acquireLock(env, jobId, now) {
  const key = 'lock:' + jobId;
  const raw = await kvGet(env, key).catch(() => null);
  if (raw) {
    const until = Number(raw) || 0;
    if (until > (now || Date.now())) return false;   // a live runner exists
  }
  await kvPut(env, key, String((now || Date.now()) + LOCK_TTL_MS));
  return true;
}

async function heartbeatLock(env, jobId, now) {
  await kvPut(env, 'lock:' + jobId, String((now || Date.now()) + LOCK_TTL_MS)).catch(() => {});
}

async function releaseLock(env, jobId) {
  if (env && env.SUBS_KV) { await env.SUBS_KV.delete('lock:' + jobId).catch(() => {}); return; }
  memStore().delete('lock:' + jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cinemeta (the same metadata service official AnantPlay resolves titles through)
// ─────────────────────────────────────────────────────────────────────────────

/** Cinemeta (the same metadata service official AnantPlay resolves titles through).
 *  CINEMETA_BASE (env): test/lab-only override (loopback allowed). */
function cinemetaBase(env) {
  const raw = String((env && env.CINEMETA_BASE) || '').trim() || 'https://v3-cinemeta.strem.io';
  try {
    const u = new URL(raw);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !loopback) return 'https://v3-cinemeta.strem.io';
    if (u.username || u.password) return 'https://v3-cinemeta.strem.io';
    return u.origin;
  } catch (e) {
    return 'https://v3-cinemeta.strem.io';
  }
}

async function cinemetaFetch(env, path, timeoutMs) {
  const res = await fetch(cinemetaBase(env) + path, {
    headers: { 'User-Agent': SUBDL_UA, 'Accept': 'application/json' },
    redirect: 'manual',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || 10000) : undefined,
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/** Title (and optional season/episode) → {imdb, name, year} via Cinemeta search. */
async function cinemetaResolve(title, type, env) {
  const q = String(title || '').trim();
  if (q.length < 2) return null;
  const j = await cinemetaFetch(env, '/catalog/' + type + '/top/search=' + encodeURIComponent(q.slice(0, 120)) + '.json');
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
async function cinemetaMeta(type, imdb, env) {
  const j = await cinemetaFetch(env, '/meta/' + type + '/' + encodeURIComponent(imdb) + '.json');
  const m = j && j.meta ? j.meta : null;
  if (!m) return { imdb, name: imdb, year: '' };
  return { imdb, name: String(m.name || imdb), year: String(m.releaseInfo || m.year || '') };
}

// ─────────────────────────────────────────────────────────────────────────────
// AnantPlay parity helpers
// ─────────────────────────────────────────────────────────────────────────────

/** EXACT flattening rule of AnantPlay's showCues() (PlayerActivity.java:356-358):
 * every inner '\n' becomes a space, EXCEPT when the next line starts with '-' or '–'
 * (a second speaker). The Player sees this exact string in the subtitle TextView. */
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
// the provider-agnostic batch translator (v4)
// ─────────────────────────────────────────────────────────────────────────────

/** Translate one batch of cues with provider failover, splitting when the model's
 * output limit truncates the answer (LLM providers only; MT providers never need
 * this because their chunking respects the request caps). */
async function translateBatchRobust(env, items, cfg) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await translateWithFailover(env, items, (k) => kvGet(env, k), (k, v) => kvPut(env, k, v), cfg);
      return r;
    } catch (e) {
      lastErr = e;
      const truncated = e && e.errors && e.errors.some((x) => /truncated/.test(String(x)));
      if (truncated) break; // splitting beats retrying a truncation
    }
  }
  if (items.length >= SPLIT_MIN_CUES * 2) {
    const mid = Math.floor(items.length / 2);
    const a = await translateBatchRobust(env, items.slice(0, mid), cfg);
    const b = await translateBatchRobust(env, items.slice(mid), cfg);
    return {
      texts: a.texts.concat(b.texts),
      provider: a.provider + '+' + b.provider,
    };
  }
  // one last halving even below the comfortable split floor (v3 behaviour:
  // a 16–31-cue truncated batch still gets one chance to fit)
  if (lastErr && lastErr.errors && lastErr.errors.some((x) => /truncated/.test(String(x))) && items.length >= SPLIT_MIN_CUES) {
    const mid = Math.floor(items.length / 2);
    const a = await translateBatchRobust(env, items.slice(0, mid), cfg);
    const b = await translateBatchRobust(env, items.slice(mid), cfg);
    return {
      texts: a.texts.concat(b.texts),
      provider: a.provider + '+' + b.provider,
    };
  }
  throw lastErr || new Error('translation failed');
}

/** Deterministic batch boundaries from the cue count alone → 3–4 batches, so a
 * resumed run splits identically and per-batch progress flags stay valid. */
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

/** Small promise pool — keeps CONCURRENCY batches in flight (RPM-safe pacing). */
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

/** Publish a finished job's artifacts (the shared tail of every done path). */
async function publishDoneJob(env, jobId, siText, siToken, enText, enToken, extra) {
  await publishSrt(env, siText, { token: siToken, permanent: true });
  if (enToken && enText) await publishSrt(env, enText, { token: enToken, permanent: true });
  await kvPut(env, 'subjob:' + siToken, jobId);
  if (enToken) await kvPut(env, 'subjob:' + enToken, jobId);
  const job = { id: jobId, status: 'done', siToken, enToken: enToken || null, updatedAt: Date.now(), ...extra };
  await putJob(env, job);
  return job;
}

/**
 * The one call behind GET /subtitles/:type/:id.json.
 * Returns {job} (done | translating | error), or {needsKey} / {notFound, hints}.
 * `started` is the background promise when a new translation run was kicked off —
 * the route passes it to ctx.waitUntil().
 */
async function ensureSubtitleJob(env, ctx, params) {
  const type = params.type === 'series' ? 'series' : 'movie';
  const imdb = /^tt\d{4,10}$/.test(params.imdb || '') ? params.imdb : null;
  if (!imdb) return { badRequest: 'id must be an IMDb id like tt34890576 (use /api/resolve?title=… first)' };
  const season = type === 'series' ? clampInt(params.season, 0, 999) : 0;
  const episode = type === 'series' ? clampInt(params.episode, 0, 9999) : 0;
  const titleHint = String(params.title || '').slice(0, 200);
  // v4.1: the target language (si default — v4 callers unchanged) + register override
  const lang = isKnownLang(params.lang) ? String(params.lang) : DEFAULT_LANG;
  const register = params.register === 'spoken' || params.register === 'formal' ? params.register : 'auto';
  const jobId = langJobIdOf(type, imdb, season, episode, lang);
  const now = Date.now();
  const siToken = await deterministicToken('si', jobId);
  const enToken = await deterministicToken('en', jobId);
  const langInfo = langOf(lang);

  // 1. cached job?
  const existing = await getJob(env, jobId);
  if (existing && !params.fresh) {
    if (existing.status === 'done') return { job: existing };
    if (existing.status === 'translating') {
      // SINGLE-FLIGHT: only the lock holder runs; a second poll just reads state.
      const locked = await acquireLock(env, jobId);
      if (!locked) return { job: existing };
      if (now - (existing.updatedAt || 0) > STALLED_MS) {
        const p = resumeTranslationJob(env, jobId).finally(() => releaseLock(env, jobId)).catch(() => {});
        return { job: existing, started: p };
      }
      await releaseLock(env, jobId);
      return { job: existing };
    }
    if (existing.status === 'error' && now - (existing.updatedAt || 0) < RESTART_ERROR_AFTER_MS) {
      return { job: existing }; // don't hot-loop a failing upstream
    }
  }

  // 2. human Sinhala first — the richest Sinhala index is the legacy OpenSubtitles REST
  //    (ChameE/Baiscope uploads); the Stremio addon and SubDL si are the fallbacks.
  //    Any of them can be rate-limited (403) at any moment; every leg degrades cleanly.
  //    ZERO translation quota is ever spent when a human file exists.
  const subdlKey = String((env && env.SUBDL_API_KEY) || '').trim() || String(params.subdlKey || '').trim();
  // v4.1: human subs in ANY registry language (OpenSubtitles ISO-639-2B codes).
  // For the DEFAULT si job this is byte-identical to v4 (sin); other languages
  // map through the registry (tam, hin, spa, jpn, ara…). SubDL search API takes
  // one language per call; si keeps the v4 behaviour, others query their code.
  const osLangs = [langInfo.osCode];
  const [osSi, stremioSi, subdlSi] = await Promise.all([
    openSubsSearch(imdb, season, episode, null, osLangs, env).catch(() => []),
    stremioOsSearch(type, imdb, season, episode, osLangs, env).catch(() => []),
    (async () => {
      if (lang !== DEFAULT_LANG) return [];   // SubDL si-only in v4 parity; other langs via OS/stremio
      return subdlSearch(imdb, season, episode, null, subdlKey).catch(() => []);
    })(),
  ]);
  const humanCandidates = [];
  const osBest = pickHumanSub(osSi, langInfo.osCode);
  if (osBest) humanCandidates.push(osBest);
  const stremioBest = pickHumanSub(stremioSi, langInfo.osCode);
  if (stremioBest) humanCandidates.push(stremioBest);
  const sdBest = lang === DEFAULT_LANG ? pickHumanSub(subdlSi, 'si') : null;
  if (sdBest) humanCandidates.push(sdBest);

  for (const cand of humanCandidates) {
    try {
      const siText = await fetchUpstreamSub(cand.url, {
        extraHosts: env && env.ALLOWED_SUB_HOSTS ? String(env.ALLOWED_SUB_HOSTS).split(',') : [],
      });
      const cues = parseSrtCues(siText);
      if (cues.length < MIN_CUES) continue; // a stub file — try the next provider
      await publishSrt(env, siText, { token: siToken, permanent: true });
      await kvPut(env, 'subjob:' + siToken, jobId);
      const job = {
        id: jobId, type, imdb, season, episode, status: 'done', source: 'human',
        provider: cand.provider, release: cand.release || '', cues: cues.length,
        siToken, enToken: null, model: null, createdAt: now,
        lang, quality: 'human', polishStatus: 'off',
      };
      await putJob(env, job);
      await kvPut(env, 'paired:' + jobId, JSON.stringify({
        jobId, status: 'done', source: 'human', cues: buildPairedCues(cues, null),
      }));
      return { job };
    } catch (e) { /* try the next provider */ }
  }

  // 3. no human Sinhala → AI-translate the best English file through the
  //    multi-provider chain (azure → google_v3 → gemini → workers_ai).
  //    A specific file can be captcha-gated (302 → captcha) or rate-limited,
  //    so try up to 4 candidates.
  const [osEn, stremioEn] = await Promise.all([
    openSubsSearch(imdb, season, episode, null, ['eng'], env).catch(() => []),
    stremioOsSearch(type, imdb, season, episode, ['eng'], env).catch(() => []),
  ]);
  const enCandidates = [];
  for (const r of osEn) { if (enCandidates.length < 3) enCandidates.push(r); }
  for (const r of stremioEn) { if (enCandidates.length < 4) enCandidates.push(r); }
  const enCand = enCandidates[0] || null;
  if (!enCand) {
    const hints = [];
    if (titleHint) hints.push({ provider: 'piratelk', url: 'https://piratelk.com/?s=' + encodeURIComponent(titleHint) });
    hints.push({ provider: 'opensubtitles', url: 'https://rest.opensubtitles.org/search/imdbid-' + imdb.replace(/^tt/, '') + '/sublanguageid-sin' });
    return { notFound: true, hints };
  }
  const chain = chainOf(env, lang);
  if (!chain.length) {
    return { needsKey: 'No human subtitle exists for this title in ' + langInfo.english + ' yet, and no translation provider is configured. Set ONE of: wrangler secret put AZURE_TRANSLATOR_KEY (2M chars/month free), wrangler secret put GOOGLE_V3_KEY (500K chars/month free), wrangler secret put GEMINI_API_KEY, or add the [ai] binding (Workers AI).' };
  }

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
        id: jobId, type, imdb, season, episode, status: 'translating', source: 'ai',
        provider: chain[0], chain: chain.slice(), release: chosen.release || '', cues: enCues.length,
        siToken, enToken, done: 0, total: batches.length, providers: [],
        batchDone: batches.map(() => false), startedAt: now, createdAt: now, error: null,
        // v4.1 two-stage + multi-language state
        lang, register, quality: 'base-nmt', polishStatus: 'pending',
      };
  job.lang = lang;
  job.register = register;
  if (job.status !== 'done') { job.quality = job.quality || 'base-nmt'; job.polishStatus = job.polishStatus || 'pending'; }
  if (params.fresh || !existing || existing.status !== 'translating') {
    job.done = 0;
    job.total = batches.length;
    job.batchDone = batches.map(() => false);
    job.startedAt = now;
    job.error = null;
    await kvPut(env, 'sidone:' + jobId, JSON.stringify(new Array(enCues.length).fill('')));
  }
  job.status = 'translating';
  await putJob(env, job);
  // single-flight: if another runner is already on it, just report progress
  const locked = await acquireLock(env, jobId);
  if (!locked) return { job };
  const started = resumeTranslationJob(env, jobId).finally(() => releaseLock(env, jobId)).catch(() => {});
  return { job, started };
}

/** Translate every unfinished batch through the failover chain, then validate +
 * publish the finished pair. Idempotent: safe to call again after a stall —
 * finished batches are skipped (a resumed run never re-bills finished work).
 * The lock holder heartbeats while running so polls never double-spawn it. */
async function resumeTranslationJob(env, jobId) {
  const job = await getJob(env, jobId);
  if (!job || job.status !== 'translating') return;
  const enText = await kvGet(env, 'entext:' + jobId);
  if (!enText) {
    job.status = 'error';
    job.error = 'cached English source vanished (re-request with ?fresh=1) — without SUBS_KV bound, jobs do not survive isolate restarts';
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
  const heartbeat = setInterval(() => heartbeatLock(env, jobId), 30000);

  try {
    await runPool(batches.map((_, b) => b).filter((b) => !job.batchDone[b]), CONCURRENCY, async (b) => {
      const idxs = batches[b];
      const items = idxs.map((i) => ({ i, text: enCues[i].lines.join('\n') }));
      const r = await translateBatchRobust(env, items, { model: job.model, targetLang: job.lang || DEFAULT_LANG });
      for (let k = 0; k < idxs.length; k++) siTexts[idxs[k]] = r.texts[k];
      job.batchDone[b] = true;
      job.done = job.batchDone.filter(Boolean).length;
      if (job.providers && job.providers.indexOf(r.provider) < 0) job.providers.push(r.provider);
      job.provider = r.provider;
      await putJob(env, job);
      await kvPut(env, 'sidone:' + jobId, JSON.stringify(siTexts));
    });

    // ── final validator: cue count identical + every timestamp byte-identical ──
    const lang = job.lang || DEFAULT_LANG;
    const langInfo = langOf(lang);
    const siCues = enCues.map((c, i) => ({ ts: c.ts, lines: String(siTexts[i] || c.lines.join('\n')).split('\n') }));
    const siSrt = reassembleSrt(siCues);
    const reEn = parseSrtCues(enText);
    const reSi = parseSrtCues(siSrt);
    if (reSi.length !== reEn.length) throw new Error('validator: cue count changed (' + reEn.length + ' → ' + reSi.length + ')');
    for (let i = 0; i < reEn.length; i++) {
      if (reEn[i].ts !== reSi[i].ts) throw new Error('validator: timestamp changed at cue ' + (i + 1));
    }
    // v4.1: the script check uses the TARGET language's script (si → Sinhala block,
    // ta → Tamil block, ja → CJK …) — Sinhala stays the default behaviour.
    const scriptRe = scriptReOf(lang) || SINHALA_RE;
    let meaningful = 0, siCount = 0;
    for (const t of siTexts) {
      if (t && t.replace(/[-–#\s.,!?'"…:;]/g, '').length >= 2) {
        meaningful++;
        if (scriptRe.test(t)) siCount++;
      }
    }
    if (meaningful > 0 && siCount / meaningful < 0.6) {
      throw new Error('validator: ' + langInfo.english + ' script in only ' + siCount + '/' + meaningful + ' cues');
    }

    // ── STAGE 1 PUBLISH (two-stage delivery): the valid base .srt goes live NOW ──
    // quality:"base-nmt" + polishStatus:"pending"; /sub/<token>.srt is playable
    // this second. The cinema polish below upgrades the SAME token in place.
    const cleanSi = toCleanSrt(siSrt).text;
    await publishSrt(env, cleanSi, { token: job.siToken, permanent: true });
    await publishSrt(env, enText, { token: job.enToken, permanent: true });
    await kvPut(env, 'paired:' + jobId, JSON.stringify({
      jobId, status: 'done', source: 'ai', cues: buildPairedCues(enCues, siTexts),
    }));
    job.status = 'done';
    job.done = job.total;
    job.error = null;
    job.quality = 'base-nmt';
    job.polishStatus = 'pending';
    await putJob(env, job);

    // ── STAGE 2 (silent cinema upgrade): polish flagged cues, swap in place ──
    // Never throws outward: any failure leaves the published base .srt intact
    // (the swap only happens after the full validator passes again).
    try {
      await runCinemaPolish(env, jobId);
    } catch (pe) {
      job.polishStatus = 'failed';
      job.polishError = String((pe && pe.message) || pe).slice(0, 200);
      await putJob(env, job).catch(() => {});
    }
  } catch (e) {
    job.status = 'error';
    job.error = String((e && e.message) || e);
    await putJob(env, job);
  } finally {
    clearInterval(heartbeat);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// v4.1 STAGE 2 — the silent cinema polish (background, resumable, fail-safe)
// ─────────────────────────────────────────────────────────────────────────────

const POLISH_BATCH_CUES = 120;       // ≤3 LLM calls for a 1,500-cue movie (300 flags / 120)
const POLISH_RECENT_CONTEXT = 5;     // sliding window: last 5 translated cues (read-only)

/** Polish the flagged cues of a DONE base-nmt job and swap the .srt in place.
 *  Resumable: progress lives in KV (polish:<jobId> = {batchDone[], texts{}}),
 *  so a dead isolate loses nothing. Idempotent + fail-safe by contract:
 *  ANY error aborts quietly — the base .srt stays published and playable. */
async function runCinemaPolish(env, jobId) {
  const job = await getJob(env, jobId);
  if (!job || job.status !== 'done') return;
  const lang = job.lang || DEFAULT_LANG;
  const register = job.register === 'spoken' || job.register === 'formal'
    ? job.register
    : registerOfJob(env, job);
  const enText = await kvGet(env, 'entext:' + jobId);
  if (!enText) return;                                  // nothing to polish against
  const enCues = parseSrtCues(enText);
  let siTexts = [];
  try { siTexts = JSON.parse((await kvGet(env, 'sidone:' + jobId)) || '[]'); } catch (e) {}
  if (!Array.isArray(siTexts) || siTexts.length !== enCues.length) return;

  // deterministic flags (same input → same flags → resumable batches line up)
  const enLines = enCues.map((c) => c.lines.join('\n'));
  const flags = flagCuesForPolish(enLines, siTexts, lang, register, 20);
  if (!flags.size) {
    job.polishStatus = 'done';                          // nothing worth polishing
    job.quality = job.quality || 'base-nmt';
    await putJob(env, job);
    return;
  }
  const flagged = [...flags.keys()];
  const batches = [];
  for (let i = 0; i < flagged.length; i += POLISH_BATCH_CUES) batches.push(flagged.slice(i, i + POLISH_BATCH_CUES));

  // resumable state
  let st = null;
  try { st = JSON.parse((await kvGet(env, 'polish:' + jobId)) || 'null'); } catch (e) {}
  if (!st || !Array.isArray(st.batchDone) || st.batchDone.length !== batches.length) {
    st = { batchDone: batches.map(() => false), fixed: {} };
  }

  // movie context (KV-cached per imdb) — best-effort
  let ctx = { title: job.name || '', year: '', genres: [], cast: [], plot: '' };
  try {
    if (job.imdb) ctx = await cinemetaContext(env, job.type === 'series' ? 'series' : 'movie', job.imdb,
      (k) => kvGet(env, k), (k, v) => kvPut(env, k, v));
  } catch (e) { /* generic context is fine */ }

  for (let b = 0; b < batches.length; b++) {
    if (st.batchDone[b]) continue;
    const idxs = batches[b];
    const items = idxs.map((i) => ({ i: i + 1, text: enLines[i] }));
    const recent = idxs[0] > POLISH_RECENT_CONTEXT
      ? siTexts.slice(Math.max(0, idxs[0] - POLISH_RECENT_CONTEXT), idxs[0])
      : [];
    const prompt = buildPolishPrompt(
      idxs.map((i) => ({ i: i + 1, en: enLines[i], draft: siTexts[i] })),
      ctx, lang, register, recent,
    );
    // polish rides the LLM providers (gemini → workers_ai …) through the same
    // failover + breakers; the numbered protocol is identical to base batches
    const r = await translateWithFailover(env, items,
      (k) => kvGet(env, k), (k, v) => kvPut(env, k, v),
      { model: null, targetLang: lang, polishPrompt: prompt, isPolish: true, promptKind: 'polish', providerKind: 'llm' });
    // map answers back through the PER-CUE fallback validator
    const answers = r.texts;
    for (let k = 0; k < idxs.length; k++) {
      const cueIdx = idxs[k];
      const polished = String(answers[k] || '');
      if (validPolishedCue(enLines[cueIdx], polished, siTexts[cueIdx], lang)) {
        st.fixed[cueIdx] = polished;
      }
      // else: keep the clean NMT draft for this cue (never corrupt the batch)
    }
    st.batchDone[b] = true;
    await kvPut(env, 'polish:' + jobId, JSON.stringify(st));
  }

  // swap in place — ONLY after the full validator passes again
  const finalTexts = siTexts.map((t, i) => (st.fixed[i] !== undefined ? st.fixed[i] : t));
  const siCues = enCues.map((c, i) => ({ ts: c.ts, lines: String(finalTexts[i] || c.lines.join('\n')).split('\n') }));
  const siSrt = reassembleSrt(siCues);
  const reEn = parseSrtCues(enText);
  const reSi = parseSrtCues(siSrt);
  if (reSi.length !== reEn.length) return;                       // abort swap, base stays
  for (let i = 0; i < reEn.length; i++) {
    if (reEn[i].ts !== reSi[i].ts) return;
  }
  const cleanSi = toCleanSrt(siSrt).text;
  await publishSrt(env, cleanSi, { token: job.siToken, permanent: true, force: true });
  await kvPut(env, 'sidone:' + jobId, JSON.stringify(finalTexts));
  await kvPut(env, 'paired:' + jobId, JSON.stringify({
    jobId, status: 'done', source: 'ai', cues: buildPairedCues(enCues, finalTexts),
  }));
  job.quality = 'cinema-polished';
  job.polishStatus = 'done';
  await putJob(env, job);
}

/** genre → register (auto mode): Cinemeta genres when we have them, else spoken. */
async function registerOfJob(env, job) {
  try {
    if (job.imdb) {
      const ctx = await cinemetaContext(env, job.type === 'series' ? 'series' : 'movie', job.imdb,
        (k) => kvGet(env, k), (k, v) => kvPut(env, k, v));
      return registerForGenres(ctx.genres, null);
    }
  } catch (e) { /* fall through */ }
  return 'spoken';
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
      if (enText && job.source === 'ai') {
        const enCues = parseSrtCues(enText);
        const siTexts = JSON.parse((await kvGet(env, 'sidone:' + jobId)) || '[]');
        const body = { ok: true, jobId, status: 'done', source: 'ai', cues: buildPairedCues(enCues, Array.isArray(siTexts) ? siTexts : null) };
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
      body: { ok: true, jobId, status: 'translating', progress: +(done / total).toFixed(3), done, total, eta_sec: eta, provider: job.provider },
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

/**
 * NEW v4 — translate a cast-supplied English subtitle text (the `subs` URLs
 * AnantPlay's POST /play payload already carries, or a side-loaded file the
 * player picked). No IMDb needed: the finished .srt is published under a
 * deterministic token derived from the text itself, so the same file is
 * translated once and cached forever.
 */
async function translateDirectSub(env, ctx, srtText, opts) {
  const o = opts || {};
  let clean;
  try {
    clean = toCleanSrt(String(srtText || ''));
  } catch (e) {
    return { badRequest: 'not a usable .srt: ' + (e && e.message ? e.message : e) };
  }
  const enCues = parseSrtCues(clean.text);
  if (enCues.length < MIN_CUES || enCues.length > MAX_CUES) {
    return { badRequest: 'subtitle has ' + enCues.length + ' cues (need ' + MIN_CUES + '–' + MAX_CUES + ')' };
  }
  // v4.1: the target language of a direct cast-sub job (si default = v4 parity)
  const lang = isKnownLang(o.lang) ? String(o.lang) : DEFAULT_LANG;
  const register = o.register === 'spoken' || o.register === 'formal' ? o.register : 'auto';
  if (lang === 'en') {
    // English target: the supplied file already IS English — publish it as-is
    const contentToken0 = await sha256Hex('direct|' + clean.text).then((h) => h.slice(0, 16));
    const jobId0 = 'direct:' + contentToken0 + ':en';
    const enToken0 = await deterministicToken('en', jobId0);
    await publishSrt(env, clean.text, { token: enToken0, permanent: true });
    await kvPut(env, 'subjob:' + enToken0, jobId0);
    const job0 = { id: jobId0, type: 'direct', imdb: null, season: 0, episode: 0, status: 'done',
      source: 'human', provider: 'supplied', release: o.name || 'cast-subs', cues: enCues.length,
      siToken: enToken0, enToken: enToken0, lang: 'en', quality: 'human', polishStatus: 'off', createdAt: Date.now() };
    await putJob(env, job0);
    return { job: job0 };
  }
  const chain = chainOf(env, lang);
  if (!chain.length) {
    return { needsKey: 'No translation provider configured. Set ONE of: AZURE_TRANSLATOR_KEY, GOOGLE_V3_KEY, GEMINI_API_KEY or the [ai] binding.' };
  }
  const contentToken = await sha256Hex('direct|' + clean.text).then((h) => h.slice(0, 16));
  const jobId = 'direct:' + contentToken + (lang === DEFAULT_LANG ? '' : ':' + lang);

  // cached? (a re-cast of the same movie = zero quota)
  const existing = await getJob(env, jobId);
  if (existing && existing.status === 'done' && !o.fresh) return { job: existing, cached: true };

  await kvPut(env, 'entext:' + jobId, clean.text);
  await publishSrt(env, clean.text, { token: await deterministicToken('en', jobId), permanent: true });
  const enToken = await deterministicToken('en', jobId);
  const siToken = await deterministicToken('si', jobId);
  const batches = makeBatches(enCues.length);
  const job = {
    id: jobId, type: 'direct', imdb: null, season: 0, episode: 0, status: 'translating',
    source: 'ai', provider: chain[0], chain: chain.slice(), release: o.name || 'cast-subs',
    cues: enCues.length, siToken, enToken, done: 0, total: batches.length, providers: [],
    batchDone: batches.map(() => false), startedAt: Date.now(), createdAt: Date.now(), error: null,
    lang, register, quality: 'base-nmt', polishStatus: 'pending',
  };
  await putJob(env, job);
  await kvPut(env, 'subjob:' + siToken, jobId);
  await kvPut(env, 'subjob:' + enToken, jobId);
  const locked = await acquireLock(env, jobId);
  if (!locked) return { job };
  const started = resumeTranslationJob(env, jobId).finally(() => releaseLock(env, jobId)).catch(() => {});
  return { job, started };
}

export {
  PIPELINE_VERSION,
  jobIdOf, JOB_ID_RE, deterministicToken, getJob, putJob, kvGet, kvPut,
  acquireLock, releaseLock, heartbeatLock,
  cinemetaResolve, cinemetaMeta, flattenLikeAnantPlay, parseTsMs, buildPairedCues,
  makeBatches, runPool, ensureSubtitleJob, resumeTranslationJob, getPaired, jobForToken,
  translateDirectSub, translateBatchRobust, runCinemaPolish,
  langJobIdOf, parseLangOf, langJobIdOf as jobLangIdOf,
};
