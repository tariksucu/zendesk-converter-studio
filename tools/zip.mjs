// Zips dist/ the way `zcli apps:package dist` does (the files at the zip's root, nothing else),
// for uploading in the Marketplace portal or with `zcli apps:create` / `apps:update`. zcli itself
// sends the zip to the signed-in Zendesk account to validate it; this makes the same zip with no
// account. Needs the `zip` command (Info-ZIP).
//
//   npm run package    → tmp/converter-studio-<version>.zip
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'tmp', `converter-studio-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
// -X: no extra file attributes (owner ids, times beyond the basic ones); -r from inside dist/.
execFileSync('zip', ['-q', '-r', '-X', out, '.'], { cwd: join(root, 'dist') });
console.log(`${out} (${Math.round(statSync(out).size / 1024)} KB)`);
