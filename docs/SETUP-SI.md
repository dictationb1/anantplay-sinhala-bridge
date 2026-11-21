# SETUP (සිංහල) — AnantPlay සිංහල උපසිරැසි පාලම v2.1

මෙය AnantPlay එක **කැපගසා නොවී** (zero-fork) සිංහල උපසිරැසි ලබා දෙන පාලමයි. v1 හි තිබූ
මාරාන්තික දෝෂය (ExoPlayer එකට `.srt` ලැබුණේ HTTP 404 ලෙස) මෙයින් නිවැරදි කර ඇත: සෑම
උපසිරැසියක්ම **ඇත්ත HTTP 200 `.srt` URL** එකකින් ලැබේ — Service Worker එකක් කොහේවත් නැහැ.

සත්කාරක ආකාර දෙකක් ඇත; එකක් තෝරන්න. AnantPlay යෙදුම (v2.23.1, `be74df2`) වෙනස් නොකර භාවිත කෙරේ.

---

## ආකාරය A — Cloudflare Worker (නොමිලේ, තත්පර 2ක දෙයක්)

### 1 · අවශ්‍ය දේ
- නොමිලේ Cloudflare ගිණුමක් (`*.workers.dev` උප-වසම නොමිලේ).
- Node 20+ (wrangler 4 සඳහා). ගොබල් install අවශ්‍ය නැහැ — wrangler මේ repo එකේ pinned
  devDependency එකකි.

### 2 · Worker එක deploy කරන්න
```bash
cd anantplay-si-subs-bridge
npm ci                 # pinned wrangler එක install කරයි (dev පමණි)
npx wrangler login     # එක් වරක්
npx wrangler deploy
```
මෙපමණයි — **මුලින්ම KV namespace එකක් අවශ්‍ය නැහැ.** KV binding එකක් නැති විට worker උපසිරැසි
Cloudflare Cache API එකේ (එක් colo එකකට, පැය 24) තබා ගනී, ඒ නිසා නොමිලේ මට්ටමේම වහාම වැඩ කරයි.

**පසුව කිරීම වඩා හොඳයි** (cache එක මැකුණත් උපසිරැසි රැඳේ, colo සියල්ලෙන් කියවිය හැක):
```bash
npx wrangler kv namespace create SUBS_KV     # id එකක් print වේ
```
`wrangler.toml` හි `[[kv_namespaces]]` block එක uncomment කර එම id එක paste කර නැවත
`npx wrangler deploy` කරන්න. `SUBS_KV` නැතත් worker crash වන්නේ නැහැ — cache එක භාවිත කරයි.

පාලම දැන් `https://anantplay-si-subs-bridge.<ඔබේ-වසම>.workers.dev/` හි සජීවීයි.

### 3 · තත්පර 30කින් පරීක්ෂා කරන්න
```bash
curl -s https://<worker>/index.json | head -c 400     # sites + deeplinks (live host, YOUR-HOST නැහැ)
curl -s https://<worker>/deeplinks.json               # යතුර = ඔබේ hostname (flat object නොවේ)
curl -s -X POST https://<worker>/api/publish-srt -H 'Content-Type: application/json' \
     -d '{"text":"1\n00:00:01,000 --> 00:00:02,000\nආයුබෝවන්\n"}'
curl -sI https://<worker>/sub/<token>.srt             # HTTP 200 · application/x-subrip; charset=utf-8
```

### 4 · AnantPlay එකට ලියාපදිංචි කරන්න (මූලාශ්‍ර දෙකම — tap 2ක්)
AnantPlay → **Settings → Sources → Add an index by link** → `https://<worker>/index.json` paste කරන්න.

Index එකේ මූලාශ්‍ර **දෙකක්** ලැයිස්තු වේ; දෙකටම **Add** කරන්න:
| මූලාශ්‍රය | වර්ගය | ඇයි |
| --- | --- | --- |
| Sinhala Subtitle Bridge | `sites` | පාලම **More** පේළියේ පෙන්වයි — එතැනින් විවෘත කළ හැක |
| Sinhala Subtitle Bridge (deeplinks) | `deeplinks` | Title Link එකකින් පාලම පෙර-පිරවූ ලෙස විවෘත වේ (`{tmdb}`/`{imdb}`/`{season}`/`{episode}`) |

AnantPlay මූලාශ්‍ර ස්වයංක්‍රීයව add නොකරයි (යෙදුමේ නිර්මාණය එසේය) — ඒ නිසා tap දෙක අවශ්‍යයි.

### 5 · බලන්න
1. AnantPlay Movies/TV **Title Links** වලින් පාලම තෝරන්න — චිත්‍රපටිය/කථාංගය ස්වයංක්‍රීයව පිරේ,
   සිංහල සෙවීම ද ලියා නැතිවම ආරම්භ වේ. (**More** පේළියෙන් කෙලින්ම ආවත් IMDb id එකක් දිය හැක.)
2. උපසිරැසියක් තෝරන්න (OpenSubtitles / SubDL — ඔබේ key එකෙන් / piratelk hint), නැත්නම් ඉංග්‍රීසි
   එකක් ඔබේ නොමිලේ Gemini key එකෙන් සිංහලට පරිවර්තනය කරන්න, නැත්නම් Baiscope/Zoom වලින් බාගත
   කළ `.srt`/`.zip` එක upload කරන්න.
3. පාලම **ඇත්ත `.srt` URL** එක පෙන්වයි — එය එක් වරක් fetch කරයි (Sniffer එකට පෙනෙන්න).
4. වීඩියෝ ධාරාව අතහැර දෙන්න: `.m3u8`/`.mp4` URL එකක් කෙලින්ම (පළමුව **Mux public HLS demo**
   බොත්තම — තත්පර 1ක පරීක්ෂාව), නැත්නම් ඔබේම embed player template එකක් (Mode 2), නැත්නම්
   පහත upstream patch එක යෙදූ නම් "📁 Open local .srt…".
5. AnantPlay native player එක වීඩියෝව + සිංහල උපසිරැසිය ඇත්ත track එකක් ලෙස වාදනය කරයි.

### Keys සහ පෞද්ගලිකත්වය
- Gemini key එක සහ අවශ්‍ය නම් SubDL key එක **එම WebView එකේ `localStorage` තුළ පමණක්** රැඳේ.
  මේ repo එකේ hardcode නොවේ, log නොවේ; Gemini endpoint එකට (හෝ SubDL සෙවීමට backend එකට) පමණක් යයි.
- Gemini model එක default `gemini-flash-latest`; *Gemini model* කොටසින් වෙනස් කළ හැක
  (උදා: `gemini-2.5-flash`).
- යෙදුමේ browser data clear කළොත් keys මැකේ.

---

## ආකාරය B — LAN / Termux (වලාකුල් නැහැ, විධානය 1කින්)

AnantPlay cleartext HTTP වලට ඉඩ දෙයි (`AndroidManifest.xml:19`), ඒ නිසා එකම Wi-Fi එකේ
දුරකථන/PC එකකින් කෙලින්ම වැඩ කරයි:

```bash
cd anantplay-si-subs-bridge
python3 local-server/server.py          # 0.0.0.0:8765 — LAN URL එක print වේ
# උදා: SiBridge local server → http://192.168.1.20:8765/  (LAN) · http://127.0.0.1:8765/
```
Python standard library පමණි — `pip install` අවශ්‍ය නැහැ. Termux: `pkg install python` කර එම
විධානයම (දිගු සැසි සඳහා `termux-wake-lock`). Windows: `python local-server\server.py`.

විකල්ප: `--port 8765`, `--host 0.0.0.0` (default) හෝ `--host 127.0.0.1` (මේ උපාංගයට පමණි).

AnantPlay එකට ලියාපදිංචි කරන්න: `http://<LAN-IP>:8765/index.json` (මූලාශ්‍ර දෙකම add කරන්න).
අනෙක් සියල්ල එකසේමයි — API මාර්ග, ඇත්ත `/sub/<token>.srt` (පැය 24 TTL, SHA-256 dedupe), පාලම UI.
උපසිරැසි ගබඩාව `local-server/subs/` — කැමති වෙලාවක delete කර නැවත පටන් ගන්න.

> සටහන: LAN සේවාදායකයෙන් OpenSubtitles/SubDL සෙවීමට අන්තර්ජාලය අවශ්‍යයි; පරිවර්තනයට ඔබේ Gemini
> key එක ඕනෑමය. අන්තර්ජාලය නැති විටත් upload ආකාරය වැඩ කරයි.

---

## ආරක්ෂණ ආකෘතිය (ආකාර දෙකටම)

- **`/api/fetch-sub` විවෘත proxy එකක් නොවේ.** එය බාගත කරන්නේ allowlist එකේ ඇති
  `opensubtitles.org`, `opensubtitles.com`, `subdl.com`, `subdl.org`, `piratelk.com` (සහ ඒවායේ
  උප-වසම්) වලින් පමණි. HTTPS නොවන scheme, URL තුළ credentials, 443/80 නොවන port, IP literal,
  loopback / RFC1918 / CGNAT / link-local (169.254.169.254) / `.local` / `.internal` සියල්ල
  ප්‍රතික්ෂේප වේ; **සෑම redirect පියවරක්ම නැවත පරීක්ෂා කෙරේ.** ඔබේම mirror එකක් නම්
  `wrangler.toml` හි `ALLOWED_SUB_HOSTS` (`[vars]`) හෝ Python සේවාදායකයේ
  `SI_BRIDGE_ALLOWED_HOSTS` පරිසර විචල්‍යයෙන් එකතු කරන්න.
- **Zip/gzip bomb 5 MB ට වඩා විස්තාරණය විය නොහැක** — declared සහ actual uncompressed ප්‍රමාණය දෙකම
  සීමා වේ; `..`, absolute path, `C:\` සහිත archive entries නොසලකා හරී.
- **Upload 2 MB** උපසිරැසි පෙළට සීමාය (HTTP 413), සහ `/sub/<token>.srt` මාර්ගය දැඩි 16-hex
  token එකකට පමණක් ගැලපේ — අත්තනෝමතික storage keys වෙත ළඟා විය නොහැක.
- පාලම UI සියලු පිටත metadata `textContent` එකෙන් render කරයි (`innerHTML` නැහැ).

---

## අභ්‍යාස ලේඛන (upstream patches — AnantPlay දායකයන්ට පමණි)

`pr-patch/` තුළ `be74df2` ට එරෙහි patch දෙකක් (අද පිරිසිදු clone එකක `git apply --check` ✅,
වෙන වෙනම සහ එකට):

- **01-subdl-provider.patch** — SubDL සැපයුම්කරු (Settings key + OpenSubtitles ප්‍රතිඵලවලට එකතු වීම +
  `test/SubDlTest.java`).
- **02-local-srt-picker.patch** — ධාවකයේ උපසිරැසි මෙනුවට "📁 Open local .srt…" (`ACTION_OPEN_DOCUMENT`).

```bash
git clone https://github.com/AnantPlay/android && cd android
git apply --check /path/to/pr-patch/01-subdl-provider.patch     # ✅
git apply /path/to/pr-patch/01-subdl-provider.patch
git apply /path/to/pr-patch/02-local-srt-picker.patch
```

ඒවා අභ්‍යාස මිස අනිවාර්ය නොවේ: පාලම නිකුත් කළ APK එකෙන්ම වැඩ කරයි.

---

## ගැටලු නිරාකරණය

| රෝග ලක්ෂණය | ප්‍රතිකාරය |
| --- | --- |
| `/api/*` "no storage" කියයි | KV bind කරන්න (`npx wrangler kv namespace create SUBS_KV`) හෝ Cache API ඇති zone එකකට deploy කරන්න. `workers.dev` deploy එකට cache ඇත — මෙය දකින්නේ විශේෂ අවස්ථාවකදීය |
| උපසිරැසි ගැලපෙන්නේ නැහැ | ධාරාව අතහැර දෙන්නට කලින් පාලමේ **URL එක fetch කරන්න** බොත්තම ඔබන්න (Sniffer එකට ඇත්ත request එක පෙනෙන්න) |
| "upstream host not allowlisted" | එම මූලාශ්‍රය සහාය දක්වන ලැයිස්තුවේ නැහැ; `.srt` එක බාගත කර Upload කරන්න, නැත්නම් `ALLOWED_SUB_HOSTS` වලින් host එක එකතු කරන්න |
| සිංහල අකුරු කැඩිලා පේනවා | පයිප්ලයිනය BOM-නැති UTF-8 ගබඩා කරයි; ප්‍රභවය legacy encoding එකක නම් UTF-8 ලෙස නැවත save කර upload කරන්න |
| Gemini batch නතර වෙනවා | නොමිලේ මට්ටමේ rate limit — මිනිත්තුවක් රැඳී සිටින්න. Cue ගණන හෝ timestamp වෙනස් කරන batch එකක් එක් වරක් නැවත උත්සාහ කර, පසුව වැරදි ලෙස publish නොකර නවතී |
| LAN එක හමු නොවේ | එකම Wi-Fi ද බලන්න; දුරකථනයේ "private address" (Wi-Fi) සැකසුම clients හුදෙකලා කරන්නේ ද බලන්න |
