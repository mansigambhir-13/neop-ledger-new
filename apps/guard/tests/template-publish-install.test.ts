import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('guard template publish/install alignment', () => templatePublishInstallTests('guard'));
