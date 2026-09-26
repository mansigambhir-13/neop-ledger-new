import { describe, expect, it } from 'vitest';
import { satisfies } from '../src/semver.ts';

describe('semver ranges for borrowed abilities', () => {
  it.each([
    ['1.4.2', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.1', true],
    ['0.3.0', '^0.2.1', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['3.1.0', '>=2.0.0', true],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '1.0.0', false],
    ['9.9.9', '*', true],
    ['1.0', '^1.0.0', false],
  ])('%s satisfies %s → %s', (v, r, want) => expect(satisfies(v, r)).toBe(want));
});
