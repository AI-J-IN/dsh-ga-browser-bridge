/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { useESM: true, tsconfig: 'tsconfig.tests.json' },
    ],
  },
  moduleNameMapper: {
    '^@cdp/(.*)$': '<rootDir>/src/cdp/$1',
    '^@tools/(.*)$': '<rootDir>/src/tools/$1',
    // NodeNext ESM sources import with .js suffixes (e.g. './json.js');
    // jest/ts-jest needs those resolved to the .ts source files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // NodeNext ESM: allow .js import specifiers that resolve to .ts sources.
  moduleFileExtensions: ['ts', 'js', 'json'],
};
