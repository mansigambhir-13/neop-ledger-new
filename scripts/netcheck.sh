#!/usr/bin/env bash
# Runtime network policy check against a running compose stack (plan: "Both a firewall rule
# and a failing test guard each row"). Usage: scripts/netcheck.sh <compose file> [project]
set -u
F=${1:?compose file}; PROJ=${2:-neops}
run() { local svc=$1; shift; echo "== $svc"; docker compose -p "$PROJ" -f "$F" exec -T "$svc" tsx scripts/netprobe.ts "$@"; }
fail=0
# The assistant: only its own backend's gate and the LLM proxy. No database, platform, vault or internet.
run ledger-agent open:ledger-gate:4102 open:ledger-backend:4102 closed:ledger-l3:4101 open:llm-proxy:4200 closed:postgres:5432 closed:pgbouncer:6432 closed:platform:4000 closed:ledger-backend:4101 closed:1.1.1.1:443 || fail=1
# The desk: only the platform. No database, no app backend, no agent.
run web open:platform:4000 closed:postgres:5432 closed:pgbouncer:6432 closed:ledger-backend:4101 closed:ledger-agent:4103 || fail=1
# The app backend: its database (pooled and direct), the platform, its agent, and door providers.
run ledger-backend open:pgbouncer:6432 open:postgres:5432 open:platform:4000 open:ledger-agent:4103 open:1.1.1.1:443 || fail=1
# The LLM proxy: the provider and the platform's JWKS; never an app backend.
run llm-proxy open:1.1.1.1:443 open:platform:4000 closed:ledger-backend:4101 closed:ledger-agent:4103 || fail=1
# The platform: app L3s and the database; never the agents.
run platform open:ledger-l3:4101 open:pgbouncer:6432 closed:ledger-agent:4103 || fail=1
[ $fail = 0 ] && echo "network policy holds" || { echo "NETWORK POLICY VIOLATED"; exit 1; }
