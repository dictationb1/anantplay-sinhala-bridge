/* AnantPlay Sinhala Subtitle Bridge — Cloudflare Worker v4 (zero-fork edition).
 *
 * ── v4 (this upgrade) — multi-provider zero-429 engine ────────────────────────
 *   GET /api/resolve?title=Clayface[&type=movie|series][&season=&episode=]
 *        → IMDb id + clean title/year via Cinemeta (same service official AnantPlay uses).
 *   GET /subtitles/:type/:id.json[?season=&episode=&title=&fresh=1]
 *        → human Sinhala first (OpenSubtitles sin / SubDL si), else a multi-provider
 *          AI translation job: azure → google_v3 → gemini → workers_ai, automatic
 *          429 failover + KV circuit breakers + single-flight job locks.
 *   POST /api/subs-direct  {srt: "<full English .srt text>", name?}
 *        → NEW v4: translate a cast-supplied English subtitle directly (AnantPlay's
 *          own `subs` extra / a side-loaded file). Same deterministic cache: the
 *          same text is translated once, forever.
 *   GET /api/paired/:jobId.json
 *        → compact {i,t0,t1,en,enf,si} cue array — the Player's <10 ms cue-lock data.
 *   GET /sub/<token>.srt — real HTTP 200 UTF-8 SRT; 202 {status,progress,eta_sec}
 *        while a job's Sinhala file is still translating (deterministic token).
 *   GET /api/status — storage mode + which provider secrets are configured
 *        (booleans only) + a LOUD warning when KV is missing.
 *   GET /health — liveness + storage warning (the app's Self-Test surfaces it).
 *
 * ── kept from v2.1/v3 (all tests preserved) ──────────────────────────────────
 *   Real HTTP 200 .srt URLs (/sub/<token>.srt); /api/search + /api/fetch-sub
 *   server-side with real User-Agent, gunzip/unzip (zip-bomb guard, __MACOSX/
 *   skipped, .. traversal rejected), BOM-less UTF-8 publish; strict subtitle-
 *   provider allowlist re-validated on every redirect hop; credentials/ports/
 *   IP-literals/private hosts rejected; 5 MB upstream + decompression caps.
 *
 * Storage: KV when bound (STRONGLY recommended: 100,000 reads + 1,000 writes
 * per day free forever — the permanent translation cache + job resume store).
 * Without KV the worker degrades to the Cache API + per-isolate Map and says
 * so LOUDLY in /health and /api/status (storageWarn) — jobs vanish on isolate
 * restarts and that must never be a mystery again.
 */

import {
  MAX_B64_CHARS, MAX_UNCOMPRESSED_BYTES, MAX_PUBLISH_BYTES,
  sha256Hex, isValidToken, toCleanSrt, parseSrtCues, reassembleSrt, hasStorage,
  publishSrt, getSrt, isGzip, isZip, zipEntries, pickBestEntry, entryRank,
  isSubtitleEntry, unzipBest, decompressAny, openSubsSearch, stremioOsSearch, subdlSearch,
  pirateLkSearch, fetchUpstreamSub, assertSafeUpstreamUrl, isPrivateHost, hostAllowed,
  safeFetchBytes, readStreamCapped, b64ToBytes, json, SRT_HEADERS, limits,
} from './lib.js';

import {
  PIPELINE_VERSION, JOB_ID_RE, jobIdOf,
  cinemetaResolve, cinemetaMeta, flattenLikeAnantPlay, parseTsMs, buildPairedCues,
  makeBatches, ensureSubtitleJob, resumeTranslationJob, getPaired, jobForToken,
  translateDirectSub, translateBatchRobust as pipelineTranslateBatchRobust,
  getJob, kvGet, kvPut, deterministicToken, acquireLock,
} from './pipeline.js';
import { LANGUAGES, CHIP_LANGS, DEFAULT_LANG } from './languages.js';

import { chainOf, providerStatus, DEFAULT_CHAIN, geminiTranslateCues, paConfigured } from './providers.js';

/** v3 API compat shim: the old tests call geminiTranslateBatch(env, key, model, items).
 *  v4 routes the same call through the provider with the key injected into env. */
async function geminiTranslateBatch(env, key, model, items) {
  const env2 = { ...env, GEMINI_API_KEY: key };
  return geminiTranslateCues(env2, { model: model || undefined }, items);
}

/** v3 API compat shim: translateBatchRobust(env, key, model, items) → v4
 *  (env, items, cfg). Detects the legacy form by its string second argument.
 *  The legacy callers expect a String[] (v4 returns {texts, provider}). */
async function translateBatchRobust(env, a, b, c) {
  if (typeof a === 'string' && Array.isArray(c)) {
    const r = await pipelineTranslateBatchRobust({ ...env, GEMINI_API_KEY: a }, c, { model: b || undefined });
    return r.texts;
  }
  return pipelineTranslateBatchRobust(env, a, b);
}

export {
  // lib (v2.1 exports kept — every existing test keeps passing unchanged)
  sha256Hex, toCleanSrt, parseSrtCues, reassembleSrt, isGzip, isZip, zipEntries,
  pickBestEntry, entryRank, isSubtitleEntry, unzipBest, decompressAny, publishSrt,
  getSrt, hasStorage, isValidToken, openSubsSearch, stremioOsSearch, subdlSearch, pirateLkSearch,
  fetchUpstreamSub, assertSafeUpstreamUrl, isPrivateHost, hostAllowed, safeFetchBytes,
  readStreamCapped, limits, catalogRoutes,
  // v4 pipeline (functions only — workerd rejects exported constants)
  cinemetaResolve, cinemetaMeta, flattenLikeAnantPlay, parseTsMs, buildPairedCues,
  makeBatches, ensureSubtitleJob, resumeTranslationJob, getPaired, jobForToken,
  translateDirectSub, getJob, kvGet, kvPut, deterministicToken, jobIdOf, handleRequest,
  acquireLock, providerStatus, chainOf, geminiTranslateCues, geminiTranslateBatch,
  translateBatchRobust,
};

/** The storage warning string — the SAME text in /health and /api/status so the
 *  app's Self-Test and the user's browser both see it. Empty when KV is bound. */
function storageWarn(env) {
  if (env && env.SUBS_KV) return '';
  return '⚠ storage=cache+memory: SUBS_KV is NOT bound. Translation jobs live only inside one isolate — they VANISH on restart (token cold / isolate miss) and finished subs are per-colo 24h only. Fix (free forever): npx wrangler kv namespace create SUBS_KV → paste the id into wrangler.toml [[kv_namespaces]] → npx wrangler deploy';
}

/** The dynamic index/sites/deeplinks JSONs — generated from the LIVE host, so there is
 * never a placeholder YOUR-HOST to forget. Shapes verified against AnantPlay v2.23.1. */
function catalogRoutes(url) {
  const origin = url.origin;
  const host = String(url.hostname || '').replace(/^www\./, '');
  const site = { name: 'Sinhala Subtitle Bridge', url: origin + '/', index: true, tags: ['Subtitles', 'Sinhala'], group: 'More' };
  const source = {
    id: origin,
    name: 'Sinhala Subtitle Bridge',
    description: 'Sinhala subtitles for any stream: search, machine-translate (EN→SI) or upload, then hand the real .srt URL to AnantPlay.',
    type: 'sites',
    url: origin + '/sites.json',
  };
  const deeplinkSource = {
    id: origin + '/deeplinks',
    name: 'Sinhala Subtitle Bridge (deeplinks)',
    description: 'Auto-fill movie/tv/episode picks from AnantPlay Title Links.',
    type: 'deeplinks',
    url: origin + '/deeplinks.json',
  };
  return {
    '/index.json': { name: 'Sinhala Subtitle Bridge', sources: [source, deeplinkSource] },
    '/sites.json': {
      rows: { more: [site] },
      languages: { 'Sinhala': [{ ...site }] },
    },
    '/deeplinks.json': {
      [host]: {
        movie: origin + '/?type=movie&tmdb={tmdb}&imdb={imdb}',
        tv: origin + '/?type=tv&tmdb={tmdb}&imdb={imdb}',
        episode: origin + '/?type=tv&tmdb={tmdb}&imdb={imdb}&s={season}&e={episode}',
      },
    },
  };
}

/** Shape the pipeline result into the /subtitles/:type/:id.json body (Stremio-addon
 * compatible `subtitles` array included, so the bridge can also be added as a plain
 * subtitle source for any Stremio-shaped client). */
function subtitleJobBody(origin, job) {
  const base = {
    ok: true, jobId: job.id, type: job.type, imdb: job.imdb, season: job.season, episode: job.episode,
    status: job.status, source: job.source || null, cues: job.cues || 0,
    provider: job.provider || null,
    // v4.1: the target language + two-stage delivery state
    lang: job.lang || 'si',
    quality: job.quality || (job.status === 'done' ? (job.source === 'human' ? 'human' : 'base-nmt') : null),
    polishStatus: job.polishStatus || (job.status === 'done' ? 'off' : null),
  };
  if (job.status === 'done') {
    base.si = { url: origin + '/sub/' + job.siToken + '.srt', token: job.siToken, lang: 'sin' };
    base.en = job.enToken ? { url: origin + '/sub/' + job.enToken + '.srt', token: job.enToken, lang: 'eng' } : null;
    base.paired = '/api/paired/' + job.id + '.json';
    base.subtitles = [{ id: job.id + ':sin', url: base.si.url, lang: 'sin' }];
    if (base.en) base.subtitles.push({ id: job.id + ':eng', url: base.en.url, lang: 'eng' });
    return base;
  }
  if (job.status === 'translating') {
    const done = job.done || 0, total = job.total || 1;
    const eta = job.startedAt && done > 0 ? Math.max(1, Math.round(((Date.now() - job.startedAt) / done) * (total - done) / 1000)) : null;
    base.progress = +(done / total).toFixed(3);
    base.done = done;
    base.total = total;
    base.eta_sec = eta;
    base.si = { url: origin + '/sub/' + job.siToken + '.srt', token: job.siToken, lang: 'sin' }; // deterministic: 202 until done
    base.en = job.enToken ? { url: origin + '/sub/' + job.enToken + '.srt', token: job.enToken, lang: 'eng' } : null;
    base.paired = '/api/paired/' + job.id + '.json';
    base.subtitles = []; // Stremio clients expect an empty list, not an error
    return base;
  }
  base.ok = false;
  base.error = job.error || 'job failed';
  base.subtitles = [];
  return base;
}

/** the fetch handler (exported; also the entry point of the deployed worker) */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;

  // CORS preflight for the API routes
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-SubDL-Key, X-Gemini-Key, X-Gemini-Model',
        'Access-Control-Expose-Headers': 'X-Sub-Quality, X-Polish-Status, X-Sub-Lang',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // ── liveness + status (v4: the loud KV warning lives in BOTH) ──
  if (p === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    const warn = storageWarn(env);
    return json({
      ok: true, status: warn ? 'degraded' : 'ok', version: PIPELINE_VERSION,
      storage: env && env.SUBS_KV ? 'kv' : 'cache+memory',
      storageWarn: warn || undefined,
      providers: providerStatus(env),
      // v4.1: multi-language engine state
      languages: { count: Object.keys(LANGUAGES).length, default: 'si', chips: CHIP_LANGS },
      chainSi: chainOf(env, 'si'),
      chainTa: chainOf(env, 'ta'),
      translatePa: paConfigured(env) ? 'enabled' : 'off',
    });
  }
  if (p === '/api/status' && request.method === 'GET') {
    const l = limits();
    const warn = storageWarn(env);
    return json({
      ok: true, version: PIPELINE_VERSION,
      storage: env && env.SUBS_KV ? 'kv' : 'cache+memory',
      storageWarn: warn || undefined,
      secrets: {
        azure: !!(env && env.AZURE_TRANSLATOR_KEY),
        google_v3: !!(env && env.GOOGLE_V3_KEY),
        gemini: !!(env && env.GEMINI_API_KEY),
        subdl: !!(env && env.SUBDL_API_KEY),
        workers_ai: !!(env && env.AI),
      },
      providers: providerStatus(env),
      translationChain: chainOf(env, 'si'),
      defaultChain: DEFAULT_CHAIN,
      limits: l,
      // v4.1: the registry + the per-language chains the player's picker uses
      languages: Object.keys(LANGUAGES).map((c) => ({ code: c, ...LANGUAGES[c] })),
      chainsByLang: Object.fromEntries(CHIP_LANGS.concat(['hi', 'zh-CN', 'ur']).map((c) => [c, chainOf(env, c)])),
      translatePa: { enabled: paConfigured(env), note: paConfigured(env) ? 'Layer-1 keyless NMT (failover-protected)' : 'set ENABLE_TRANSLATE_PA=true + TRANSLATE_PA_KEY to activate' },
      companion: { defaultWorkerUrl: 'https://anantplay-si-subs-bridge.techworldlk.workers.dev' },
    });
  }

  // ── the REAL subtitle delivery (the BUG #1 fix) ──
  const subMatch = /^\/sub\/([0-9a-f]{16})\.srt$/.exec(p);
  if (subMatch) {
    let text = null;
    try {
      text = await getSrt(env, subMatch[1]);
    } catch (e) {
      text = null;
    }
    if (text === null) {
      // a pipeline job token? → the deterministic 202-progress contract
      const job = await jobForToken(env, subMatch[1]);
      if (job && job.status === 'translating') {
        const done = job.done || 0, total = job.total || 1;
        const eta = job.startedAt && done > 0 ? Math.max(1, Math.round(((Date.now() - job.startedAt) / done) * (total - done) / 1000)) : null;
        return json({ status: 'translating', progress: +(done / total).toFixed(3), done, total, eta_sec: eta, provider: job.provider || null }, 202);
      }
      if (job && job.status === 'error') {
        return json({ status: 'error', error: job.error || 'job failed' }, 410);
      }
      return new Response('subtitle expired or not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }
    {
      // v4.1 two-stage headers: the player hot-swaps when quality flips to
      // cinema-polished (X-Polish-Status: pending → done)
      const job = await jobForToken(env, subMatch[1]).catch(() => null);
      const h = { ...SRT_HEADERS };
      if (job) {
        h['X-Sub-Quality'] = String(job.quality || (job.status === 'done' && job.source === 'human' ? 'human' : 'base-nmt'));
        h['X-Polish-Status'] = String(job.polishStatus || (job.status === 'done' ? 'off' : 'pending'));
        h['X-Sub-Lang'] = String(job.lang || 'si');
        h['Access-Control-Expose-Headers'] = 'X-Sub-Quality, X-Polish-Status, X-Sub-Lang';
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: h });
      return new Response(text, { status: 200, headers: h });
    }
  }

  // ── dynamic catalog JSONs (live-host generated) ──
  const cat = catalogRoutes(url);
  if (cat[p] && (request.method === 'GET' || request.method === 'HEAD')) return json(cat[p]);

  // ── Cinemeta resolve (title → IMDb; the Player's zero-typing path) ──
  if (p === '/api/resolve' && request.method === 'GET') {
    const imdbIn = String(url.searchParams.get('imdb') || '').trim();
    const type = url.searchParams.get('type') === 'series' ? 'series' : 'movie';
    const season = Math.max(0, Math.min(999, Number(url.searchParams.get('season') || 0) || 0));
    const episode = Math.max(0, Math.min(9999, Number(url.searchParams.get('episode') || 0) || 0));
    if (/^tt\d{4,10}$/.test(imdbIn)) {
      const meta = await cinemetaMeta(type, imdbIn, env).catch(() => ({ imdb: imdbIn, name: imdbIn, year: '' }));
      return json({ ok: true, type, imdb: imdbIn, name: meta.name, year: meta.year, season, episode });
    }
    const title = String(url.searchParams.get('title') || '').trim();
    if (title.length < 2) return json({ ok: false, error: 'give ?title=… (min 2 chars) or ?imdb=tt…' }, 400);
    const hit = await cinemetaResolve(title, type, env).catch(() => null);
    if (!hit) return json({ ok: false, error: 'no Cinemeta match for: ' + title.slice(0, 80) }, 404);
    return json({ ok: true, type, imdb: hit.imdb, name: hit.name, year: hit.year, season, episode });
  }

  // ── the Player's main endpoint (Stremio-addon shaped) ──
  const subsMatch = /^\/subtitles\/(movie|series)\/(tt\d{4,10})(?:\.json)?$/.exec(p);
  if (subsMatch && request.method === 'GET') {
    const r = await ensureSubtitleJob(env, ctx, {
      type: subsMatch[1],
      imdb: subsMatch[2],
      season: url.searchParams.get('season'),
      episode: url.searchParams.get('episode'),
      title: url.searchParams.get('title') || '',
      fresh: url.searchParams.get('fresh') === '1',
      subdlKey: request.headers.get('X-SubDL-Key') || '',
      lang: url.searchParams.get('lang') || 'si',          // v4.1: any registry language
      register: url.searchParams.get('register') || 'auto', // v4.1: auto|spoken|formal
      headers: request.headers,
    });
    if (r.badRequest) return json({ ok: false, error: r.badRequest }, 400);
    if (r.started && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(r.started);
    if (r.needsKey) return json({ ok: false, status: 'needs-key', error: r.needsKey, subtitles: [] });
    if (r.notFound) return json({ ok: false, status: 'not-found', error: r.error || 'no subtitle found', hints: r.hints || [], subtitles: [] });
    return json(subtitleJobBody(url.origin, r.job));
  }

  // ── NEW v4: translate a cast-supplied English .srt directly ──
  // The AnantPlay cast payload already carries `subs` URLs (and the stream may
  // hold its own text track). The player POSTs that text here; the worker
  // translates it through the same failover chain + permanent cache.
  if (p === '/api/subs-direct' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
    const srt = String(body && body.srt || '');
    if (!srt) return json({ ok: false, error: 'missing "srt" (the full English .srt text)' }, 400);
    if (srt.length > MAX_PUBLISH_BYTES) return json({ ok: false, error: 'srt too large (2 MB max)' }, 413);
    const r = await translateDirectSub(env, ctx, srt, {
      name: String(body.name || '').slice(0, 200),
      fresh: body.fresh === true,
      lang: String(body.lang || 'si'),
      register: String(body.register || 'auto'),
    });
    if (r.badRequest) return json({ ok: false, error: r.badRequest }, 400);
    if (r.needsKey) return json({ ok: false, status: 'needs-key', error: r.needsKey, subtitles: [] });
    if (r.started && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(r.started);
    return json(subtitleJobBody(url.origin, r.job));
  }

  // ── the <10 ms cue-lock payload ──
  const pairedMatch = /^\/api\/paired\/((?:movie|series):tt\d{4,10}:\d{1,4}:\d{1,5}(?::[a-z]{2}(?:-CN)?)?|direct:[0-9a-f]{16}(?::[a-z]{2}(?:-CN)?)?)(?:\.json)?$/.exec(p);
  if (pairedMatch && request.method === 'GET') {
    const jobId = pairedMatch[1];
    if (!JOB_ID_RE.test(jobId)) return json({ ok: false, error: 'bad job id' }, 400);
    const r = await getPaired(env, jobId);
    if (!r) return json({ ok: false, error: 'unknown job — request /subtitles/:type/:id.json first' }, 404);
    return json(r.body, r.status);
  }

  // ── API: search (server-side User-Agent) ──
  if (p === '/api/search' && request.method === 'GET') {
    const imdb = url.searchParams.get('imdb') || '';
    if (!/^tt\d{4,10}$/.test(imdb)) return json({ ok: false, error: 'bad imdb' }, 400);
    const season = Math.max(0, Math.min(999, Number(url.searchParams.get('season') || 0) || 0));
    const episode = Math.max(0, Math.min(9999, Number(url.searchParams.get('episode') || 0) || 0));
    const titleHint = String(url.searchParams.get('title') || '').slice(0, 200);
    const apiKey = request.headers.get('X-SubDL-Key') || String((env && env.SUBDL_API_KEY) || '');
    const failed = [];
    const settled = await Promise.all([
      openSubsSearch(imdb, season, episode, null, ['sin', 'eng'], env).catch(() => { failed.push('opensubtitles'); return []; }),
      subdlSearch(imdb, season, episode, null, apiKey).catch(() => { failed.push('subdl'); return []; }),
      pirateLkSearch(imdb, titleHint).catch(() => { failed.push('piratelk'); return []; }),
    ]);
    const results = [].concat(...settled).filter((r) => r && r.url);
    return json({ ok: true, imdb, season, episode, count: results.length, results, failed });
  }

  // ── API: fetch + extract + publish one upstream result (SSRF-guarded) ──
  if (p === '/api/fetch-sub' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
    const urlIn = String(body.url || '');
    let parsed;
    try {
      parsed = assertSafeUpstreamUrl(urlIn, { extraHosts: env && env.ALLOWED_SUB_HOSTS ? String(env.ALLOWED_SUB_HOSTS).split(',') : [] });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
    if (!hasStorage(env)) return json({ ok: false, error: 'no storage: bind SUBS_KV (wrangler kv namespace create SUBS_KV) or deploy to a zone with the Cache API' }, 503);
    try {
      const text = await fetchUpstreamSub(parsed.toString(), {
        allowHttp: false,
        extraHosts: env && env.ALLOWED_SUB_HOSTS ? String(env.ALLOWED_SUB_HOSTS).split(',') : [],
      });
      const pub = await publishSrt(env, text);
      return json({ ok: true, url: new URL(request.url).origin + pub.url, token: pub.token, bytes: text.length, cues: parseSrtCues(text).length });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 502);
    }
  }

  // ── API: publish a finished .srt (translation result, upload, or edited text) ──
  if (p === '/api/publish-srt' && request.method === 'POST') {
    const ctype = String(request.headers.get('content-type') || '');
    let source = null; // {text} or {bytes}
    try {
      if (ctype.indexOf('multipart/form-data') === 0) {
        const form = await request.formData();
        const f = form.get('file');
        if (!f || typeof f.arrayBuffer !== 'function') return json({ ok: false, error: 'no file field' }, 400);
        if (typeof f.size === 'number' && f.size > MAX_PUBLISH_BYTES * 2) return json({ ok: false, error: 'upload too large (2 MB max)' }, 413);
        source = { bytes: new Uint8Array(await f.arrayBuffer()) };
      } else {
        let body;
        try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
        if (typeof body.b64 === 'string' && body.b64) {
          if (body.b64.length > MAX_B64_CHARS) return json({ ok: false, error: 'upload too large (2 MB max)' }, 413);
          try {
            source = { bytes: b64ToBytes(body.b64) };
          } catch (e) {
            return json({ ok: false, error: 'bad base64' }, 400);
          }
        } else if (typeof body.text === 'string') {
          source = { text: body.text };
        }
      }
    } catch (e) {
      return json({ ok: false, error: 'bad request' }, 400);
    }

    if (!source) return json({ ok: false, error: 'empty subtitle' }, 400);
    let clean;
    try {
      if (source.text !== undefined) {
        if (new TextEncoder().encode(source.text).length > MAX_UNCOMPRESSED_BYTES) return json({ ok: false, error: 'subtitle too large' }, 413);
        clean = toCleanSrt(source.text);
      } else {
        if (source.bytes.length > MAX_UNCOMPRESSED_BYTES) return json({ ok: false, error: 'upload too large (5 MB max)' }, 413);
        clean = toCleanSrt(new TextDecoder('utf-8', { fatal: false }).decode((await decompressAny(source.bytes)).bytes));
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      return json({ ok: false, error: msg }, /too large/i.test(msg) ? 413 : 400);
    }
    if (!hasStorage(env)) return json({ ok: false, error: 'no storage: bind SUBS_KV (wrangler kv namespace create SUBS_KV) or deploy to a zone with the Cache API' }, 503);
    const pub = await publishSrt(env, clean.text);
    return json({ ok: true, url: new URL(request.url).origin + pub.url, token: pub.token, bytes: clean.text.length, cues: parseSrtCues(clean.text).length });
  }

  // ── static Bridge UI (assets served by the worker — no second host) ──
  const staticMap = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/style.css': 'style.css',
    '/app.js': 'app.js',
  };
  if (staticMap[p]) {
    const asset = env && env.ASSETS ? await env.ASSETS.fetch(new URL(staticMap[p], url.origin)) : null;
    if (asset && asset.status === 200) return asset;
    return new Response('bridge UI asset ' + staticMap[p] + ' — deploy with [assets] directory = "./bridge-ui/public" or run local-server/server.py', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// worker entry point (wrangler) + test exports (node)
export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
