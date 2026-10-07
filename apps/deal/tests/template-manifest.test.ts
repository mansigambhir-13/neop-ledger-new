import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('deal template manifest alignment', () => templateManifestTests('deal'));
