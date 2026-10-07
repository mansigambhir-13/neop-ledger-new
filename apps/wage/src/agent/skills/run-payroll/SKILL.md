---
key: run-payroll
requires: [wage.settings.get, wage.employees.list, wage.timesheets.list, wage.payroll.prepare, wage.payroll.list, wage.payslips.list, wage.payroll.release]
---
# Prepare and release payroll

1. Read the reviewed settings, employee master and period's timesheets. Ask one structured question for missing inputs; do not assume zero hours or statutory rates.
2. Prepare the period once. Read the persisted run and payslips; report the currency, headcount, gross, deductions, net and capped-deduction flags.
3. Ask the person to review the register. Call the ask-first release with the run UUID. The gate binds the exact input hash, currency and total to the proposal.
4. Wait. The runner executes after a person's approval; verify its proof when resumed.
5. State "released internally, not paid". There is no bank, statutory filing or email delivery capability in this build. A change of input requires reopening an unreleased run and a fresh calculation/approval; never overwrite an issued run.
