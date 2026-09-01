'use strict';

module.exports = (options = {}) => {
  const { createAdapter } = require('./lib/adapter');
  return createAdapter(options);
};
