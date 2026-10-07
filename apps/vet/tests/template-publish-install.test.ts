import { describe } from 'vitest';
import { templatePublishInstallTests } from '../../../scripts/fleet/testing/template-publish-install.ts';

describe('vet template publish/install alignment', () => templatePublishInstallTests('vet'));
