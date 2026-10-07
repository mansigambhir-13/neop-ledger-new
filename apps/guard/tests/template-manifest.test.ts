import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('guard template manifest alignment', () => templateManifestTests('guard'));
