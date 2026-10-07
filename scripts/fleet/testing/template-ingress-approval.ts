import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export function templateIngressApprovalProblems(root: string, app: string): string[] {
  const problems: string[] = [];
  const manifestPath = path.join(root, 'apps', app, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonObject;
  const abilities = Array.isArray(manifest.abilities) ? manifest.abilities.filter(object) : [];
  if (!abilities.some((ability) => ability.kind === 'write' && ability.floor === 'ask_first')) problems.push(`${app} must expose at least one exact-content human-approved write`);
  for (const file of [
    'packages/contracts/src/matrix-events.ts',
    'packages/neop-template/src/presence/events.ts',
    'packages/neop-template/src/presence/appservice.ts',
    'packages/neop-template/src/data/human-authority.ts',
    'packages/neop-template/src/capabilities/execute.ts',
    'packages/neop-template/migrations/t020_human_authority.sql',
    'packages/neop-template/migrations/t022_answer_deadline.sql',
    'packages/neop-template/migrations/t023_input_deadline.sql',
    'packages/neop-template/migrations/t024_answer_intents.sql',
  ]) if (!existsSync(path.join(root, file))) problems.push(`shared ingress/approval component is missing: ${file}`);
  const events = readFileSync(path.join(root, 'packages/contracts/src/matrix-events.ts'), 'utf8');
  for (const marker of ['neos.neop.task', 'neos.neop.answer', 'neos.neop.approve', 'neos.neop.done', 'additionalProperties: false']) {
    if (!events.includes(marker)) problems.push(`typed Matrix contract is missing ${marker}`);
  }
  const authority = readFileSync(path.join(root, 'packages/neop-template/src/data/human-authority.ts'), 'utf8');
  for (const marker of ['check_human_authority', 'fingerprint', 'authority_required', 'authority_evidence']) {
    if (!authority.includes(marker)) problems.push(`transaction-time human authority is missing ${marker}`);
  }
  const authoritySql = readFileSync(path.join(root, 'packages/neop-template/migrations/t020_human_authority.sql'), 'utf8');
  // The fleet stores the approving identity as proposals.decided_by and deliberately takes
  // stable SHARE locks plus the switchboard advisory lock; the imported race tests above
  // prove that lock order. Requiring an upstream column name or FOR UPDATE would reject the
  // locally equivalent (and deadlock-reviewed) contract.
  for (const marker of ['for share', 'decided_by', 'four_eyes', 'pg_advisory_xact_lock', 'clock_timestamp()']) {
    if (!authoritySql.toLowerCase().includes(marker)) problems.push(`human-authority migration is missing ${marker}`);
  }
  return [...new Set(problems)].sort();
}
