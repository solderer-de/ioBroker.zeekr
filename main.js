'use strict';

const { createAdapter } = require('./lib/adapter');

if (require.main === module) {
    createAdapter();
} else {
    module.exports = (options = {}) => createAdapter(options);
}
