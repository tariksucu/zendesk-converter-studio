// Draws the Marketplace logos from Converter Studio's mark (an open square over an orange one, on
// its cream tile) at the sizes Zendesk asks for, with rsvg-convert and optipng:
//
// - assets/logo.png        320 × 320, square corners (Zendesk rounds them itself);
// - assets/logo-small.png  128 × 128, PNG with transparency, readable on light and dark: the
//                          cream tile with rounded corners.
//
//   node tools/icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets');
const mark = (
  radius,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="${radius}" fill="#f2efe8"/>
  <rect x="5" y="5" width="15" height="15" fill="none" stroke="#16150f" stroke-width="2.2"/>
  <rect x="12" y="12" width="15" height="15" fill="#ff5418"/>
</svg>
`;

const work = mkdtempSync(join(tmpdir(), 'cvs-zendesk-icons-'));
try {
  for (const [name, size, radius] of [
    ['logo.png', 320, 0],
    ['logo-small.png', 128, 3],
  ]) {
    const svg = join(work, `${name}.svg`);
    writeFileSync(svg, mark(radius));
    const out = join(assets, name);
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, svg]);
    // No palette: Zendesk asks for PNG-24 (true colour) with transparency.
    execFileSync('optipng', ['-quiet', '-o5', '-nc', '-nb', '-strip', 'all', out]);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`logos written to ${assets}`);
