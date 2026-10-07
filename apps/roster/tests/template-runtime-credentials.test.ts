import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateRuntimeCredentialProblems } from '../../../scripts/fleet/testing/template-runtime-credentials.ts';

describe('roster pinned-template runtime credentials', () => {
  it('keeps database, Matrix, model and frontend credentials in their owning processes', async () => {
    expect(await templateRuntimeCredentialProblems(ROOT, 'roster')).toEqual([]);
  });
});
