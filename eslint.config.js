import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Flat config (ESLint 9+). Replaces the legacy .eslintrc.json. Only src/**/*.ts
// is linted (test files are checked by Prettier only, matching the lint script).
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts'],
    // Base recommended + typescript-eslint's non-type-checked recommended. This
    // mirrors what the old .eslintrc.json effectively enforced: its
    // `recommended-requiring-type-checking` preset was removed in typescript-eslint
    // v8, so type-aware rules were not actually running. Enabling them
    // (recommendedTypeChecked) is a worthwhile but separate change — it surfaces
    // ~30 pre-existing findings — so it's intentionally left out of this upgrade.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['viem', 'viem/*'],
              message:
                'Import viem only via src/lib/x402/viem.ts — it is bundled at build time so viem stays a devDependency.',
            },
          ],
        },
      ],
    },
  },
  {
    // The boundary module is the single place allowed to import viem.
    files: ['src/lib/x402/viem.ts'],
    rules: { 'no-restricted-imports': 'off' },
  }
);
