// Checks the built app (dist/) before it is zipped: exactly the files Zendesk loads, the manifest
// as the build wrote it, and nothing zendesk_apps_support refuses (symlinks, archives, PDFs and
// Office files inside the package).
//
//   npm run build && node tools/check-package.mjs
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`symlink in the package: ${relative(dist, path)}`);
    return stat.isDirectory() ? walk(path) : [relative(dist, path)];
  });
}

const files = walk(dist).sort();
const expected = [
  'assets/iframe.html',
  'assets/logo-small.png',
  'assets/logo.png',
  'assets/main.js',
  'assets/screenshot-0.png',
  'assets/screenshot-1.png',
  'assets/screenshot-2.png',
  'manifest.json',
  'translations/en.json',
].sort();
const problems = [];
if (JSON.stringify(files) !== JSON.stringify(expected))
  problems.push(`files: ${files.join(', ')}\n   expected: ${expected.join(', ')}`);

const blocked = /\.(rar|zip|gz|pdf|docx?|avi|bin|bz2?|csh|sh|jar|mp3|mpeg|odt|pptx?|xlsx?|7z)$/i;
for (const file of files)
  if (blocked.test(file)) problems.push(`not allowed in a Zendesk app: ${file}`);

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== version)
  problems.push(`manifest version ${manifest.version} ≠ ${version}`);
if (manifest.private !== false && process.env.PRIVATE_APP !== '1')
  problems.push('manifest.private must be false for the Marketplace');
if (manifest.location?.support?.ticket_sidebar?.url !== 'assets/iframe.html')
  problems.push('the sidebar does not point at assets/iframe.html');

const html = readFileSync(join(dist, 'assets/iframe.html'), 'utf8');
if (!html.includes('https://static.zdassets.com/zendesk_app_framework_sdk/2.0/zaf_sdk.min.js'))
  problems.push('iframe.html does not load the ZAF SDK');
if (!/src="\.\/main\.js"/.test(html)) problems.push('iframe.html does not load ./main.js');

const size = files.reduce((sum, file) => sum + lstatSync(join(dist, file)).size, 0);
if (problems.length) {
  console.error(`dist/ is not ready:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`dist/ ok: ${files.length} files, ${Math.round(size / 1024)} KB, version ${version}`);
