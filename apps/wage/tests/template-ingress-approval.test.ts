import './conformance.test.ts';
import './workflow.test.ts';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateIngressApprovalProblems } from '../../../scripts/fleet/testing/template-ingress-approval.ts';

describe('Wage pinned-template ingress and approval contract', () => {
  it('keeps typed Matrix input and exact-content human authority fail closed', () => {
    expect(templateIngressApprovalProblems(ROOT, 'wage')).toEqual([]);
  });
});
