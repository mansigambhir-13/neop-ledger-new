#!/usr/bin/env bash
# One-time Matrix setup for the chat overlay: generate the homeserver config and, per road,
#   appservice (default): write the NEOS appservice registration (tokens from deploy/secrets) and register it;
#   client:               no appservice — prepare the secret file that will hold the operator-issued token of the
#                         app's ordinary account (@ledger:<server>), and print how to issue it.
#   room:                 create one NEOP room the v3 §8 way (below), as an admin account, once the homeserver is up.
#   scripts/matrix-setup.sh <compose file> [project] [server name] [appservice|client]
#   MATRIX_ADMIN_TOKEN=… scripts/matrix-setup.sh <compose file> [project] [server name] room <app> <company slug> <@person:server>…
#
# NEOP rooms (v3 §8, B7): invite-only (private_chat preset), NEVER end-to-end encrypted (audit needs the plaintext;
# we run the server — the platform refuses to bind a room with m.room.encryption), and power levels where only
# people reach the level of neos.neop.approve (50): the app's identity @neop_<app>_<company>, the reasoning agent
# @neuralchat_<company> and other NEOPs sit at 10. The appservice registration reserves BOTH @neop_.* and
# @neuralchat_.* as exclusive namespaces (appservice road only), so nobody can register a look-alike name.
set -euo pipefail
F=${1:?compose file}; PROJ=${2:-neops}; NAME=${3:-acme.example}; MODE=${4:-${MATRIX_MODE:-appservice}}

if [ "$MODE" = "room" ]; then
  APP=${5:?app key}; CO=${6:?company slug}; : "${7:?at least one @person:server}"; shift 6; PEOPLE=("$@")
  : "${MATRIX_ADMIN_TOKEN:?an admin account token to create the room with (it stays the room admin at 100)}"
  HS=${MATRIX_HOMESERVER_URL:-http://127.0.0.1:8008}
  BOT="@neop_${APP}_${CO}:${NAME}"; AGENT="@neuralchat_${CO}:${NAME}"
  users="\"$BOT\": 10, \"$AGENT\": 10"; invite="\"$BOT\", \"$AGENT\""
  for p in "${PEOPLE[@]}"; do users="$users, \"$p\": 50"; invite="$invite, \"$p\""; done
  body=$(cat <<JSON
{"preset": "private_chat", "visibility": "private", "name": "${APP} · ${CO}", "invite": [${invite}],
 "initial_state": [{"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}}],
 "power_level_content_override": {"users_default": 0, "events_default": 0, "state_default": 100, "users": {${users}},
   "events": {"neos.neop.approve": 50, "neos.neop.task": 0, "neos.neop.answer": 0, "neos.neop.ask": 10, "neos.neop.propose": 10,
              "neos.neop.done": 10, "neos.neop.note": 10, "m.room.power_levels": 100, "m.room.encryption": 100, "m.room.join_rules": 100}}}
JSON
)
  # The token travels on stdin (curl -K -), never on a command line.
  printf 'header = "Authorization: Bearer %s"\n' "$MATRIX_ADMIN_TOKEN" | curl -sf -K - -XPOST "$HS/_matrix/client/v3/createRoom" -H 'content-type: application/json' -d "$body"
  echo
  echo "Bind it (admin): POST /api/chat/rooms {\"app\": \"$APP\", \"room_id\": \"<room_id above>\"} — the platform checks the settings again."
  exit 0
fi
DIR=$(cd "$(dirname "$F")" && pwd); SEC="$DIR/secrets"
mkdir -p "$SEC"
for t in matrix_hs_token matrix_as_token; do [ -s "$SEC/$t" ] || { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "$SEC/$t"; chmod 600 "$SEC/$t"; }; done
# The client road's token file must exist for compose; it stays empty (client off) until the operator fills it.
[ -e "$SEC/matrix_ledger_token" ] || { : > "$SEC/matrix_ledger_token"; chmod 600 "$SEC/matrix_ledger_token"; }
VOL="${PROJ}_synapse-data"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/data" -e SYNAPSE_SERVER_NAME="$NAME" -e SYNAPSE_REPORT_STATS=no matrixdotorg/synapse:v1.139.0 generate >/dev/null

if [ "$MODE" = "client" ]; then
  cat <<EOF
Matrix ready for $NAME (client road). As the operator, once the homeserver is up:
  1. create the account:   docker compose -p $PROJ exec synapse register_new_matrix_user -c /data/homeserver.yaml -u ledger --no-admin http://localhost:8008
  2. issue its token (the platform never logs in itself, and never logs out):
       curl -s -XPOST http://127.0.0.1:8008/_matrix/client/v3/login -H 'content-type: application/json' \\
         -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"ledger"},"password":"<password>"}' \\
         | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p' > $SEC/matrix_ledger_token
  3. start with MATRIX_MODE=client:  MATRIX_MODE=client docker compose -p $PROJ -f $F -f $DIR/compose.chat.yml up -d
  4. allowlist who may DM @ledger:$NAME (admin):  PUT /api/chat/allowlist {app, matrix_id, kind: person|bridge, acts_for?}
EOF
  exit 0
fi

cat > "$SEC/appservice.yaml" <<YAML
id: neos-chat-bridge
url: http://platform:4000
as_token: "$(cat "$SEC/matrix_as_token")"
hs_token: "$(cat "$SEC/matrix_hs_token")"
sender_localpart: neos_bridge
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@neop_.*"
    - exclusive: true
      regex: "@neuralchat_.*"
  rooms: []
  aliases: []
YAML
docker run --rm -v "$VOL:/data" -v "$SEC/appservice.yaml:/tmp/appservice.yaml:ro" --entrypoint sh matrixdotorg/synapse:v1.139.0 -c '
  cp /tmp/appservice.yaml /data/neos-appservice.yaml && chown 991:991 /data/neos-appservice.yaml
  grep -q "^app_service_config_files" /data/homeserver.yaml || printf "\napp_service_config_files:\n  - /data/neos-appservice.yaml\n" >> /data/homeserver.yaml'
echo "Matrix ready for $NAME. Start with: docker compose -p $PROJ -f $F -f $DIR/compose.chat.yml up -d"
