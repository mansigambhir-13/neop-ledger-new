import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { composeYaml } from '../../../scripts/fleet/deploy/compose.ts';
import { templateRuntimeProcessProblems } from '../../../scripts/fleet/testing/template-runtime-processes.ts';

describe('ledger pinned-template runtime topology', () => {
  it('defines hardened backend, keyless agent and frontend processes with isolated networks', () => {
    expect(templateRuntimeProcessProblems(ROOT, 'ledger')).toEqual([]);
    expect(composeYaml('ledger')).toContain('ledger-frontend:');
  });
});
