// Pipeline v3 tests — Cinemeta resolve, human-Sinhala path (Dark Knight), the full
// Clayface EN→SI Gemini translation job (mocked Gemini), the 202-progress contract,
// the /api/paired cue-lock payload, and the validator. All offline via fetch mocks.
// Run: node tests/pipeline.test.js
import {
  handleRequest, ensureSubtitleJob, makeBatches, flattenLikeAnantPlay, parseTsMs,
  parseSrtCues, buildPairedCues, geminiTranslateBatch, translateBatchRobust,
  jobIdOf, toCleanSrt, reassembleSrt,
} from '../worker/src/index.js';
import { JOB_ID_RE } from '../worker/src/pipeline.js';
import { gzipSync } from 'node:zlib';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 160) : '')); }
}

function kvMock() {
  const map = new Map();
  return { puts: 0, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { this.puts++; map.set(k, v); }, _map: map };
}

// ── fixtures ──────────────────────────────────────────────────────────────────
// A human Sinhala track (Dark Knight / ChameE shape) with 10 cues
const DK_SI_SRT = Array.from({ length: 10 }, (_, i) =>
  `${i + 1}\n00:0${i}:01,000 --> 00:0${i}:04,000\nචැමී පේළිය ${i + 1}\n`).join('\n') + '\n';
// An English-only track (Clayface / OnlyFlix shape) with 100 cues, multi-line + speaker dashes
const CF_EN_SRT = Array.from({ length: 100 }, (_, i) =>
  `${i + 1}\n00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},500 --> 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},900\n`
  + (i % 3 === 0 ? `- Hello there.\n- General Kenobi! (line ${i + 1})` : `Clayface speaks line ${i + 1}\nwith a second row`)).join('\n\n') + '\n';

const DK_SI_GZ = 'https://dl.opensubtitles.org/en/download/sub/darkknight-si.gz';
const CF_EN_GZ = 'https://dl.opensubtitles.org/en/download/sub/clayface-en.gz';
const GEMINI_MOCK_BASE = 'http://localhost:9'; // loopback override allowed for tests/lab

function osEntry(link, lang, name, dl) {
  return { IDSubtitleFile: '1', SubDownloadLink: link, SubLanguageID: lang, SubFileName: name, MovieReleaseName: name, SubFormat: 'srt', SubHearingImpaired: '0', SubBad: '0', SubDownloadsCnt: String(dl || 10) };
}

/** A mock Gemini: returns every input line prefixed with Sinhala script. */
function geminiOkBody(prompt) {
  const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
  const out = lines.map((l) => {
    const m = /^(\d+)\|(.*)$/.exec(l);
    return m[1] + '|සිංහල පරිවර්තනය ' + m[2];
  }).join('\n');
  return { candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] };
}

/** Install the upstream mocks; returns a spy with call counters. */
function mockUpstreams(opts) {
  const o = opts || {};
  const origFetch = globalThis.fetch;
  const spy = { gemini: 0, os: 0, subs: 0, cinemeta: 0 };
  let geminiGate = null; // when set, gemini answers wait on this promise
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith(GEMINI_MOCK_BASE)) {
      spy.gemini++;
      const body = JSON.parse(init.body);
      const prompt = body.contents[0].parts[0].text;
      if (geminiGate) await geminiGate;
      if (o.geminiBehavior === 'drop-half') {
        const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
        const out = lines.slice(0, Math.ceil(lines.length / 2)).map((l) => {
          const m = /^(\d+)\|(.*)$/.exec(l);
          return m[1] + '|සිංහල ' + m[2];
        }).join('\n');
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }), { status: 200 });
      }
      if (o.geminiBehavior === 'english') {
        const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: lines.map((l) => l.replace('|', '|kept english ')).join('\n') }] }, finishReason: 'STOP' }] }), { status: 200 });
      }
      if (o.geminiBehavior === 'max-tokens') {
        const lines = prompt.split('\n').filter((l) => /^\d+\|/.test(l));
        // a real model fits small batches: only pretend to hit the output limit on big ones
        const kept = lines.length > 10 ? lines.slice(0, 2) : lines;
        const out = kept.map((l) => {
          const m = /^(\d+)\|(.*)$/.exec(l);
          return m[1] + '|සිංහල ' + m[2];
        }).join('\n');
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: kept.length < lines.length ? 'MAX_TOKENS' : 'STOP' }] }), { status: 200 });
      }
      return new Response(JSON.stringify(geminiOkBody(prompt)), { status: 200 });
    }
    if (url.indexOf('rest.opensubtitles.org') >= 0) {
      spy.os++;
      if (/imdbid-0468569/.test(url) && /sublanguageid-sin/.test(url)) {
        return new Response(JSON.stringify([osEntry(DK_SI_GZ, 'sin', 'The.Dark.Knight.2008.480p.BRRip-ChameE.srt', 5000)]), { status: 200 });
      }
      if (/imdbid-34890576/.test(url) && /sublanguageid-sin/.test(url)) {
        return new Response(JSON.stringify([]), { status: 200 }); // NO Sinhala for Clayface
      }
      if (/imdbid-34890576/.test(url) && /sublanguageid-eng/.test(url)) {
        return new Response(JSON.stringify([
          osEntry(CF_EN_GZ, 'eng', 'Clayface.2026.CAM-Rip-OnlyFlix.1080p.srt', 67825),
          osEntry('https://dl.opensubtitles.org/en/download/sub/clayface-other.gz', 'eng', 'Clayface.Other.srt', 10),
        ]), { status: 200 });
      }
      if (/imdbid-0903747/.test(url) && /sublanguageid-sin/.test(url)) {
        return new Response(JSON.stringify([osEntry(DK_SI_GZ, 'sin', 'Breaking.Bad.s01e02.srt', 4000)]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url === DK_SI_GZ) { spy.subs++; return new Response(gzipSync(Buffer.from(DK_SI_SRT, 'utf8')), { status: 200 }); }
    if (url === CF_EN_GZ) { spy.subs++; return new Response(gzipSync(Buffer.from(CF_EN_SRT, 'utf8')), { status: 200 }); }
    if (url.indexOf('v3-cinemeta.strem.io') >= 0) {
      spy.cinemeta++;
      if (url.indexOf('search=Clayface') >= 0) {
        return new Response(JSON.stringify({ metas: [{ id: 'tt34890576', imdb_id: 'tt34890576', type: 'movie', name: 'Clayface', releaseInfo: '2026' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ metas: [] }), { status: 200 });
    }
    if (url.indexOf('opensubtitles-v3.strem.io') >= 0 || url.indexOf('subs5.strem.io') >= 0 || url.indexOf('strem.io') >= 0) {
      return new Response(JSON.stringify({ subtitles: [] }), { status: 200 }); // no addon sample in the default mock
    }
    if (url.indexOf('subdl') >= 0) return new Response(JSON.stringify({}), { status: 200 });
    if (url.indexOf('piratelk') >= 0) return new Response('User-agent: *\nDisallow:', { status: 200 });
    return origFetch(url, init);
  };
  return {
    spy,
    restore: () => { globalThis.fetch = origFetch; },
    gate: (p) => { geminiGate = p; },
  };
}

const ORIGIN = 'https://bridge.example';

// ── 1. unit: batcher, flattening, timestamps, job ids ────────────────────────
{
  check('makeBatches: 2000 cues → 4-6 batches', (() => { const b = makeBatches(2000); return b.length >= 4 && b.length <= 6; })(), makeBatches(2000).length);
  check('makeBatches: 5200 cues → 6 batches max', makeBatches(5200).length <= 6, makeBatches(5200).length);
  check('makeBatches: every cue in exactly one batch', (() => {
    const b = makeBatches(1234); const seen = new Set();
    for (const idx of b) for (const i of idx) { if (seen.has(i)) return false; seen.add(i); }
    return seen.size === 1234;
  })());
  check('makeBatches is deterministic (resume-safe)', JSON.stringify(makeBatches(999)) === JSON.stringify(makeBatches(999)));
  check('flattenLikeAnantPlay: inner \\n → space', flattenLikeAnantPlay('one\ntwo') === 'one two');
  check('flattenLikeAnantPlay: speaker dash kept', flattenLikeAnantPlay('- me\n- you') === '- me\n- you');
  check('flattenLikeAnantPlay: en-dash kept', flattenLikeAnantPlay('a\n– b') === 'a\n– b');
  check('parseTsMs: comma ms', JSON.stringify(parseTsMs('00:00:01,000 --> 00:00:03,500')) === '{"t0":1000,"t1":3500}');
  check('parseTsMs: dot + short fraction', parseTsMs('01:02:03.5 --> 01:02:04,25').t0 === 3723500 && parseTsMs('01:02:03.5 --> 01:02:04,25').t1 === 3724250);
  check('jobIdOf shape', jobIdOf('movie', 'tt34890576', 0, 0) === 'movie:tt34890576:0:0');
  check('JOB_ID_RE rejects traversal junk', !JOB_ID_RE.test('movie:../../etc:0:0') && !JOB_ID_RE.test('movie:tt1:0:0;drop'));
  check('JOB_ID_RE accepts series episode', JOB_ID_RE.test('series:tt0903747:1:2'));
}

// ── 2. /api/resolve (Cinemeta, mocked) ───────────────────────────────────────
{
  const m = mockUpstreams();
  const res = await handleRequest(new Request(ORIGIN + '/api/resolve?title=Clayface&type=movie'), {});
  const j = JSON.parse(await res.text());
  check('resolve: Clayface → tt34890576', res.status === 200 && j.ok === true && j.imdb === 'tt34890576', JSON.stringify(j));
  check('resolve: clean name + year', j.name === 'Clayface' && j.year === '2026', JSON.stringify(j));
  const bad = await handleRequest(new Request(ORIGIN + '/api/resolve'), {});
  check('resolve: no title → 400', bad.status === 400, bad.status);
  const imdb = await handleRequest(new Request(ORIGIN + '/api/resolve?imdb=tt0468569'), {});
  check('resolve: imdb passthrough ok', imdb.status === 200 && (await imdb.json()).imdb === 'tt0468569');
  m.restore();
}

// ── 3. The Dark Knight: human Sinhala (ChameE) found, published, paired ──────
{
  const m = mockUpstreams();
  const kv = kvMock();
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt0468569.json?title=Dark+Knight'), { SUBS_KV: kv }, ctx);
  const j = JSON.parse(await res.text());
  check('dark knight: done via human source', res.status === 200 && j.status === 'done' && j.source === 'human', JSON.stringify(j).slice(0, 160));
  check('dark knight: jobId deterministic', j.jobId === 'movie:tt0468569:0:0', j.jobId);
  check('dark knight: si .srt url is absolute + token 16 hex', /^https:\/\/bridge\.example\/sub\/[0-9a-f]{16}\.srt$/.test(j.si.url), j.si.url);
  check('dark knight: stremio shape subtitles[0] sin', j.subtitles[0] && j.subtitles[0].lang === 'sin' && j.subtitles[0].url === j.si.url, JSON.stringify(j.subtitles));
  check('dark knight: paired path present', j.paired === '/api/paired/movie:tt0468569:0:0.json', j.paired);
  await Promise.all(ctx.waited);

  const srt = await handleRequest(new Request(j.si.url), { SUBS_KV: kv });
  const srtText = await srt.text();
  check('dark knight: /sub/<si>.srt → HTTP 200 UTF-8 Sinhala', srt.status === 200 && srtText.includes('චැමී') && srtText.includes('-->'));

  const paired = await handleRequest(new Request(ORIGIN + j.paired), { SUBS_KV: kv });
  const pj = JSON.parse(await paired.text());
  check('dark knight: /api/paired → 200 with 10 cues', paired.status === 200 && pj.ok === true && pj.cues.length === 10, paired.status);
  check('dark knight: paired cue timing parsed to ms', pj.cues[0].t0 === 1000 && pj.cues[0].t1 === 4000, JSON.stringify(pj.cues[0]));
  check('dark knight: paired enf flattened', pj.cues[0].enf === 'චැමී පේළිය 1', pj.cues[0].enf);

  // cached second fetch: no upstream calls, fast
  const calls0 = m.spy.os;
  const t0 = Date.now();
  const res2 = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt0468569.json'), { SUBS_KV: kv }, ctx);
  const ms = Date.now() - t0;
  const j2 = JSON.parse(await res2.text());
  check('dark knight: cached second fetch does not re-search upstream', m.spy.os === calls0, m.spy.os + ' vs ' + calls0);
  check('dark knight: cached second fetch < 200 ms', ms < 200, ms + ' ms');
  check('dark knight: cached job still done with same token', j2.status === 'done' && j2.si.token === j.si.token, j2.si && j2.si.token);
  m.restore();
}

// ── 4. Clayface: no human Sinhala → full EN→SI Gemini translation job ────────
{
  const m = mockUpstreams();
  const kv = kvMock();
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const env = { SUBS_KV: kv, GEMINI_API_KEY: 'test-key', GEMINI_API_BASE: GEMINI_MOCK_BASE };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json?title=Clayface'), env, ctx);
  const j = JSON.parse(await res.text());
  check('clayface: starts translating job', res.status === 200 && j.status === 'translating' && j.source === 'gemini', JSON.stringify(j).slice(0, 160));
  check('clayface: deterministic si url present while translating', /^\/sub\/[0-9a-f]{16}\.srt$/.test(j.si.url.replace(ORIGIN, '')), j.si.url);
  check('clayface: 4 batches of 100 cues', j.total === 4 && j.done === 0, JSON.stringify({ total: j.total, done: j.done }));

  // the 202 progress contract on the deterministic URL while translating
  const mid = await handleRequest(new Request(j.si.url), env);
  const midJ = JSON.parse(await mid.text());
  check('clayface: /sub/<si>.srt → 202 with progress while translating', mid.status === 202 && midJ.status === 'translating' && typeof midJ.progress === 'number' && midJ.eta_sec === null || midJ.eta_sec >= 1, mid.status + ' ' + JSON.stringify(midJ));

  // paired while translating → 202
  const midP = await handleRequest(new Request(ORIGIN + '/api/paired/movie:tt34890576:0:0.json'), env);
  check('clayface: /api/paired → 202 while translating', midP.status === 202, midP.status);

  // let the background job finish (the route parked it in ctx.waitUntil)
  await Promise.all(ctx.waited);

  // now both URLs are real 200s
  const srt = await handleRequest(new Request(j.si.url), env);
  const srtText = await srt.text();
  check('clayface: /sub/<si>.srt → HTTP 200 after translation', srt.status === 200, srt.status);
  check('clayface: Sinhala script present', /[\u0D80-\u0DFF]/.test(srtText));

  const enSrt = await handleRequest(new Request(j.en.url), env);
  const enText = await enSrt.text();
  check('clayface: paired English /sub/<en>.srt → HTTP 200', enSrt.status === 200 && enText.includes('Clayface speaks'), enSrt.status);

  // THE VALIDATOR: cue count identical + every timestamp byte-identical
  const enCues = parseSrtCues(enText);
  const siCues = parseSrtCues(srtText);
  check('clayface: cue count identical', enCues.length === siCues.length && siCues.length === 100, enCues.length + ' vs ' + siCues.length);
  let tsOk = true;
  for (let i = 0; i < enCues.length; i++) if (enCues[i].ts !== siCues[i].ts) { tsOk = false; break; }
  check('clayface: every timestamp byte-identical', tsOk);
  check('clayface: translations carry Sinhala + original words', siCues[1].lines.join(' ').includes('සිංහල'));

  // paired payload (the <10 ms cue-lock data)
  const paired = await handleRequest(new Request(ORIGIN + '/api/paired/movie:tt34890576:0:0.json'), env);
  const pj = JSON.parse(await paired.text());
  check('clayface: /api/paired → 200 done', paired.status === 200 && pj.status === 'done' && pj.ok === true, paired.status);
  check('clayface: paired cues = 100 with {i,t0,t1,en,enf,si}', pj.cues.length === 100 && pj.cues.every((c) => typeof c.i === 'number' && typeof c.t0 === 'number' && typeof c.t1 === 'number' && typeof c.en === 'string' && typeof c.enf === 'string' && typeof c.si === 'string' && c.si.includes('සිංහල')));
  const dashCue = pj.cues[0]; // cue 1 is the "- Hello there.\n- General Kenobi!" one
  check('clayface: paired enf keeps speaker dashes (AnantPlay rule)', dashCue.enf === '- Hello there.\n- General Kenobi! (line 1)', JSON.stringify(dashCue.enf));
  const twoLineCue = pj.cues[1];
  check('clayface: paired enf flattens inner line break', twoLineCue.enf === 'Clayface speaks line 2 with a second row', JSON.stringify(twoLineCue.enf));
  check('clayface: t0/t1 in ms match the timestamps', twoLineCue.t0 === 1500 && twoLineCue.t1 === 1900, twoLineCue.t0 + '/' + twoLineCue.t1);

  // final job state via /subtitles: done, cached, no upstream churn
  const callsOs = m.spy.os, callsGem = m.spy.gemini;
  const res3 = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json'), env, ctx);
  const j3 = JSON.parse(await res3.text());
  await Promise.all(ctx.waited);
  check('clayface: job reports done with cue count', j3.status === 'done' && j3.cues === 100, JSON.stringify(j3).slice(0, 120));
  check('clayface: cached done job triggers no new upstream/gemini calls', m.spy.os === callsOs && m.spy.gemini === callsGem, m.spy.os + '/' + m.spy.gemini);

  // gemini was called 4 times (one per batch), concurrency respected
  check('clayface: exactly one gemini call per batch (4)', m.spy.gemini === 4, m.spy.gemini);
  m.restore();
}

// ── 5. needs-key path (no human sub, no GEMINI_API_KEY secret) ───────────────
{
  const m = mockUpstreams();
  const kv = kvMock();
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt34890576.json?title=Clayface'), { SUBS_KV: kv });
  const j = JSON.parse(await res.text());
  check('needs-key: honest status when no secret and no human sub', res.status === 200 && j.ok === false && j.status === 'needs-key' && /GEMINI_API_KEY/.test(j.error), JSON.stringify(j).slice(0, 140));
  check('needs-key: stremio clients still get an empty subtitles array', Array.isArray(j.subtitles) && j.subtitles.length === 0);
  m.restore();
}

// ── 6. validation: bad gemini answers are rejected, truncated ones split ─────
{
  const m = mockUpstreams({ geminiBehavior: 'english' });
  const env = { GEMINI_API_KEY: 'k', GEMINI_API_BASE: GEMINI_MOCK_BASE };
  const items = Array.from({ length: 6 }, (_, i) => ({ i, text: 'line ' + i }));
  let threw = '';
  try { await geminiTranslateBatch(env, 'k', 'gemini-flash-latest', items); } catch (e) { threw = e.message; }
  check('validator: an English answer is rejected', /wrong language/.test(threw), threw);
  m.restore();

  const m2 = mockUpstreams({ geminiBehavior: 'drop-half' });
  let threw2 = '';
  try { await geminiTranslateBatch(env, 'k', 'gemini-flash-latest', items); } catch (e) { threw2 = e.message; }
  check('validator: missing lines are rejected', /missing|incomplete/.test(threw2), threw2);
  m2.restore();

  const m3 = mockUpstreams({ geminiBehavior: 'max-tokens' });
  const out = await translateBatchRobust(env, 'k', 'gemini-flash-latest', Array.from({ length: 40 }, (_, i) => ({ i, text: 'line ' + i })));
  check('truncated batch is split and retried until complete', out.length === 40 && out.every((t) => t.includes('සිංහල')), out.length);
  m3.restore();
}

// ── 7. route guards ──────────────────────────────────────────────────────────
{
  const kv = kvMock();
  const badType = await handleRequest(new Request(ORIGIN + '/subtitles/banana/tt34890576.json'), { SUBS_KV: kv });
  check('subtitles: bad type → 404 (route miss)', badType.status === 404, badType.status);
  const badId = await handleRequest(new Request(ORIGIN + '/subtitles/movie/wrong-id.json'), { SUBS_KV: kv });
  check('subtitles: bad id → 404 (route miss)', badId.status === 404, badId.status);
  const unknown = await handleRequest(new Request(ORIGIN + '/api/paired/movie:tt9999999:0:0.json'), { SUBS_KV: kv });
  check('paired: unknown job → 404 with guidance', unknown.status === 404 && (await unknown.json()).ok === false);
  const health = await handleRequest(new Request(ORIGIN + '/health'), {});
  check('health: ok', health.status === 200 && (await health.json()).ok === true);
  const status = await handleRequest(new Request(ORIGIN + '/api/status'), { GEMINI_API_KEY: 'x' });
  const st = JSON.parse(await status.text());
  check('status: reports secrets as booleans (never values)', status.status === 200 && st.secrets.gemini === true && st.secrets.subdl === false && st.model === 'gemini-flash-latest', JSON.stringify(st).slice(0, 140));
}

// ── 8. series episode path (S01E02 job key) ─────────────────────────────────
{
  const m = mockUpstreams();
  const kv = kvMock();
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/series/tt0903747.json?season=1&episode=2&title=Dark'), { SUBS_KV: kv }, ctx);
  const j = JSON.parse(await res.text());
  check('series: job keyed with season/episode', j.jobId === 'series:tt0903747:1:2', j.jobId);
  await Promise.all(ctx.waited);
  m.restore();
}

// ── 9. legacy OpenSubtitles 403 → Stremio addon fallback (AnantPlay parity) ─
{
  const origFetch = globalThis.fetch;
  const DK_SI_SRT = Array.from({ length: 10 }, (_, i) =>
    `${i + 1}\n00:0${i}:01,000 --> 00:0${i}:04,000\nචැමී පේළිය ${i + 1}\n`).join('\n') + '\n';
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.indexOf('rest.opensubtitles.org') >= 0) {
      return new Response('<!DOCTYPE html><html>403</html>', { status: 403 }); // rate-limited legacy API
    }
    if (url.indexOf('opensubtitles-v3.strem.io') >= 0 && url.indexOf('tt0468569') >= 0) {
      return new Response(JSON.stringify({ subtitles: [
        { id: '1', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1', lang: 'pob' },
        { id: '2', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/2', lang: 'sin', subtitleFileName: 'Dark.Knight.si.srt' },
      ] }), { status: 200 });
    }
    if (url.indexOf('subs5.strem.io') >= 0 && url.endsWith('/file/2')) {
      return new Response(DK_SI_SRT, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (url.indexOf('subdl') >= 0) return new Response(JSON.stringify({}), { status: 200 });
    if (url.indexOf('piratelk') >= 0) return new Response('User-agent: *\nDisallow:', { status: 200 });
    return origFetch(url, init);
  };
  const kv = kvMock();
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt0468569.json?title=Dark+Knight'), { SUBS_KV: kv }, ctx);
  const j = JSON.parse(await res.text());
  check('fallback: legacy 403 → human Sinhala found via the Stremio addon', j.status === 'done' && j.source === 'human' && j.jobId === 'movie:tt0468569:0:0', JSON.stringify(j).slice(0, 160));
  const srt = await handleRequest(new Request(j.si.url), { SUBS_KV: kv });
  check('fallback: plain (non-gz) addon download published as real .srt', srt.status === 200 && (await srt.text()).includes('චැමී'));
  await Promise.all(ctx.waited);
  globalThis.fetch = origFetch;
}

// ── 10. http:// legacy download links are upgraded to https ────────────────
{
  const origFetch = globalThis.fetch;
  let sawUrl = '';
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.indexOf('rest.opensubtitles.org') >= 0) {
      return new Response(JSON.stringify([{ IDSubtitleFile: '9', SubDownloadLink: 'http://dl.opensubtitles.org/en/download/src-api/x', SubLanguageID: 'sin', SubFileName: 'a.si.srt', SubFormat: 'srt', SubDownloadsCnt: '5' }]), { status: 200 });
    }
    if (url.indexOf('dl.opensubtitles.org') >= 0) {
      sawUrl = url;
      const srt = Array.from({ length: 10 }, (_, i) => `${i + 1}\n00:0${i}:01,000 --> 00:0${i}:04,000\nසිංහල ${i + 1}\n`).join('\n') + '\n';
      return new Response(gzipSync(Buffer.from(srt, 'utf8')), { status: 200 });
    }
    if (url.indexOf('opensubtitles-v3.strem.io') >= 0 || url.indexOf('subdl') >= 0) return new Response(JSON.stringify({ subtitles: [] }), { status: 200 });
    if (url.indexOf('piratelk') >= 0) return new Response('User-agent: *\nDisallow:', { status: 200 });
    return origFetch(url, init);
  };
  const kv = kvMock();
  const ctx = { waited: [], waitUntil(p) { this.waited.push(p); } };
  const res = await handleRequest(new Request(ORIGIN + '/subtitles/movie/tt0468569.json'), { SUBS_KV: kv }, ctx);
  const j = JSON.parse(await res.text());
  check('http→https: the legacy http:// link was fetched over https', j.status === 'done' && sawUrl.startsWith('https://dl.opensubtitles.org/'), sawUrl);
  await Promise.all(ctx.waited);
  globalThis.fetch = origFetch;
}

console.log(`pipeline.test.js — ${pass} PASS / ${fail} FAIL`);
if (fails.length) fails.forEach((f) => console.log('FAIL ' + f));
process.exit(fail ? 1 : 0);
