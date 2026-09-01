const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createDeviceBaseId, ZeekrAdapter } = require('../lib/adapter');

function createMainAdapterFactory() {
  return require('../main');
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

test('main entrypoint exports an adapter factory', () => {
  const factory = createMainAdapterFactory();
  const adapter = factory({ name: 'zeekr' });
  assert.equal(typeof adapter.on, 'function');
  assert.equal(typeof adapter.emit, 'function');
});

test('adapter falls back to the stub when no ioBroker runtime is present', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalIobDataDir = process.env.IOB_DATA_DIR;
  const originalIoBrokerDataDir = process.env.IOBROKER_DATA_DIR;
  const originalIoBrokerHost = process.env.IOBROKER_HOST;
  const originalObjdbType = process.env.OBJDB_TYPE;

  delete process.env.NODE_ENV;
  delete process.env.IOB_DATA_DIR;
  delete process.env.IOBROKER_DATA_DIR;
  delete process.env.IOBROKER_HOST;
  delete process.env.OBJDB_TYPE;
  delete require.cache[require.resolve('../lib/adapter')];

  try {
    const { createAdapter } = require('../lib/adapter');
    const adapter = createAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const grandParent = Object.getPrototypeOf(Object.getPrototypeOf(adapter));
    assert.equal(grandParent.constructor.name, 'AdapterStub');
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalIobDataDir === undefined) {
      delete process.env.IOB_DATA_DIR;
    } else {
      process.env.IOB_DATA_DIR = originalIobDataDir;
    }
    if (originalIoBrokerDataDir === undefined) {
      delete process.env.IOBROKER_DATA_DIR;
    } else {
      process.env.IOBROKER_DATA_DIR = originalIoBrokerDataDir;
    }
    if (originalIoBrokerHost === undefined) {
      delete process.env.IOBROKER_HOST;
    } else {
      process.env.IOBROKER_HOST = originalIoBrokerHost;
    }
    if (originalObjdbType === undefined) {
      delete process.env.OBJDB_TYPE;
    } else {
      process.env.OBJDB_TYPE = originalObjdbType;
    }
    delete require.cache[require.resolve('../lib/adapter')];
  }
});

test('adapter ignores a missing ioBroker config file even if the env var is set', () => {
  const originalIoBrokerDataDir = process.env.IOBROKER_DATA_DIR;
  process.env.IOBROKER_DATA_DIR = '/tmp/definitely-missing-iobroker-config';
  delete require.cache[require.resolve('../lib/adapter')];

  try {
    const { createAdapter } = require('../lib/adapter');
    const adapter = createAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const grandParent = Object.getPrototypeOf(Object.getPrototypeOf(adapter));
    assert.equal(grandParent.constructor.name, 'AdapterStub');
  } finally {
    if (originalIoBrokerDataDir === undefined) {
      delete process.env.IOBROKER_DATA_DIR;
    } else {
      process.env.IOBROKER_DATA_DIR = originalIoBrokerDataDir;
    }
    delete require.cache[require.resolve('../lib/adapter')];
  }
});

test('main entrypoint avoids auto-start during npm lifecycle installs', () => {
  const originalLifecycleEvent = process.env.npm_lifecycle_event;
  process.env.npm_lifecycle_event = 'install';
  delete require.cache[require.resolve('../main')];

  try {
    const factory = require('../main');
    assert.equal(typeof factory, 'function');
  } finally {
    if (originalLifecycleEvent === undefined) {
      delete process.env.npm_lifecycle_event;
    } else {
      process.env.npm_lifecycle_event = originalLifecycleEvent;
    }
    delete require.cache[require.resolve('../main')];
  }
});
