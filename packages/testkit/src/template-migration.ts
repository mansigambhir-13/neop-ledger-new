import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportCompany, importCompany, schemaDrift, shippedMigrations, sqlIdent } from '@neop/pgkit';
import { appMigrationSources, migrateApp, type AppDefinition } from '@neop/template';
import { bootPilot, finish, type Pilot } from './pilot.ts';

export function templateMigrationConformance(app: string, factory: () => Promise<AppDefinition>): void {
  let P: Pilot;
  let def: AppDefinition;
  beforeAll(async () => {
    def = await factory();
    P = await bootPilot({ apps: [{ def }] });
  });
  afterAll(async () => P?.close());

  describe(`${app}: pinned-template migration behavior`, () => {
    it('boots from empty with the exact shipped checksum ledger', async () => {
      const shipped = await shippedMigrations(await appMigrationSources(def));
      const applied = (await P.backend.core.runnerPool.query(`select name, checksum from ${sqlIdent(app)}.schema_migrations order by applied_at, name`)).rows;
      expect(new Map(applied.map((row) => [row.name, row.checksum]))).toEqual(new Map(shipped.map((row) => [row.name, row.checksum])));
    });

    it('preserves populated history on reapply and round-trips a company backup exactly', async () => {
      P.setBrain(() => finish('migration proof completed'));
      const task = await P.ask('Record one completed job for migration proof', undefined, app);
      await P.waitFor(async () => (await P.task(task.task_id)).task.status === 'COMPLETED', 'migration proof job');
      const before = await exportCompany(P.adminUrl, app, P.company.id);
      expect(Object.values(before.tables).reduce((sum, rows) => sum + rows.length, 0)).toBeGreaterThan(0);
      expect(await migrateApp(P.adminUrl, def)).toEqual([]);
      const afterReapply = await exportCompany(P.adminUrl, app, P.company.id);
      expect(afterReapply.tables).toEqual(before.tables);
      await importCompany(P.adminUrl, before);
      const restored = await exportCompany(P.adminUrl, app, P.company.id);
      expect(restored.order).toEqual(before.order);
      expect(restored.tables).toEqual(before.tables);
    });

    it('classifies edited and unknown applied migrations as drift', async () => {
      const shipped = await shippedMigrations(await appMigrationSources(def));
      const changed = shipped.map((entry, index) => index ? entry : { ...entry, checksum: '0'.repeat(64) });
      expect(schemaDrift(changed, shipped).changed).toEqual([shipped[0]!.name]);
      expect(schemaDrift([...shipped, { name: '999_unknown.sql', checksum: '1'.repeat(64) }], shipped).unknown).toEqual(['999_unknown.sql']);
    });
  });
}
