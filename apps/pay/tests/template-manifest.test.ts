import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('pay template manifest alignment', () => templateManifestTests('pay'));
