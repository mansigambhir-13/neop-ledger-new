import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function templateFrontendProblems(root: string, app: string): string[] {
  const problems: string[] = [];
  for (const file of [
    'packages/neop-frontend/src/index.ts',
    'scripts/fleet/runtime/frontend.ts',
    'deploy/fleet/frontend.Dockerfile',
    `apps/${app}/scripts/frontend.ts`,
  ]) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) problems.push(`${app} frontend component is missing or linked: ${file}`);
  }
  const source = readFileSync(path.join(root, 'packages/neop-frontend/src/index.ts'), 'utf8');
  for (const marker of ['x-neop-frontend-key', 'NEOP_FRONTEND_BASE_PATH', '/api/health', 'No records yet', 'Unknown', 'Unable to load']) {
    if (!source.includes(marker)) problems.push(`${app} frontend compatibility shell is missing ${marker}`);
  }
  const dockerfile = readFileSync(path.join(root, 'deploy/fleet/frontend.Dockerfile'), 'utf8');
  for (const marker of ['USER node', 'HEALTHCHECK', '4105']) if (!dockerfile.includes(marker)) problems.push(`${app} frontend image is missing ${marker}`);
  return [...new Set(problems)].sort();
}
