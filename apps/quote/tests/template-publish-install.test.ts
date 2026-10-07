import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('quote template publish/install alignment', () => templatePublishInstallTests('quote'));
