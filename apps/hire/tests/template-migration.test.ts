import { describe, expect, it } from 'vitest';
import { templateMigrationConformance } from '@neop/testkit';
import { hireApp } from '../src/index.ts';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateMigrationProblems } from '../../../scripts/fleet/testing/template-migration.ts';

describe('hire pinned-template migration crosswalk', () => {
  it('maps the pinned upstream 001-008 set to immutable fleet migrations', async () => {
    expect(await templateMigrationProblems(ROOT, 'hire')).toEqual([]);
  });
});
templateMigrationConformance('hire', hireApp);
