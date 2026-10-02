// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    files: ['**/scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', process: 'readonly', console: 'readonly', __dirname: 'readonly', module: 'writable' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
