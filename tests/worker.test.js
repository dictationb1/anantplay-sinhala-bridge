// Worker direct-fetch tests: the Cloudflare Worker's real /sub/<token>.srt delivery, API routes,
// dynamic catalogs, SRT/ZIP/GZ parsing and dedupe — all offline with a KV mock and synthetic
// Sinhala fixtures. Run: node tests/worker.test.js
import { handleRequest, toCleanSrt, parseSrtCues, reassembleSrt, isGzip, isZip,
         zipEntries, pickBestEntry, isSubtitleEntry, entryRank, sha256Hex, catalogRoutes,
         publishSrt } from '../worker/src/index.js';
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; }
  else { fail++; fails.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 140) : '')); }
}

// a KV mock: Map with TTL + call counting
function kvMock() {
  const map = new Map();
  return {
    puts: 0,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v, o) { this.puts++; map.set(k, v); },
    _map: map,
  };
}

const SINHALA_SRT = '1\n00:00:01,000 --> 00:00:03,500\nආයුබෝවන් ලොව! මෙය පරීක්ෂණයකි.\n\n2\n00:00:04,000 --> 00:00:06,000\nදෙවන පේළිය\n';

// The subtitle hosts the worker is allowed to fetch from (see DEFAULT_ALLOWED_HOSTS).
const UP_GZ = 'https://dl.opensubtitles.org/en/download/sub/12345.gz';
const UP_ZIP = 'https://dl.subdl.com/subtitle/12345.zip';

// ── 1. real HTTP 200 delivery through the worker fetch handler ───────────────
{
  const kv = kvMock();
  const pub = await publishSrt({ SUBS_KV: kv }, SINHALA_SRT);
  check('publish returns .srt-suffixed path', /\.srt$/.test(pub.url), pub.url);
  check('token is 16 hex', /^[0-9a-f]{16}$/.test(pub.token), pub.token);

  const req = new Request('https://bridge.example' + pub.url);
  const res = await handleRequest(req, { SUBS_KV: kv });
  check('GET /sub/<token>.srt → HTTP 200', res.status === 200, res.status);
  check('Content-Type is application/x-subrip; charset=utf-8', (res.headers.get('content-type') || '').includes('application/x-subrip'), res.headers.get('content-type'));
  check('CORS * on the .srt', res.headers.get('access-control-allow-origin') === '*', res.headers.get('access-control-allow-origin'));
  const text = await res.text();
  check('body is the Sinhala cues (real content, no 404)', text.includes('ආයුබෝවන්') && text.includes('-->'), text.slice(0, 60));
  check('body bytes match input (UTF-8 round-trip)', new TextEncoder().encode(text).length === new TextEncoder().encode(SINHALA_SRT).length);
  check('delivered .srt is BOM-less', text.charCodeAt(0) !== 0xfeff);

  // SHA-256 dedupe: same content → same token, one KV write
  const kv2 = kvMock();
  await publishSrt({ SUBS_KV: kv2 }, SINHALA_SRT);
  await publishSrt({ SUBS_KV: kv2 }, SINHALA_SRT);
  check('SHA-256 dedupe: identical content written once', kv2.puts === 1, kv2.puts + ' writes');

  // unknown token → 404 (correct behavior), BUT the delivered real token never 404s
  const miss = await handleRequest(new Request('https://bridge.example/sub/0000000000000000.srt'), { SUBS_KV: kv });
  check('unknown token → 404', miss.status === 404, miss.status);
  check('no KV → 404 (binding guard)', (await handleRequest(new Request('https://bridge.example/sub/abcd0123abcd0123.srt'), {})).status === 404);
}

// ── 2. dynamic catalogs (live origin, zero YOUR-HOST, real AnantPlay shapes) ──
{
  const cat = catalogRoutes(new URL('https://bridge.example'));
  check('index.json has BOTH sites and deeplinks sources',
    cat['/index.json'].sources.length === 2 && cat['/index.json'].sources.some(s => s.type === 'sites') && cat['/index.json'].sources.some(s => s.type === 'deeplinks'));
  const res = await handleRequest(new Request('https://bridge.example/index.json'), {});
  const j = JSON.parse(await res.text());
  check('GET /index.json → 200 + sources', res.status === 200 && j.sources.length === 2);
  check('index.json carries live host (no YOUR-HOST placeholder)', JSON.stringify(j).includes('https://bridge.example') && !JSON.stringify(j).includes('YOUR-HOST'));
  check('index.json source urls are absolute http(s) (Sources.parseIndex filter)',
    j.sources.every(s => /^https?:\/\/.+/.test(s.url)), JSON.stringify(j.sources.map(s => s.url)));
  check('index.json does not misuse `languages` as prose (it must be a playlist URL)',
    j.sources.every(s => !s.languages || /^https?:\/\//.test(s.languages)), JSON.stringify(j.sources.map(s => s.languages)));

  const sites = await handleRequest(new Request('https://bridge.example/sites.json'), {});
  const sj = JSON.parse(await sites.text());
  check('GET /sites.json → 200', sites.status === 200);
  check('sites.json has rows.more with a STRICTLY boolean index (Sites.merge)',
    Array.isArray(sj.rows.more) && sj.rows.more.length === 1 && sj.rows.more[0].index === true && typeof sj.rows.more[0].index === 'boolean',
    JSON.stringify(sj.rows));
  check('sites.json row url points at the live bridge origin', sj.rows.more[0].url === 'https://bridge.example/', sj.rows.more[0].url);
  check('sites.json languages.Sinhala entry present', Array.isArray(sj.languages.Sinhala) && sj.languages.Sinhala.length === 1);
  check('sites.json row name non-empty + https url (Sites.merge drops otherwise)',
    !!sj.rows.more[0].name && /^https?:\/\//.test(sj.rows.more[0].url));

  const dl = await (await handleRequest(new Request('https://bridge.example/deeplinks.json'), {})).json();
  const host = Object.keys(dl)[0];
  check('deeplinks.json is keyed by the live hostname (Sites.hostOf, no scheme)',
    host === 'bridge.example' && !host.includes('://'), host);
  check('deeplinks.json movie/tv/episode templates fill {tmdb},{imdb},{season},{episode}',
    dl[host].movie === 'https://bridge.example/?type=movie&tmdb={tmdb}&imdb={imdb}' &&
    dl[host].tv === 'https://bridge.example/?type=tv&tmdb={tmdb}&imdb={imdb}' &&
    dl[host].episode === 'https://bridge.example/?type=tv&tmdb={tmdb}&imdb={imdb}&s={season}&e={episode}',
    JSON.stringify(dl[host]));
}

// ── 3. /api/publish-srt (JSON text + b64 + multipart) ───────────────────────
{
  const kv = kvMock();
  const res = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: SINHALA_SRT }),
  }), { SUBS_KV: kv });
  const j = JSON.parse(await res.text());
  check('publish-srt ok with cues counted', j.ok === true && j.cues === 2, JSON.stringify(j));
  check('publish-srt returns FULL real https URL ending .srt', /\.srt$/.test(j.url) && j.url.startsWith('https://bridge.example'), j.url);
  const got = await (await handleRequest(new Request(j.url), { SUBS_KV: kv })).text();
  // toCleanSrt normalizes trailing blank lines — the stored body is the CLEAN srt, cues intact
  check('published .srt GETs back the clean normalized content',
    got.replace(/\n+$/, '') === SINHALA_SRT.replace(/\n+$/, '') && got.includes('ආයුබෝවන්') && got.includes('-->'),
    JSON.stringify(got.slice(-24)));

  // b64 leg (the Bridge upload path)
  const b64 = Buffer.from(SINHALA_SRT, 'utf8').toString('base64');
  const res2 = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: JSON.stringify({ b64 }),
  }), { SUBS_KV: kv });
  const j2 = JSON.parse(await res2.text());
  check('publish-srt b64 leg ok', j2.ok === true && j2.cues === 2, JSON.stringify(j2));

  // b64 leg carrying a .zip (upload parity with the local server)
  const zipBuf = readFileSync(new URL('./fixtures/pack.zip', import.meta.url));
  const resZip = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: JSON.stringify({ b64: zipBuf.toString('base64') }),
  }), { SUBS_KV: kv });
  const jz = JSON.parse(await resZip.text());
  check('publish-srt b64 .zip extracts the best .srt (worker/local parity)', jz.ok === true && jz.cues === 3, JSON.stringify(jz));

  // multipart leg (the file picker path)
  const form = new FormData();
  form.set('file', new File([SINHALA_SRT], 'si.srt', { type: 'application/x-subrip' }));
  const res3 = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: form,
  }), { SUBS_KV: kv });
  const j3 = JSON.parse(await res3.text());
  check('publish-srt multipart leg ok', j3.ok === true && j3.cues === 2, JSON.stringify(j3));

  // a non-subtitle body → rejected, never stored
  const bad = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: JSON.stringify({ text: '<html>not a sub</html>' }),
  }), { SUBS_KV: kv });
  check('publish-srt rejects non-subtitle text', bad.status === 400, bad.status);
}

// ── 4. /api/fetch-sub with a MOCKED upstream (gz + zip) ──────────────────────
{
  // monkey-patch global fetch for upstream calls: /api/search and the upstream subtitle GET
  const origFetch = globalThis.fetch;
  const upstreamGz = gzipSync(Buffer.from(SINHALA_SRT, 'utf8'));
  const upstreamZip = (() => {
    // minimal ZIP with 3 entries: junk __MACOSX, nested best .si.srt, an .nfo
    const entries = [
      ['__MACOSX/._junk', Buffer.from('junkjunkjunk')],
      ['Subs/Nested/Breaking.Bad.si.srt', Buffer.from(SINHALA_SRT, 'utf8')],
      ['info.nfo', Buffer.from('nfo')],
    ];
    const chunks = [];
    const central = [];
    let off = 0;
    for (const [name, data] of entries) {
      const nb = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
      const comp = deflateRawSync(data);
      chunks.push(lh, nb, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc >>> 0, 16);
      ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      central.push(Buffer.concat([ch, nb]));
      off += 30 + nb.length + comp.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...chunks, ...central, eocd]);
  })();
  let served = upstreamGz;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith(UP_GZ) || url.startsWith(UP_ZIP)) {
      return new Response(served, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (url.indexOf('opensubtitles') >= 0) {
      return new Response(JSON.stringify([
        { IDSubtitleFile: '1', SubDownloadLink: UP_GZ, SubLanguageID: 'sin', MovieReleaseName: 'Test.Release', SubHearingImpaired: '0', SubDownloadsCnt: '9' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.indexOf('subdl') >= 0) return new Response(JSON.stringify({}), { status: 200 });
    if (url.indexOf('piratelk') >= 0) return new Response('User-agent: *\nDisallow:', { status: 200 });
    return origFetch(url, init);
  };

  // gz leg
  served = upstreamGz;
  const kv = kvMock();
  const res = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
    method: 'POST', body: JSON.stringify({ url: UP_GZ }),
  }), { SUBS_KV: kv });
  const j = JSON.parse(await res.text());
  check('fetch-sub (.gz) ok + cues', j.ok === true && j.cues === 2, JSON.stringify(j));
  const gzGet = await handleRequest(new Request(j.url), { SUBS_KV: kv });
  check('fetch-sub .gz → real 200 .srt', gzGet.status === 200 && (await gzGet.text()).includes('ආයුබෝවන්'));

  // zip leg (best-entry pick, __MACOSX skipped, nested ok)
  served = upstreamZip;
  const kv2 = kvMock();
  const res2 = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
    method: 'POST', body: JSON.stringify({ url: UP_ZIP }),
  }), { SUBS_KV: kv2 });
  const j2 = JSON.parse(await res2.text());
  check('fetch-sub (.zip) picks the best .srt entry', j2.ok === true && j2.cues === 2, JSON.stringify(j2));
  const zipGet = await handleRequest(new Request(j2.url), { SUBS_KV: kv2 });
  const zipText = await zipGet.text();
  check('fetch-sub .zip → real 200 .srt with Sinhala', zipGet.status === 200 && zipText.includes('ආයුබෝවන්'));
  check('zip __MACOSX junk not chosen', !zipText.includes('junkjunkjunk'));

  // search aggregation
  const sres = await handleRequest(new Request('https://bridge.example/api/search?imdb=tt0903747&season=1&episode=1&title=Dark'), {});
  const sj = JSON.parse(await sres.text());
  check('/api/search aggregates OpenSubtitles result', sj.ok === true && sj.results.some(r => r.provider === 'opensubtitles' && r.url === UP_GZ), JSON.stringify(sj).slice(0, 120));
  check('/api/search reports failed providers instead of hiding them', Array.isArray(sj.failed), JSON.stringify(sj.failed));
  const badImdb = await handleRequest(new Request('https://bridge.example/api/search?imdb=zzz'), {});
  check('/api/search validates imdb', badImdb.status === 400, badImdb.status);

  globalThis.fetch = origFetch;
}

// ── 5. shared logic: srt parsing, zip ranking, traversal rejection ──────────
{
  const cues = parseSrtCues(SINHALA_SRT);
  check('parseSrtCues counts 2 cues', cues.length === 2, cues.length);
  check('reassembleSrt round-trips', /ආයුබෝවන්/.test(reassembleSrt(cues)) && /-->/.test(reassembleSrt(cues)));
  check('isGzip', isGzip(new Uint8Array([0x1f, 0x8b, 0, 0])) === true);
  check('isZip', isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04])) === true);
  check('isSubtitleEntry rejects __MACOSX', isSubtitleEntry('__MACOSX/._x.srt') === false);
  check('isSubtitleEntry rejects .. traversal', isSubtitleEntry('../../etc/passwd.srt') === false);
  check('isSubtitleEntry accepts nested si.srt', isSubtitleEntry('Subs/x.si.srt') === true);
  check('entryRank prefers .srt over .vtt', entryRank({ name: 'a.srt' }) > entryRank({ name: 'a.vtt' }));
  check('entryRank prefers Sinhala-named', entryRank({ name: 'movie.si.srt' }) > entryRank({ name: 'movie.srt' }));
  try { toCleanSrt('no timings here'); check('toCleanSrt rejects non-sub', false); } catch (e) { check('toCleanSrt rejects non-sub', true); }
  const bom = toCleanSrt('\ufeff1\n00:00:01,000 --> 00:00:02,000\nx\n');
  check('toCleanSrt strips BOM', !bom.text.startsWith('\ufeff'));
  check('sha256Hex stable', (await sha256Hex('x')) === (await sha256Hex('x')));
  check('zipEntries parses the central directory without inflating', zipEntries(new Uint8Array([0x50, 0x4b, 0x03, 0x04])).length === 0);
  check('pickBestEntry ignores entries over the 5 MB cap',
    pickBestEntry([{ name: 'a.srt', usize: 6 * 1024 * 1024 }, { name: 'b.vtt', usize: 10 }]).name === 'b.vtt');
}

// ── 6. OPTIONS preflight + 404 guard ────────────────────────────────────────
{
  const pre = await handleRequest(new Request('https://bridge.example/api/publish-srt', { method: 'OPTIONS' }), {});
  check('OPTIONS preflight → 204', pre.status === 204, pre.status);
  const nf = await handleRequest(new Request('https://bridge.example/nope'), {});
  check('unknown route → 404 JSON', nf.status === 404);
  const uiMissing = await handleRequest(new Request('https://bridge.example/app.js'), {});
  check('/app.js without an ASSETS binding degrades to a clear 404 (no crash)', uiMissing.status === 404);
}

console.log(`worker.test.js — ${pass} PASS / ${fail} FAIL`);
if (fails.length) fails.forEach(f => console.log('FAIL ' + f));
process.exit(fail ? 1 : 0);
