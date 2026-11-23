import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// typescript-eslint's type-checked rules on the TypeScript, React's rules of hooks on the
// components, and plain rules on the Node scripts (build tools, the private harness and e2e).
export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tmp/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser },
    },
  },
  {
    files: ['src/**/*.tsx', 'test/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2024 },
  },
  {
    // The harness's page scripts run in the browser; e2e checks run partly inside the page.
    files: ['dev/**/*.js', 'e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      // Fakes stand in for Zendesk's and the API's typed objects.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      // ZAF rejects a failed request with the response object, not an Error: the fakes do too.
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
);
