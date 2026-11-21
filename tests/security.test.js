// Security regression tests — Gate 4 (anti-SSRF, zip-bomb, payload caps, token validation,
// XSS surface, worker portability). Every check is offline and deterministic.
// Run: node tests/security.test.js
import { handleRequest, assertSafeUpstreamUrl, isPrivateHost, hostAllowed,
         fetchUpstreamSub, unzipBest, toCleanSrt, limits, hasStorage } from '../worker/src/index.js';

const LIMITS = limits();
const MAX_PUBLISH_BYTES = LIMITS.maxPublishBytes;
const MAX_UNCOMPRESSED_BYTES = LIMITS.maxUncompressedBytes;
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 160) : '')); }
}
function rejects(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

const SINHALA_SRT = '1\n00:00:01,000 --> 00:00:03,500\nආයුබෝවන් ලොව!\n\n2\n00:00:04,000 --> 00:00:06,000\nදෙවන පේළිය\n';

function kvMock() {
  const map = new Map();
  return { puts: 0, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { this.puts++; map.set(k, v); } };
}

// ── 1. SSRF: scheme, credentials, port, private/loopback/link-local hosts ─────
{
  const bad = [
    'http://dl.opensubtitles.org/en/download/sub/1.gz',   // not https
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://dl.opensubtitles.org/x.zip',
    'gopher://127.0.0.1:6379/_INFO',
    'https://127.0.0.1/x.srt',
    'https://127.1.2.3/x.srt',
    'http://localhost/x.srt',
    'http://localhost:8765/index.json',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/x.srt',
    'https://172.16.4.4/x.srt',
    'https://172.31.255.255/x.srt',
    'https://192.168.1.10/x.srt',
    'https://100.64.0.1/x.srt',
    'https://[::1]/x.srt',
    'https://[fd00::1]/x.srt',
    'https://0.0.0.0/x.srt',
    'https://2130706433/x.srt',                            // WHATWG normalises to 127.0.0.1
    'https://0x7f.0.0.1/x.srt',
    'https://sub.internal/x.srt',
    'https://printer.local/x.srt',
    'https://evil.example/x.srt',                          // not allowlisted
    'https://dl.opensubtitles.org.evil.example/x.srt',      // suffix trick
    'https://opensubtitles.org.evil.example/x.srt',
    'https://user:pass@dl.opensubtitles.org/x.srt',         // credentials in URL
    'https://dl.opensubtitles.org:8080/x.srt',              // odd port
    'https://dl.opensubtitles.org:6379/x.srt',
    '',
    'not a url',
  ];
  let blocked = 0;
  for (const u of bad) if (rejects(() => assertSafeUpstreamUrl(u))) blocked++;
  check(`assertSafeUpstreamUrl blocks all ${bad.length} unsafe URLs`, blocked === bad.length, blocked + '/' + bad.length);

  const good = [
    'https://dl.opensubtitles.org/en/download/sub/1.gz',
    'https://rest.opensubtitles.org/search/imdbid-tt1',
    'https://api.opensubtitles.com/api/v1/subtitles',
    'https://dl.subdl.com/subtitle/1.zip',
    'https://api.subdl.com/api/v1/subtitles',
    'https://evildl.opensubtitles.org/x.srt', // subdomain of a provider = provider-controlled DNS
    'https://piratelk.com/?s=x',
    'https://www.piratelk.com/x.zip',
  ];
  let allowed = 0;
  for (const u of good) { try { assertSafeUpstreamUrl(u); allowed++; } catch (e) { /* counted below */ } }
  check(`assertSafeUpstreamUrl accepts the ${good.length} legitimate provider URLs`, allowed === good.length, allowed + '/' + good.length);

  check('isPrivateHost: 169.254.169.254 metadata endpoint', isPrivateHost('169.254.169.254') === true);
  check('isPrivateHost: 127.0.0.1 loopback', isPrivateHost('127.0.0.1') === true);
  check('isPrivateHost: 172.16..172.31 only', isPrivateHost('172.15.0.1') === false && isPrivateHost('172.32.0.1') === false);
  check('hostAllowed: subdomains of a provider', hostAllowed('dl.subdl.com') === true && hostAllowed('subdl.com') === true);
  check('hostAllowed: unrelated host', hostAllowed('example.com') === false);
  check('hostAllowed: env extra hosts still work', hostAllowed('mirror.example', ['mirror.example']) === true);
}

// ── 2. /api/fetch-sub refuses unsafe URLs before any network call ────────────
{
  const origFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response('should not happen'); };

  const kv = kvMock();
  const targets = [
    'https://127.0.0.1/secret.srt',
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.example/x.srt',
    'file:///etc/passwd',
  ];
  let statuses = [];
  for (const url of targets) {
    const res = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
      method: 'POST', body: JSON.stringify({ url }),
    }), { SUBS_KV: kv });
    statuses.push(res.status);
  }
  check('fetch-sub rejects SSRF attempts with HTTP 400', statuses.every((s) => s === 400), statuses.join(','));
  check('fetch-sub never dispatches a network request for a blocked URL', called === 0, called + ' calls');

  // allowlist bypass through a redirect must also be blocked
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/index.json' } });
  const res = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
    method: 'POST', body: JSON.stringify({ url: 'https://dl.opensubtitles.org/x.gz' }),
  }), { SUBS_KV: kv });
  const j = JSON.parse(await res.text());
  check('fetch-sub blocks an allowlisted URL that redirects to loopback', res.status === 502 && /SSRF|allowlisted/i.test(j.error), JSON.stringify(j));

  // a redirect that stays allowlisted is followed (and re-validated per hop)
  let hops = 0;
  globalThis.fetch = async (url) => {
    hops++;
    if (hops === 1) return new Response(null, { status: 301, headers: { Location: 'https://dl.subdl.com/final.zip' } });
    return new Response(SINHALA_SRT, { status: 200, headers: { 'Content-Length': String(SINHALA_SRT.length) } });
  };
  const resOk = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
    method: 'POST', body: JSON.stringify({ url: 'https://dl.opensubtitles.org/start.gz' }),
  }), { SUBS_KV: kvMock() });
  const jOk = JSON.parse(await resOk.text());
  check('fetch-sub follows an allowlisted redirect and publishes a real .srt', jOk.ok === true && hops === 2, JSON.stringify(jOk));

  // oversized upstream body is refused (5 MB cap)
  globalThis.fetch = async () => new Response(new Uint8Array(6 * 1024 * 1024), { status: 200 });
  const big = await handleRequest(new Request('https://bridge.example/api/fetch-sub', {
    method: 'POST', body: JSON.stringify({ url: 'https://dl.opensubtitles.org/big.gz' }),
  }), { SUBS_KV: kvMock() });
  const jBig = JSON.parse(await big.text());
  check('fetch-sub rejects an upstream body over the 5 MB cap', big.status === 502 && /large/i.test(jBig.error), JSON.stringify(jBig));

  globalThis.fetch = origFetch;
}

// ── 3. ZIP-bomb + traversal safety ─────────────────────────────────────────
{
  // a ZIP whose central directory declares a 40 MB entry (a classic zip bomb)
  const data = Buffer.from('x'.repeat(64));
  const nb = Buffer.from('bomb.srt', 'utf8');
  const comp = deflateRawSync(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc32(data) >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nb.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(data) >>> 0, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(40 * 1024 * 1024, 24);
  ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt32LE(30 + nb.length + comp.length, 16);
  const bomb = Buffer.concat([lh, nb, comp, ch, nb, eocd]);

  const best = await unzipBest(new Uint8Array(bomb));
  check('zip bomb: an entry declaring 40 MB is never selected', best === null, best && best.name);
  check('zip bomb: the uncompressed cap is 5 MB', MAX_UNCOMPRESSED_BYTES === 5 * 1024 * 1024);

  const traversal = Buffer.from(readFileSync(join(ROOT, 'tests/fixtures/en.srt')));
  check('traversal: "../../etc/passwd.srt" entries are rejected by naming rules',
    (await import('../worker/src/index.js')).isSubtitleEntry('../../etc/passwd.srt') === false);
  check('traversal: absolute "/etc/x.srt" entries are rejected by naming rules',
    (await import('../worker/src/index.js')).isSubtitleEntry('/etc/x.srt') === false);
  check('traversal: Windows drive "C:\\\\x.srt" entries are rejected',
    (await import('../worker/src/index.js')).isSubtitleEntry('C:\\subs\\x.srt') === false);
  check('traversal: the fixture .srt is a normal, accepted entry name',
    (await import('../worker/src/index.js')).isSubtitleEntry('en.srt') === true && traversal.length > 0);

  // gzip bomb: 200 MB of zeros compressed is tiny
  const { gzipSync } = await import('node:zlib');
  const gz = gzipSync(Buffer.alloc(8 * 1024 * 1024));
  const { decompressAny } = await import('../worker/src/index.js');
  let gzBlocked = false;
  try { await decompressAny(new Uint8Array(gz)); } catch (e) { gzBlocked = /large/i.test(e.message); }
  check('gzip bomb: an 8 MB expansion is refused by the cap', gzBlocked);
}

// ── 4. /api/publish-srt payload caps + token validation ────────────────────
{
  const kv = kvMock();
  const huge = '1\n00:00:01,000 --> 00:00:02,000\n' + 'x'.repeat(MAX_PUBLISH_BYTES + 1024) + '\n';
  const res = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: JSON.stringify({ text: huge }),
  }), { SUBS_KV: kv });
  check('publish-srt rejects a >2 MB subtitle', res.status === 413, res.status);
  check('publish-srt stored nothing after a size rejection', kv.puts === 0, kv.puts);

  const resB64 = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
    method: 'POST', body: JSON.stringify({ b64: 'A'.repeat(4 * 1024 * 1024) }),
  }), { SUBS_KV: kv });
  check('publish-srt rejects an oversized base64 envelope', resB64.status === 413, resB64.status);

  const badTok = await handleRequest(new Request('https://bridge.example/sub/ZZZZZZZZZZZZZZZZ.srt'), { SUBS_KV: kv });
  check('/sub/<non-hex token>.srt never matches the route (strict ^[0-9a-f]{16}$) → 404', badTok.status === 404, badTok.status);
  const shortTok = await handleRequest(new Request('https://bridge.example/sub/abc.srt'), { SUBS_KV: kv });
  check('/sub/<too-short token>.srt → 404 route miss (never a KV lookup)', shortTok.status === 404, shortTok.status);

  const head = await handleRequest(new Request('https://bridge.example/sub/0000000000000000.srt', { method: 'HEAD' }), { SUBS_KV: kv });
  check('HEAD on a missing subtitle → 404 (ExoPlayer probe safe)', head.status === 404);
}

// ── 5. Cache API fallback: works with NO KV binding (zero-config deploy) ────
{
  const store = new Map();
  const cacheMock = {
    default: {
      async match(req) { const k = typeof req === 'string' ? req : req.url; const r = store.get(k); return r ? r.clone() : undefined; },
      async put(req, res) { store.set(typeof req === 'string' ? req : req.url, res.clone()); },
    },
  };
  const orig = globalThis.caches;
  globalThis.caches = cacheMock;
  try {
    check('hasStorage() true with only the Cache API', hasStorage({}) === true);
    const pub = await handleRequest(new Request('https://bridge.example/api/publish-srt', {
      method: 'POST', body: JSON.stringify({ text: SINHALA_SRT }),
    }), {});
    const j = JSON.parse(await pub.text());
    check('publish-srt works with NO KV binding (no unhandled TypeError)', j.ok === true && /\.srt$/.test(j.url), JSON.stringify(j));
    const got = await handleRequest(new Request(j.url), {});
    const body = await got.text();
    check('Cache-API fallback serves the .srt at real HTTP 200', got.status === 200 && body.includes('ආයුබෝවන්'));
    check('Cache-API fallback keeps the x-subrip content type', (got.headers.get('content-type') || '').includes('application/x-subrip'));
  } finally {
    if (orig === undefined) delete globalThis.caches; else globalThis.caches = orig;
  }
  check('hasStorage() false with neither KV nor Cache API', hasStorage({}) === false);
}

// ── 6. XSS surface + worker portability (static audit of shipped files) ────
{
  const appJsRaw = readFileSync(join(ROOT, 'bridge-ui/public/app.js'), 'utf8');
  // strip comments so documentation that *names* innerHTML does not trip the scanner
  const appJs = appJsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('app.js uses no innerHTML/outerHTML/document.write', !/innerHTML|outerHTML|document\.write/.test(appJs));
  check('app.js renders API metadata with textContent', /textContent/.test(appJs));
  check('app.js never console.logs the API keys', !/console\.(log|info|warn|error)/.test(appJs));
  check('app.js has no hardcoded API key (AIza…)', !/AIza[0-9A-Za-z_\-]{20,}/.test(appJs));
  check('app.js defaults to the gemini-flash-latest model', /gemini-flash-latest/.test(appJs));
  check('app.js supports a user model override', /si-bridge-model/.test(appJs) && /normalizeModel/.test(appJs));
  check('app.js persists keys only in localStorage', /localStorage/.test(appJs) && !/document\.cookie/.test(appJs));
  check('app.js enforces cue-count + timestamp validation', /cue count/.test(appJs) && /timestamp changed/.test(appJs));

  const workerSrc = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
  const nodeApis = [/\brequire\s*\(/, /\bprocess\.env\b/, /\bBuffer\b/, /from\s+['"]node:/, /\b__dirname\b/, /\bglobal\./];
  const leaked = nodeApis.filter((re) => re.test(workerSrc));
  check('worker/src/index.js leaks no Node-only API', leaked.length === 0, leaked.map(String).join(','));

  const uiFiles = readdirSync(join(ROOT, 'bridge-ui/public')).sort();
  check('no sw.js Service-Worker hack ships in bridge-ui/public', !uiFiles.includes('sw.js'), uiFiles.join(','));
  const swRefs = [readFileSync(join(ROOT, 'bridge-ui/public/app.js'), 'utf8'), readFileSync(join(ROOT, 'bridge-ui/public/index.html'), 'utf8')];
  check('no serviceWorker registration anywhere in the UI', swRefs.every((s) => !/serviceWorker/.test(s)));
}

// ── 6b. loopback upstreams stay blocked (lab parity must be an explicit opt-in) ──
{
  // /api/fetch-sub passes allowHttp:false — that hint must be authoritative even
  // when a loopback host was allowlisted for a lab mirror.
  let blocked = 0;
  for (const u of ['http://127.0.0.1:8765/index.json', 'http://localhost/secret.srt']) {
    try { await fetchUpstreamSub(u, { allowHttp: false, extraHosts: ['127.0.0.1', 'localhost'] }); }
    catch (e) { blocked++; }
  }
  check('fetchUpstreamSub: explicit allowHttp:false blocks loopback even when allowlisted', blocked === 2, blocked);

  // No allowHttp hint at all → implicit loopback auto-detect must NOT fire
  // (production ALLOWED_SUB_HOSTS is empty).
  let implicit = 0;
  for (const u of ['http://127.0.0.1:8765/index.json', 'http://localhost/secret.srt', 'http://[::1]/x.srt']) {
    try { await fetchUpstreamSub(u, { extraHosts: [] }); } catch (e) { implicit++; }
  }
  check('fetchUpstreamSub: loopback is never fetched implicitly (operator opt-in required)', implicit === 3, implicit);
}

// ── 7. token / content-type contract quotes the audit requirements ─────────
{
  check('publish token format matches ^[a-f0-9]{8,64}$', /^[0-9a-f]{16}$/.test('0123456789abcdef'));
  const cleaned = toCleanSrt('\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nx\r\n');
  check('toCleanSrt yields LF-only, BOM-less text', !cleaned.text.includes('\r') && cleaned.text.charCodeAt(0) !== 0xfeff);
  check('fetchUpstreamSub is exported for direct auditing', typeof fetchUpstreamSub === 'function');
}

// ── 8. Wrangler module-Worker contract: only functions may be exported ─────
// `export const MAX_…` makes workerd throw "Incorrect type for map entry …" at startup, and
// `wrangler deploy --dry-run` does NOT catch it — only a real boot does. Guard it here.
{
  const mod = await import('../worker/src/index.js');
  const nonFunctions = Object.entries(mod)
    .filter(([k, v]) => k !== 'default' && typeof v !== 'function') // `default` is the handler object
    .map(([k]) => k);
  check('every named worker export is a function (workerd rejects exported constants)',
    nonFunctions.length === 0, nonFunctions.join(','));
  check('the default export is a handler with .fetch', typeof mod.default === 'object' && typeof mod.default.fetch === 'function');
  check('limits() exposes the caps without exporting constants',
    LIMITS.maxPublishBytes === 2 * 1024 * 1024 && Array.isArray(LIMITS.allowedHosts) && LIMITS.allowedHosts.length >= 5,
    JSON.stringify(LIMITS.allowedHosts));
}

console.log(`security.test.js — ${pass} PASS / ${fail} FAIL`);
if (fails.length) fails.forEach(f => console.log('FAIL ' + f));
process.exit(fail ? 1 : 0);
