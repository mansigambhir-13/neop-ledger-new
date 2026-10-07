import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('asset template manifest alignment', () => templateManifestTests('asset'));
