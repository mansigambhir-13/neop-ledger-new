# Build ONLY from the generated agent context, never from the repository root.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /srv
COPY --chown=node:node runtime/node_modules ./node_modules
COPY --chown=node:node runtime/packages ./packages
COPY --chown=node:node runtime/scripts ./scripts
COPY --chown=node:node runtime/apps ./apps
COPY --chown=node:node runtime/package.json ./package.json
ARG NEOP_APP
COPY --chown=node:node entries/${NEOP_APP}.mjs ./entry.mjs
ENV NEOS_ENV=production NODE_ENV=production NODE_NO_WARNINGS=1 HOST=0.0.0.0 PORT=4103 NEOP_APP=${NEOP_APP}
USER node
EXPOSE 4103
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4103/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "entry.mjs"]
