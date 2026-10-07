import './contract.test.ts';
import './honesty.test.ts';
import './injection.test.ts';
import './migration.test.ts';
import './proposal.test.ts';
import './resume.test.ts';
import './schema-only.test.ts';
import './sender.test.ts';
import './switchboard.test.ts';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateStandardProblems } from '../../../scripts/fleet/testing/template-standard.ts';

describe('Ledger pinned-template standard-suite crosswalk', () => {
  it('covers the complete pinned upstream standard inventory with executable local behavior', () => {
    expect(templateStandardProblems(ROOT, 'ledger')).toEqual([]);
  });
});
