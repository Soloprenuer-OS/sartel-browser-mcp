#!/usr/bin/env bash
#
# Ship a new version of the Sartel extension to the Chrome Web Store.
#
# This uploads a package and sets the publish state. That is ALL the CWS API
# can do — it cannot touch the listing (description, screenshots, category,
# permission justifications, privacy practices, data disclosure). Those are
# dashboard-only, with no API at all. So this script is for version updates
# after the listing already exists; the first submission is manual and is
# documented in store/SUBMIT.md.
#
# Usage:
#   ./scripts/publish-cws.sh              upload + submit for public review
#   ./scripts/publish-cws.sh --trusted    upload + publish to trusted testers
#   ./scripts/publish-cws.sh --draft      upload only, leave as a draft
#
# One-time setup: docs/CWS_PUBLISH_SETUP.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/cws-lib.sh
. "$ROOT/scripts/cws-lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/publish-cws.sh [options]

Uploads the current extension/ package to the Chrome Web Store and sets its
publish state. Listing metadata (description, screenshots, category, privacy
practices) has no API and is not touched — see store/SUBMIT.md.

Options:
  --draft        Upload the package only; leave the item as an unpublished
                 draft for you to review and submit from the dashboard.
  --trusted      Publish to the trustedTesters track instead of the public one.
  --default      Publish publicly. This is the default; the flag is explicit.
  --skip-build   Use the existing dist/ zip instead of rebuilding it.
  -h, --help     Show this message.

Credentials, read from .env (gitignored) or the environment:
  CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_EXTENSION_ID

First time publishing this extension? The item does not exist yet:
run scripts/cws-create-item.sh, then follow store/SUBMIT.md.
EOF
}

MODE="default"
DRAFT_ONLY=0
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --draft)      DRAFT_ONLY=1 ;;
    --trusted)    MODE="trustedTesters" ;;
    --default)    MODE="default" ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; echo "" >&2; usage >&2; exit 2 ;;
  esac
done

cws_require_tools
cws_load_env
cws_require_oauth
cws_require CWS_EXTENSION_ID \
  "The 32-character Item ID from chrome.google.com/webstore/devconsole.
  If the item does not exist yet, run scripts/cws-create-item.sh first."

case "$CWS_EXTENSION_ID" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) cws_die "CWS_EXTENSION_ID does not look like a Chrome extension ID
  (32 lowercase letters a–p). Got a ${#CWS_EXTENSION_ID}-character value." ;;
esac

VERSION="$(node -p "require('$ROOT/extension/manifest.json').version")"
NAME="$(node -p "require('$ROOT/extension/manifest.json').name.toLowerCase().replace(/[^a-z0-9]+/g,'-')")"
ZIP="$ROOT/dist/$NAME-$VERSION.zip"

echo "Sartel → Chrome Web Store"
cws_note "version:      $VERSION"
cws_note "item:         $CWS_EXTENSION_ID"
cws_note "publish:      $([ "$DRAFT_ONLY" = 1 ] && echo 'draft only (no submit)' || echo "$MODE")"
cws_note "credentials:  client_id $(cws_redact "$CWS_CLIENT_ID"), secret $(cws_redact "$CWS_CLIENT_SECRET"), refresh token $(cws_redact "$CWS_REFRESH_TOKEN")"
echo ""

# ---------------------------------------------------------------- 1. package

if [ "$SKIP_BUILD" = 1 ]; then
  cws_step "Using existing package (--skip-build)"
  [ -f "$ZIP" ] || cws_die "$ZIP does not exist. Drop --skip-build."
else
  cws_step "Building package via scripts/build-zip.sh --update"
  "$ROOT/scripts/build-zip.sh" --update >/dev/null \
    || cws_die "scripts/build-zip.sh failed. Run it directly to see why."
fi
[ -f "$ZIP" ] || cws_die "expected $ZIP after the build, but it is not there."

# Updates must carry the CWS public key in the manifest; the key-stripped
# variant is for the very first upload only, and uploading it here would
# silently change the extension's identity expectations.
cws_assert_manifest_key "$ZIP" present
cws_note "$(basename "$ZIP") — $(du -h "$ZIP" | cut -f1), manifest key present"

# ------------------------------------------------------------------ 2. token

cws_step "Refreshing access token"
ACCESS_TOKEN="$(cws_access_token)"
cws_note "access token acquired (not logged)"

# ----------------------------------------------------------------- 3. upload

cws_step "Uploading package"
cws_cfg_new
cws_cfg_add "url = \"https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}\""
cws_cfg_add "header = \"Authorization: Bearer ${ACCESS_TOKEN}\""
cws_cfg_add 'header = "x-goog-api-version: 2"'
cws_cfg_add "upload-file = \"${ZIP}\""
cws_cfg_add 'request = "PUT"'
cws_cfg_add 'silent'
cws_cfg_add 'show-error'

rc=0
UPLOAD_RESP="$(curl --config "$CWS_CFG" 2>&1)" || rc=$?
cws_curl_cleanup
[ "$rc" -eq 0 ] || cws_die "upload request failed (curl exit $rc)."

UPLOAD_STATE="$(printf '%s' "$UPLOAD_RESP" | cws_json_field 'd.uploadState')" || UPLOAD_STATE=""
if [ "$UPLOAD_STATE" != "SUCCESS" ]; then
  echo "" >&2
  echo "✗ Upload rejected${UPLOAD_STATE:+ (uploadState: $UPLOAD_STATE)}" >&2
  printf '%s' "$UPLOAD_RESP" | cws_json_dump
  DETAIL="$(printf '%s' "$UPLOAD_RESP" | cws_json_field '(d.itemError||[]).map(e=>e.error_code).join(",")')" || DETAIL=""
  case "$DETAIL" in
    *ITEM_NOT_UPDATABLE*)
      echo "  → A previous version is still in review. Wait for it, or re-run with --draft" >&2
      echo "    to replace the queued package." >&2 ;;
    *VERSION*|*version*)
      echo "  → The store already has version $VERSION. Bump \"version\" in" >&2
      echo "    extension/manifest.json and re-run." >&2 ;;
    *)
      echo "  → 401/403 here usually means the developer account that owns the item is not" >&2
      echo "    the Google account you granted in scripts/oauth-init.mjs." >&2 ;;
  esac
  exit 1
fi
cws_note "upload SUCCESS"

# ---------------------------------------------------------------- 4. publish

if [ "$DRAFT_ONLY" = 1 ]; then
  echo ""
  echo "✓ v${VERSION} uploaded as a draft. Nothing was submitted."
  echo "  Review and submit at https://chrome.google.com/webstore/devconsole/"
  exit 0
fi

cws_step "Submitting for review (target: $MODE)"
cws_cfg_new
cws_cfg_add "url = \"https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}/publish?publishTarget=${MODE}\""
cws_cfg_add "header = \"Authorization: Bearer ${ACCESS_TOKEN}\""
cws_cfg_add 'header = "x-goog-api-version: 2"'
cws_cfg_add 'header = "Content-Length: 0"'
cws_cfg_add 'request = "POST"'
cws_cfg_add 'silent'
cws_cfg_add 'show-error'

rc=0
PUBLISH_RESP="$(curl --config "$CWS_CFG" 2>&1)" || rc=$?
cws_curl_cleanup
[ "$rc" -eq 0 ] || cws_die "publish request failed (curl exit $rc). The package IS uploaded;
  submit from the dashboard, or re-run once the network is back."

PUBLISH_STATUS="$(printf '%s' "$PUBLISH_RESP" | cws_json_field '(d.status||[])[0]')" || PUBLISH_STATUS=""
case "$PUBLISH_STATUS" in
  OK)
    cws_note "accepted into the review queue" ;;
  ITEM_PENDING_REVIEW)
    cws_note "item was already pending review — this upload replaced the queued package" ;;
  *)
    echo "" >&2
    echo "✗ Publish returned${PUBLISH_STATUS:+ $PUBLISH_STATUS}" >&2
    printf '%s' "$PUBLISH_RESP" | cws_json_dump
    echo "  → The package uploaded fine; only the submit failed. You can submit by hand at" >&2
    echo "    https://chrome.google.com/webstore/devconsole/" >&2
    exit 1 ;;
esac

echo ""
echo "✓ v${VERSION} submitted to the Chrome Web Store ($MODE)."
echo "  Review takes a few days; an extension using \`debugger\` over <all_urls> takes longer."
echo "  Status: https://chrome.google.com/webstore/devconsole/"
echo ""
echo "  Reminder: listing text, screenshots and privacy answers were NOT touched —"
echo "  the API cannot set them. Change those in the dashboard (store/LISTING.md)."
