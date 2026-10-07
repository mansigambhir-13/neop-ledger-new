import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('reach template manifest alignment', () => templateManifestTests('reach'));
