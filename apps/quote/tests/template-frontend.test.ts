import { describe, expect, it } from 'vitest';
import { templateFrontendConformance } from '@neop/testkit';
import { manifest } from '../src/index.ts';
import { ROOT } from '../../../scripts/fleet/template-alignment.ts';
import { templateFrontendProblems } from '../../../scripts/fleet/testing/template-frontend.ts';

describe('quote pinned-template frontend packaging', () => {
  it('ships the shared frontend image and a fixed app entrypoint', () => {
    expect(templateFrontendProblems(ROOT, 'quote')).toEqual([]);
  });
});
templateFrontendConformance('quote', manifest.name);
