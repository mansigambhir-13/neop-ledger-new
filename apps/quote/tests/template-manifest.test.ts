import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('quote template manifest alignment', () => templateManifestTests('quote'));
