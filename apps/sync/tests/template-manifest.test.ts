import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('sync template manifest alignment', () => templateManifestTests('sync'));
