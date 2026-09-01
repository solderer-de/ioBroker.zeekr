'use strict';

const { createAdapter } = require('./lib/adapter');

function main() {
  const adapter = createAdapter();
  adapter.on('ready', () => {
    if (adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info('Adapter ready');
    }
  });
  return adapter;
}

main();
