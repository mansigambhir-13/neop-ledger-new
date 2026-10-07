import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('asset template publish/install alignment', () => templatePublishInstallTests('asset'));
