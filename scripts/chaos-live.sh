#!/usr/bin/env bash
# Real chaos (plan Phase 6: "zero lost jobs across 50 forced restarts") against a RUNNING compose
# project: sends asks, SIGKILLs the backend again and again (once the agent, once the platform),
# answers cards, then checks from the platform's records and the provider's own count that every
# task completed exactly once and nothing was executed twice. See deploy/chaos/driver.ts.
#
#   docker compose -p neops-chaos -f deploy/compose.pilot.yml -f deploy/compose.chaos.yml run --rm migrate
#   docker compose -p neops-chaos -f deploy/compose.pilot.yml -f deploy/compose.chaos.yml up -d
#   scripts/chaos-live.sh neops-chaos deploy/compose.pilot.yml,deploy/compose.chaos.yml
#
# The chaos overlay swaps the model provider and Resend for deploy/chaos/fakes.ts (reached through
# the egress proxy like the real ones), so no key or money is needed and emails are countable.
# Env: CHAOS_JOBS (20) CHAOS_RESTARTS (50) CHAOS_INTERVAL_MS (3000) CHAOS_PLATFORM_URL
# (http://127.0.0.1:4000) CHAOS_SECRETS_DIR (deploy/secrets). Bootstraps a fresh company unless
# CHAOS_TOKEN (an admin's desk token of a company already set up this way) is given.
set -euo pipefail
PROJ=${1:?compose project}; FILES=${2:-deploy/compose.pilot.yml,deploy/compose.chaos.yml}
cd "$(dirname "$0")/.."
args=(-p "$PROJ")
IFS=',' read -ra fs <<< "$FILES"
for f in "${fs[@]}"; do args+=(-f "$f"); done
dc() { docker compose "${args[@]}" "$@"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=s.trim().split('\n').filter(x=>x.startsWith('{')).pop();console.log(JSON.parse(l)$1)})"; }
SECRETS=${CHAOS_SECRETS_DIR:-deploy/secrets}
export CHAOS_PLATFORM_URL=${CHAOS_PLATFORM_URL:-http://127.0.0.1:4000}

dc ps --status running --services | grep -qx fakes || { echo "the chaos overlay (fakes) is not running in $PROJ" >&2; exit 2; }

if [ -z "${CHAOS_TOKEN:-}" ]; then
  OPS=(run --rm --no-deps -T -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOP_SERVICE_SECRET_FILE=/run/secrets/ledger_service_secret
       -v "$PWD/$SECRETS/ledger_service_secret:/run/secrets/ledger_service_secret:ro" platform tsx scripts/ops.ts)
  dc "${OPS[@]}" register-app ledger http://ledger-l3:4101 >/dev/null
  CO=$(dc "${OPS[@]}" create-company "Chaos Traders $(date +%s)" Asia/Kolkata | json .id)
  export CHAOS_TOKEN=$(dc "${OPS[@]}" create-user "$CO" Chaos "chaos-$CO@example.test" admin | json .token)
  dc "${OPS[@]}" install "$CO" ledger >/dev/null
  dc exec -T ledger-backend tsx apps/ledger/scripts/seed.ts "$CO" --demo-data >/dev/null
  RESEND=$(dc exec -T fakes node -e "fetch('http://127.0.0.1:4900/_resend_token').then(r=>r.text()).then(t=>process.stdout.write(t))")
  # v3 §12: the email door's credential goes into the secret store the backend reads per call (stdin, never argv).
  printf '{"provider":"resend","api_key":"%s","from":"Chaos Books <books@chaos.example>","base_url":"http://fakes:4900"}' "$RESEND" \
    | NEOS_SECRETS_DIR="$(cd "$SECRETS" && pwd)" bash scripts/deploy.sh door set "$CO" email ledger >/dev/null 2>&1
  # CI only (as for the other throwaway secrets): the backend runs as another uid than the runner.
  [ -n "${CI:-}" ] && chmod -R a+rX "$SECRETS/doors"
  echo "bootstrapped company $CO" >&2
fi

CHAOS_COMPOSE_ARGS=$(printf '%s\n' "${args[@]}") \
  exec node --import tsx deploy/chaos/driver.ts
