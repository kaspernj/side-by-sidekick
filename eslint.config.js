// @ts-check
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

export default [
  {
    ignores: ['build/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.js'],
    plugins: { jsdoc },
    rules: {
      ...jsdoc.configs['flat/recommended'].rules,
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: false,
            ClassDeclaration: true,
          },
        },
      ],
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
      'jsdoc/no-undefined-types': ['error', { definedTypes: ['NodeJS'] }],
    },
  },
];
