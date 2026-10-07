import { conformance } from '@neop/testkit';
import { wageApp } from '../src/index.ts';
import { seed, RUN, settings } from './fixtures.ts';
conformance({
  app: async () => ({ def: await wageApp(), seed }),
  reads: {
    'wage.settings.get': {}, 'wage.employees.list': {}, 'wage.timesheets.list': { period: '2026-09' },
    'wage.payroll.list': {}, 'wage.payslips.list': { run_id: RUN },
  },
  gatedWrite: { key: 'wage.settings.update', args: settings },
});
