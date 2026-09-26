# backend container · an app's L3 + gate + runner, and its package sandboxes (Deno, glibc).
# Debian slim, not Alpine: the Deno binary the package sandbox runs is glibc-only.
FROM node:24-bookworm-slim
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# tsx is a dev dependency, so install before switching to production mode.
RUN pnpm install --frozen-lockfile \
 && mkdir -p /srv/var /var/lib/neop/packages /var/lib/neos/keys \
 && chown -R node:node /srv/var /var/lib/neop /var/lib/neos
ENV NEOS_ENV=production NODE_ENV=production PATH=/srv/node_modules/.bin:$PATH NEOP_DENO_DIR=/srv/var/deno
USER node
CMD ["tsx", "apps/ledger/scripts/backend.ts"]
