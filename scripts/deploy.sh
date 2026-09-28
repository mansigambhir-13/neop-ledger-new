#!/usr/bin/env bash
# One-command deploy (and upgrade) of NEOS + Ledger, for a production host. Idempotent: re-running it
# upgrades in place and skips what is done. It never prints a secret.
#
#   scripts/deploy.sh <env file>          (template: deploy/production.env.example)
#
# Steps: check inputs → backup (upgrade only) → secrets → build → migrate → start → register (with the
# release's conformance attestation) → company, admin, install → Matrix allowlist → optional email door →
# verify-install → smoke. The admin's API token is written to $NEOS_SECRETS_DIR/admin_token (0600).
set -euo pipefail
ENV_FILE=${1:?usage: scripts/deploy.sh <env file>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
set -a; . "$ENV_FILE"; set +a
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }
need() { for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set in $ENV_FILE"; done; }
need NEOS_PROJECT NEOS_SECRETS_DIR COMPANY_NAME COMPANY_TZ ADMIN_NAME ADMIN_EMAIL LLM_KEY_FILE MATRIX_HOMESERVER_URL MATRIX_SERVER_NAME LEDGER_MXID LEDGER_MATRIX_TOKEN_FILE BRIDGE_MXID
[ -s "$LLM_KEY_FILE" ] || die "LLM_KEY_FILE ($LLM_KEY_FILE) is empty or missing"
[ -s "$LEDGER_MATRIX_TOKEN_FILE" ] || die "LEDGER_MATRIX_TOKEN_FILE ($LEDGER_MATRIX_TOKEN_FILE) is empty or missing"
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
api PUT /api/chat/allowlist "{\"app\":\"ledger\",\"matrix_id\":\"$BRIDGE_MXID\",\"kind\":\"bridge\",\"acts_for\":\"$ME\",\"may_approve\":${BRIDGE_MAY_APPROVE:-false}}" | jq -c '{matrix_id,kind,may_approve}'
api GET /api/chat/client | jq -c '.accounts[]|{account,running,stopped}'

say "9/11 email door (optional)"
if [ -n "${EMAIL_DOOR_JSON:-}" ]; then
  keyfile=$(jq -r '.api_key_file // empty' <<<"$EMAIL_DOOR_JSON") || die "EMAIL_DOOR_JSON is not valid JSON — in the env file it must be in single quotes: EMAIL_DOOR_JSON='{\"provider\":…}'"
  key=""; if [ -n "$keyfile" ]; then [ -s "$keyfile" ] || die "email api_key_file ($keyfile) is empty or missing"; key=$(tr -d '\n' < "$keyfile"); fi
  body=$(jq -c --arg k "$key" 'if .api_key_file then (.api_key = $k | del(.api_key_file)) else . end' <<<"$EMAIL_DOOR_JSON")
  res=$(api PUT '/api/vault/email?app=ledger' "$body"); unset key body
  jq -e '.ok == true' >/dev/null <<<"$res" || die "the email door was refused: $(jq -c '.error // .' <<<"$res")"
  jq -c '{ok,door,app,provider}' <<<"$res"
else echo "not configured: gated emails will fail cleanly until an admin connects the email door"; fi

say "10/11 verify the install (read-only)"
dc run --rm --no-deps -T -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOP_RUNNER_DB_URL_FILE=/tmp/r -e NEOS_PLATFORM_URL=http://platform:4000 -e NEOP_LLM_UPSTREAM_KEY_FILE=/tmp/k \
  -v "$NEOS_SECRETS_DIR/ledger_runner_url:/tmp/r:ro" -v "$NEOS_SECRETS_DIR/llm_upstream_key:/tmp/k:ro" \
  platform tsx scripts/verify-install.ts ledger "$CO" 2>/dev/null | grep -v '^ *Container ' | tee /tmp/neops-verify.txt | tail -16
grep -q 'All checks passed' /tmp/neops-verify.txt || die "verify-install reported failures (above)"

say "11/11 smoke"
tb=$(api POST /api/apps/ledger/read/ledger.periods.status '{}' | jq -r 'if .result then "ok" else . end')
[ "$tb" = ok ] || die "a read through the gateway failed: $tb"
echo "reads through the gateway: ok · model, Matrix and approvals: run scripts/neuralchat-sim.ts or ask through NeuralChat"
say "DEPLOYED · project $NEOS_PROJECT · company $CO · platform http://127.0.0.1:$PORT"
