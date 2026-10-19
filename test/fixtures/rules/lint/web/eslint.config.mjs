export default [
  { ignores: ['src/_generated/**'] },
  { files: ['**/*.mjs'], rules: { 'no-console': 'error', 'no-debugger': 'warn' } },
  { files: ['src/cli/**'], rules: { 'no-console': 'off' } },
];
