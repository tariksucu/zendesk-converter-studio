import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Unit and component tests: the Zendesk Apps Framework client (test/fake-zaf.ts, which also
// plays Zendesk's proxy) and Converter Studio's API (test/fake-api.ts) are stood in for. No
// network.
export default mergeConfig(
  viteConfig,
  defineConfig({
    root: import.meta.dirname,
    test: {
      include: ['test/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['test/setup.ts'],
    },
  }),
);
