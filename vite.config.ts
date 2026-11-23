import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * The app as Zendesk wants it (`dist/`, what `zcli apps:package dist` zips):
 *
 *   dist/manifest.json            src/manifest.json, with package.json's version
 *   dist/translations/en.json     src/translations/en.json (Marketplace texts, setting labels)
 *   dist/assets/iframe.html       the sidebar page, and main.js / main.css it loads
 *   dist/assets/*.png             src/assets: logos and the Marketplace screenshots
 *
 * `PRIVATE_APP=1 npm run build` marks the manifest private (an app uploaded to one account
 * only, for testing); the Marketplace needs `private: false`.
 */
function zendeskFiles(): Plugin {
  return {
    name: 'zendesk-app-files',
    apply: 'build',
    closeBundle() {
      const dist = join(here, 'dist');
      const manifest = JSON.parse(readFileSync(join(here, 'src/manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      manifest.version = version;
      if (process.env.PRIVATE_APP === '1') manifest.private = true;
      writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      mkdirSync(join(dist, 'translations'), { recursive: true });
      for (const name of readdirSync(join(here, 'src/translations')))
        copyFileSync(join(here, 'src/translations', name), join(dist, 'translations', name));
      for (const name of readdirSync(join(here, 'src/assets')))
        copyFileSync(join(here, 'src/assets', name), join(dist, 'assets', name));
    },
  };
}

export default defineConfig({
  root: join(here, 'src'),
  // Zendesk serves the files from its own CDN, under a path of its choosing: relative links only.
  base: './',
  plugins: [react(), zendeskFiles()],
  define: {
    // The app names itself and its version on every Converter Studio API call.
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: join(here, 'dist/assets'),
    emptyOutDir: true,
    sourcemap: false,
    // Fixed names: the manifest points at iframe.html, which loads main.js and main.css.
    rollupOptions: {
      input: join(here, 'src/iframe.html'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
