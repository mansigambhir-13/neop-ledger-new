import { describe } from 'vitest';
import { templateManifestTests } from '../../../scripts/fleet/testing/template-manifest.ts';

describe('ledger template manifest alignment', () => templateManifestTests('ledger'));
