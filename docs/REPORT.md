# AnantPlay Sinhala Subtitle Bridge — AUDIT & VERIFICATION REPORT (v2.1)

**Zero-fork, official-AnantPlay-only.** Companion for `me.champdev.weblock` v2.23.1 (`be74df2`):
every subtitle is delivered at a **REAL HTTP 200 `.srt` URL**, never a Service-Worker ghost URL
that ExoPlayer answers with 404.

This report covers the v2.1 hardening pass: full line-by-line audit of the V2 archive, upstream
schema verification against the real AnantPlay source, security fixes (SSRF / zip-bomb / payload
caps), CI repair, and the verified test/CI numbers.

---

## 1 · Why real HTTP matters (the v1 fatal bug)

1. `PlayerActivity` builds its subtitle track through `DefaultDataSource.Factory(this, web)`
   (`PlayerActivity.java:1104`) — ExoPlayer's own Java HTTP stack, **outside the WebView**. It
   cannot read Service-Worker Cache Storage; a SW-only `/si.srt` URL simply 404s.
2. In Android WebView, requests served by a Service Worker **bypass
   `WebViewClient.shouldInterceptRequest`** (`WebActivity.java:443-444`), so `Sniffer.request()`
   (`Sniffer.java:105-110`) may never see the URL to capture either.

### The v2 architecture

```
Bridge page (in AnantPlay's WebView)          Backend (real HTTP, user's choice)
──────────────────────────────                ──────────────────────────────────
search / translate / upload  ──POST /api/*──▶ Cloudflare Worker  (free tier, 1 deploy)
                                             ├─ GET  /sub/<token>.srt → 200, x-subrip, UTF-8, CORS *
                                             ├─ POST /api/publish-srt  → KV / Cache, SHA-256 dedupe, 24 h TTL
                                             ├─ GET  /api/search      → OpenSubtitles + SubDL + piratelk
                                             └─ POST /api/fetch-sub   → .gz/.zip → best .srt → publish
                          ── same routes───▶  local-server/server.py (pure stdlib, LAN/Termux)
                                             └─ GET /sub/<token>.srt → 200 (cleartext OK —
                                                AndroidManifest.xml:19 usesCleartextTraffic="true")
```

The Bridge page `fetch()`es the real `/sub/<token>.srt` URL — a genuine network request
`shouldInterceptRequest` sees, so `Sniffer.request()` records it; when the stream is handed off,
`PlayerActivity` passes it to ExoPlayer, which downloads the **same real HTTP 200 file**. Both
sides of the seam speak HTTP, so it cannot 404.

---

## 2 · AnantPlay v2.23.1 schema — verified against the real source

Checked by cloning `AnantPlay/android` @ `be74df2` and reading the parsers (not from memory):

| Endpoint | Real parser | Shape we now emit |
| --- | --- | --- |
| `/index.json` | `Sources.parseIndex` — `{"sources":[{id,name,type,url}]}`, `url` must match `(?i)https?://.+`, known types `sites\|playlist\|deeplinks` | `{"sources":[sites…, deeplinks…]}` with both absolute URLs on the live origin |
| `/sites.json` | `Sites.merge` over `Cats.KEYS = movies,tv,sports,anime,live,more`; `s.index = o.optBoolean("index")`; `name` non-empty, `url` http(s) | `{"rows":{"more":[{name,url,index:true,tags,group}]},"languages":{"Sinhala":[…]}}` — `index` is a **real JSON boolean** |
| `/deeplinks.json` | `Sites.deeplinks()` merges `{host: {movie,tv,episode,anime}}`; `Sites.link()` looks up `hostOf(siteUrl)` (hostname, `www.` stripped) then fills `{tmdb}{imdb}{season}{episode}` | `{"<bridge-hostname>": {movie,tv,episode}}` |
| `.srt` capture | `Sniffer.request()` — any `.vtt`/`.srt` request from the WebView (`subs.size() < 8`) | the Bridge fetches `/sub/<token>.srt` before handoff |

### Schema bugs found in the shipped V2 archive (both fixed)

1. **`/sites.json` had no `rows.more`** and used a non-existent `series` key, so AnantPlay's
   `Sites.parse` found nothing to display. `index` was absent entirely.
2. **`/deeplinks.json` was a flat `{movie,tv,episode}` object.** `Sites.hostOf()`-keyed lookup
   would never match, so Title Links could never pre-fill the Bridge. Now keyed by hostname.
3. `index.json` used `"languages": "Sinhala, English"` — `Sources` treats `languages` as a
   **playlist URL** and would try to download that string as an `.m3u`. Removed.
4. AnantPlay does **not** auto-add sources marked `default` (that flag only drives the legacy
   migration), so the setup docs now say to tap **Add** on both sources.

---

## 3 · Audit log — every defect found in the V2 archive and the patch applied

### 3.1 Deployment / CI / hygiene (Gate 1, 2, 7)

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| A1 | `wrangler.toml` had **no `[assets]` section** | A deployed Worker served **no UI at all** — `/`, `/app.js`, `/style.css` returned the "deploy with [site] assets" 404 text. Silent: `wrangler deploy --dry-run` passed because nothing was validated. | `[assets] directory = "./bridge-ui/public" binding = "ASSETS"`; dry-run now reports `✨ Read 3 files from the assets directory` + `env.ASSETS Assets` |
| A2 | KV binding defaulted to `id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"` | `wrangler deploy` fails for anyone who follows "deploy first, KV later"; `--dry-run` cannot catch it | KV block commented out → **zero-config deploy works**; worker falls back to the Cache API at runtime |
| A3 | Missing `env.SUBS_KV` threw / 503'd every write | First-run experience broken without KV | `hasStorage()` + Cache API publish/get fallback; no unhandled `TypeError` |
| A4 | Empty `[triggers]` table with only comments | Wrangler config noise | removed |
| A5 | `.gitignore` lacked `dist/`, `*.zip`, `.env` | Deploy archives / secrets could get committed | added (`*.zip` with a `!tests/fixtures/*.zip` exception for the test fixture) |
| A6 | CI used `npx wrangler` (floating download), no `package-lock.json`, redundant background server | Non-reproducible; two servers started for one test module | `wrangler@4.166.0` pinned as devDependency + committed `package-lock.json` + `npm ci`; background server removed; explicit steps for worker/fixtures/security/py tests |
| A7 | `/api/publish-srt` b64 branch did `body instanceof FormData` **after** `request.json()` had consumed the body | Multipart upload always failed with "body used" | content-type dispatch first; multipart handled properly (tested) |
| A8 | **The Worker exported constants** (`MAX_PUBLISH_BYTES`, `MAX_UNCOMPRESSED_BYTES`, `DEFAULT_ALLOWED_HOSTS`) | workerd refuses to boot: `Uncaught TypeError: Incorrect type for map entry 'MAX_PUBLISH_BYTES'`. A module Worker may only export functions/handlers. **`wrangler deploy --dry-run` does NOT catch this**, so CI would have been green over a 100%-broken deployment | constants are internal; exposed through a `limits()` **function**; `security.test.js` now asserts every named export is a function |

### 3.2 Security (Gate 4) — the serious ones

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| S1 | `/api/fetch-sub` validated only `^https?://` | **Full SSRF**: any caller could make the worker fetch `http://169.254.169.254/`, `http://127.0.0.1:…`, internal hosts, then read the response back through the published `.srt` | strict host allowlist (`opensubtitles.org/.com`, `subdl.com/.org`, `piratelk.com` + subdomains), HTTPS-only, no credentials, ports 443/80 only, and `isPrivateHost()` rejecting loopback/RFC1918/CGNAT/link-local/metadata/IPv6/`.local`/`.internal`; **every redirect hop re-validated** via `redirect: 'manual'` |
| S2 | No cap on upstream download or decompressed size | gzip/zip bomb → isolate OOM (worker) / memory exhaustion (server) | 5 MB cap on the download (declared + streamed), 5 MB cap on every gunzip/unzip; zip entries whose declared `usize` exceeds the cap can never be *selected*, and a second cap applies while inflating |
| S3 | No cap on `/api/publish-srt` payload | 100 MB body → memory blow-up | 2 MB subtitle cap (413), base64 envelope pre-check, `Content-Length` pre-check on the Python side |
| S4 | Uploaded `.zip` via b64 was never decompressed in the Worker (Python did) | Same file worked on LAN but failed on Cloudflare — parity bug | shared `decompressAny()` used by both upload legs |
| S5 | ZIP entries with `/etc/...`, `C:\...` were "acceptable" names | Defence in depth for any future on-disk extraction | `isSubtitleEntry`/`_candidate_ok` reject absolute paths and drive letters, in addition to `..` and `__MACOSX/` |
| S6 | `app.js` used `innerHTML` for list/status text | Any future interpolation of provider metadata would be an XSS sink | all DOM built with `textContent`; regression test scans the file (comments stripped) |
| S7 | Gemini/SubDL keys were not persisted at all, and there was no model override | Not a leak — but the brief requires localStorage-only keys + configurable model | keys saved to `localStorage` on `change`, never logged (regression test greps for `console.*` and `AIza…`), model field with `^[A-Za-z0-9._-]{2,64}$` validation |
| S8 | Python `_origin()` trusted the `Host` header verbatim | Host-header injection into generated catalog URLs | validated against `^(host|\[ipv6\])(:port)?$`, falls back to the bound address |
| S9 | Python `int(q.get("season"))` raised on junk input | 500 instead of 400 | `_safe_int()` clamp |
| S10 | TLS/HTTP fetch had no timeout | Hanging upstream pinned a worker/server thread | 15 s (`AbortSignal.timeout` / urllib `timeout`) |

### 3.3 Correctness / UX

| # | Defect | Fix |
| --- | --- | --- |
| C1 | Translation accepted a batch with a different cue count and silently fell back to the English text | strict validation: cue count must match, timestamps must be byte-identical, no empty cues; one retry, then abort **without publishing** |
| C2 | Final assembly was never re-validated | cue count + every timestamp re-checked on the assembled SRT before publishing |
| C3 | `String.fromCharCode.apply(null, wholeFile)` overflowed on real subtitle sizes | chunked base64 encoder (32 KB chunks) |
| C4 | Upload had no `catch` (silent failure), no size guard | error paths + 5 MB client guard |
| C5 | `input` elements were given `tabindex="-1"` | un-focusable on a TV remote; now `tabindex="0"` everywhere |
| C6 | `openSubsSearch` swallowed provider failures silently | `/api/search` now returns `failed: [...]`, shown in the UI |

---

## 4 · Verification logs (this session, on the exact packaged tree)

### 4.1 Node suites — 121 PASS / 0 FAIL

```
$ node tests/run-all.js
fixtures.test.js: 18 PASS / 0 FAIL ✅
security.test.js: 48 PASS / 0 FAIL ✅
worker.test.js:   55 PASS / 0 FAIL ✅
──────────────────────────────────────────
run-all.js — 3 files · 121 PASS / 0 FAIL
```

`security.test.js` covers: 30 unsafe URLs rejected (scheme/credentials/port/IP-literal/loopback/
RFC1918/CGNAT/link-local/metadata/suffix-trick), legitimate provider URLs accepted, no network call
dispatched for a blocked URL, redirect-to-loopback blocked, allowlisted redirect followed,
6 MB upstream refused, 40 MB zip-bomb entry never selected, 8 MB gzip bomb refused, `..`/absolute/
drive-letter entry names rejected, >2 MB publish → 413 with nothing stored, Cache-API fallback
publishes and serves 200 with no KV, no `sw.js`/`serviceWorker` anywhere, no Node-only API in the
worker bundle, `app.js` free of `innerHTML`/key logging/hardcoded keys.

### 4.2 Python real-HTTP end-to-end — 20/20

```
$ python3 -m unittest discover -s tests -p 'local_server_test.py' -v
test_01_publish_returns_real_srt_url ... ok
test_02_get_sub_returns_real_http_200_sinhala ... ok      (200, application/x-subrip; charset=utf-8, CORS *)
test_03_get_by_full_url_through_plain_http ... ok         (plain urllib GET — exactly ExoPlayer's fetch)
test_04_sha256_dedupe_same_content_same_token ... ok
test_05_publish_b64_zip_upload ... ok                     (best .srt extracted; __MACOSX junk skipped)
test_06_publish_b64_gz_upload ... ok
test_07_multipart_file_upload ... ok
test_08_unknown_token_is_404_but_published_never ... ok
test_09_bad_publish_rejected ... ok
test_10_index_json_dynamic_with_live_host ... ok
test_11_sites_and_deeplinks_json ... ok                   (rows.more index is a bool; deeplinks host-keyed)
test_12_bridge_ui_served ... ok
test_13_search_validates_imdb ... ok
test_14_cors_preflight ... ok
test_15_gemini_test_health ... ok
test_16_fetch_sub_blocks_ssrf ... ok                      (8 hostile URLs → 400)
test_17_fetch_sub_allows_provider_hosts ... ok
test_18_publish_size_cap ... ok                           (413)
test_19_bad_token_is_404_and_published_still_200 ... ok
test_20_head_request_on_srt ... ok
Ran 20 tests — OK
```

### 4.3 Wrangler dry-run (no Cloudflare secrets)

```
$ npx wrangler deploy --dry-run
✨ Read 3 files from the assets directory .../bridge-ui/public
Total Upload: 25.85 KiB / gzip: 7.66 KiB
Your Worker has access to the following bindings:
env.ASSETS         Assets
--dry-run: exiting now.
```

### 4.4 Upstream patch pack (pristine `AnantPlay/android` @ `be74df2`)

```
$ git apply --check pr-patch/01-subdl-provider.patch      # exit 0
$ git apply --check pr-patch/02-local-srt-picker.patch    # exit 0
$ git apply 01… && git apply 02…                          # both applied, in order
 src/me/champdev/weblock/SubDl.java         | 81 ++ (new)
 src/me/champdev/weblock/Subs.java          | 14 +
 test/SubDlTest.java                        | 112 ++ (new)
 res/values/strings_player.xml              |  1 +
 src/me/champdev/weblock/PlayerActivity.java| 43 +
 src/me/champdev/weblock/SubFetch.java      | 37 +
```
Java 8 style throughout (no `var`, no `List.of`, no `String.repeat`). Optional: not required to use
the bridge.

### 4.5 Real Workers runtime boot (`wrangler dev`, not just `--dry-run`)

```
GET /                200 text/html        (asset layer)
GET /app.js          200 text/javascript  (asset layer)
GET /style.css       200 text/css         (asset layer)
GET /index.json      200 {"sources":[sites…, deeplinks…]}
GET /sites.json      200 rows.more[{index:true}], languages.Sinhala
GET /deeplinks.json  200 {"127.0.0.1":{movie,tv,episode}}
POST /api/publish-srt 200 (NO KV bound → Cache API fallback) → /sub/abb72a335267e04f.srt
GET /sub/abb72a335267e04f.srt 200 application/x-subrip; charset=utf-8 · ACAO * · nosniff
POST /api/fetch-sub {"url":"http://169.254.169.254/…"} → 400 "only https upstream URLs are allowed"
GET /sub/ZZZZZZZZZZZZZZZZ.srt → 404 (never a storage lookup)
```

Cross-backend dedupe parity: the same CRLF input hashes to the **same token**
(`abb72a335267e04f`) through both the Worker and `server.py`, so identical content is one file
whichever mode you deploy.

**Totals: 121 Node + 20 Python = 141 checks PASS, 0 FAIL, 0 skipped, 0 404 on any published subtitle.**

---

## 5 · Repository layout

```
.github/workflows/ci.yml     syntax gates + worker/fixtures/security tests + python e2e + wrangler dry-run
bridge-ui/public/            index.html · app.js · style.css (D-pad, deeplink auto-fill, search,
                            Gemini translate, upload, 3 handoff modes, Mux demo)
docs/                        REPORT.md · SETUP-EN.md · SETUP-SI.md
local-server/server.py       pure-stdlib LAN/Termux server (same endpoints, port 8765)
pr-patch/                    01-subdl-provider.patch · 02-local-srt-picker.patch
tests/                       worker.test.js · fixtures.test.js · security.test.js ·
                             local_server_test.py · run-all.js
tests/fixtures/              synthetic Sinhala/English fixtures + pack.zip + make-fixtures.mjs
worker/src/index.js          Cloudflare Worker (UI + /api/* + real /sub/<token>.srt)
wrangler.toml · package.json · package-lock.json · tsconfig.json · .gitignore
```

No `.zip` archive is tracked in this repository; `tests/fixtures/pack.zip` is a 752-byte synthetic
ZIP used by the extraction tests (allowlisted in `.gitignore`).

## 6 · Deployment

See `docs/SETUP-EN.md` (Cloudflare, ~2 minutes, free tier) or `docs/SETUP-SI.md` (සිංහල, LAN/Termux
ඇතුළුව). Both end with the same flow: add the index in AnantPlay → add both sources → open the
Bridge from a Title Link → search/translate/upload → the real `.srt` URL is captured by the
Sniffer → play.
