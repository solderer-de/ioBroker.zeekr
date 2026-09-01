const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createDeviceBaseId, ZeekrAdapter } = require('../lib/adapter');

function createMainAdapterInstance() {
  const AdapterClass = require('../main');
  return new AdapterClass({ name: 'zeekr' });
}

test('createDeviceBaseId sanitizes VIN identifiers', () => {
  assert.equal(createDeviceBaseId({ vin: 'ABC-123/XYZ' }), 'vehicles.abc_123_xyz');
});

test('createDeviceBaseId falls back to the vehicle name', () => {
  assert.equal(createDeviceBaseId({ name: 'My Car' }), 'vehicles.my_car');
});

test('bridge normalization exposes common vehicle fields', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import importlib.util
import json
import pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = module.normalize_vehicle(
    {'vehicleName': 'My Car', 'vin': 'ABC123'},
    {'batteryLevel': 82, 'rangeKm': 410, 'odometer': 1234},
    {'pluggedIn': True, 'isCharging': True, 'chargingPower': 11},
    {'lockState': 'locked'}
)
print(json.dumps(payload))
`], { cwd: path.join(__dirname, '..') });

  assert.equal(result.status, 0, result.stderr.toString());
  const payload = JSON.parse(result.stdout.toString());
  assert.equal(payload.batteryLevel, 82);
  assert.equal(payload.chargePower, 11);
  assert.equal(payload.isCharging, true);
  assert.equal(payload.isLocked, true);
  assert.equal(payload.lockState, 'locked');
});

test('ensureBaseObjects creates the root info and vehicles channels', async () => {
  const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
  await adapter.ensureBaseObjects();
  assert.ok(adapter._objects.has('info'));
  assert.ok(adapter._objects.has('vehicles'));
});

test('main entrypoint exports an adapter constructor', () => {
  const adapter = createMainAdapterInstance();
  assert.equal(typeof adapter.on, 'function');
  assert.equal(typeof adapter.emit, 'function');
});
