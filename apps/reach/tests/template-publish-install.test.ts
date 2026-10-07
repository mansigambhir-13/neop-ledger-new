import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('reach template publish/install alignment', () => templatePublishInstallTests('reach'));
