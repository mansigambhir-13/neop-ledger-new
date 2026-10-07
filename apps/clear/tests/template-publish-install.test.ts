import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('clear template publish/install alignment', () => templatePublishInstallTests('clear'));
