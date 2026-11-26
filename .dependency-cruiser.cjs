const FEATURES =
  '^src/(auth|orders|products|files|sessions|events|checkout|health|reports|tasks|queue|redis)/';

module.exports = {
  forbidden: [
    {
      name: 'entities-are-leaves',
      comment:
        'Entities describe tables; they must not know about services, controllers or infrastructure. The one exception is the order status vocabulary, which is a plain type shared with the orders module.',
      severity: 'error',
      from: { path: '^src/entities/' },
      to: {
        path: '^src/',
        pathNot: '^src/(entities/|orders/order-status\\.ts$)',
      },
    },
    {
      name: 'observability-knows-no-features',
      comment:
        'Logging, metrics and tracing are imported by features, never the other way round.',
      severity: 'error',
      from: { path: '^src/observability/' },
      to: { path: FEATURES },
    },
    {
      name: 'config-knows-no-features',
      comment: 'The environment schema is the bottom layer.',
      severity: 'error',
      from: { path: '^src/config/' },
      to: { path: '^src/', pathNot: '^src/config/' },
    },
    {
      name: 'products-do-not-reach-into-orders',
      comment: 'Orders depend on products, not the other way round.',
      severity: 'error',
      from: { path: '^src/products/' },
      to: { path: '^src/(orders|checkout|files)/' },
    },
    {
      name: 'files-stand-alone',
      comment: 'The files module shares nothing with orders and products.',
      severity: 'error',
      from: { path: '^src/files/' },
      to: { path: '^src/(orders|products|checkout|sessions)/' },
    },
    {
      name: 'auth-knows-no-business-modules',
      comment:
        'Authentication is used by business modules and must not import them.',
      severity: 'error',
      from: { path: '^src/auth/' },
      to: { path: '^src/(orders|products|files|checkout|sessions)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
