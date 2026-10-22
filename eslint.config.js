import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The Prisma client is generated, not written: `npm run generate` writes it
    // and the suite runs against whatever it produced.
    ignores: ['test-fixtures/*/dist/**', 'data/**', 'prisma/generated/**'],
  },
];
