import './conformance.test.ts';
import './payroll.test.ts';
import './workflow.test.ts';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateStandardProblems } from '../../../scripts/fleet/testing/template-standard.ts';

describe('Wage pinned-template standard-suite crosswalk', () => {
  it('covers the complete pinned upstream standard inventory with executable local behavior', () => {
    expect(templateStandardProblems(ROOT, 'wage')).toEqual([]);
  });
});
