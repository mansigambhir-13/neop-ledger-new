import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateModelAuthProviderProblems } from '../../../scripts/fleet/testing/template-model-auth-provider.ts';

describe('post pinned-template model authentication and provider contract', () => {
  it('uses app-bound short-lived proxy sessions and never falls back to an agent credential', async () => {
    expect(await templateModelAuthProviderProblems(ROOT, 'post')).toEqual([]);
  });
});
