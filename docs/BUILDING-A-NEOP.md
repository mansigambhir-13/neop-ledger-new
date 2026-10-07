# Building a fleet NEOP

This monorepo implements the app/template ownership model pinned to
`NEOS-Ecosystem/neos-neop-template` v0.8.16 at
`94db804f94403c15ad1279e6d30dcecc7c078b82`.

## App-owned inputs

Each app owns `app.declaration.json`, business capabilities and domain code,
forward-only migrations, its agent prompt and reviewed skills, data-only blocks,
and app tests. `app.declaration.json` is the source of truth for identity and the
fleet contract. Do not hand-edit `manifest.json` or `manifest.template.json`.

After changing a declaration, run:

```sh
pnpm fleet:emit-manifests
pnpm fleet:emit-manifests -- --check
```

The emitter writes both manifest forms and the app-specific Compose contract in
`deploy/fleet/generated/`. The installed release carries that generated Compose
contract as `deploy/compose.yaml`.

## Shared template runtime

The gate, proposal lifecycle, Matrix ingress, runner, model-session proxy,
migration engine, registry installer, three-process deployment topology, and
standalone frontend live in shared packages and `scripts/fleet/`. Apps import
them; they do not copy them into app directories.

Backend receives database, Matrix, and short-lived signing credentials. Agent
receives no long-lived credential or database connection. Frontend receives only
its proxy key. All production credentials enter through mounted files.

## Verification and release

Run `pnpm typecheck`, then the twelve `template-*.test.ts` gates for the app.
The evidence runner records a gate only from a committed, unchanged source tree:

```sh
pnpm fleet:template-gate -- --app <app> --gate <gate>
```

`pnpm neop-app-publish` creates a signed, immutable app/version release.
`pnpm neop-app-install` verifies the trusted signature, pinned template, file
hashes, and generated manifests before atomic activation. It refuses local drift
and restores the prior release if activation fails.
