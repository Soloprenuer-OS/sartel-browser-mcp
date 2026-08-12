#!/usr/bin/env bash
#
# Shared helpers for the Chrome Web Store API scripts.
#
#   scripts/publish-cws.sh      — upload a new version of an existing item
#   scripts/cws-create-item.sh  — create the item in the first place
#
# Sourced, not executed. Nothing here prints a secret: credentials go to curl
# through a mode-0600 config file rather than argv, so they never appear in
# `ps`, and every response body printed on failure is scrubbed of token fields.
#
# One-time setup: docs/CWS_PUBLISH_SETUP.md

# ---------------------------------------------------------------- diagnostics

cws_die() {
  echo "" >&2
  echo "✗ $*" >&2
  exit 1
}

cws_note() { echo "  $*"; }
cws_step() { echo "→ $*"; }

# Describe a secret without disclosing it.
cws_redact() {
  local v="${1-}"
  if [ -z "$v" ]; then echo "unset"; else echo "set (${#v} chars)"; fi
}

# ------------------------------------------------------------------ env / .env

# Callers define ROOT (the repo root) before sourcing this file.
CWS_ENV_FILE="${CWS_ENV_FILE:-${ROOT:-.}/.env}"

# Parse .env without sourcing it. `source .env` executes whatever is in the
# file — a stray $(...) in a value would run as a command. Only plain
# KEY=VALUE lines are honoured, and only the CWS_* keys are exported.
cws_load_env() {
  if [ ! -f "$CWS_ENV_FILE" ]; then
    return 0
  fi
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    line="${line#export }"
    case "$line" in
      CWS_*=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Strip one layer of surrounding quotes, and any trailing CR from CRLF.
    value="${value%$'\r'}"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Environment already set wins over .env, so CI secrets override the file.
    if [ -z "$(eval "printf '%s' \"\${$key-}\"")" ]; then
      export "$key=$value"
    fi
  done < "$CWS_ENV_FILE"
}

# Credentials are pasted by hand, so reject anything that cannot be a Google
# credential before it reaches a curl config file, where a quote would break
# out of the value.
cws_check_charset() {
  local name="$1" value="$2"
  case "$value" in
    *[!A-Za-z0-9._~:/@-]*)
      cws_die "$name contains characters that are not valid in a Google OAuth credential.
  Re-copy it from the Cloud console; do not wrap it in quotes in .env."
      ;;
  esac
}

# cws_require VAR "hint shown when it is missing"
cws_require() {
  local name="$1" hint="$2" value
  value="$(eval "printf '%s' \"\${$name-}\"")"
  if [ -z "$value" ]; then
    cat >&2 <<EOF

✗ $name is not set.

  Expected it in $CWS_ENV_FILE (gitignored) or in the environment.
  $hint

  One-time setup instructions: docs/CWS_PUBLISH_SETUP.md
EOF
    exit 1
  fi
  cws_check_charset "$name" "$value"
}

cws_require_oauth() {
  cws_require CWS_CLIENT_ID     "Create a Desktop-app OAuth client — setup doc step 3."
  cws_require CWS_CLIENT_SECRET "Same modal as the client ID — setup doc step 3."
  cws_require CWS_REFRESH_TOKEN "Run: node scripts/oauth-init.mjs — setup doc step 4."
}

# --------------------------------------------------------------------- tooling

cws_require_tools() {
  local t
  for t in node curl zip unzip; do
    command -v "$t" >/dev/null 2>&1 || cws_die "\`$t\` is not on PATH; it is required."
  done
}

# ------------------------------------------------------------------ JSON utils

# Read JSON on stdin, evaluate a JS expression over `d`, print the result.
# Exit 3 = body was not JSON, 4 = field absent.
cws_json_field() {
  node -e '
    const fs = require("fs");
    let raw = "";
    try { raw = fs.readFileSync(0, "utf8"); } catch (e) { raw = ""; }
    let d;
    try { d = JSON.parse(raw); }
    catch (e) {
      process.stderr.write("  (response was not JSON)\n");
      process.stderr.write(raw.slice(0, 800).replace(/^/gm, "  ") + "\n");
      process.exit(3);
    }
    let v;
    try { v = new Function("d", "return (" + process.argv[1] + ")")(d); }
    catch (e) { process.exit(4); }
    if (v === undefined || v === null) process.exit(4);
    process.stdout.write(String(v));
  ' "$1"
}

# Pretty-print a response for a human, with any credential-shaped field removed.
cws_json_dump() {
  node -e '
    const fs = require("fs");
    const SECRET = /token|secret|assertion|password|credential/i;
    const scrub = (v) => {
      if (Array.isArray(v)) return v.map(scrub);
      if (v && typeof v === "object") {
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = SECRET.test(k) ? "«redacted»" : scrub(x);
        return o;
      }
      return v;
    };
    let raw = "";
    try { raw = fs.readFileSync(0, "utf8"); } catch (e) {}
    try { console.error(JSON.stringify(scrub(JSON.parse(raw)), null, 2).replace(/^/gm, "  ")); }
    catch (e) { console.error(raw.slice(0, 2000).replace(/^/gm, "  ")); }
  '
}

# ------------------------------------------------------------------ curl plumbing

# Build a mode-0600 curl config file. Credentials passed as `-d` / `-H`
# arguments are visible to every user on the machine via `ps`; a config file
# is not. Prints the path; caller is responsible for cws_curl_cleanup.
CWS_CFG=""
cws_curl_cleanup() { [ -n "$CWS_CFG" ] && rm -f "$CWS_CFG"; CWS_CFG=""; }

cws_cfg_new() {
  local old_umask
  old_umask="$(umask)"
  umask 077
  CWS_CFG="$(mktemp "${TMPDIR:-/tmp}/cws-cfg.XXXXXX")"
  umask "$old_umask"
  : > "$CWS_CFG"
}

cws_cfg_add() { printf '%s\n' "$1" >> "$CWS_CFG"; }

# --------------------------------------------------------------- access token

# Exchange the long-lived refresh token for a one-hour access token.
# Echoes the token on stdout; never logs it.
cws_access_token() {
  cws_cfg_new
  cws_cfg_add 'url = "https://oauth2.googleapis.com/token"'
  cws_cfg_add "data-urlencode = \"client_id=${CWS_CLIENT_ID}\""
  cws_cfg_add "data-urlencode = \"client_secret=${CWS_CLIENT_SECRET}\""
  cws_cfg_add "data-urlencode = \"refresh_token=${CWS_REFRESH_TOKEN}\""
  cws_cfg_add 'data-urlencode = "grant_type=refresh_token"'
  cws_cfg_add 'silent'
  cws_cfg_add 'show-error'

  local resp rc=0
  resp="$(curl --config "$CWS_CFG" 2>&1)" || rc=$?
  cws_curl_cleanup
  if [ "$rc" -ne 0 ]; then
    cws_die "could not reach oauth2.googleapis.com (curl exit $rc). Check your network."
  fi

  local token
  token="$(printf '%s' "$resp" | cws_json_field 'd.access_token')" || token=""
  if [ -z "$token" ]; then
    local err
    err="$(printf '%s' "$resp" | cws_json_field 'd.error')" || err=""
    echo "" >&2
    echo "✗ OAuth token refresh failed${err:+: $err}" >&2
    printf '%s' "$resp" | cws_json_dump
    case "$err" in
      invalid_grant)
        echo "  → The refresh token is expired or was revoked." >&2
        echo "    Delete the CWS_REFRESH_TOKEN line from .env and re-run: node scripts/oauth-init.mjs" >&2 ;;
      invalid_client)
        echo "  → CWS_CLIENT_ID / CWS_CLIENT_SECRET do not match a live OAuth client." >&2
        echo "    Re-copy them from the Google Cloud console — docs/CWS_PUBLISH_SETUP.md step 3." >&2 ;;
    esac
    exit 1
  fi
  printf '%s' "$token"
}

# --------------------------------------------------------------- zip inspection

# Fail loudly rather than upload a package whose manifest `key` is wrong for
# the endpoint being called. "present" or "absent" as $2.
cws_assert_manifest_key() {
  local zip_path="$1" want="$2" has
  has="$(unzip -p "$zip_path" manifest.json | cws_json_field 'd.key ? "present" : "absent"')" \
    || cws_die "could not read manifest.json out of $zip_path"
  if [ "$has" != "$want" ]; then
    cws_die "$(basename "$zip_path") has manifest key $has, expected $want.
  Rebuild with scripts/build-zip.sh — see store/SUBMIT.md for which zip goes where."
  fi
}
