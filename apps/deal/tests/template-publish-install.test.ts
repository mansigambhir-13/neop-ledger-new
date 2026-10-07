import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('deal template publish/install alignment', () => templatePublishInstallTests('deal'));
