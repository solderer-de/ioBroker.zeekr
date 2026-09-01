'use strict';

const { createAdapter } = require('./lib/adapter');

function createNoopAdapter() {
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

function isInstallLifecycle() {
  const lifecycleEvent = process.env.npm_lifecycle_event;
  return lifecycleEvent === 'install' || lifecycleEvent === 'postinstall';
}

function isIoBrokerRuntime() {
  return Boolean(
    process.env.IOBROKER_DATA_DIR ||
    process.env.IOBROKER_HOST ||
    process.env.IOBROKER_MAIN ||
    process.env.IOBROKER_INSTANCE ||
    process.env.NODE_ENV === 'test',
  );
}

function createExportedAdapter() {
  if (isInstallLifecycle() || !isIoBrokerRuntime()) {
    return createNoopAdapter();
  }

  return createAdapter();
}

module.exports = createExportedAdapter();
