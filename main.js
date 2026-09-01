'use strict';

const { createAdapter } = require('./lib/adapter');

module.exports = (options = {}) => createAdapter(options);
