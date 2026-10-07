import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../template-alignment.ts';
import {
  parseTemplateOwnershipArgs,
  PINNED_TEMPLATE_RULES_SHA256,
  templateOwnershipStatus,
  validatePinnedTemplateDefinition,
  validateTemplateOwnership,
} from '../template-ownership.ts';

const ownershipPath = path.join(ROOT, 'fleet/template-ownership.json');
const baseline = () => JSON.parse(readFileSync(ownershipPath, 'utf8'));
const pinnedTemplate = () => JSON.parse(readFileSync(path.join(ROOT, 'reference/upstream/neos-neop-template/template.json'), 'utf8'));

describe('pinned upstream template ownership crosswalk', () => {
  it('accounts for every ordered upstream rule without claiming readiness', () => {
    const report = templateOwnershipStatus();
    expect(report.rules_sha256).toBe(PINNED_TEMPLATE_RULES_SHA256);
    expect(report.total).toBe(41);
    expect(report.counts).toEqual({
      mapped: 21,
      adapter_required: 13,
      missing: 4,
      conflict: 3,
    });
    expect(report.ready).toBe(false);
    expect(report.mappings.at(-1)?.path).toBe('**');
  });

  it('matches the checked-out pinned template definition exactly', () => {
    expect(validatePinnedTemplateDefinition(pinnedTemplate())).toEqual({
      template_version: '0.8.16',
      rules_sha256: PINNED_TEMPLATE_RULES_SHA256,
      rules: 41,
    });
  });

  it('parses source verification and release-gate arguments', () => {
    expect(parseTemplateOwnershipArgs([])).toEqual({ requireReady: false });
    expect(parseTemplateOwnershipArgs(['--', '--template-dir', 'reference/template', '--require-ready'])).toEqual({
      templateDirectory: 'reference/template',
      requireReady: true,
    });
    expect(() => parseTemplateOwnershipArgs(['--template-dir'])).toThrow(/unsupported argument/);
    expect(() => parseTemplateOwnershipArgs(['--other'])).toThrow(/unsupported argument/);
  });

  it.each([
    ['repository', (data: any) => { data.upstream.repository = 'https://example.invalid/template'; }],
    ['commit', (data: any) => { data.upstream.commit = 'a'.repeat(40); }],
    ['version', (data: any) => { data.upstream.template_version = '0.8.15'; }],
    ['digest', (data: any) => { data.upstream.rules_sha256 = 'b'.repeat(64); }],
  ])('rejects an unreviewed upstream %s', (_name, mutate) => {
    const data = baseline();
    mutate(data);
    expect(() => validateTemplateOwnership(data)).toThrow(/invalid fleet template ownership/);
  });

  it('rejects a missing, reordered, duplicated or mutated upstream rule', () => {
    const mutations = [
      (data: any) => data.mappings.pop(),
      (data: any) => data.mappings.reverse(),
      (data: any) => { data.mappings[1].path = data.mappings[0].path; },
      (data: any) => { data.mappings[0].owner = 'template'; },
      (data: any) => { data.mappings[0].seed = true; },
    ];
    for (const mutate of mutations) {
      const data = baseline();
      mutate(data);
      expect(() => validateTemplateOwnership(data)).toThrow(/invalid fleet template ownership/);
    }
  });

  it('rejects unknown states, strategies, and unsafe or duplicate fleet paths', () => {
    const mutations = [
      (data: any) => { data.mappings[0].state = 'done'; },
      (data: any) => { data.mappings[0].strategy = 'copy_everything'; },
      (data: any) => { data.mappings[0].fleet_paths = ['../outside']; },
      (data: any) => { data.mappings[0].fleet_paths = ['/absolute']; },
      (data: any) => { data.mappings[0].fleet_paths = ['apps/{app}', 'apps/{app}']; },
      (data: any) => { data.mappings[0].note = ' '; },
    ];
    for (const mutate of mutations) {
      const data = baseline();
      mutate(data);
      expect(() => validateTemplateOwnership(data)).toThrow(/invalid fleet template ownership/);
    }
  });

  it('derives readiness only when every rule is mapped', () => {
    const data = baseline();
    for (const mapping of data.mappings) mapping.state = 'mapped';
    const report = validateTemplateOwnership(data);
    expect(report.counts).toEqual({ mapped: 41, adapter_required: 0, missing: 0, conflict: 0 });
    expect(report.ready).toBe(true);
  });

  it.each([
    ['name', (data: any) => { data.name = 'other-template'; }],
    ['version', (data: any) => { data.templateVersion = '0.8.15'; }],
    ['rules', (data: any) => { data.rules[0].owner = 'template'; }],
    ['extra rule field', (data: any) => { data.rules[0].unexpected = true; }],
  ])('rejects a checked-out template with a changed %s', (_name, mutate) => {
    const data = pinnedTemplate();
    mutate(data);
    expect(() => validatePinnedTemplateDefinition(data)).toThrow(/invalid fleet template ownership/);
  });
});
