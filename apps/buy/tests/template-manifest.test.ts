import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('buy template manifest alignment', () => templateManifestTests('buy'));
