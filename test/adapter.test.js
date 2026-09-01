const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceBaseId } = require('../lib/adapter');

test('createDeviceBaseId sanitizes VIN identifiers', () => {
  assert.equal(createDeviceBaseId({ vin: 'ABC-123/XYZ' }), 'vehicles.abc_123_xyz');
});

test('createDeviceBaseId falls back to the vehicle name', () => {
  assert.equal(createDeviceBaseId({ name: 'My Car' }), 'vehicles.my_car');
});
