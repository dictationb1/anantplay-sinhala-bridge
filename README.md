# AnantPlay Sinhala Subtitle Bridge — v4.1 (multi-language, cinema-grade, zero-429)

**v4.1** turns the zero-429 engine into a **universal 18-language subtitle bridge** with
**two-stage instant delivery**:

1. **Stage 1 — base NMT, playable immediately.** As soon as the cascade finishes, a validated
   `.srt` is served with `X-Sub-Quality: base-nmt` and `X-Polish-Status: pending`.
2. **Stage 2 — cinema polish, same token.** A resumable LLM-only pass (≤3 calls, `providerKind:
   'llm'`) rewrites the ~20% of cues that need it (idioms, slang, sarcasm, stiff-literary
   Sinhala) and hot-swaps the SAME `/sub/<token>.srt` in place (`X-Polish-Status: done`). A
   per-cue validator falls back to the clean NMT draft if a polished cue is garbled, and **any
   polish failure leaves the published base .srt intact** — the player never loses subtitles.

The translation chain is a **legitimate multi-provider failover** —
`translate-pa (optional) → azure → google_v3 → gemini → workers_ai` — with a 10-minute
per-provider circuit breaker, single-flight job locks (no duplicate jobs from polls), compact
paced batching (3–4 requests per 1,500-cue movie on the chain head) and a permanent KV cache
(re-watches cost zero quota). One legitimate key per provider; no multi-account farming (Google
ToS risk).

Zero-fork companion for [AnantPlay](https://github.com/AnantPlay/android) (official v2.23.1,
commit `be74df2`): hand the app's **native player** a REAL HTTP 200 `.srt` URL — never a
Service-Worker ghost URL that 404s inside ExoPlayer.

## Supported languages (18)

`si` සිංහල · `ta` தமிழ் · `hi` हिन्दी · `en` English · `es` Español · `fr` Français · `ja` 日本語 ·
`ko` 한국어 · `zh-CN` 中文 · `ar` العربية · `ur` اردو · `de` Deutsch · `ru` Русский · `pt` Português ·
`th` ไทย · `id` Bahasa Indonesia · `tr` Türkçe · `vi` Tiếng Việt

Each entry carries its **OpenSubtitles ISO-639-2B** code (`sin`, `tam`, `chi` …), **SubDL** code,
**NMT ISO-639-1** code, **script class**, **RTL flag** (`ar`, `ur`) and a **per-script line
budget** (CJK 18 chars, Sinhala/Latin 42, Tamil/Hindi 38 …). Ask for any of them on every endpoint:

```bash
GET /subtitles/movie/tt34890576.json?lang=ta&register=auto     # auto | spoken | formal
POST /api/subs-direct   {"srt":"…", "lang":"ja", "register":"spoken"}
GET /api/paired/movie:tt34890576:0:0:ta.json                   # :lang suffix (si = bare v4 id)
```

`si` keeps the **bare v4 job ids** (`movie:tt34890576:0:0`) so every existing Companion/player
install keeps working unchanged; other languages get a `:lang` suffix.

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /api/resolve?title=Clayface&type=movie` | Cinemeta resolve → IMDb id + clean title/year |
| `GET /subtitles/movie/tt34890576.json?lang=…&register=…` | **human subs first** (OpenSubtitles `sin`/`tam`… — ChameE/Baiscope — then the Stremio addon, then SubDL); if none exists, starts a **multi-provider translation job** (3–4 compact batches, cue-count + byte-identical-timestamp validator). 200 + `status` always; Stremio-addon-shaped `subtitles[]` included. |
| `GET /api/paired/movie:tt34890576:0:0.json` | the **<10 ms cue-lock payload**: `{i,t0,t1,en,enf,si}` for every cue — `enf` pre-flattened with AnantPlay's exact `showCues()` rule. 202 with progress while translating. Accepts the optional `:lang` suffix. |
| `GET /sub/<token>.srt` | real HTTP 200 UTF-8 SRT + `X-Sub-Quality` / `X-Polish-Status` / `X-Sub-Lang`; the job's **deterministic** token answers **202 `{status, progress, eta_sec}`** while the base translation is still running. |
| `POST /api/subs-direct` `{srt, name?, lang?, register?}` | translate a cast-supplied English `.srt` (AnantPlay's own `subs` extra / a side-loaded file) — deterministic content-hash cache, same failover chain |
| `GET /api/status` · `GET /health` | storage mode + provider chain (booleans only — no key material) + language registry + **loud storageWarn** when `SUBS_KV` is not bound |
| `GET /api/search` · `/api/fetch-sub` · `/api/publish-srt` | kept from v2.1 (server-side UA, gz/zip extraction, real .srt publishing) |
| `GET /index.json` · `/sites.json` · `/deeplinks.json` | AnantPlay "Add source" catalogs (live-host generated) |

Finished jobs are a **permanent cache** (bind KV): the second fetch of the same movie is a KV
read away — measured **< 50 ms** in the live lab.

## Setup — the 2-minute Cloudflare deploy

```sh
npm ci && npx wrangler login

# KV (permanent job cache + resumable polish) — free forever
npx wrangler kv namespace create SUBS_KV        # prints id = "…" → paste into wrangler.toml

# ONE legitimate key per provider (unconfigured providers are skipped automatically)
npx wrangler secret put AZURE_TRANSLATOR_KEY    # Azure AI Translator F0 — 2,000,000 chars/MONTH free (the workhorse)
npx wrangler secret put AZURE_TRANSLATOR_REGION # optional (default global), e.g. eastus
npx wrangler secret put GOOGLE_V3_KEY           # Google Cloud Translation — 500,000 chars/month free
npx wrangler secret put GEMINI_API_KEY          # Gemini free tier ≈1,500 RPD shared (the cinema polish LLM)
npx wrangler secret put SUBDL_API_KEY           # optional human-subs provider

npx wrangler deploy
```

Optional Layer-1 accelerator (**OFF by default** — undocumented Google endpoint, env-gated):

```sh
npx wrangler secret put TRANSLATE_PA_KEY        # or use TRANSLATE_PA_KEY_HEAD/TAIL vars
# wrangler.toml → [vars]  ENABLE_TRANSLATE_PA = "true"
npx wrangler deploy
```

`TRANSLATION_CHAIN` (var) overrides the order. **No key literal is ever committed** — the repo
carries zero `AIza…` strings (CI enforces it). Every provider is ONE legitimate account/key: see
[docs/SETUP-EN.md](docs/SETUP-EN.md) for the honest ToS notes on multi-account farming (don't).

**No KV at all?** The worker still boots and serves — `/health` reports `status: "degraded"` and
`/api/status` carries a loud `storageWarn` naming the exact fix. Jobs then live inside one isolate
and vanish on restart; that must never be a mystery again.

**LAN / Termux / Windows (zero cloud):**
```bash
python3 local-server/server.py        # → http://<LAN-IP>:8765/
```

Then in AnantPlay: **Settings → Sources → Add an index by link** →
`https://<your-worker>/index.json` (or `http://<LAN-IP>:8765/index.json`) and tap **Add** on both
listed sources (`sites` + `deeplinks`). See [`docs/SETUP-EN.md`](docs/SETUP-EN.md) /
[`docs/SETUP-SI.md`](docs/SETUP-SI.md). The dashboard at `/` is a clean **Status & Secret
Verification** page (quick title test proves the whole chain).

## Repo map

| Path | What |
| --- | --- |
| `worker/src/index.js` | the router: endpoints above, static UI, module-Worker entry (exports functions only) |
| `worker/src/languages.js` | the 18-language registry (OS/SubDL/NMT codes, scripts, RTL, line budgets) |
| `worker/src/providers.js` | translate-pa · Azure · Google v3 · Gemini · Workers AI + failover chain & 10-min breakers |
| `worker/src/cinema.js` | register decision, deterministic cue flagger, two-input polish prompt, per-cue validator |
| `worker/src/pipeline.js` | Cinemeta, job store, paced batching, two-stage publish, resumable cinema polish |
| `worker/src/lib.js` | SSRF-safe fetch, SRT/ZIP/GZ parsing, providers, KV/Cache storage |
| `local-server/server.py` | pure-stdlib LAN server, the v2.1 endpoints on port 8765 |
| `bridge-ui/public/` | the status dashboard (tabs: Status · Manual/Emergency) |
| `lab/verify_worker_v41_e2e.mjs` | **live lab**: 18-language + translate-pa + two-stage (35 assertions) |
| `lab/verify_worker_v4_e2e.mjs` | **live lab**: zero-429 failover + permanent cache (27 assertions) |
| `lab/verify_worker_e2e.mjs` | the original v2.1/v3 live lab (real downloads, mock Gemini) |
| `pr-patch/` | two `git apply --check`-verified upstream patches (`be74df2`) — optional |
| `tests/` | worker 55 · pipeline 61 · providers 38 · security 50 · v41 16 · fixtures 18 = **238 checks** |
| `docs/` | `RELEASE_REPORT_v4.1_v2.2.md`, `REPORT.md`, `SETUP-EN.md`, `SETUP-SI.md` |

## Security model (unchanged hardened baseline, re-verified)

- `/api/fetch-sub` and every provider download go through the **strict allowlist**
  (opensubtitles / strem.io / subdl / piratelk), HTTPS-only, no credentials/odd ports, and
  loopback / RFC1918 / CGNAT / link-local (`169.254.169.254`) / `.local` / `.internal` hosts
  rejected — re-validated on **every redirect hop** (legacy `http://` download links are upgraded,
  never followed raw; captcha redirects are refused and the next candidate file is tried instead).
- 5 MB caps on downloads *and* on every gunzip/unzip (zip-bomb safe); 2 MB cap on uploads (413);
  archive entries with `..`, absolute paths or `C:\` are ignored.
- `/sub/<token>.srt` matches only a strict 16-hex token, so storage keys are not enumerable.
- Provider keys never leave the worker (Worker secrets/vars); `/api/status` exposes only booleans.
  All external metadata in the UI is rendered with `textContent` (no `innerHTML`).
- **Subrequest budget:** worst case per invocation is **15 of Cloudflare's 50** (12 MT + 3 polish
  on the pa-dead Azure path; KV operations are not subrequests) and the pipeline caps at 4 batches.

## Verify everything yourself

```bash
npm ci
npm run scan:secrets                                                 # zero AIza… literals
node tests/run-all.js                                                # 238 PASS / 0 FAIL
python3 -m unittest discover -s tests -p 'local_server_test.py' -v   # 20 OK (real HTTP 200 .srt)
./node_modules/.bin/wrangler deploy --dry-run                        # bundle + env.ASSETS + env.SUBS_KV
node lab/verify_worker_v41_e2e.mjs                                   # 35/35 (real workerd)
node lab/verify_worker_v4_e2e.mjs                                    # 27/27 (real workerd)
npm run lab:remote                                                   # the same v3 lab against the live URL
```

The labs boot the real worker (`wrangler dev` = real `workerd` + simulated KV) with loopback mock
providers, so they need **no keys and no external services**. They prove: multi-language
independent jobs + caching (`si`/`ta`/`ja`/`ar`), translate-pa wire escaping and ≤500-line
batching, `pa`→`azure` failover on 429, the two-stage base→polished swap on the same token, and
the full offline suite re-run.

No uploaded `.zip` archive is tracked here; the subtitle fixtures in `tests/fixtures/` are
**synthetic** (no copyrighted subtitle content ships with this repo), and
`tests/fixtures/pack.zip` is a 752-byte synthetic archive used by the extraction tests.
