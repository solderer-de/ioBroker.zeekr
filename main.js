'use strict';

const { createAdapter } = require('./lib/adapter');

function createExportedAdapter() {
  const lifecycleEvent = process.env.npm_lifecycle_event;
  if (lifecycleEvent === 'install' || lifecycleEvent === 'postinstall') {
    return {
      on() {},
      emit() {},
      setStateChangedAsync() { return Promise.resolve(true); },
      setStateAsync() { return Promise.resolve(true); },
      subscribeStatesAsync() { return Promise.resolve(true); },
      sendTo() {},
      stop() {},
    };
  }

  return createAdapter();
}

module.exports = createExportedAdapter();
