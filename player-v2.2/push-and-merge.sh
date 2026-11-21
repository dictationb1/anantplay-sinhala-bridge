#!/usr/bin/env bash
# Finish the v2.2.0 integration of dictationb1/anantplay-sinhala-player.
#
# Run this from a machine whose `gh` login (or GH_TOKEN) has contents:write on
# dictationb1/anantplay-sinhala-player. The Arena session that produced the patch
# did not (see README-INTEGRATION.md).
#
#   bash player-v2.2/push-and-merge.sh
#
# Steps: temp clone -> drop the uploaded .zip -> apply the reviewed patch ->
#        push a branch -> open the PR -> watch CI -> merge only when green.
set -euo pipefail

REPO="dictationb1/anantplay-sinhala-player"
BASE="main"
BRANCH="arena/v2.2.0-18-languages"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/player-v2.2.patch"
TITLE="v2.2.0 — 18 languages, two-stage cinema polish, Option-C, mDNS fix"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -s "$PATCH" ] || die "patch missing: $PATCH"
command -v gh   >/dev/null || die "gh CLI not found"
command -v git  >/dev/null || die "git not found"

echo "── 0. preflight: write access to $REPO"
MAIN_SHA=$(gh api "repos/$REPO/git/ref/heads/$BASE" --jq .object.sha) || die "cannot read $BASE"
gh api -X POST "repos/$REPO/git/blobs" -f content="preflight" -f encoding=utf-8 >/dev/null \
  || die "no contents:write on $REPO — reconnect GitHub with write access and retry"
echo "   OK ($BASE = ${MAIN_SHA:0:8})"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "── 1. clone"
gh repo clone "$REPO" "$WORK/p" -- --quiet
cd "$WORK/p"
git config user.name  "$(git config --global user.name  || echo 'AnantPlay release bot')"
git config user.email "$(git config --global user.email || echo 'release@techworld.lk')"

echo "── 2. the uploaded archive must not stay tracked"
if git ls-files --error-unmatch repo3-anantplay-sinhala-player-v2.2.zip >/dev/null 2>&1; then
  git rm -q -f repo3-anantplay-sinhala-player-v2.2.zip
  git commit -q -m "chore: remove the uploaded v2.2 archive (never track .zip)"
fi
COUNT=$(git ls-files '*.zip' | wc -l | tr -d ' ')
[ "$COUNT" = "0" ] || die "$COUNT .zip file(s) still tracked"
echo "   tracked .zip files: 0"

echo "── 3. apply the reviewed v2.2.0 delta"
git checkout -q -b "$BRANCH"
git apply --check "$PATCH" || die "patch does not apply to ${MAIN_SHA:0:8} — rebase needed"
git apply "$PATCH"
git add -A
git commit -q -F - <<'MSG'
v2.2.0 — 18 languages, two-stage cinema polish, Option-C, mDNS fix

Integrates the v2.2 archive and closes the 8-gate audit:
  * NEW Langs.java (18-language registry, 1:1 with worker/src/languages.js v4.1)
  * NEW MdnsWire.java (RFC 6762 PTR question, QU unicast bit)
  * script-safe rendering (bundled Sinhala font only for `si`), RTL for ar/ur
  * two-stage hot-swap off X-Sub-Quality / X-Polish-Status
  * Option-C "✨ AI Studio": UTF-8 40 KB budget, ACTION_VIEW only, ANFE caught
  * onDestroy() cancels the polish re-check / ticker / HUD timers before
    releasing ExoPlayer (leak fix)
  * CI: build-tools 35.0.1 is mandatory (d8 8.2 in 34.0.0 crashes on
    media3/guava); artifact AnantPlay-Sinhala-Player-v2.2.0.apk with
    versionCode 20200 / versionName 2.2.0 asserted
  * docs: README / SETUP-SI / CAST-VERIFICATION at v2.2.0, lab 93/93
  * 0 .zip files tracked
MSG

echo "── 4. push + PR"
git push -q -u origin "$BRANCH"
if gh pr view "$BRANCH" --repo "$REPO" >/dev/null 2>&1; then
  PR=$(gh pr view "$BRANCH" --repo "$REPO" --json number --jq .number)
  echo "   reusing PR #$PR"
else
  PR=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \
        --title "$TITLE" --body "Automated v2.2.0 integration + 8-gate audit. See the commit message for the full audit/patch log." \
        --json number --jq .number)
  echo "   opened PR #$PR"
fi
echo "   $REPO/pull/$PR"

echo "── 5. wait for CI (lab 93/93 + signed, verified APK)"
gh pr checks "$PR" --repo "$REPO" --watch --interval 20 || {
  gh pr checks "$PR" --repo "$REPO" || true
  die "CI is not green — inspect the run, fix, and re-run this script (the branch is left in place)"
}

echo "── 6. merge"
gh pr merge "$PR" --repo "$REPO" --merge
echo "── 7. post-merge main"
gh run list --repo "$REPO" --branch "$BASE" --limit 1
gh pr view "$PR" --repo "$REPO" --json state,mergedAt,mergeCommit
echo
echo "Artifact: Actions run → AnantPlay-Sinhala-Player-v2.2.0-apk"
