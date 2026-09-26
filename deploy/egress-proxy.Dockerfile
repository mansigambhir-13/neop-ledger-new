# egress-proxy · the only way out of the stack (plan: "Enforce with network policy (egress
# allow-lists)"). The LLM proxy and app backends sit on internal networks only; their HTTP(S)
# goes through this forward proxy, which allows CONNECT/GET only to the hosts in NEOS_EGRESS_ALLOW.
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY deploy/egress-proxy/entrypoint.sh /usr/local/bin/egress-proxy
RUN chmod 0755 /usr/local/bin/egress-proxy
USER nobody
EXPOSE 3128
ENTRYPOINT ["/usr/local/bin/egress-proxy"]
