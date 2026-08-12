#!/usr/bin/env bash
#
# Create the Sartel item in the Chrome Web Store for the first time.
#
# The publish API's `items.insert` endpoint is the only part of the flow that
# can create an item; scripts/publish-cws.sh assumes one already exists. This
# script uploads the KEY-STRIPPED package, because the store rejects a first
# upload whose manifest carries a `key` field — it generates its own keypair
# at this moment and assigns the extension ID from it.
#
# It creates a DRAFT and stops. It cannot fill in the listing: description,
# screenshots, category, permission justifications, privacy practices and the
# data-collection declaration have no API and must be entered in the dashboard.
# store/SUBMIT.md is the checklist for that, and step 5 there (writing the
# assigned ID and public key back into the repo) must happen before anything
# is published to npm.
#
# Usage:
#   ./scripts/cws-create-item.sh
#
# One-time setup: docs/CWS_PUBLISH_SETUP.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/cws-lib.sh
. "$ROOT/scripts/cws-lib.sh"

usage() {
  cat <<'EOF'
Usage: scripts/cws-create-item.sh [options]

Creates the Chrome Web Store item (once) by uploading the key-stripped
first-upload package, and prints the Item ID the store assigns.

The item is left as a DRAFT with an empty listing. Listing metadata cannot be
set through the API at all — continue at store/SUBMIT.md step 4.

Options:
  --publisher-email EMAIL   Create the item under a publisher group rather
                            than your own account.
  --skip-build              Use the existing dist/ first-upload zip.
  --force                   Proceed even though CWS_EXTENSION_ID is already
                            set in .env (creates a SECOND, separate item).
  -h, --help                Show this message.

Credentials, read from .env (gitignored) or the environment:
  CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN
EOF
}

PUBLISHER_EMAIL=""
SKIP_BUILD=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --publisher-email)
      [ $# -ge 2 ] || { echo "--publisher-email needs a value" >&2; exit 2; }
      PUBLISHER_EMAIL="$2"; shift 2 ;;
    --publisher-email=*) PUBLISHER_EMAIL="${1#*=}"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --force)      FORCE=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; echo "" >&2; usage >&2; exit 2 ;;
  esac
done

cws_require_tools
cws_load_env
cws_require_oauth

if [ -n "${CWS_EXTENSION_ID-}" ] && [ "$FORCE" != 1 ]; then
  cws_die "CWS_EXTENSION_ID is already set — the item exists.
  Creating another one would give you a second, unrelated listing.
  To ship a new version instead:  ./scripts/publish-cws.sh
  If you really do want a second item, re-run with --force."
fi

VERSION="$(node -p "require('$ROOT/extension/manifest.json').version")"
NAME="$(node -p "require('$ROOT/extension/manifest.json').name.toLowerCase().replace(/[^a-z0-9]+/g,'-')")"
ZIP="$ROOT/dist/$NAME-$VERSION-first-upload.zip"

echo "Sartel → Chrome Web Store — creating the item"
cws_note "version:      $VERSION"
cws_note "credentials:  client_id $(cws_redact "$CWS_CLIENT_ID"), secret $(cws_redact "$CWS_CLIENT_SECRET"), refresh token $(cws_redact "$CWS_REFRESH_TOKEN")"
[ -n "$PUBLISHER_EMAIL" ] && cws_note "publisher:    $PUBLISHER_EMAIL"
echo ""

# ---------------------------------------------------------------- 1. package

if [ "$SKIP_BUILD" = 1 ]; then
  cws_step "Using existing package (--skip-build)"
  [ -f "$ZIP" ] || cws_die "$ZIP does not exist. Drop --skip-build."
else
  cws_step "Building first-upload package via scripts/build-zip.sh --first-upload"
  "$ROOT/scripts/build-zip.sh" --first-upload >/dev/null \
    || cws_die "scripts/build-zip.sh failed. Run it directly to see why."
fi
[ -f "$ZIP" ] || cws_die "expected $ZIP after the build, but it is not there."

# The whole point of this variant. A first upload carrying `key` is rejected
# with "key field is not allowed in manifest".
cws_assert_manifest_key "$ZIP" absent
cws_note "$(basename "$ZIP") — $(du -h "$ZIP" | cut -f1), manifest key stripped"

# ------------------------------------------------------------------ 2. token

cws_step "Refreshing access token"
ACCESS_TOKEN="$(cws_access_token)"
cws_note "access token acquired (not logged)"

# ------------------------------------------------------------- 3. items.insert

cws_step "Creating the item (items.insert)"
URL="https://www.googleapis.com/upload/chromewebstore/v1.1/items"
[ -n "$PUBLISHER_EMAIL" ] && URL="${URL}?publisherEmail=${PUBLISHER_EMAIL}"

cws_cfg_new
cws_cfg_add "url = \"${URL}\""
cws_cfg_add "header = \"Authorization: Bearer ${ACCESS_TOKEN}\""
cws_cfg_add 'header = "x-goog-api-version: 2"'
cws_cfg_add "upload-file = \"${ZIP}\""
cws_cfg_add 'request = "POST"'
cws_cfg_add 'silent'
cws_cfg_add 'show-error'

rc=0
RESP="$(curl --config "$CWS_CFG" 2>&1)" || rc=$?
cws_curl_cleanup
[ "$rc" -eq 0 ] || cws_die "items.insert request failed (curl exit $rc)."

STATE="$(printf '%s' "$RESP" | cws_json_field 'd.uploadState')" || STATE=""
ITEM_ID="$(printf '%s' "$RESP" | cws_json_field 'd.id')" || ITEM_ID=""

if [ "$STATE" != "SUCCESS" ] || [ -z "$ITEM_ID" ]; then
  echo "" >&2
  echo "✗ Item creation failed${STATE:+ (uploadState: $STATE)}" >&2
  printf '%s' "$RESP" | cws_json_dump
  echo "" >&2
  echo "  Common causes:" >&2
  echo "  • The \$5 developer registration fee is unpaid, or the developer agreement" >&2
  echo "    is unaccepted — both are yours to do at chrome.google.com/webstore/devconsole." >&2
  echo "  • The Google account you granted in oauth-init.mjs is not the developer account." >&2
  echo "  • The manifest still carries a \`key\` field (this script checks, so unlikely)." >&2
  exit 1
fi

cat <<EOF

  ┌───────────────────────────────────────────────────┐
     Item ID:  $ITEM_ID
  └───────────────────────────────────────────────────┘

  Add it to .env (gitignored) so scripts/publish-cws.sh can find it:

      echo 'CWS_EXTENSION_ID=$ITEM_ID' >> .env

  The item is a DRAFT with an EMPTY listing, and it stays that way: the API
  cannot set the description, screenshots, category, permission
  justifications, privacy practices or the data-collection declaration.
  All of that is dashboard-only.

  Next, in order — store/SUBMIT.md has the detail:
    4. Copy the Item ID and the public key from the item's Package tab.
    5. Write both back into extension/manifest.json and mcp-server/index.js,
       then re-run the tests. Do this BEFORE npm publish, or every Web Store
       user gets a server that 403s their extension.
    6. ./scripts/publish-cws.sh --draft   (uploads the real, key-carrying zip)
    7. Fill in the listing in the dashboard from store/LISTING.md.
   10. Submit for review.

  https://chrome.google.com/webstore/devconsole/
EOF
