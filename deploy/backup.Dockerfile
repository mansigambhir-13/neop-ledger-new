# backup container · nightly per-schema pg_dump (+ per-company exports) with retention (plan §Backups).
# pg_dump must match the server's major version (17), which Debian bookworm does not ship: PGDG it is.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# A slow link to the registry must not fail the build (pnpm's default fetch timeout is 60 s).
RUN pnpm install --frozen-lockfile --fetch-timeout=600000 --fetch-retries=5 --network-concurrency=4 && mkdir -p /backups && chown node:node /backups
ENV NEOS_ENV=production NODE_ENV=production PATH=/srv/node_modules/.bin:$PATH
USER node
CMD ["tsx", "scripts/backup.ts", "schedule"]
