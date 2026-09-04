'use strict';
const p = require('../package.json').version;
const io = require('../io-package.json').common.version;
if (p !== io) {
  console.error('version mismatch: package.json ' + p + ' vs io-package.json ' + io);
  process.exit(1);
} else {
  console.log('versions ok: ' + p);
}
