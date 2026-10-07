import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('wage template manifest alignment', () => templateManifestTests('wage'));
