import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('clear template manifest alignment', () => templateManifestTests('clear'));
