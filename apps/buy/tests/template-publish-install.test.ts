import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('buy template publish/install alignment', () => templatePublishInstallTests('buy'));
