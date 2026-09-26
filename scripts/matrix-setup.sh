#!/usr/bin/env bash
# One-time Matrix setup for the chat overlay: generate the homeserver config, write the NEOS
# appservice registration (tokens from deploy/secrets), and register it with the homeserver.
#   scripts/matrix-setup.sh <compose file> [project] [server name]
set -euo pipefail
F=${1:?compose file}; PROJ=${2:-neops}; NAME=${3:-acme.example}
DIR=$(cd "$(dirname "$F")" && pwd); SEC="$DIR/secrets"
for t in matrix_hs_token matrix_as_token; do [ -s "$SEC/$t" ] || { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "$SEC/$t"; chmod 600 "$SEC/$t"; }; done
VOL="${PROJ}_synapse-data"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/data" -e SYNAPSE_SERVER_NAME="$NAME" -e SYNAPSE_REPORT_STATS=no matrixdotorg/synapse:v1.139.0 generate >/dev/null
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
  rooms: []
  aliases: []
YAML
docker run --rm -v "$VOL:/data" -v "$SEC/appservice.yaml:/tmp/appservice.yaml:ro" --entrypoint sh matrixdotorg/synapse:v1.139.0 -c '
  cp /tmp/appservice.yaml /data/neos-appservice.yaml && chown 991:991 /data/neos-appservice.yaml
  grep -q "^app_service_config_files" /data/homeserver.yaml || printf "\napp_service_config_files:\n  - /data/neos-appservice.yaml\n" >> /data/homeserver.yaml'
echo "Matrix ready for $NAME. Start with: docker compose -p $PROJ -f $F -f $DIR/compose.chat.yml up -d"
