import { stringify } from 'yaml';
import { isFleetApp, type FleetApp } from '../runtime/apps.ts';

export function composeFor(app: FleetApp) {
  if (!isFleetApp(app)) throw new Error('unsupported app');
  const backend = `${app}-backend`;
  const agent = `${app}-agent`;
  const frontend = `${app}-frontend`;
  return {
    name: `neop-${app}`,
    services: {
      [backend]: {
        image: `neos/${app}-backend:${'${NEOP_VERSION:-local}'}`,
        build: { context: '${NEOP_BACKEND_CONTEXT}', dockerfile: 'deploy/fleet/backend.Dockerfile', args: { NEOP_APP: app } },
        command: ['node', 'entry.mjs'],
        read_only: true,
        init: true,
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        networks: { db: {}, [`agent-${app}`]: { aliases: [`${app}-gate`] }, files: {} },
        environment: {
          NEOP_APP: app,
          NEOP_APP_DB_URL_FILE: '/run/secrets/app_db_url',
          NEOP_RUNNER_DB_URL_FILE: '/run/secrets/runner_db_url',
          NEOP_DIRECT_DB_URL_FILE: '/run/secrets/direct_db_url',
          NEOP_JOB_TOKEN_SECRET_FILE: '/run/secrets/job_token',
          NEOP_LLM_SIGNING_KEY_FILE: '/run/secrets/llm_signing_key',
          NEOP_LLM_PROXY_URL: 'http://llm-proxy:4200/v1',
          NEOP_AGENT_URL: `http://${app}-agent-rpc:4103`,
          NEOP_GATE_URL: `http://${app}-gate:4102`,
          NEOP_PRESENCE: 'client',
          NEOP_MATRIX_HOMESERVER_URL: '${NEOP_MATRIX_HOMESERVER_URL}',
          NEOP_MATRIX_CLIENT_ACCOUNTS_FILE: '/run/secrets/matrix_accounts',
          FILES_HOST: '0.0.0.0',
          GATE_HOST: `${app}-gate`,
        },
        secrets: ['app_db_url', 'runner_db_url', 'direct_db_url', 'job_token', 'llm_signing_key', 'matrix_accounts'],
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4101/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '15s', timeout: '3s', retries: 3 },
      },
      [agent]: {
        image: `neos/${app}-agent:${'${NEOP_VERSION:-local}'}`,
        build: { context: '${NEOP_AGENT_CONTEXT}', dockerfile: 'deploy/fleet/agent.Dockerfile', args: { NEOP_APP: app } },
        command: ['node', 'entry.mjs'],
        read_only: true,
        init: true,
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        networks: { [`agent-${app}`]: { aliases: [`${app}-agent-rpc`] }, llm: {} },
        environment: { NEOP_APP: app, NEOP_ALLOWED_GATE: `http://${app}-gate:4102`, HOST: `${app}-agent-rpc`, PORT: '4103', NEOP_LLM_PROVIDER: 'proxy' },
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4103/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '15s', timeout: '3s', retries: 3 },
      },
      [frontend]: {
        image: `neos/${app}-frontend:${'${NEOP_VERSION:-local}'}`,
        build: { context: '${NEOP_FRONTEND_CONTEXT}', dockerfile: 'deploy/fleet/frontend.Dockerfile', args: { NEOP_APP: app } },
        command: ['node', 'entry.mjs'],
        read_only: true,
        init: true,
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        networks: { edge: {} },
        ports: [`127.0.0.1:${'${NEOP_FRONTEND_PORT:-4105}'}:4105`],
        environment: { NEOP_APP: app, NEOS_PLATFORM_URL: 'http://platform:4000', NEOP_FRONTEND_KEY_FILE: '/run/secrets/frontend_key', NEOP_FRONTEND_BASE_PATH: `/apps/${app}` },
        secrets: ['frontend_key'],
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4105/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '15s', timeout: '3s', retries: 3 },
      },
    },
    networks: {
      db: { external: true, name: '${NEOS_DB_NETWORK}' },
      [`agent-${app}`]: { internal: true },
      files: { external: true, name: '${NEOS_FILES_NETWORK}' },
      llm: { external: true, name: '${NEOS_LLM_NETWORK}' },
      edge: { external: true, name: '${NEOS_EDGE_NETWORK}' },
    },
    secrets: Object.fromEntries(['app_db_url', 'runner_db_url', 'direct_db_url', 'job_token', 'llm_signing_key', 'matrix_accounts', 'frontend_key'].map((name) => [name, { file: `\${NEOS_SECRETS_DIR:-./secrets}/${app}/${name}` }])),
  };
}

export function composeYaml(app: FleetApp): string {
  return stringify(composeFor(app), { lineWidth: 0 });
}
