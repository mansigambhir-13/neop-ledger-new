import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('roster template publish/install alignment', () => templatePublishInstallTests('roster'));
