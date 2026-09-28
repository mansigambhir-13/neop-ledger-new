#!/usr/bin/env bash
# Runtime network policy check against a running compose stack (plan: "Both a firewall rule
# and a failing test guard each row"). Usage:
#   scripts/netcheck.sh <compose file>[,<overlay>...] [project]
# Every row runs a probe inside the container (scripts/netprobe.ts). Services from optional profiles
# (web: test) are checked when running and reported as skipped otherwise.
# The egress rows need the internet: the allowed host must answer through egress-proxy
# (NETCHECK_ALLOWED_URL, default https://api.anthropic.com) and a host off the list must be refused
# (NETCHECK_DENIED_URL, default https://example.com).
set -u
FILES=${1:?compose file}; PROJ=${2:-neops}
ALLOWED=${NETCHECK_ALLOWED_URL:-https://api.anthropic.com}
DENIED=${NETCHECK_DENIED_URL:-https://example.com}
args=(-p "$PROJ")
IFS=',' read -ra fs <<< "$FILES"
for f in "${fs[@]}"; do args+=(-f "$f"); done
running=" $(docker compose "${args[@]}" ps --status running --services 2>/dev/null | tr '\n' ' ') "
fail=0
run() {
  local svc=$1 optional=$2; shift 2
  if [[ "$running" != *" $svc "* ]]; then
    if [ "$optional" = optional ]; then echo "== $svc (not running; skipped)"; return 0; fi
    echo "== $svc NOT RUNNING"; return 1
  fi
  echo "== $svc"
  docker compose "${args[@]}" exec -T "$svc" tsx scripts/netprobe.ts "$@"
}
# The assistant: only its own backend's gate and the LLM proxy. No database, platform, vault, egress proxy or internet.
run ledger-agent required open:ledger-gate:4102 open:ledger-backend:4102 closed:ledger-l3:4101 open:llm-proxy:4200 closed:postgres:5432 closed:pgbouncer:6432 closed:platform:4000 closed:ledger-backend:4101 closed:egress-proxy:3128 closed:1.1.1.1:443 "proxy-refused:$ALLOWED" || fail=1
# The desk (test profile): only the platform. No database, no app backend, no agent.
run web optional open:platform:4000 closed:postgres:5432 closed:pgbouncer:6432 closed:ledger-backend:4101 closed:ledger-agent:4103 || fail=1
# The app backend: its database (pooled and direct), the platform, its agent; providers only via the egress proxy.
run ledger-backend required open:pgbouncer:6432 open:postgres:5432 open:platform:4000 open:ledger-agent:4103 open:egress-proxy:3128 closed:1.1.1.1:443 "proxy-open:$ALLOWED" "proxy-refused:$DENIED" || fail=1
# v3 S4 · NEOP presence (compose.chat.yml, NEOP_PRESENCE=appservice|client): the backend may reach the homeserver on
# the chat network (and the homeserver its appservice listener, 4104). Checked when a local synapse runs; an external
# homeserver is reached through egress-proxy like any allowed host (deploy.sh adds it to NEOS_EGRESS_EXTRA).
if [[ "$running" == *" synapse "* ]]; then
  run ledger-backend required open:synapse:8008 || fail=1
fi
# The LLM proxy: the platform's JWKS and the provider (via the egress proxy only); never an app backend.
run llm-proxy required open:platform:4000 open:egress-proxy:3128 closed:ledger-backend:4101 closed:ledger-agent:4103 closed:1.1.1.1:443 "proxy-open:$ALLOWED" "proxy-refused:$DENIED" || fail=1
# The platform: app L3s and the database; never the agents or the egress proxy.
run platform required open:ledger-l3:4101 open:pgbouncer:6432 closed:ledger-agent:4103 closed:egress-proxy:3128 || fail=1
# Nightly backups: the db network only (admin URL). No app L3, agent, egress proxy or internet. (The platform
# also sits on db — it reaches PgBouncer — so its authenticated port answers here, as it does for migrate.)
run backup required open:postgres:5432 closed:ledger-l3:4101 closed:ledger-agent:4103 closed:egress-proxy:3128 closed:1.1.1.1:443 || fail=1
[ $fail = 0 ] && echo "network policy holds" || { echo "NETWORK POLICY VIOLATED"; exit 1; }
