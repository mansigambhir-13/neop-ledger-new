import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('grant template manifest alignment', () => templateManifestTests('grant'));
