import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const NO_FS_EXTRA = {
  name: 'fs-extra',
  message: 'agent-sdk-watchdog does not declare fs-extra; use node:fs.',
}
const NO_EXECA = {
  name: 'execa',
  message: 'agent-sdk-watchdog does not declare execa; use node:child_process.',
}

/**
 * Rules that fail an import of each banned module: static imports (type-only ones too) through
 * no-restricted-imports, `import()` calls and `import('…')` types through two selectors.
 */
function bannedImports(bans) {
  const pattern = (name) => `/^${name.replaceAll('/', '\\/')}(\\/|$)/`
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: bans.map(({ name, message }) => ({ name, message })),
        patterns: bans.map(({ name, message }) => ({ group: [`${name}/*`], message })),
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...bans.flatMap(({ name, message }) => [
        { selector: `ImportExpression[source.value=${pattern(name)}]`, message },
        { selector: `TSImportType[argument.literal.value=${pattern(name)}]`, message },
      ]),
    ],
  }
}

export default defineConfig(
  { ignores: ['dist'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // Inside a workspace these modules can be hoisted next to the package, so an undeclared
  // import would still compile and run.
  { files: ['**/*.ts'], rules: bannedImports([NO_FS_EXTRA, NO_EXECA]) },
  prettier,
)
