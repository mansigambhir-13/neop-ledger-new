// Operator tool: build a package from its source folder and submit it for review.
//   NEOS_PLATFORM_URL=... NEOS_OPERATOR_TOKEN=... tsx scripts/publish-package.ts registry/nep-gst
import { buildPackage } from '@neop/template';

const dir = process.argv[2];
if (!dir) throw new Error('usage: publish-package.ts <package dir>');
const bundle = await buildPackage(dir);
const res = await fetch(`${process.env.NEOS_PLATFORM_URL ?? 'http://127.0.0.1:4700'}/api/registry/packages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.NEOS_OPERATOR_TOKEN ?? 'dev_operator'}`, 'content-type': 'application/json' },
  body: JSON.stringify({ bundle }),
});
console.log(res.status, await res.text());
