import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateOwnershipProblems } from '../../../scripts/fleet/testing/template-ownership.ts';

describe('Desk pinned-template ownership', () => {
  it('keeps app-owned files isolated from the shared template runtime', () => {
    expect(templateOwnershipProblems(ROOT, 'desk')).toEqual([]);
  });
});
