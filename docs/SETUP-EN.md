# SETUP (EN) — AnantPlay Sinhala Subtitle Bridge v2.1

Two hosting modes; pick ONE. Both serve the **same real HTTP 200 `.srt` URLs** that fix the v1
404-on-ExoPlayer bug. No fork of AnantPlay is required for any of this — the app is used exactly
as released (`me.champdev.weblock` v2.23.1, commit `be74df2`).

---

## Mode A — Cloudflare Worker (recommended, free tier, ~2 minutes)

### 1 · Prerequisites
- A free Cloudflare account (a `*.workers.dev` subdomain is included).
- Node 20+ (wrangler 4 requires it). No global install needed — wrangler is a pinned
  devDependency in this repo.

### 2 · Deploy the worker
```bash
cd anantplay-si-subs-bridge
npm ci                 # installs the pinned wrangler (dev-only)
npx wrangler login     # once
npx wrangler deploy
```
That is the whole deploy: **no KV namespace is required to start.** Without a KV binding the
worker keeps subtitles in the Cloudflare Cache API (per-colo, 24 h), so it works immediately on
the free tier.

**Recommended once it runs** (subtitles then survive cache eviction and are readable from every
colo):
```bash
npx wrangler kv namespace create SUBS_KV     # prints an id
```
Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`, paste the id, and `npx wrangler deploy`
again. The worker never crashes when `SUBS_KV` is missing; it just uses the cache instead.

Your bridge is live at `https://anantplay-si-subs-bridge.<your-subdomain>.workers.dev/`.

### 3 · Verify (30 seconds)
```bash
curl -s https://<your-worker>/index.json | head -c 400   # sources: sites + deeplinks, live host, no YOUR-HOST
curl -s https://<your-worker>/deeplinks.json             # keyed by YOUR hostname, not a flat object
curl -s -X POST https://<your-worker>/api/publish-srt \
     -H 'Content-Type: application/json' \
     -d '{"text":"1\n00:00:01,000 --> 00:00:02,000\nආයුබෝවන්\n"}'
curl -sI https://<your-worker>/sub/<token>.srt           # HTTP 200 · application/x-subrip; charset=utf-8
```

### 4 · Register inside AnantPlay (both sources — 2 taps)
AnantPlay → **Settings → Sources → Add an index by link** → paste
`https://<your-worker>/index.json`.

The index lists **two** sources; tap **Add** on both:
| Source | Type | Why |
| --- | --- | --- |
| Sinhala Subtitle Bridge | `sites` | puts the Bridge in the **More** row so you can open it |
| Sinhala Subtitle Bridge (deeplinks) | `deeplinks` | lets a Title Link open the Bridge pre-filled (`{tmdb}`/`{imdb}`/`{season}`/`{episode}`) |

Neither is auto-added by AnantPlay — that is by design in the app, so both taps are required.

### 5 · Play something
1. From AnantPlay's Movies/TV **Title Links**, pick the Bridge — the movie/episode auto-fills from
   the deeplink and search runs with zero typing. (Opening the Bridge directly from the **More**
   row works too; type an IMDb id or hit *Resolve*.)
2. Pick a subtitle (OpenSubtitles / SubDL with your own key / piratelk hint) → or translate an
   English one to Sinhala with your free Gemini key (aistudio.google.com) → or upload a
   `.srt`/`.zip` you downloaded from Baiscope/Zoom.
3. The Bridge shows the **real `.srt` URL** and fetches it once (so the Sniffer captures it).
4. Hand off the stream: paste a direct `.m3u8`/`.mp4` URL (try the built-in **Mux public HLS
   demo** button first — 1-click proof), or load your own embed-player template (Mode 2), or use
   "📁 Open local .srt…" from the upstream patch below.
5. AnantPlay's native player plays the stream with the Sinhala subtitle as a real track.

### Keys & privacy
- The Gemini key and the optional SubDL key are typed by you and stored **only in that WebView's
  `localStorage`**. They are never hardcoded in this repo, never logged, and never sent anywhere
  except Google's Gemini endpoint (or the bridge backend for SubDL search).
- The Gemini model defaults to `gemini-flash-latest`; the *Gemini model* field lets you override it
  (e.g. `gemini-2.5-flash`).
- Clearing the app's browser data removes the stored keys.

---

## Mode B — LAN / Termux (zero cloud, one command)

AnantPlay allows cleartext HTTP (`AndroidManifest.xml:19` `android:usesCleartextTraffic="true"`),
so a phone/PC on the same Wi-Fi works directly.

```bash
cd anantplay-si-subs-bridge
python3 local-server/server.py          # binds 0.0.0.0:8765, prints the LAN URL
# e.g.  SiBridge local server → http://192.168.1.20:8765/  (LAN) · http://127.0.0.1:8765/
```
Pure standard library — no `pip install`, nothing to compile. Termux: `pkg install python` first;
then the same command (`termux-wake-lock` keeps it alive). Windows: `python local-server\server.py`.

Options: `--port 8765`, `--host 0.0.0.0` (default) or `--host 127.0.0.1` for this device only.

Register inside AnantPlay exactly like Mode A but with `http://<LAN-IP>:8765/index.json`
(add both sources). Everything else is identical: the API routes, the real `/sub/<token>.srt`
(24 h TTL, SHA-256 dedupe), the Bridge UI. Subtitle storage is the plain `local-server/subs/`
folder — delete it any time to reset.

> Note: OpenSubtitles/SubDL search from the LAN server requires outbound internet from the host;
> translation needs your Gemini key either way. If the host is offline, upload mode still works.

---

## Security model (both modes)

- **`/api/fetch-sub` is not an open proxy.** It only downloads from an allowlist —
  `opensubtitles.org`, `opensubtitles.com`, `subdl.com`, `subdl.org`, `piratelk.com` (and their
  subdomains). Non-HTTPS schemes, credentials in the URL, non-443/80 ports, IP literals and every
  loopback / RFC1918 / CGNAT / link-local (169.254.169.254) / `.local` / `.internal` host are
  rejected, and **each redirect hop is re-validated**. Add your own mirror with
  `ALLOWED_SUB_HOSTS` in `wrangler.toml` (`[vars]`) or the `SI_BRIDGE_ALLOWED_HOSTS` environment
  variable for the Python server.
- **Zip/gzip bombs cannot expand past 5 MB** — the declared and the actual uncompressed size are
  both capped, and archive entries with `..`, absolute paths or `C:\` are ignored.
- **Uploads are capped at 2 MB** of subtitle text (rejected with HTTP 413), and the
  `/sub/<token>.srt` route only matches a strict 16-hex token, so arbitrary storage keys are
  unreachable.
- The Bridge UI renders every provider/metadata string with `textContent` (no `innerHTML`).

---

## Optional upstream patches (for AnantPlay contributors)

Two `git apply`-ready patches against `AnantPlay/android` @ `be74df2` live in `pr-patch/`
(both verified today with `git apply --check` on a pristine clone, individually and stacked):

- **01-subdl-provider.patch** — adds SubDL as a subtitle provider (Settings key + merge into
  OpenSubtitles results + `test/SubDlTest.java`).
- **02-local-srt-picker.patch** — adds "📁 Open local .srt…" to the player's subtitle sheet
  (`ACTION_OPEN_DOCUMENT`, UTF-8 normalization through the existing SubFetch path).

```bash
git clone https://github.com/AnantPlay/android && cd android
git apply --check /path/to/pr-patch/01-subdl-provider.patch   # ✅
git apply /path/to/pr-patch/01-subdl-provider.patch
git apply /path/to/pr-patch/02-local-srt-picker.patch
```

They are OPTIONAL: the Bridge works with the released APK as-is.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/api/*` returns "no storage" | Either bind KV (`npx wrangler kv namespace create SUBS_KV`) or deploy to a zone where the Cache API is available. A `workers.dev` deploy has the cache, so this only appears in exotic setups. |
| Subtitles don't attach | Tap **URL එක fetch කරන්න** on the Bridge so the Sniffer sees the real request BEFORE handing off the stream |
| "upstream host not allowlisted" | The source is not one of the supported providers; download the `.srt` and use Upload instead, or add the host via `ALLOWED_SUB_HOSTS` |
| Sinhala text looks broken | The pipeline stores BOM-less UTF-8; if a source file is in another legacy encoding, re-save it as UTF-8 and upload again |
| Gemini batch stalls | Free-tier rate limit — wait a minute; batches resume automatically. A batch that changes cue count or timestamps is retried once and then aborted rather than published wrong. |
| LAN mode unreachable | Same Wi-Fi, and check the phone's "private address" Wi-Fi setting isn't isolating clients |
