import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('renew template manifest alignment', () => templateManifestTests('renew'));
