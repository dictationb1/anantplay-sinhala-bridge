/* AnantPlay Sinhala Subtitle Bridge — shared library (v3).
 *
 * Everything the routes and the subtitle pipeline share: limits, the SSRF-safe fetch
 * wrapper, SRT/ZIP/GZ parsing, the KV/Cache storage layer and the upstream providers
 * (OpenSubtitles legacy REST, SubDL, piratelk hint). Extracted from index.js so the
 * pipeline (pipeline.js) and the router (index.js) never import each other.
 *
 * Zero Node-only APIs: this file also runs inside workerd.
 */

// ─────────────────────────────────────────────────────────────────────────────
// limits + security policy
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_LEN = 16; // hex chars of the SHA-256 used as the token
const TTL_SECONDS = 24 * 3600; // 24h KV TTL for ad-hoc publishes
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024; // 5 MiB compressed download cap
const MAX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024; // 5 MiB gunzip/unzip cap (zip-bomb guard)
const MAX_PUBLISH_BYTES = 2 * 1024 * 1024; // 2 MiB finished .srt cap
const MAX_B64_CHARS = Math.ceil((MAX_PUBLISH_BYTES * 4) / 3) + 1024;
const MAX_REDIRECTS = 3;
const UPSTREAM_TIMEOUT_MS = 15000;
const CACHE_STORE_ORIGIN = 'https://si-bridge-substore.invalid';

/** Subtitle providers the bridge is allowed to download from. Subdomains match too. */
const DEFAULT_ALLOWED_HOSTS = [
  'opensubtitles.org',
  'opensubtitles.com',
  'strem.io',   // the Stremio OpenSubtitles addon + its subs*.strem.io download CDN
  'subdl.com',
  'subdl.org',
  'piratelk.com',
];

const TOKEN_RE = /^[0-9a-f]{16}$/;

// ─────────────────────────────────────────────────────────────────────────────
// shared helpers (exported for tests via `export`)
// ─────────────────────────────────────────────────────────────────────────────

function hexOf(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
  return out;
}

async function sha256Hex(data) {
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const h = await crypto.subtle.digest('SHA-256', d);
  return hexOf(new Uint8Array(h));
}

/** True when bytes start with the gzip magic 1f 8b. */
function isGzip(bytes) {
  return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** True when bytes start with the ZIP magic PK\x03\x04. */
function isZip(bytes) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Parse a ZIP's central directory WITHOUT inflating entries (works on plain Uint8Array).
 * Returns [{name, method, csize, usize, localHeaderOffset}] — the reader only needs names
 * + sizes to pick the best entry; the actual inflate happens in inflateEntry(). */
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findEOCD = () => {
    const start = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= start; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  };
  const eocd = findEOCD();
  if (eocd < 0) return [];
  const count = dv.getUint16(eocd + 8, true); // EOCD+8: total entries on this disk
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count && n < 4096; n++) {
    if (off + 46 > bytes.length) break;
    if (dv.getUint32(off, true) !== 0x02014b50) break; // central file header signature
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    out.push({ name, method, csize, usize, localHeaderOffset: lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Is this ZIP entry a candidate subtitle we accept? (.srt/.vtt, not __MACOSX/, no ..) */
function isSubtitleEntry(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n.indexOf('__macosx/') === 0 || n.indexOf('__macosx\\') === 0) return false;
  // reject absolute paths and Windows drive letters as well as `..` traversal
  if (n.startsWith('/') || n.startsWith('\\') || /^[a-z]:[\\/]/.test(n)) return false;
  if (n.split('/').some((p) => p === '..') || n.split('\\').some((p) => p === '..')) return false;
  return /\.srt$/.test(n) || /\.vtt$/.test(n);
}

/** Rank: prefer .srt in the archive root, then nested; then .vtt. Sinhala-named files rank higher. */
function entryRank(e) {
  const n = String(e && e.name ? e.name : '').toLowerCase();
  let score = 0;
  if (n.endsWith('.srt')) score += 100;
  if (n.endsWith('.vtt')) score += 40;
  const depth = n.split('/').length;
  score -= depth * 5; // shallower = better
  if (/[සිංහල]|sinhala|(^|[-._])si\b|[-._]si[._-]|\.si\./.test(n)) score += 30;
  if (n.length < 40) score += 10;
  return score;
}

function pickBestEntry(entries) {
  const subs = entries.filter((e) => isSubtitleEntry(e.name) && e.usize <= MAX_UNCOMPRESSED_BYTES);
  if (!subs.length) return null;
  let best = subs[0];
  for (const e of subs) if (entryRank(e) > entryRank(best)) best = e;
  return best;
}

/** Read a ReadableStream with a hard byte cap (zip/gzip-bomb guard). */
async function readStreamCapped(stream, maxBytes) {
  if (!stream || typeof stream.getReader !== 'function') {
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    if (buf.length > maxBytes) throw new Error('decompressed content too large');
    return buf;
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      throw new Error('decompressed content too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Read a fetch Response body with a hard byte cap. */
async function readResponseCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error('upstream file too large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('upstream file too large');
    return buf;
  }
  return readStreamCapped(res.body, maxBytes);
}

/** gunzip with a size cap. */
async function gunzipCapped(bytes, maxBytes = MAX_UNCOMPRESSED_BYTES) {
  const ds = new DecompressionStream('gzip');
  const piped = new Response(bytes).body.pipeThrough(ds);
  return readStreamCapped(piped, maxBytes);
}

/** Inflate ONE zip entry (method 0 stored / 8 deflate) via DecompressionStream. */
async function inflateEntry(bytes, entry) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localHeaderOffset;
  if (off + 30 > bytes.length || dv.getUint32(off, true) !== 0x04034b50) throw new Error('bad local header');
  if (entry.usize > MAX_UNCOMPRESSED_BYTES) throw new Error('zip entry too large (zip-bomb guard)');
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart > bytes.length) throw new Error('bad local header');
  const raw = bytes.subarray(dataStart, dataStart + entry.csize);
  if (entry.method === 0) {
    if (raw.length > MAX_UNCOMPRESSED_BYTES) throw new Error('zip entry too large (zip-bomb guard)');
    return new Uint8Array(raw);
  }
  if (entry.method !== 8) throw new Error('unsupported zip method ' + entry.method);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(raw).body.pipeThrough(ds);
  return readStreamCapped(stream, MAX_UNCOMPRESSED_BYTES);
}

/** Extract the best .srt/.vtt from a ZIP (Uint8Array) → {bytes, name} or null. */
async function unzipBest(zipBytes) {
  const entries = zipEntries(zipBytes);
  const best = pickBestEntry(entries);
  if (!best) return null;
  const bytes = await inflateEntry(zipBytes, best);
  return { bytes, name: best.name };
}

/** Normalize ANY subtitle text (srt or vtt) into a clean BOM-less UTF-8 SRT string.
 * - strips BOM, unifies newlines, trims trailing whitespace
 * - validates it actually looks like a subtitle (has --> timings or WEBVTT header)
 * Returns {text, wasVtt} or throws. */
function toCleanSrt(text) {
  if (typeof text !== 'string') throw new Error('subtitle must be text');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const wasVtt = /^\ufeff?WEBVTT/.test(text.trimStart());
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  if (!wasVtt && !text.includes('-->')) throw new Error('not a subtitle file (no "-->" cues)');
  if (new TextEncoder().encode(text).length > MAX_PUBLISH_BYTES) throw new Error('subtitle too large (2 MB max)');
  return { text, wasVtt };
}

/** Split an SRT into cues [{idx, ts, lines}] — used by the translation batcher.
 * `ts` is the RAW timing line (e.g. "00:00:01,000 --> 00:00:03,500") — the pipeline
 * re-uses it verbatim so the translated file's timestamps are byte-identical. */
function parseSrtCues(text) {
  const cues = [];
  const blocks = String(text).split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    if (!lines[i] || !lines[i].includes('-->')) continue;
    cues.push({ idx: cues.length, ts: lines[i], lines: lines.slice(i + 1) });
  }
  return cues;
}

function reassembleSrt(cues) {
  return cues
    .map((c, n) => (n + 1) + '\n' + c.ts + '\n' + c.lines.join('\n'))
    .join('\n\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// SSRF protection (Gate 4)
// ─────────────────────────────────────────────────────────────────────────────

/** Loopback / private / link-local / metadata / internal-only hosts. */
function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (/\.(localhost|local|internal|home\.arpa|intranet|lan)$/.test(h)) return true;
  if (h.includes(':')) return true; // never allow raw IPv6 literals upstream
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Exact host or a subdomain of an allowlisted provider. */
function hostAllowed(hostname, extraHosts) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h) return false;
  const list = DEFAULT_ALLOWED_HOSTS.concat(Array.isArray(extraHosts) ? extraHosts : []);
  return list.some((allowed) => {
    const a = String(allowed || '').toLowerCase().trim().replace(/^www\./, '');
    return a && (h === a || h.endsWith('.' + a));
  });
}

/** Parse + validate one upstream subtitle URL. Throws on anything unsafe.
 * opts: {allowHttp, extraHosts} — extraHosts is `env.ALLOWED_SUB_HOSTS` (comma list). */
function assertSafeUpstreamUrl(raw, opts) {
  const o = opts || {};
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch (e) {
    throw new Error('invalid subtitle URL');
  }
  if (u.protocol !== 'https:' && !(o.allowHttp === true && u.protocol === 'http:')) {
    throw new Error('only https upstream URLs are allowed');
  }
  if (u.username || u.password) throw new Error('upstream URL must not contain credentials');
  if (u.port && u.port !== '443' && u.port !== '80') throw new Error('upstream port not allowed');
  if (isPrivateHost(u.hostname)) throw new Error('upstream host is private/loopback — SSRF blocked');
  if (!hostAllowed(u.hostname, o.extraHosts)) throw new Error('upstream host not allowlisted: ' + u.hostname);
  return u;
}

/** fetch() wrapper: allowlist + per-hop redirect re-validation + timeout + size cap. */
async function safeFetchBytes(rawUrl, opts) {
  const o = opts || {};
  const headers = o.headers || { 'User-Agent': OS_UA, 'Accept': '*/*' };
  const maxBytes = o.maxBytes || MAX_UPSTREAM_BYTES;
  let url = assertSafeUpstreamUrl(rawUrl, o);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      headers,
      redirect: 'manual',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(o.timeoutMs || UPSTREAM_TIMEOUT_MS) : undefined,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('upstream redirect without a location');
      url = assertSafeUpstreamUrl(new URL(loc, url).toString(), o); // every hop re-checked
      continue;
    }
    if (!res.ok) throw new Error('upstream ' + res.status);
    return { bytes: await readResponseCapped(res, maxBytes), headers: res.headers, url: url.toString() };
  }
  throw new Error('too many upstream redirects');
}

// ─────────────────────────────────────────────────────────────────────────────
// storage (KV first, Cache API fallback, SHA-256 dedupe, 24h TTL)
// ─────────────────────────────────────────────────────────────────────────────

function hasStorage(env) {
  if (env && env.SUBS_KV) return true;
  try {
    return !!(typeof caches !== 'undefined' && caches && caches.default);
  } catch (e) {
    return false;
  }
}

function cacheStore() {
  try {
    return typeof caches !== 'undefined' && caches && caches.default ? caches.default : null;
  } catch (e) {
    return null;
  }
}

/** Publish a finished .srt.
 * opts.token — force the token (pipeline jobs use a deterministic jobId-derived token so
 *              the URL is known before the translation finishes; /sub/<token>.srt then
 *              answers 202 progress while the job is still running).
 * opts.permanent — write without TTL (finished jobs are the permanent cache). */
async function publishSrt(env, text, opts) {
  const o = opts || {};
  const token = o.token || (await sha256Hex(text)).slice(0, TOKEN_LEN);
  const key = 'sub:' + token;
  const ttl = o.permanent ? undefined : TTL_SECONDS;
  if (env && env.SUBS_KV) {
    // metadata-only write refreshes TTL without re-uploading the blob
    const existing = await env.SUBS_KV.get(key);
    if (!existing) await env.SUBS_KV.put(key, text, ttl ? { expirationTtl: ttl } : undefined);
  } else {
    const c = cacheStore();
    if (c) {
      const req = new Request(CACHE_STORE_ORIGIN + '/sub/' + token + '.srt');
      const hit = await c.match(req);
      if (!hit) {
        await c.put(req, new Response(text, {
          headers: { 'Content-Type': 'application/x-subrip; charset=utf-8', 'Cache-Control': 'public, max-age=' + (o.permanent ? 31536000 : TTL_SECONDS) },
        }));
      }
    }
  }
  return { token, url: '/sub/' + token + '.srt' };
}

function isValidToken(token) {
  return TOKEN_RE.test(String(token || ''));
}

async function getSrt(env, token) {
  if (!isValidToken(token)) return null;
  if (env && env.SUBS_KV) {
    return (await env.SUBS_KV.get('sub:' + token)) || null;
  }
  const c = cacheStore();
  if (!c) return null;
  const hit = await c.match(new Request(CACHE_STORE_ORIGIN + '/sub/' + token + '.srt'));
  return hit ? await hit.text() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// upstream subtitle providers (server-side only — real User-Agent)
// ─────────────────────────────────────────────────────────────────────────────

const OS_UA = 'TemporaryUserAgent'; // OpenSubtitles legacy REST required UA (SubOs.java:26)
const SUBDL_UA = 'Mozilla/5.0 (X11; Linux x86_64) AnantPlaySiBridge/3.0';

/** Legacy OpenSubtitles REST search (no key, no login) — the SAME API official
 * AnantPlay uses (SubOs.java). Results are sorted by download count, exactly like
 * AnantPlay sorts them before showing the pick list.
 *
 * OS_REST_BASE (env): test/lab-only override of the search endpoint (e.g. the Live
 * Verification Lab mirrors the real search JSON on loopback, because rest.opensubtitles.org's
 * Cloudflare bot check challenges the local dev runtime's TLS fingerprint). https or
 * loopback only; the DEFAULT is always the real endpoint. */
function osRestBase(env) {
  const raw = String((env && env.OS_REST_BASE) || '').trim() || 'https://rest.opensubtitles.org';
  try {
    const u = new URL(raw);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !loopback) return 'https://rest.opensubtitles.org';
    if (u.username || u.password) return 'https://rest.opensubtitles.org';
    return u.origin;
  } catch (e) {
    return 'https://rest.opensubtitles.org';
  }
}

async function openSubsSearch(imdb, season, episode, lang, langs, env) {
  // SubOs.java:43-49: the server only answers the canonical form directly — imdb digits
  // with 'tt' stripped, zero-padded to 7 (anything else 302s to it, which a manual-redirect
  // fetch would silently turn into an empty result — the v2.1 latent bug this fixes).
  const digits = String(imdb || '').replace(/^tt/i, '').replace(/\D/g, '');
  if (!digits || digits.length > 9) return [];
  let url = osRestBase(env) + '/search/imdbid-' + digits.padStart(7, '0');
  const want = langs && langs.length ? langs : ['sin', 'eng'];
  url += '/sublanguageid-' + want.join(',');
  if (season) url += '/season-' + season;
  if (episode && episode > 0) url += '/episode-' + episode;
  const res = await fetch(url, {
    headers: { 'User-Agent': OS_UA, 'Accept': 'application/json' },
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined,
  });
  if (!res.ok) return [];
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];
  const out = arr
    .filter((r) => r && r.SubDownloadLink && String(r.SubBad || '0') !== '1'
      && (!r.SubFormat || String(r.SubFormat).toLowerCase() === 'srt'))
    .map((r) => ({
      provider: 'opensubtitles',
      id: String(r.IDSubtitleFile || ''),
      url: String(r.SubDownloadLink || '').replace(/^http:\/\//i, 'https://'), // legacy links come http://; https works on the same host
      lang: r.SubLanguageID || r.ISO639 || 'en',
      release: r.MovieReleaseName || r.SubFileName || '',
      fileName: r.SubFileName || '',
      format: 'srt',
      hearingImpaired: !!(r.SubHearingImpaired && String(r.SubHearingImpaired) === '1'),
      downloads: Number(r.SubDownloadsCnt || 0),
    }))
    .filter((r) => r.url);
  out.sort((a, b) => (b.downloads || 0) - (a.downloads || 0)); // SubOs.java:92-95
  return out.slice(0, 40);
}

/** The Stremio OpenSubtitles addon (no key, no login) — the SAME fallback official
 * AnantPlay uses when the legacy REST is unreachable (Subs.java:14, 74-77, 478-496).
 * Returns a mixed-language sample per title; we filter to the wanted codes.
 * Download URLs are plain UTF-8 .srt on subs*.strem.io (no gzip). */
async function stremioOsSearch(type, imdb, season, episode, langs) {
  const want = langs && langs.length ? langs : ['sin', 'eng'];
  const path = (type === 'series'
    ? 'series/' + imdb + ':' + Math.max(1, season || 1) + ':' + Math.max(1, episode || 1)
    : 'movie/' + imdb) + '.json';
  const res = await fetch('https://opensubtitles-v3.strem.io/subtitles/' + path, {
    headers: { 'User-Agent': SUBDL_UA, 'Accept': 'application/json' },
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined,
  });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  const arr = j && Array.isArray(j.subtitles) ? j.subtitles : [];
  return arr
    .filter((s) => s && s.url && want.indexOf(String(s.lang || '')) >= 0)
    .map((s) => ({
      provider: 'stremio-opensubtitles',
      id: String(s.id || ''),
      url: String(s.url).replace(/^http:\/\//i, 'https://'),
      lang: String(s.lang || ''),
      release: s.subtitleFileName || s.movieReleaseName || '',
      fileName: s.subtitleFileName || '',
      format: 'srt',
      hearingImpaired: false,
      downloads: 0,
    }))
    .slice(0, 40);
}

async function subdlSearch(imdb, season, episode, lang, apiKey) {  if (!apiKey) return []; // needs the user's key — Worker secret SUBDL_API_KEY or X-SubDL-Key
  const q = new URLSearchParams({ imdb_id: imdb, languages: 'si,en', dl: '1' });
  if (season) q.set('season', String(season));
  if (episode && episode > 0) q.set('episode', String(episode));
  const res = await fetch('https://api.subdl.com/api/v1/subtitles?' + q.toString(), {
    headers: { 'User-Agent': SUBDL_UA, 'X-SubDL-Key': apiKey },
    redirect: 'manual',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined,
  });
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  const arr = j && j.subtitles ? j.subtitles : [];
  return arr.slice(0, 40).map((s) => ({
    provider: 'subdl',
    id: String(s.id || ''),
    url: s.url ? (/^https?:\/\//.test(s.url) ? s.url : 'https://dl.subdl.com' + s.url) : '', // .zip download — fetched server-side
    lang: s.language || 'si',
    release: s.release_name || s.name || '',
    fileName: s.release_name || s.name || '',
    format: 'srt',
    hearingImpaired: false,
    downloads: 0,
  })).filter((r) => r.url);
}

/** piratelk.com listing pages — robots.txt is honoured before any hint is returned. */
async function pirateLkSearch(imdb, titleHint) {
  try {
    const rb = await fetch('https://piratelk.com/robots.txt', {
      headers: { 'User-Agent': SUBDL_UA },
      redirect: 'manual',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (rb.ok) {
      const txt = await rb.text();
      if (/^\s*Disallow:\s*\/\s*$/m.test(txt)) return []; // site-wide disallow → stay out
    }
    // NOTE: piratelk results are page-structured, not an API; the worker returns them
    // only as {provider:'piratelk', url:<listing page>} hints the Bridge can open.
    if (!titleHint) return [];
    return [{ provider: 'piratelk', id: 'hint', url: 'https://piratelk.com/?s=' + encodeURIComponent(titleHint), lang: 'si', release: titleHint, format: 'zip', hearingImpaired: false, downloads: 0 }];
  } catch (e) {
    return [];
  }
}

/** gunzip / unzip / passthrough → raw subtitle bytes + entry name. All paths capped. */
async function decompressAny(bytes) {
  if (isGzip(bytes)) return { bytes: await gunzipCapped(bytes), name: '' };
  if (isZip(bytes)) {
    const best = await unzipBest(bytes);
    if (!best) throw new Error('no subtitle entry inside zip');
    return { bytes: best.bytes, name: best.name };
  }
  if (bytes.length > MAX_UNCOMPRESSED_BYTES) throw new Error('subtitle file too large');
  return { bytes, name: '' };
}

/** Download + extract + normalize ONE upstream subtitle → clean UTF-8 SRT string.
 * Handles .gz (OpenSubtitles) and .zip (SubDL/piratelk) and plain .srt/.vtt. */
async function fetchUpstreamSub(url, opts) {
  const got = await safeFetchBytes(url, opts);
  const data = await decompressAny(got.bytes);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data.bytes);
  return toCleanSrt(text).text;
}

// ─────────────────────────────────────────────────────────────────────────────
// responses
// ─────────────────────────────────────────────────────────────────────────────

const JSON_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
const SRT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/x-subrip; charset=utf-8',
  'Cache-Control': 'public, max-age=86400',
  'X-Content-Type-Options': 'nosniff',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: JSON_HEADERS });
}

function b64ToBytes(b64) {
  const s = atob(String(b64 || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Runtime limits + the provider allowlist, as a FUNCTION rather than exported constants:
 * a module Worker may only export functions / handlers, so `export const MAX_…` makes workerd
 * throw "Incorrect type for map entry … is not of type 'function or ExportedHandler'".
 * (Caught by `wrangler dev`; `wrangler deploy --dry-run` does NOT catch it.)
 */
function limits() {
  return {
    maxPublishBytes: MAX_PUBLISH_BYTES,
    maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
    maxUpstreamBytes: MAX_UPSTREAM_BYTES,
    tokenLength: TOKEN_LEN,
    ttlSeconds: TTL_SECONDS,
    allowedHosts: DEFAULT_ALLOWED_HOSTS.slice(),
  };
}

export {
  TOKEN_LEN, TTL_SECONDS, MAX_UPSTREAM_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_PUBLISH_BYTES,
  MAX_B64_CHARS, MAX_REDIRECTS, UPSTREAM_TIMEOUT_MS, CACHE_STORE_ORIGIN, DEFAULT_ALLOWED_HOSTS,
  hexOf, sha256Hex, isGzip, isZip, zipEntries, isSubtitleEntry, entryRank, pickBestEntry,
  readStreamCapped, readResponseCapped, gunzipCapped, inflateEntry, unzipBest, toCleanSrt,
  parseSrtCues, reassembleSrt, isPrivateHost, hostAllowed, assertSafeUpstreamUrl, safeFetchBytes,
  hasStorage, cacheStore, publishSrt, isValidToken, getSrt, OS_UA, SUBDL_UA,
  openSubsSearch, stremioOsSearch, osRestBase, subdlSearch, pirateLkSearch, decompressAny, fetchUpstreamSub,
  JSON_HEADERS, SRT_HEADERS, json, b64ToBytes, limits,
};
