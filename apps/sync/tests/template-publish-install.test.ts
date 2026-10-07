import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('sync template publish/install alignment', () => templatePublishInstallTests('sync'));
