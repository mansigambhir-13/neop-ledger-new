import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('desk template publish/install alignment', () => templatePublishInstallTests('desk'));
