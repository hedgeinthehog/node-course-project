const { TestEnvironment } = require('jest-environment-node');

module.exports = class NativeRequireEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    process.env.PACT_DO_NOT_TRACK ??= 'true';
    this.global.nativeRequire = require;
  }
};
