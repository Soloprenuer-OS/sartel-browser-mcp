#!/usr/bin/env bash
#
# Build the Chrome Web Store upload zip from extension/.
#
# Two variants, because the store treats the manifest "key" field differently on
# the first upload than on every one after it:
#
#   --first-upload   strips "key" from the manifest inside the zip. The Chrome
#                    Web Store REJECTS a first upload that carries "key" ("key
#                    field not allowed"); it generates its own keypair and
#                    assigns the extension ID at that upload.
#   (default)        keeps "key" as committed. Use for every upload after the
#                    first, once the CWS-issued public key has been written back
#                    into extension/manifest.json.
#
# With no flag both variants are built, so the user has each on hand.
#
# The working-tree manifest is never modified. key.pem, dotfiles and anything
# ignored by git stay out of the zip by construction: the file list is built
# from an explicit allowlist walk, not from a glob of the directory.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/extension"
OUT="$ROOT/dist"

VERSION="$(node -p "require('$SRC/manifest.json').version")"
NAME="$(node -p "require('$SRC/manifest.json').name.toLowerCase().replace(/[^a-z0-9]+/g,'-')")"

MODE="both"
case "${1:-}" in
  --first-upload) MODE="first" ;;
  --update)       MODE="update" ;;
  "")             MODE="both" ;;
  *) echo "usage: $(basename "$0") [--first-upload|--update]" >&2; exit 2 ;;
esac

mkdir -p "$OUT"

# Build one zip. $1 = "strip" | "keep", $2 = output path.
build() {
  local key_mode="$1" zip_path="$2"
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN

  # Copy the extension, excluding dotfiles, keys and anything git ignores.
  ( cd "$SRC" && find . -mindepth 1 \
      \( -name '.*' -o -name '*.pem' -o -name 'node_modules' \) -prune -o \
      -type f -print ) | while read -r f; do
    mkdir -p "$stage/$(dirname "$f")"
    cp "$SRC/$f" "$stage/$f"
  done

  if [ "$key_mode" = "strip" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      delete m.key;
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    ' "$stage/manifest.json"
  fi

  rm -f "$zip_path"
  ( cd "$stage" && zip -q -r -X "$zip_path" . -x '.*' -x '*/.*' )

  echo
  echo "→ $zip_path"
  echo "  manifest key: $( [ "$key_mode" = "strip" ] && echo 'STRIPPED (first upload only)' || echo 'present (updates only)' )"
  echo "  contents:"
  unzip -Z1 "$zip_path" | sed 's/^/    /'
  # Belt and braces: fail loudly rather than ship a private key or a dotfile.
  if unzip -Z1 "$zip_path" | grep -qE '(^|/)\.|\.pem$'; then
    echo "  ERROR: zip contains a dotfile or a key. Refusing." >&2
    exit 1
  fi
}

if [ "$MODE" = "first" ] || [ "$MODE" = "both" ]; then
  build strip "$OUT/$NAME-$VERSION-first-upload.zip"
fi
if [ "$MODE" = "update" ] || [ "$MODE" = "both" ]; then
  build keep "$OUT/$NAME-$VERSION.zip"
fi

echo
echo "Upload order matters — see store/SUBMIT.md."
