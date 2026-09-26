# ADR 0013 · The registry holds publishable know-how: skills and packages

Status: **Proposed — implemented; confirm in architecture review.**
Date: 2026-09-26

## Decision
`neos.registry_entries` has two kinds: **skill** (text a host assistant loads, requiring abilities) and
**package** (a skill plus its own handlers and tables, signed, loaded by hash). The plan lists four kinds
(skill, ability, package, door). The other two are not registry entries:

- An **ability** is declared in its owner app's `manifest.json`, registered with the app, and borrowed
  through an ACL row (`neos.acl`) — the gateway checks the caller, the row and the owner's switchboard.
- A **door** is declared in the manifest that uses it (the app's, or a package's), keyed in the vault,
  and lent per call (`vault.lend`), refused when undeclared.

## Why
Both are already versioned and owned by an app's manifest; a second copy in the registry would be a
second source of truth. What the registry adds — review, platform co-signature, pinning, deprecation
windows, install screens — matters for text and code another team wrote, which is exactly skills and
packages.

## Consequences
The switchboard shows all four as lines (own and package abilities, skills with their needs, doors),
so a person sees one board. The registry catalogue (`/api/registry/catalog`) lists skills and packages;
borrowing an ability is granted on the Apps page.

## Evidence
registry.test, governance.test (catalogue, package lines, skill lines, uninstall), a2a.test.
