# Build only from the explicit, integrity-checked backend context.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /srv
COPY runtime/ ./
COPY --chmod=0555 deno/deno /usr/local/bin/deno
COPY deno/provenance.json /usr/local/share/neop/deno-provenance.json
# Assert architecture/version inside the target image. No download or install step.
RUN node --input-type=module -e "import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; const p=JSON.parse(fs.readFileSync('/usr/local/share/neop/deno-provenance.json')); const v=execFileSync('/usr/local/bin/deno',['--version'],{encoding:'utf8'}).trim().split(/\s+/); if(process.platform!=='linux'||process.arch!==p.architecture||v[0]!=='deno'||v[1]!==p.version) throw Error('Deno target mismatch');"
ARG NEOP_APP
COPY entries/${NEOP_APP}/ ./
ENV NEOS_ENV=production NODE_ENV=production NODE_NO_WARNINGS=1 NEOP_APP=${NEOP_APP} NEOP_DENO_PATH=/usr/local/bin/deno NEOP_DENO_DIR=/tmp/deno DENO_NO_UPDATE_CHECK=1
RUN chmod -R a+rX /srv
USER node
EXPOSE 4101 4102 4104
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4101/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "entry.mjs"]
