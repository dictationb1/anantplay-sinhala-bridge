# AnantPlay Sinhala Subtitle Bridge — v3 (zero-fork Companion API)

Zero-fork companion for [AnantPlay](https://github.com/AnantPlay/android) (official v2.23.1, commit
`be74df2`): search, machine-translate (EN→SI with a worker-secret Gemini key) or upload Sinhala
subtitles and hand AnantPlay's **native player** a REAL HTTP 200 `.srt` URL — never a Service-Worker
ghost URL that 404s inside ExoPlayer.

**v3** adds the API that powers the standalone
[anantplay-si-companion](https://github.com/dictationb1/anantplay-si-companion) Android app
(the floating-pill, cue-locked overlay for the 100% official, unmodified APK):

| Endpoint | What it does |
| --- | --- |
| `GET /api/resolve?title=Clayface&type=movie` | Cinemeta resolve → IMDb id + clean title/year |
| `GET /subtitles/movie/tt34890576.json?title=…` | **human Sinhala first** (OpenSubtitles `sin` — ChameE/Baiscope — then the Stremio addon, then SubDL `si`); if none exists, starts a **Gemini Flash full-movie translation job** (4–6 large context batches, cue-count + byte-identical-timestamp validator). 200 + `status` always; Stremio-addon-shaped `subtitles[]` included. |
| `GET /api/paired/movie:tt34890576:0:0.json` | the **<10 ms cue-lock payload**: `{i,t0,t1,en,enf,si}` for every cue — `enf` is pre-flattened with AnantPlay's exact `showCues()` rule (PlayerActivity.java:356-358). 202 with progress while translating. |
| `GET /sub/<token>.srt` | real HTTP 200 UTF-8 SRT; the job's **deterministic** token answers **202 `{status, progress, eta_sec}`** while the Sinhala translation is still running. |
| `GET /api/status` · `GET /health` | storage mode + which worker secrets are configured (booleans only — no key material). |
| `GET /api/search` · `/api/fetch-sub` · `/api/publish-srt` | kept from v2.1 (server-side UA, gz/zip extraction, real .srt publishing) |
| `GET /index.json` · `/sites.json` · `/deeplinks.json` | AnantPlay "Add source" catalogs (live-host generated) |

Finished jobs are a **permanent cache** (bind KV): the second fetch of the same movie is a KV
read away — measured **< 200 ms** in the live lab.

## Quick start

**Cloudflare (free, ~2 min, no KV required):**
```bash
npm ci && npx wrangler login && npx wrangler deploy
```
**Enable AI translation (recommended, no key is ever typed on a phone):**
```bash
npx wrangler secret put GEMINI_API_KEY    # free key: aistudio.google.com/apikey
npx wrangler secret put SUBDL_API_KEY     # optional: the SubDL 'si' provider
npx wrangler kv namespace create SUBS_KV  # optional but recommended: permanent job cache
# paste the printed id into wrangler.toml's [[kv_namespaces]] block, then:
npx wrangler deploy
```
**LAN / Termux / Windows (zero cloud):**
```bash
python3 local-server/server.py        # → http://<LAN-IP>:8765/
```
Then in AnantPlay: **Settings → Sources → Add an index by link** →
`https://<your-worker>/index.json` (or `http://<LAN-IP>:8765/index.json`) and tap **Add** on both
listed sources (`sites` + `deeplinks`). See [`docs/SETUP-EN.md`](docs/SETUP-EN.md) /
[`docs/SETUP-SI.md`](docs/SETUP-SI.md). The dashboard at `/` is a clean **Status & Secret
Verification** page (quick title test proves the whole chain); the manual `.srt/.zip/.gz`
publishing and optional per-browser keys moved to the second tab.

## Repo map

| Path | What |
| --- | --- |
| `worker/src/index.js` | the router: all endpoints above + static UI |
| `worker/src/pipeline.js` | v3 engine: Cinemeta, job store, Gemini batch translation, paired cues |
| `worker/src/lib.js` | SSRF-safe fetch, SRT/ZIP/GZ parsing, providers, KV/Cache storage |
| `local-server/server.py` | pure-stdlib LAN server, the v2.1 endpoints on port 8765 |
| `bridge-ui/public/` | the clean status dashboard (tabs: Status · Manual/Emergency) |
| `lab/verify_worker_e2e.mjs` | **the LIVE end-to-end lab** (see below) |
| `pr-patch/` | two `git apply --check`-verified upstream patches (`be74df2`) — optional |
| `tests/` | worker (55), **pipeline (61)**, security (48), fixture (18) — all green |
| `docs/` | `REPORT.md` (audit + verification logs), `SETUP-EN.md`, `SETUP-SI.md` |

## Security model (unchanged from v2.1's hardened baseline, re-verified)

- `/api/fetch-sub` and every provider download go through the **strict allowlist**
  (opensubtitles / strem.io / subdl / piratelk), HTTPS-only, no credentials/odd ports, and
  loopback / RFC1918 / CGNAT / link-local (`169.254.169.254`) / `.local` / `.internal` hosts
  rejected — re-validated on **every redirect hop** (the legacy `http://` download links are
  upgraded, never followed raw; captcha redirects are refused, and the next candidate file is
  tried instead).
- 5 MB caps on downloads *and* on every gunzip/unzip (zip-bomb safe); 2 MB cap on uploads (413);
  archive entries with `..`, absolute paths or `C:\` are ignored.
- `/sub/<token>.srt` matches only a strict 16-hex token, so storage keys are not enumerable.
- The **Gemini key never leaves the worker** (a Worker secret); `/api/status` exposes only a
  boolean. The dashboard's optional per-browser keys stay in `localStorage`, are sent as request
  headers only, never logged, and all external metadata is rendered with `textContent`.

## Verify everything yourself

```bash
npm ci
node tests/run-all.js                                                # 182 PASS / 0 FAIL
node lab/verify_worker_e2e.mjs                                       # LIVE lab: real wrangler dev,
                                                                     #   real OpenSubtitles downloads,
                                                                     #   mock Gemini (no key needed)
node lab/verify_worker_e2e.mjs --target https://anantplay-si-subs-bridge.techworldlk.workers.dev
GEMINI_API_KEY=… node lab/verify_worker_e2e.mjs --use-real-gemini   # real Gemini translation
python3 -m unittest discover -s tests -p 'local_server_test.py' -v  # 20 OK (real HTTP 200 .srt)
npx wrangler deploy --dry-run                                        # assets + bindings, no secrets
git clone https://github.com/AnantPlay/android && cd android
git apply --check ../pr-patch/01-subdl-provider.patch                # ✅
git apply --check ../pr-patch/02-local-srt-picker.patch              # ✅
```

The live lab boots the real worker (`wrangler dev`) and proves, with hard assertions: The Dark
Knight's **live human Sinhala** (ChameE) delivered as a real 200 `.srt`; the full **Clayface
EN→SI job** on the real OnlyFlix English file (202 → 200 on `/sub/<token>.srt` AND
`/api/paired/<jobId>.json`, cue count identical, **every timestamp byte-identical**, Sinhala
script present, cached second fetch **< 200 ms**); and a re-run of the entire offline suite
(48+ security checks included). Two honest notes baked into the lab: `rest.opensubtitles.org`
rate-limits (403) and `dl.opensubtitles.org` captcha-gates heavy IPs, so the lab replays the
**search** documents via a loopback mirror (fetched live with curl) while every **download**
stays 100% real from the worker, and third-party outages surface as visible `⚠ SKIPPED (live)`
lines — never as silent passes.

No `.zip` archive is tracked here; the subtitle fixtures in `tests/fixtures/` are **synthetic
Sinhala text** (no copyrighted subtitle content ships with this repo), and
`tests/fixtures/pack.zip` is a tiny synthetic archive used by the extraction tests.
