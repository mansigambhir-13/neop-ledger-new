import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('grant template publish/install alignment', () => templatePublishInstallTests('grant'));
