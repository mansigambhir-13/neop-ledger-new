import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('roster template manifest alignment', () => templateManifestTests('roster'));
