'use strict';

const { createAdapter } = require('./lib/adapter');

function startAdapter() {
  const adapter = createAdapter();
  adapter.on('ready', () => {
    if (adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info('Adapter ready');
    }
  });
  return adapter;
}

if (require.main === module) {
  startAdapter();
}

module.exports = startAdapter;
