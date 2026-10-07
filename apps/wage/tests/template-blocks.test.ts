import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateBlocksProblems } from '../../../scripts/fleet/testing/template-blocks.ts';

describe('Wage pinned-template blocks', () => {
  it('keeps every screen data-only, read-only, declared, and provenance-bearing', () => {
    expect(templateBlocksProblems(ROOT, 'wage')).toEqual([]);
  });
});
