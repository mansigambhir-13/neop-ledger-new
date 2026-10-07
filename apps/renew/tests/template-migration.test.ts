import { describe, expect, it } from 'vitest';
import { templateMigrationConformance } from '@neop/testkit';
import { renewApp } from '../src/index.ts';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateMigrationProblems } from '../../../scripts/fleet/testing/template-migration.ts';

describe('renew pinned-template migration crosswalk', () => {
  it('maps the pinned upstream 001-008 set to immutable fleet migrations', async () => {
    expect(await templateMigrationProblems(ROOT, 'renew')).toEqual([]);
  });
});
templateMigrationConformance('renew', renewApp);
