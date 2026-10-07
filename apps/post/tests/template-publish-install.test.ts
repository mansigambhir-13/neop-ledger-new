import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('post template publish/install alignment', () => templatePublishInstallTests('post'));
