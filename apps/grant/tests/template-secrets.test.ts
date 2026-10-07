import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateSecretProblems } from '../../../scripts/fleet/testing/template-secrets.ts';

describe('grant pinned-template secret and image isolation', () => {
  it('finds no unmarked credential and keeps secrets out of the wrong process and image', async () => {
    expect(await templateSecretProblems(ROOT, 'grant')).toEqual([]);
  });
});
