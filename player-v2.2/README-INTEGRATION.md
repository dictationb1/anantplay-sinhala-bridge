# AnantPlay Sinhala Player v2.2.0 — integration hand-off

This folder holds the **complete, audited v2.2.0 delta** for the sibling repository
[`dictationb1/anantplay-sinhala-player`](https://github.com/dictationb1/anantplay-sinhala-player),
staged here because the agent session that produced it **could not write to that repository**
(see "Why this lives here" below).

| file | what it is |
| --- | --- |
| `player-v2.2.patch` | `git diff --binary` of `main..v2.2.0` — the 17-file delta, verified to apply cleanly to `main` at `b60edfb`. |
| `push-and-merge.sh` | one command: clone → drop the `.zip` → apply → branch → push → PR → watch CI → merge. |
| `README-INTEGRATION.md` | this file: audit results, the blocker, and the exact remaining steps. |

SHA-256 of the patch: `6c7135c0e9995b89dfcd8e2d45bff132740b05ee5169f71370f9b555ead529c0`

---

## Why this lives here

The task targeted `dictationb1/anantplay-sinhala-player`, but this session's GitHub credential is
scoped to **this** repository. Verified directly:

```
POST /repos/dictationb1/anantplay-sinhala-bridge/git/blobs        -> 201  (write OK)
POST /repos/dictationb1/anantplay-sinhala-player/git/blobs        -> 403  Resource not accessible by integration
git push origin arena/28aba632-anantplay-sinhala-player            -> 403  Permission denied
```

Read access, PR comments and lab-free static work all succeed on the player repo; **contents
write** does not. So Gates 6 (real CI APK build) and 7 (auto-merge into `main`) could not be
executed from here — everything up to and including the reviewed, applicable patch is done.

> **One side effect to ignore:** the permission probe created and could not delete
> [issue #2 "probe"](https://github.com/dictationb1/anantplay-sinhala-player/issues/2) on the player
> repo (`issues: write` on create was granted, on update it was not). Delete or close it manually.

To finish: reconnect GitHub in Arena with write access to `anantplay-sinhala-player`, or run
`player-v2.2/push-and-merge.sh` with a local `gh` login that has it.

---

## What the patch contains

### 1. The v2.2 archive, integrated

`repo3-anantplay-sinhala-player-v2.2.zip` (7,346,582 bytes, 66 clean root-level entries) is
extracted over the repo root and then **deleted from git** — `.gitignore` already ignores `*.zip`,
and `git ls-files '*.zip'` is 0 before and after.

* **NEW** `Langs.java` — the 18-language registry.
* **NEW** `MdnsWire.java` — the RFC 6762 PTR question bytes (QU unicast bit).
* `PlayActivity.java`, `MainActivity.java`, `BridgeApi.java`, `NsdAnnouncer.java`, `ReceiverLab.java`,
  `run_lab.sh`, `build.sh`, `strings.xml`, `styles.xml`, `README.md` — upgraded to v2.2.0.
* Dotfiles were **preserved and upgraded**, not re-created: `.gitignore` and
  `.github/workflows/build-apk.yml` already existed on `main` and were edited in place.

### 2. Audit fixes applied on top of the archive

| # | Gate | Defect | Fix |
| --- | --- | --- | --- |
| 1 | 2 | `PlayActivity.onDestroy()` never cancelled the delayed Cinema Polish re-check (or the 4 Hz ticker / HUD timers / delayed PiP arming). The `finished` flag made them harmless but they still held the Activity, its `SubtitleStore` and its views reachable for up to 20 s after `onDestroy()`. | `main.removeCallbacksAndMessages(null)` runs **first** in `onDestroy()`, before `player.release()`. |
| 2 | 2 | Option-C clipped its prompt with a *cue count* (`300`), never a byte budget — 300 cues of non-Latin text can exceed the 40 KB contract. | Hard `AI_STUDIO_MAX_BYTES = 40 * 1024`, measured as **real UTF-8 bytes** while appending (`Charset.encode(...).remaining()`). The lab's 300-cue check still passes. |
| 3 | 2 | Option-C caught only a generic `Exception`; a browser-less device reported "AI Studio bridge failed". | `ActivityNotFoundException` caught **by name**: "✅ N cues copied — but this phone has no browser to open AI Studio". Still `ACTION_VIEW` only — never a WebView, zero automation. |
| 4 | 2 | The subtitle `TextView` was created with `siFont` unconditionally, so a saved default of `ta`/`ar` started life in the wrong typeface/direction. | Initial typeface + `TEXT_DIRECTION_ANY_RTL` now derive from the configured language, exactly like the per-cue ticker path. |
| 5 | 2 | `Langs.java` declared `ru` as script `latin`; the worker declares `cyrillic`. | `ru` → `cyrillic`. The registry is now identical to `worker/src/languages.js` v4.1 on **every** field, not just codes/labels. |
| 6 | 6 | CI installed build-tools only when **no** `aapt2` existed. A runner image with only `34.0.0` satisfied that check, `build.sh` then refused every toolchain it could see, and the job died — the exact `d8 8.2` trap. | The workflow probes `build-tools/35.0.1/aapt2` **itself** and fails loudly if absent; `build.sh` prefers `35.0.1` explicitly before falling back to the highest ≥35. |
| 7 | 6 | Artifact was always `AnantPlay-Sinhala-Player.apk`. | Versioned `AnantPlay-Sinhala-Player-v2.2.0.apk`, with `versionCode 20200` / `versionName 2.2.0` asserted from `aapt2 dump badging` before upload. |
| 8 | 5 | `README.md` (v2.1.0, "72 checks"), `SETUP-SI.md` (v2.1.0), `docs/CAST-VERIFICATION.md` (72/72) were stale. | All three rewritten for v2.2.0: 18 languages, Spoken/Formal, two-stage Cinema Polish, Option-C AI Studio, AdGuard Private DNS vs VPN, Xiaomi/HyperOS, 93/93 lab, build-tools rationale, versioned artifact. `THIRD_PARTY.md` notes the OFL font is `si`-only. |

### 3. Audit results — all gates

| Gate | Result | Evidence |
| --- | --- | --- |
| **1 — zero accessibility / A14–16 / HyperOS** | **PASS** | No `AccessibilityService` / `BIND_ACCESSIBILITY_SERVICE` outside an XML comment (CI strips comments before grepping); zero API references in `src/`. `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE` + `connectedDevice` type, `POST_NOTIFICATIONS` prompted at API 33+ (`MainActivity:86,206`), `CHANGE_WIFI_MULTICAST_STATE` for `MdnsWire`/`MulticastLock`, `BootReceiver → ReceiverService.arm()` catches `ForegroundServiceStartNotAllowed*` by class name (API-26-safe), `forceDarkAllowed=false` on both themes, explicit high-contrast colours, bottom `OnApplyWindowInsetsListener` padding (`MainActivity:139`). |
| **2 — 18 languages / two-stage / Option-C** | **PASS** (5 fixes) | Registry verified 1:1 against `worker/src/languages.js` v4.1 by script: 18/18 codes, os/subdl codes, native labels, `rtl` (`ar`,`ur`), budgets, scripts, same order. Bundled font `si`-only + RTL direction + cached `Typeface`. `BridgeApi.srtWithQuality()` captures `X-Sub-Quality`/`X-Polish-Status`; base NMT renders immediately; one background re-check; silent hot-swap; "✨ Cinema Polish Ready". All network work on `si-subs` threads. |
| **3 — mDNS / AdGuard / security** | **PASS** | `MdnsWire.queryPacket()` is the only packet builder (QU bit `0x8001`); the probe holds a `MulticastLock` and releases it in `finally`; `TRANSPORT_VPN` detection intact and documented as "Private DNS is *not* the culprit". `CastPolicy` scheme/action whitelist + seek clamp, `ReceiverServer` LAN-source lock, 12-connection cap, 256 KB body cap, `SrtLoader` 5 MB zip-bomb budget + `..`/absolute/`C:\` rejection, `Diag` secret/cookie redaction — all unchanged and still covered by the lab. |
| **4 — lab** | **NOT RUN LOCALLY** | This sandbox has **no JDK** and cannot install one (`dl.google.com`, Adoptium release assets and Maven Central are all unreachable; the PyPI `jdk4py` wheel ships a JRE without `javac`). Static analysis only: bracket/string-aware parse of every touched Java file is clean, and the check count is **93** (94 call sites, 1 mutually-exclusive catch fallback) — matching the expected 93/93. The lab is the **first step** of the CI job and must go green there before merge. |
| **5 — docs & licences** | **PASS** | `THIRD_PARTY.md`: Apache-2.0 (media3 1.11.1, guava 33.3.1, failureaccess, concurrent-futures, annotation-experimental), SIL OFL 1.1 (`NotoSansSinhala-Regular.ttf`), GPL-2.0+CE (`tools/core-lambda-stubs.jar`, build-time only). README / SETUP-SI / CAST-VERIFICATION updated. |
| **6 — real APK in CI** | **BLOCKED** | Wiring fixed and versioned; `build.sh` signs with `KS_BASE64`/`KS_PASS`/`KS_ALIAS` when present and falls back to a debug key otherwise (CI never fails without secrets), then `apksigner verify --verbose`. Cannot run: no write access to the repo. |
| **7 — auto-merge** | **BLOCKED** | Same blocker. 0 `.zip` files tracked in the patch. |
| — | Repo hygiene | The uploaded archive is deleted by the patch; `.gitignore` keeps `*.zip`, `*.apk`, `*.jks`, `*.keystore`, `*.idsig`, `build/`, `dist/`, `out/`, `.DS_Store`. |

---

## Finish it

```sh
# needs: gh authenticated with contents:write on dictationb1/anantplay-sinhala-player
bash player-v2.2/push-and-merge.sh
```

The script is idempotent-ish: it works in a temporary clone, refuses to run if the branch already
exists with different content, and stops on the first red check instead of merging.

Expected green run: **lab 93/93 → APK built with build-tools 35.0.1 → `apksigner verify` pass →
`AnantPlay-Sinhala-Player-v2.2.0.apk` uploaded** (`versionCode 20200`, `versionName 2.2.0`).

<details>
<summary>Manual equivalent</summary>

```sh
git clone https://github.com/dictationb1/anantplay-sinhala-player.git && cd anantplay-sinhala-player
git rm -f repo3-anantplay-sinhala-player-v2.2.zip        # the archive must not stay tracked
git commit -m "chore: drop the uploaded v2.2 archive"
git checkout -b arena/v2.2.0-18-languages
git apply /path/to/player-v2.2.patch
git add -A && git commit -m "v2.2.0 — 18 languages, two-stage cinema polish, Option-C, mDNS fix"
git push -u origin arena/v2.2.0-18-languages
gh pr create --fill --base main
gh pr checks --watch                                    # must be 100% green
gh pr merge --merge --delete-branch
```
</details>
