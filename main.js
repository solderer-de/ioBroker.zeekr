'use strict';

const { createAdapter } = require('./lib/adapter');

if (require.main !== module) {
  module.exports = (options = {}) => createAdapter(options);
} else {
  createAdapter();
}
