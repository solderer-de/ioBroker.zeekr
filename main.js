'use strict';

const { createAdapter } = require('./lib/adapter');

function shouldAutoStart() {
  const lifecycleEvent = process.env.npm_lifecycle_event;
  if (lifecycleEvent && ['install', 'postinstall', 'preinstall', 'prepare', 'prepublish'].includes(lifecycleEvent)) {
    return false;
  }

  return true;
}

if (require.main === module) {
  if (shouldAutoStart()) {
    createAdapter();
  }
} else {
  module.exports = (options = {}) => createAdapter(options);
}
