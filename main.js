'use strict';

const { createAdapter } = require('./lib/adapter');

const adapter = createAdapter();

adapter.on('ready', () => {
  if (adapter.log && typeof adapter.log.info === 'function') {
    adapter.log.info('Adapter ready');
  }
});

module.exports = adapter;
