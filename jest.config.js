const database = {
  globalSetup: '<rootDir>/test/integration/testkit/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/testkit/global-teardown.ts',
};
const pact = {
  testEnvironment: '<rootDir>/test/contract/native-require-environment.js',
};

const project = (displayName, pattern, options) => ({
  displayName,
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: { module: 'esnext', moduleResolution: 'bundler' },
      },
    ],
  },
  testMatch: [`<rootDir>/test/${pattern}`],
  ...options,
});

module.exports = {
  reporters: ['default'],
  maxWorkers: 1,
  verbose: true,
  testTimeout: 60000,
  projects: [
    project('integration', 'integration/**/*.int-spec.ts', database),
    project('e2e', 'e2e/**/*.e2e-spec.ts', database),
    project('contract', 'contract/consumer.pact-spec.ts', pact),
    project('provider', 'contract/provider.pact-spec.ts', {
      ...database,
      ...pact,
    }),
  ],
};
