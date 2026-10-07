import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('renew template publish/install alignment', () => templatePublishInstallTests('renew'));
