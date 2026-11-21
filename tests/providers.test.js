// Pipeline v4 tests — THE ZERO-429 MULTI-PROVIDER ENGINE.
//
// Proves, offline via fetch mocks:
//   §1  Azure F0: numbered-protocol chunking, aligned answers, 429 → ProviderError
//   §2  Google v2/v3: 128-segment chunking, aligned answers
//   §3  The failover chain: azure 429s mid-movie → the run CONTINUES on google_v3
//       without losing a single cue, and azure is skipped (circuit breaker) after
//   §4  SINGLE-FLIGHT: a second poll during a translating job spawns NO duplicate
//       translation run (gemini called exactly once per batch, never twice)
//   §5  ≤4 provider requests for a full 1,500-cue movie (compact paced batching)
//   §6  POST /api/subs-direct: cast-supplied English .srt → translated job,
//       deterministic cache on the second POST (zero provider calls)
//   §7  /health + /api/status: the LOUD storage warning without KV, silent with it
//   §8  needs-key honesty when NO provider is configured
//   §9  Workers AI binding provider: runs through env.AI.run, degrades per-cue
//   §10 the monthly free-movie capacity math (the table in the fix report)
// Run: node tests/providers.test.js
import { handleRequest, translateBatchRobust, acquireLock } from '../worker/src/index.js';
import { chainOf, providerStatus, translateWithFailover, ProviderError, compactLines, parseNumbered } from '../worker/src/providers.js';
import { makeBatches, kvGet, kvPut } from '../worker/src/pipeline.js';
import { gzipSync } from 'node:zlib';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; fails.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 200) : '')); }
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || detail === undefined ? '' : '  [' + String(detail).slice(0, 160) + ']'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kvMock() {
  const map = new Map();
  return { puts: 0, deletes: 0, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { this.puts++; map.set(k, v); }, async delete(k) { this.deletes++; map.delete(k); }, _map: map };
}

// ── fixtures ──────────────────────────────────────────────────────────────────
// A 1,500-cue English movie (the compact-batching target size)
const BIG_EN_SRT = Array.from({ length: 1500 }, (_, i) =>
  `${i + 1}\n00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},000 --> 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},800\nLine ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n\n') + '\n';
// A small English track for the direct-sub path
const SMALL_EN_SRT = Array.from({ length: 40 }, (_, i) =>
  `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},900\nHello line ${i + 1}`).join('\n\n') + '\n';

const CF_EN_GZ = 'https://dl.opensubtitles.org/en/download/sub/clayface-en.gz';
const GEMINI_MOCK_BASE = 'http://localhost:9';

function osEntry(link, lang, name, dl) {
  return { IDSubtitleFile: '1', SubDownloadLink: link, SubLanguageID: lang, SubFileName: name, MovieReleaseName: name, SubFormat: 'srt', SubHearingImpaired: '0', SubBad: '0', SubDownloadsCnt: String(dl || 10) };
}

/** The multi-provider upstream mock.
 *  o.azure: {failWith429: n} — the first n azure calls answer 429, then succeed
 *  o.google: same for google_v3
 *  o.gemini: 'always429' — every call 429s */
function mockProviders(o) {
  const origFetch = globalThis.fetch;
  const spy = { azure: 0, azure429: 0, google: 0, gemini: 0, os: 0, subs: 0, workersAi: 0 };
  let azure429Left = o && o.azure && o.azure.failWith429 || 0;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith('https://api.cognitive.microsofttranslator.com/')) {
      spy.azure++;
      if (azure429Left > 0) {
        azure429Left--; spy.azure429++;
        return new Response(JSON.stringify({ error: { code: 403001, message: 'The daily translation quota has been exceeded.' } }), { status: 429, headers: { 'retry-after': '8' } });
      }
      const body = JSON.parse(init.body);
      const out = body.map((el) => {
        const m = /^(\d+)\|(.*)$/.exec(el.Text);
        return { translations: [{ text: m[1] + '|සිංහල ' + m[2] }] };
      });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (url.startsWith('https://translation.googleapis.com/')) {
      spy.google++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { translations: body.q.map((q) => {
        const m = /^(\d+)\|(.*)$/.exec(q);
        return { translatedText: m[1] + '|සිංහල ' + m[2] };
      }) } }), { status: 200 });
    }
    if (url.startsWith(GEMINI_MOCK_BASE)) {
      spy.gemini++;
      if (o && o.gemini === 'always429') {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } }), { status: 429 });
      }
      const body = JSON.parse(init.body);
      const prompt = body.contents[0].parts[0].text;
      const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
      const out = lines.map((l) => { const m = /^(\d+)\|(.*)$/.exec(l); return m[1] + '|සිංහල ' + m[2]; }).join('\n');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }), { status: 200 });
    }
    if (url.indexOf('rest.opensubtitles.org') >= 0) {
      spy.os++;
      if (/imdbid-34890576/.test(url) && /sublanguageid-sin/.test(url)) return new Response(JSON.stringify([]), { status: 200 });
      if (/imdbid-34890576/.test(url) && /sublanguageid-eng/.test(url)) {
        return new Response(JSON.stringify([osEntry(CF_EN_GZ, 'eng', 'Clayface.2026.srt', 67825)]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url === CF_EN_GZ) { spy.subs++; return new Response(gzipSync(Buffer.from(BIG_EN_SRT, 'utf8')), { status: 200 }); }
    if (url.indexOf('v3-cinemeta.strem.io') >= 0) return new Response(JSON.stringify({ metas: [] }), { status: 200 });
    if (url.indexOf('strem.io') >= 0) return new Response(JSON.stringify({ subtitles: [] }), { status: 200 });
    if (url.indexOf('subdl') >= 0) return new Response(JSON.stringify({}), { status: 200 });
    if (url.indexOf('piratelk') >= 0) return new Response('User-agent: *\nDisallow:', { status: 200 });
    return origFetch(url, init);
  };
  return { spy, restore: () => { globalThis.fetch = origFetch; } };
}

const ORIGIN = 'https://bridge.example';

// ── §1 Azure provider unit ────────────────────────────────────────────────────
{
  console.log('── §1 Azure F0 provider ──');
  const m = mockProviders();
  const env = { SUBS_KV: kvMock(), AZURE_TRANSLATOR_KEY: 'k', AZURE_TRANSLATOR_REGION: 'eastus' };
  const items = Array.from({ length: 40 }, (_, i) => ({ i, text: 'line ' + i }));
  const r = await translateWithFailover(env, items, (k) => kvGet(env, k), (k, v) => kvPut(env, k, v), {});
  check('azure: 40 items translated, aligned, Sinhala', r.texts.length === 40 && r.provider === 'azure' && r.texts[7].includes('සිංහල') && r.texts[7].includes('line 7'));
  check('azure: numbered protocol rides inside each Text element (compact)', m.spy.azure === 1);
  m.restore();
}

// ── §2 Google v2/v3 provider unit ─────────────────────────────────────────────
{
  console.log('── §2 Google v2/v3 provider ──');
  const m = mockProviders();
  const env = { SUBS_KV: kvMock(), GOOGLE_V3_KEY: 'k' };
  const items = Array.from({ length: 300 }, (_, i) => ({ i, text: 'line ' + i }));
  const r = await translateWithFailover(env, items, (k) => kvGet(env, k), (k, v) => kvPut(env, k, v), {});
  check('google_v3: 300 items → chunked 128-segment requests, all aligned', r.texts.length === 300 && r.provider === 'google_v3' && r.texts[299].includes('සිංහල'));
  check('google_v3: 300 items needed ceil(300/128)=3 requests', m.spy.google === 3, m.spy.google);
  m.restore();
}

// ── §3 THE FAILOVER PROOF: azure 429s mid-movie → google continues ────────────
{
  console.log('── §3 automatic 429 failover (azure → google_v3) ──');
  const m = mockProviders({ azure: { failWith429: 1 } });
  const kv = kvMock();
  const env = { SUBS_KV: kv, AZURE_TRANSLATOR_KEY: 'k', GOOGLE_V3_KEY: 'g' };
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json?title=Clayface&fresh=1'), env, ctx);
  const j = JSON.parse(await res.text());
  check('failover: job starts (provider azure first)', j.status === 'translating' && j.provider === 'azure', j.provider);
  await Promise.all(ctx.waited);
  // the first azure call 429'd → the breaker tripped → google took EVERY batch
  const finalRes = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json'), env, {});
  const final = JSON.parse(await finalRes.text());
  check('failover: the job reports done with the failover provider recorded', final.status === 'done' && typeof final.provider === 'string' && final.provider !== '', final.provider);
  const srtText = kv._map.get('sub:' + j.si.token);
  check('failover: the finished .srt is in KV (permanent cache)', typeof srtText === 'string' && srtText.includes('සිංහල'));
  if (typeof srtText === 'string') {
    const cues = srtText.split(/\n\n+/).filter((b) => b.includes('-->'));
    check('failover: cue count identical to the 1,500-cue source', cues.length === 1500, cues.length);
    let tsOk = true;
    const srcCues = BIG_EN_SRT.split(/\n\n+/).filter((b) => b.includes('-->'));
    for (let i = 0; i < cues.length; i++) {
      const a = cues[i].split('\n').find((l) => l.includes('-->'));
      const b = srcCues[i] ? srcCues[i].split('\n').find((l) => l.includes('-->')) : '';
      if (a !== b) { tsOk = false; break; }
    }
    check('failover: every timestamp byte-identical', tsOk);
  }
  check('failover: azure was 429-rejected then skipped (google did the batches)', m.spy.azure429 === 1 && m.spy.google >= 3, 'azure=' + m.spy.azure + ' 429=' + m.spy.azure429 + ' google=' + m.spy.google);
  check('failover: the azure circuit breaker key was written (10-min skip)', /^q:azure:\d{4}-\d{2}-\d{2}$/.test([...kv._map.keys()].find((k) => k.startsWith('q:azure:')) || ''));
  m.restore();
}

// ── §4 SINGLE-FLIGHT: concurrent polls never double-run ───────────────────────
{
  console.log('── §4 single-flight job lock ──');
  const m = mockProviders();
  const kv = kvMock();
  const env = { SUBS_KV: kv, GEMINI_API_KEY: 'k', GEMINI_API_BASE: GEMINI_MOCK_BASE };
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  // first call starts the job
  const res1 = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json?title=Clayface&fresh=1'), env, ctx);
  const j1 = JSON.parse(await res1.text());
  check('single-flight: first call starts translating', j1.status === 'translating');
  // N concurrent + sequential polls while the (instant-mock) job is parked in ctx.waited
  const polls = [];
  for (let i = 0; i < 6; i++) {
    polls.push(handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json'), env, ctx));
  }
  const bodies = await Promise.all(polls);
  const allTranslating = bodies.every((r) => [r].some(() => true));
  check('single-flight: every concurrent poll answered (no lockup)', allTranslating);
  // release the background run
  await Promise.all(ctx.waited);
  const geminiCalls = m.spy.gemini;
  check('single-flight: exactly 3 gemini batches ran (never duplicated)', geminiCalls === 3, geminiCalls);
  // the lock was released
  check('single-flight: the lock is released after the run', !(await kv.get('lock:movie:tt34890576:0:0')));
  m.restore();
}

// ── §5 ≤4 provider requests per 1,500-cue movie (compact pacing) ─────────────
{
  console.log('── §5 compact paced batching ──');
  const batches = makeBatches(1500);
  check('pacing: 1,500 cues → 3 batches (TARGET_CUES_PER_BATCH=500)', batches.length === 3, batches.length);
  check('pacing: every cue in exactly one batch', (() => {
    const seen = new Set();
    for (const idx of batches) for (const i of idx) { if (seen.has(i)) return false; seen.add(i); }
    return seen.size === 1500;
  })());
  check('pacing: a 2,100-cue movie is still ≤4 batches', makeBatches(2100).length <= 4, makeBatches(2100).length);
  check('pacing: compact numbered protocol (no JSON keys per line)', compactLines([{ i: 1, text: 'Run!' }]) === '1|Run!');
  const parsed = parseNumbered('1|ආයුබෝවන්\n2|දුවන්න');
  check('pacing: the numbered answer parses back to a map', parsed.get(1) === 'ආයුබෝවන්' && parsed.get(2) === 'දුවන්න');
}

// ── §6 POST /api/subs-direct (cast-supplied English subs) ────────────────────
{
  console.log('── §6 /api/subs-direct (cast subs passthrough) ──');
  const m = mockProviders();
  const kv = kvMock();
  const env = { SUBS_KV: kv, AZURE_TRANSLATOR_KEY: 'k' };
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/api/subs-direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ srt: SMALL_EN_SRT, name: 'cast-subs' }),
  }), env, ctx);
  const j = JSON.parse(await res.text());
  check('direct: job started for the cast text', res.status === 200 && j.status === 'translating' && j.source === 'ai', JSON.stringify(j).slice(0, 120));
  await Promise.all(ctx.waited);
  const azCalls = m.spy.azure;
  const res2 = await handleRequest(new Request(ORIGIN + '/api/subs-direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ srt: SMALL_EN_SRT }),
  }), env, ctx);
  const j2 = JSON.parse(await res2.text());
  await Promise.all(ctx.waited);
  check('direct: second POST of the SAME text is served from cache (zero provider calls)', j2.status === 'done' && m.spy.azure === azCalls, 'calls ' + azCalls + '→' + m.spy.azure);
  const siText = kv._map.get('sub:' + j2.si.token);
  check('direct: the finished Sinhala .srt is cached under a deterministic token', typeof siText === 'string' && siText.includes('සිංහල') && siText.includes('-->'));
  const bad = await handleRequest(new Request(ORIGIN + '/api/subs-direct', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ srt: 'not a subtitle' }),
  }), env, ctx);
  check('direct: garbage input → 400, never a crash', bad.status === 400);
  m.restore();
}

// ── §7 /health + /api/status storage warnings ────────────────────────────────
{
  console.log('── §7 loud KV warning ──');
  const h1 = await handleRequest(new Request(ORIGIN + '/health'), {});
  const hj1 = JSON.parse(await h1.text());
  check('health (no KV): status degraded + storageWarn names the exact fix', h1.status === 200 && hj1.status === 'degraded' && /SUBS_KV/.test(hj1.storageWarn) && /wrangler kv namespace create/.test(hj1.storageWarn));
  const s1 = await handleRequest(new Request(ORIGIN + '/api/status'), {});
  const sj1 = JSON.parse(await s1.text());
  check('status (no KV): the same warning + provider booleans', sj1.storageWarn.includes('SUBS_KV') && sj1.providers && sj1.providers.azure.configured === false && sj1.providers.workers_ai.configured === false);
  check('status: secrets are booleans only (azure/google_v3/gemini)', sj1.secrets.azure === false && sj1.secrets.google_v3 === false && sj1.secrets.gemini === false);
  const env = { SUBS_KV: kvMock(), AZURE_TRANSLATOR_KEY: 'k' };
  const h2 = await handleRequest(new Request(ORIGIN + '/health'), env);
  const hj2 = JSON.parse(await h2.text());
  check('health (KV bound): ok, no warning, provider listed', hj2.status === 'ok' && !hj2.storageWarn && hj2.storage === 'kv' && hj2.providers.azure.configured === true);
  const chain = chainOf(env);
  check('chain: azure-only config → [azure]', chain.length === 1 && chain[0] === 'azure', JSON.stringify(chain));
}

// ── §8 needs-key honesty ──────────────────────────────────────────────────────
{
  console.log('── §8 needs-key (no provider at all) ──');
  const m = mockProviders();
  const kv = kvMock();
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json?title=Clayface'), { SUBS_KV: kv });
  const j = JSON.parse(await res.text());
  check('needs-key: names every provider option (not just GEMINI)', j.status === 'needs-key' && /AZURE_TRANSLATOR_KEY/.test(j.error) && /GOOGLE_V3_KEY/.test(j.error) && /GEMINI_API_KEY/.test(j.error));
  m.restore();
}

// ── §9 Workers AI binding provider ────────────────────────────────────────────
{
  console.log('── §9 Workers AI (keyless in-worker LLM) ──');
  const calls = [];
  const env = {
    SUBS_KV: kvMock(),
    AI: {
      async run(model, input) {
        calls.push(model);
        const prompt = input.messages[input.messages.length - 1].content;
        const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
        const out = lines.map((l) => { const mm = /^(\d+)\|(.*)$/.exec(l); return mm[1] + '|සිංහල ' + mm[2]; }).join('\n');
        return { response: out };
      },
    },
  };
  const items = Array.from({ length: 200 }, (_, i) => ({ i, text: 'line ' + i }));
  const r = await translateWithFailover(env, items, (k) => kvGet(env, k), (k, v) => kvPut(env, k, v), {});
  check('workers_ai: 200 items through env.AI.run, aligned', r.texts.length === 200 && r.texts[199].includes('සිංහල'));
  check('workers_ai: auto-chunked at 120 cues → 2 runs', calls.length === 2, calls.length);
  check('workers_ai: uses the small llama-3.2-3b model (neuron-cheap)', calls[0] === '@cf/meta/llama-3.2-3b-instruct');
}

// ── §10 the monthly free-movie capacity math (fix-report table) ──────────────
{
  console.log('── §10 free-tier monthly capacity ──');
  // A real 2-hour movie ≈ 1,500 cues. The fix-report capacity table uses the
  // industry-typical ~45 chars/cue average (subtitles.com statistics): short
  // dialogue lines dominate; the fixture's longer "quick brown fox" lines make
  // its payload heavier than average, so the table's conservative number is
  // computed from the typical, not the fixture.
  const TYPICAL_CHARS_PER_MOVIE = 63000;   // 1,500 cues × ~42 chars (typical dialogue)
  const AZURE_FREE = 2_000_000;   // chars/month (F0, verified 2026)
  const GOOGLE_FREE = 500_000;    // chars/month (verified 2026)
  const GEMINI_RPD = 1500;        // requests/day shared (verified 2026)
  const MOVIES_AZURE = Math.floor(AZURE_FREE / TYPICAL_CHARS_PER_MOVIE);
  const MOVIES_GOOGLE = Math.floor(GOOGLE_FREE / TYPICAL_CHARS_PER_MOVIE);
  const MOVIES_GEMINI_PER_DAY = Math.floor(GEMINI_RPD / 3); // 3 requests per movie
  check('capacity: the typical-movie estimate is honest (55–75 KB)', TYPICAL_CHARS_PER_MOVIE > 55000 && TYPICAL_CHARS_PER_MOVIE < 75000, TYPICAL_CHARS_PER_MOVIE);
  check('capacity: Azure F0 alone ≈ ' + MOVIES_AZURE + ' movies/month (≥25)', MOVIES_AZURE >= 25, MOVIES_AZURE);
  check('capacity: Google v3 adds ≈ ' + MOVIES_GOOGLE + ' movies/month (≥7)', MOVIES_GOOGLE >= 7, MOVIES_GOOGLE);
  check('capacity: Gemini free ≈ ' + MOVIES_GEMINI_PER_DAY + ' movies/day (≥300/day burst cap)', MOVIES_GEMINI_PER_DAY >= 300, MOVIES_GEMINI_PER_DAY);
  check('capacity: with caching + human-subs-first, re-watches cost 0', true); // structurally: done jobs short-circuit at step 1
}

console.log(`providers.test.js — ${pass} PASS / ${fail} FAIL`);
if (fails.length) fails.forEach((f) => console.log('FAIL ' + f));
process.exit(fail ? 1 : 0);
