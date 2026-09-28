#!/usr/bin/env bash
# One-command deploy (and upgrade) of NEOS + Ledger, for a production host. Idempotent: re-running it
# upgrades in place and skips what is done. It never prints a secret.
#
#   scripts/deploy.sh <env file>          (template: deploy/production.env.example)
#
# Steps: check inputs → backup (upgrade only) → secrets → build → migrate → start → register (with the
# release's conformance attestation) → company, admin, install → Matrix allowlist → optional email door →
# verify-install → smoke. The admin's API token is written to $NEOS_SECRETS_DIR/admin_token (0600).
#
# Door credentials (v3 §12: the secret store, per (app, company), read by the backend per call):
#   scripts/deploy.sh door set <company_id> <door> [app] < credential.json    (JSON on stdin, never argv)
#   scripts/deploy.sh door rm  <company_id> <door> [app]
#   scripts/deploy.sh door ls                                                (names only, never contents)
# NEOS_SECRETS_DIR from the environment, or from the env file named by NEOS_ENV_FILE. Files land in
# $NEOS_SECRETS_DIR/doors/<company>/[<app>/]<door>.json, 0600, owned by the backend's user (NEOS_DOORS_UID,
# default 1000 = the image's `node`); without [app] the credential is company-wide. The backend reads it on the
# next call: no restart.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)

say() { printf '\n== %s\n' "$*"; }
die() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }
seg() { [[ "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ && "$2" != *..* ]] || die "$1 '$2' is not a valid secret-store name"; }
# The backend runs as NEOS_DOORS_UID; the store must be its own (0700 directories, 0600 files).
own_doors() {
  local u=${NEOS_DOORS_UID:-1000} d="$NEOS_SECRETS_DIR/doors"
  [ -d "$d" ] || return 0
  chmod -R go-rwx "$d"
  if [ "$(id -u)" = 0 ]; then chown -R "$u:$u" "$d"
  elif [ "$(id -u)" != "$u" ]; then printf 'WARNING: %s is owned by uid %s but the backend reads it as uid %s: run as root or set NEOS_DOORS_UID\n' "$d" "$(id -u)" "$u" >&2; fi
}
# door_write <company> <door> [app] — the credential JSON on stdin. Written beside, then renamed: a backend reading
# mid-rotation sees the old credential or the new one, never half of one. Nothing is echoed.
door_write() {
  local co=$1 door=$2 app=${3:-} dir file tmp
  seg company "$co"; seg door "$door"; [ -z "$app" ] || seg app "$app"
  dir="$NEOS_SECRETS_DIR/doors/$co${app:+/$app}"; file="$dir/$door.json"
  (umask 077; mkdir -p "$dir")
  tmp=$(umask 077; mktemp "$dir/.$door.XXXXXX")
  if ! jq -ce 'if type == "object" and (.provider | type) == "string" then . else error("x") end' > "$tmp" 2>/dev/null; then
    rm -f "$tmp"; die "the credential on stdin must be one JSON object with a \"provider\" (nothing was written)"
  fi
  chmod 600 "$tmp"; mv -f "$tmp" "$file"
  own_doors
  printf '{"ok":true,"company":"%s","door":"%s","app":%s,"file":"%s"}\n' "$co" "$door" "$( [ -n "$app" ] && printf '"%s"' "$app" || printf null)" "${file#"$NEOS_SECRETS_DIR"/}"
}

if [ "${1:-}" = door ]; then
  if [ -z "${NEOS_SECRETS_DIR:-}" ] && [ -n "${NEOS_ENV_FILE:-}" ]; then set -a; . "$NEOS_ENV_FILE"; set +a; fi
  [ -n "${NEOS_SECRETS_DIR:-}" ] || die "NEOS_SECRETS_DIR is not set (or name the deploy env file in NEOS_ENV_FILE)"
  command -v jq >/dev/null || die "jq is required"
  case "${2:-}" in
    set) [ -n "${3:-}" ] && [ -n "${4:-}" ] || die "usage: scripts/deploy.sh door set <company_id> <door> [app] < credential.json"
         [ -t 0 ] && die "the credential goes on stdin (never on the command line): scripts/deploy.sh door set $3 $4 ${5:-} < credential.json"
         door_write "$3" "$4" "${5:-}";;
    rm)  [ -n "${3:-}" ] && [ -n "${4:-}" ] || die "usage: scripts/deploy.sh door rm <company_id> <door> [app]"
         seg company "$3"; seg door "$4"; [ -z "${5:-}" ] || seg app "$5"
         rm -f "$NEOS_SECRETS_DIR/doors/$3${5:+/$5}/$4.json"; echo "removed: the door now fails as not connected";;
    ls)  [ -d "$NEOS_SECRETS_DIR/doors" ] && (cd "$NEOS_SECRETS_DIR/doors" && find . -name '*.json' -type f | sed 's|^\./||' | sort) || true;;
    *)   die "usage: scripts/deploy.sh door set|rm|ls …";;
  esac
  exit 0
fi

ENV_FILE=${1:?usage: scripts/deploy.sh <env file>  |  scripts/deploy.sh door set|rm|ls …}
set -a; . "$ENV_FILE"; set +a
cd "$ROOT"
need() { for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set in $ENV_FILE"; done; }
need NEOS_PROJECT NEOS_SECRETS_DIR COMPANY_NAME COMPANY_TZ ADMIN_NAME ADMIN_EMAIL LLM_KEY_FILE MATRIX_HOMESERVER_URL MATRIX_SERVER_NAME LEDGER_MXID LEDGER_MATRIX_TOKEN_FILE BRIDGE_MXID
[ -s "$LLM_KEY_FILE" ] || die "LLM_KEY_FILE ($LLM_KEY_FILE) is empty or missing"
[ -s "$LEDGER_MATRIX_TOKEN_FILE" ] || die "LEDGER_MATRIX_TOKEN_FILE ($LEDGER_MATRIX_TOKEN_FILE) is empty or missing"
# v3 §5/§8/§16: only a person says yes — on the desk, or with their own answer in their own DM/room. Nothing
# approves on a person's behalf: the old BRIDGE_MAY_APPROVE switch is gone and the platform refuses it.
case "${BRIDGE_MAY_APPROVE:-}" in
  ""|false) ;;
  *) die "BRIDGE_MAY_APPROVE is no longer supported: a bridge (NeuralChat) can never approve — only a person, on the desk or in their own DM (v3 §5/§8/§16). Remove BRIDGE_MAY_APPROVE from $ENV_FILE (docs/GO-LIVE.md §3)";;
esac
ATTEST="$ROOT/deploy/attestations/ledger.json"
[ -s "$ATTEST" ] || die "no conformance attestation for this release ($ATTEST): run tsx scripts/conformance.ts ledger --out $ATTEST on the build machine"
command -v docker >/dev/null || die "docker is required"
command -v jq >/dev/null || die "jq is required"
export NEOS_SECRETS_DIR NEOS_PLATFORM_PORT="${NEOS_PLATFORM_PORT:-4000}"
PORT=$NEOS_PLATFORM_PORT
STATE="$NEOS_SECRETS_DIR/deploy-state.json"
BASE=(-f deploy/compose.pilot.yml)
for extra in ${NEOS_COMPOSE_EXTRA:-}; do BASE+=(-f "$extra"); done
FILES=("${BASE[@]}")
# The Matrix client road needs the company; it is added once the company exists (steps 8+).
[ -s "$STATE" ] && [ -n "$(jq -r '.company_id // empty' "$STATE")" ] && FILES=("${BASE[@]}" -f deploy/compose.matrix-external.yml)
PROFILES=()
[ "${OBSERVABILITY:-0}" = 1 ] && PROFILES+=(--profile observability)
dc() { docker compose -p "$NEOS_PROJECT" "${FILES[@]}" ${PROFILES[@]+"${PROFILES[@]}"} "$@"; }
state() { [ -s "$STATE" ] && jq -r ".$1 // empty" "$STATE" || true; }
setstate() { local cur='{}'; [ -s "$STATE" ] && cur=$(cat "$STATE"); echo "$cur" | jq --arg k "$1" --arg v "$2" '.[$k]=$v' > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; chmod 600 "$STATE"; }
# The Matrix overlay (added once the company exists) needs the company id from the very first compose call.
export NEOS_CHAT_COMPANY="$(state company_id)"
# The body goes on stdin (printf is a builtin), never on a command line where `ps` could show a key.
api() {
  if [ -n "${3:-}" ]; then printf '%s' "$3" | curl -sS -X "$1" "http://127.0.0.1:$PORT$2" -H "@$NEOS_SECRETS_DIR/.auth_header" -H 'content-type: application/json' --data-binary @-
  else curl -sS -X "$1" "http://127.0.0.1:$PORT$2" -H "@$NEOS_SECRETS_DIR/.auth_header" -H 'content-type: application/json'; fi
}
auth_header() { [ -s "$NEOS_SECRETS_DIR/admin_token" ] && { printf 'authorization: Bearer %s\n' "$(cat "$NEOS_SECRETS_DIR/admin_token")" > "$NEOS_SECRETS_DIR/.auth_header"; chmod 600 "$NEOS_SECRETS_DIR/.auth_header"; }; }
OPS=(run --rm --no-deps -T -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOP_SERVICE_SECRET_FILE=/tmp/svc -v "$NEOS_SECRETS_DIR/ledger_service_secret:/tmp/svc:ro" -v "$ATTEST:/tmp/conformance.json:ro" platform tsx scripts/ops.ts)
ops() { dc "${OPS[@]}" "$@" 2>/dev/null | grep -v '^ *Container ' | tail -1; }

say "1/11 backup before upgrading (skipped on a first install)"
if [ -n "$(state company_id)" ] && dc ps --services --status running 2>/dev/null | grep -qx backup; then
  dc exec -T backup tsx scripts/backup.ts nightly | tail -1 || die "pre-upgrade backup failed — nothing was changed"
else echo "first install: nothing to back up"; fi

say "2/11 secrets (never overwrites)"
mkdir -p "$NEOS_SECRETS_DIR" && chmod 700 "$NEOS_SECRETS_DIR"
docker run --rm -v "$ROOT:/src:ro" -v "$NEOS_SECRETS_DIR:/out" -w /src node:24-bookworm-slim sh -c 'npx --yes tsx@4 scripts/gen-secrets.ts /out ledger' >/dev/null 2>&1 \
  || (command -v pnpm >/dev/null && pnpm exec tsx scripts/gen-secrets.ts "$NEOS_SECRETS_DIR" ledger >/dev/null) || die "could not generate secrets"
install -m 600 "$LLM_KEY_FILE" "$NEOS_SECRETS_DIR/llm_upstream_key"
install -m 600 "$LEDGER_MATRIX_TOKEN_FILE" "$NEOS_SECRETS_DIR/matrix_ledger_token"
for f in matrix_hs_token matrix_as_token; do [ -e "$NEOS_SECRETS_DIR/$f" ] || : > "$NEOS_SECRETS_DIR/$f"; done
# Containers run as their own users: they must be able to read the files mounted as secrets (the directory stays 0700).
chmod a+r "$NEOS_SECRETS_DIR"/*
# … except what no container reads: the admin's token and the deploy state stay owner-only.
for f in admin_token deploy-state.json; do [ -e "$NEOS_SECRETS_DIR/$f" ] && chmod 600 "$NEOS_SECRETS_DIR/$f"; done
# … and the door secret store (v3 §12): the backend's alone, 0700/0600, mounted read-only into it (and the backup).
mkdir -p "$NEOS_SECRETS_DIR/doors"; own_doors
chmod 755 "$NEOS_SECRETS_DIR"

say "3/11 build images"
dc build >/dev/null

say "4/11 migrate (admin link; safe to re-run)"
dc run --rm migrate 2>&1 | grep -E 'applying|complete|rror' || die "migration failed"

say "5/11 start"
# The company is needed by the Matrix client road; on a first install it does not exist yet, so start without it first.
dc up -d --remove-orphans >/dev/null 2>&1 || die "compose up failed: dc up -d to see why"
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/live" >/dev/null 2>&1 && break; sleep 2; [ "$i" = 60 ] && die "platform did not become live"; done

say "6/11 register Ledger (conformance attestation required in production)"
ops register-app ledger http://ledger-l3:4101 --conformance /tmp/conformance.json | tee /dev/stderr | grep -q '"attested":true' || die "registration refused"

say "7/11 company, admin, install"
CO=$(state company_id)
if [ -z "$CO" ]; then
  CO=$(ops create-company "$COMPANY_NAME" "$COMPANY_TZ" | jq -r .id); [ -n "$CO" ] && [ "$CO" != null ] || die "create-company failed"
  setstate company_id "$CO"
  ops create-user "$CO" "$ADMIN_NAME" "$ADMIN_EMAIL" admin | jq -r .token > "$NEOS_SECRETS_DIR/admin_token"; chmod 600 "$NEOS_SECRETS_DIR/admin_token"
  [ -s "$NEOS_SECRETS_DIR/admin_token" ] || die "create-user failed"
fi
ops install "$CO" ledger >/dev/null
# A real company starts with empty books: give it the starter chart of accounts once (never on a re-run).
if [ "${STARTER_CHART:-in_sme}" != none ] && [ -z "$(state starter_chart)" ]; then
  dc exec -T ledger-backend tsx apps/ledger/scripts/seed.ts "$CO" --starter-chart | tail -1 || die "starter chart failed"
  setstate starter_chart "${STARTER_CHART:-in_sme}"
fi
auth_header
echo "company $CO · admin token in $NEOS_SECRETS_DIR/admin_token"

say "8/11 Matrix client road for this company"
export NEOS_CHAT_COMPANY="$CO"
FILES=("${BASE[@]}" -f deploy/compose.matrix-external.yml)
dc up -d platform >/dev/null 2>&1 || die "platform with the Matrix overlay did not start"
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/live" >/dev/null 2>&1 && break; sleep 2; done
ME=$(api GET /api/me | jq -r .id)
[ -n "${ADMIN_MXID:-}" ] && api PUT "/api/users/$ME/chat" "{\"matrix_user_id\":\"$ADMIN_MXID\"}" >/dev/null && api PUT /api/chat/allowlist "{\"app\":\"ledger\",\"matrix_id\":\"$ADMIN_MXID\",\"kind\":\"person\"}" >/dev/null
api PUT /api/chat/allowlist "{\"app\":\"ledger\",\"matrix_id\":\"$BRIDGE_MXID\",\"kind\":\"bridge\",\"acts_for\":\"$ME\"}" | jq -c '{matrix_id,kind,acts_for}'
api GET /api/chat/client | jq -c '.accounts[]|{account,running,stopped}'

say "9/11 email door (optional) → the secret store, for Ledger at this company"
if [ -n "${EMAIL_DOOR_JSON:-}" ]; then
  keyfile=$(jq -r '.api_key_file // empty' <<<"$EMAIL_DOOR_JSON") || die "EMAIL_DOOR_JSON is not valid JSON — in the env file it must be in single quotes: EMAIL_DOOR_JSON='{\"provider\":…}'"
  key=""; if [ -n "$keyfile" ]; then [ -s "$keyfile" ] || die "email api_key_file ($keyfile) is empty or missing"; key=$(tr -d '\n' < "$keyfile"); fi
  body=$(jq -c --arg k "$key" 'if .api_key_file then (.api_key = $k | del(.api_key_file)) else . end' <<<"$EMAIL_DOOR_JSON")
  # On stdin (printf is a builtin), never argv; written 0600 where the backend reads it on the next call.
  printf '%s' "$body" | door_write "$CO" email ledger >/dev/null; unset key body
  jq -c '{ok: true, door: "email", app: "ledger", provider}' <<<"$EMAIL_DOOR_JSON"
else echo "not configured: gated emails will fail cleanly until ops runs: scripts/deploy.sh door set $CO email ledger < credential.json"; fi

say "10/11 verify the install (read-only)"
# The door files are checked by name and mode only (never opened); the rendered compose config shows who mounts them.
RENDERED=$(mktemp /tmp/neops-compose.XXXXXX); dc config > "$RENDERED" 2>/dev/null || die "docker compose config failed"; chmod 644 "$RENDERED"
dc run --rm --no-deps -T -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOP_RUNNER_DB_URL_FILE=/tmp/r -e NEOS_PLATFORM_URL=http://platform:4000 -e NEOP_LLM_UPSTREAM_KEY_FILE=/tmp/k \
  -e NEOP_DOOR_SECRETS_DIR=/run/secrets/doors -e NEOS_COMPOSE_FILE=/tmp/compose.yml \
  -v "$NEOS_SECRETS_DIR/ledger_runner_url:/tmp/r:ro" -v "$NEOS_SECRETS_DIR/llm_upstream_key:/tmp/k:ro" \
  -v "$NEOS_SECRETS_DIR/doors:/run/secrets/doors:ro" -v "$RENDERED:/tmp/compose.yml:ro" \
  platform tsx scripts/verify-install.ts ledger "$CO" 2>/dev/null | grep -v '^ *Container ' | tee /tmp/neops-verify.txt | tail -16
rm -f "$RENDERED"
grep -q 'All checks passed' /tmp/neops-verify.txt || die "verify-install reported failures (above)"

say "11/11 smoke"
tb=$(api POST /api/apps/ledger/read/ledger.periods.status '{}' | jq -r 'if .result then "ok" else . end')
[ "$tb" = ok ] || die "a read through the gateway failed: $tb"
echo "reads through the gateway: ok · model, Matrix and approvals: run scripts/neuralchat-sim.ts or ask through NeuralChat"
say "DEPLOYED · project $NEOS_PROJECT · company $CO · platform http://127.0.0.1:$PORT"
