import './conformance.test.ts';
import './authority.test.ts';
import './approval-lifecycle.test.ts';
import './bus-answer-lifecycle.test.ts';
import './bus-question-lifecycle.test.ts';
import './bus-result-lifecycle.test.ts';
import './input-lifecycle.test.ts';
import './origins.test.ts';
import './timer-lifecycle.test.ts';
import './workflow.test.ts';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateStandardProblems } from '../../../scripts/fleet/testing/template-standard.ts';

describe('Shift pinned-template standard-suite crosswalk', () => {
  it('covers the complete pinned upstream standard inventory with executable local behavior', () => {
    expect(templateStandardProblems(ROOT, 'shift')).toEqual([]);
  });
});
