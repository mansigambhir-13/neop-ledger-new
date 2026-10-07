import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('shift template manifest alignment', () => templateManifestTests('shift'));
