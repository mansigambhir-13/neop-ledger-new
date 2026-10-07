import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { composeFor } from '../deploy/compose.ts';
import type { FleetApp } from '../runtime/apps.ts';

export function templateRuntimeProcessProblems(root: string, app: FleetApp): string[] {
  const problems: string[] = [];
  const compose = composeFor(app) as any;
  const names = [`${app}-backend`, `${app}-agent`, `${app}-frontend`];
  if (JSON.stringify(Object.keys(compose.services).sort()) !== JSON.stringify([...names].sort())) problems.push(`${app} compose must contain exactly backend, agent and frontend`);
  for (const name of names) {
    const service = compose.services[name];
    if (!service?.healthcheck || service.read_only !== true || !service.security_opt?.includes('no-new-privileges:true') || !service.cap_drop?.includes('ALL')) problems.push(`${name} lacks a health or container-hardening contract`);
  }
  const backend = compose.services[`${app}-backend`];
  const agent = compose.services[`${app}-agent`];
  const frontend = compose.services[`${app}-frontend`];
  if (!Object.hasOwn(backend.networks, 'db')) problems.push(`${app} backend is not on the database network`);
  if (Object.hasOwn(agent.networks, 'db') || Object.hasOwn(frontend.networks, 'db')) problems.push(`${app} database network reaches a non-backend process`);
  if (agent.ports) problems.push(`${app} agent must not publish a port`);
  if (!frontend.ports?.every((entry: string) => entry.startsWith('127.0.0.1:'))) problems.push(`${app} frontend ports must bind loopback`);
  const secretText = JSON.stringify(agent);
  if (/DB_URL|PASSWORD|TOKEN|SECRET|API_KEY|_FILE/.test(secretText)) problems.push(`${app} agent service carries a credential setting`);
  for (const process of ['backend', 'agent', 'frontend']) {
    const script = path.join(root, 'apps', app, 'scripts', `${process}.ts`);
    if (!existsSync(script)) problems.push(`${app} ${process} entrypoint is missing`);
  }
  for (const process of ['backend', 'agent', 'frontend']) {
    const dockerfile = readFileSync(path.join(root, 'deploy/fleet', `${process}.Dockerfile`), 'utf8');
    for (const marker of ['USER node', 'HEALTHCHECK']) if (!dockerfile.includes(marker)) problems.push(`${app} ${process} image is missing ${marker}`);
  }
  return [...new Set(problems)].sort();
}
