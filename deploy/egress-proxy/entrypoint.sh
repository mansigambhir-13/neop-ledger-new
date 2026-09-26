#!/bin/sh
# Build tinyproxy's config from NEOS_EGRESS_ALLOW (comma-separated exact host names) and run it
# in the foreground. Anything not on the list is refused (403); only port 443 may be tunnelled.
set -eu
ALLOW=${NEOS_EGRESS_ALLOW:?set NEOS_EGRESS_ALLOW (comma-separated host names)}
dir=/tmp/egress-proxy
mkdir -p "$dir"
: > "$dir/filter"
for h in $(echo "$ALLOW" | tr ',' ' '); do
  case "$h" in
    *[!A-Za-z0-9.-]*) echo "egress-proxy: refusing bad host name '$h'" >&2; exit 78 ;;
  esac
  # Exact host match (anchored, dots literal): no suffix tricks like api.anthropic.com.evil.test.
  printf '^%s$\n' "$(echo "$h" | sed 's/\./\\./g')" >> "$dir/filter"
done
[ -s "$dir/filter" ] || { echo "egress-proxy: empty allow-list" >&2; exit 78; }
cat > "$dir/tinyproxy.conf" <<EOF
Port 3128
Listen 0.0.0.0
Timeout 600
MaxClients 256
LogLevel Connect
Syslog Off
DisableViaHeader Yes
Filter "$dir/filter"
FilterType ere
FilterCaseSensitive No
FilterURLs Off
FilterDefaultDeny Yes
EOF
# Tunnel ports (Node's env proxy tunnels plain http too): 443 only unless NEOS_EGRESS_PORTS says otherwise.
for p in $(echo "${NEOS_EGRESS_PORTS:-443}" | tr ',' ' '); do
  case "$p" in *[!0-9]*|'') echo "egress-proxy: bad port '$p'" >&2; exit 78 ;; esac
  echo "ConnectPort $p" >> "$dir/tinyproxy.conf"
done
echo "egress-proxy: allowing $(tr '\n' ' ' < "$dir/filter")"
exec tinyproxy -d -c "$dir/tinyproxy.conf"
