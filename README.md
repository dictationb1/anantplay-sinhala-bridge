# AnantPlay Sinhala Subtitle Bridge — v2.1 (real-HTTP .srt delivery)

Zero-fork companion for [AnantPlay](https://github.com/AnantPlay/android) (official v2.23.1, commit
`be74df2`): search, machine-translate (EN→SI with a free Gemini key) or upload Sinhala subtitles and
hand AnantPlay's **native player** a REAL HTTP 200 `.srt` URL — never a Service-Worker ghost URL
that 404s inside ExoPlayer.

## Quick start

**Cloudflare (free, ~2 min, no KV required):**
```bash
npm ci && npx wrangler login && npx wrangler deploy
```
**LAN / Termux / Windows (zero cloud):**
```bash
python3 local-server/server.py        # → http://<LAN-IP>:8765/
```
Then in AnantPlay: **Settings → Sources → Add an index by link** →
`https://<your-worker>/index.json` (or `http://<LAN-IP>:8765/index.json`) and tap **Add** on both
listed sources (`sites` + `deeplinks`). See [`docs/SETUP-EN.md`](docs/SETUP-EN.md) /
[`docs/SETUP-SI.md`](docs/SETUP-SI.md).

KV is optional: without it the Worker stores subtitles in the Cache API (per-colo, 24 h). Bind it
for subtitles that survive a cache eviction — `npx wrangler kv namespace create SUBS_KV`, then
uncomment the block in `wrangler.toml`.

## Repo map

| Path | What |
| --- | --- |
| `worker/src/index.js` | the Cloudflare Worker: `/api/*` + real `/sub/<token>.srt` + dynamic catalogs |
| `local-server/server.py` | pure-stdlib LAN server, the same endpoints on port 8765 |
| `bridge-ui/public/` | the Bridge page (deeplink auto-fill, search, translate, upload, 3 handoff modes) |
| `pr-patch/` | two `git apply --check`-verified upstream patches (`be74df2`) — optional |
| `tests/` | worker (55), security (48), fixture (18), real-HTTP e2e (20) — all green |
| `docs/` | `REPORT.md` (audit + verification logs), `SETUP-EN.md`, `SETUP-SI.md` |

## Security model

- `/api/fetch-sub` is **not an open proxy**: strict provider allowlist (opensubtitles / subdl /
  piratelk), HTTPS-only, no credentials/odd ports, and loopback / RFC1918 / CGNAT / link-local
  (`169.254.169.254`) / `.local` / `.internal` hosts rejected — re-validated on **every redirect**.
- 5 MB caps on downloads *and* on every gunzip/unzip (zip-bomb safe); 2 MB cap on uploads (413);
  archive entries with `..`, absolute paths or `C:\` are ignored.
- `/sub/<token>.srt` matches only a strict 16-hex token, so storage keys are not enumerable.
- Keys live in the WebView's `localStorage` on your device only — never hardcoded, never logged.
  All external metadata is rendered with `textContent`.

## Verify everything yourself

```bash
npm ci
node tests/run-all.js                                                # 121 PASS / 0 FAIL
python3 -m unittest discover -s tests -p 'local_server_test.py' -v   # 20 OK (real HTTP 200 .srt)
npx wrangler deploy --dry-run                                       # assets + bindings, no secrets
git clone https://github.com/AnantPlay/android && cd android
git apply --check ../pr-patch/01-subdl-provider.patch               # ✅
git apply --check ../pr-patch/02-local-srt-picker.patch             # ✅
```

No `.zip` archive is tracked here; the subtitle fixtures in `tests/fixtures/` are **synthetic
Sinhala text** (no copyrighted subtitle content ships with this repo), and
`tests/fixtures/pack.zip` is a tiny synthetic archive used by the extraction tests.
