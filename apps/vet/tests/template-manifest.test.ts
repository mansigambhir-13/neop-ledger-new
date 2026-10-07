import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('vet template manifest alignment', () => templateManifestTests('vet'));
