import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('wage template publish/install alignment', () => templatePublishInstallTests('wage'));
