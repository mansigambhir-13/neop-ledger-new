import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('ledger template publish/install alignment', () => templatePublishInstallTests('ledger'));
