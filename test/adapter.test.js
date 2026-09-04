const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createDeviceBaseId, ZeekrAdapter, suggestRegionForCountry, getErrorHint } = require('../lib/adapter');

// Windows runners provide `python`, not `python3`.
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

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
  const result = spawnSync(PYTHON, ['-c', `
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

test('config hashes do not leak secrets in plain text', () => {
  const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
  adapter.config = {
    username: 'demo',
    password: 'super-secret-password',
    countryCode: 'DE',
    hmacAccessKey: 'hmac',
    hmacSecretKey: 'secret-key',
    passwordPublicKey: 'pub',
    prodSecret: 'prod',
    vinKey: 'vin-key',
    vinIv: 'vin-iv',
  };
  const hash = adapter.getConfigHash();
  assert.equal(typeof hash, 'string');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(hash, /super-secret-password/);
  assert.doesNotMatch(hash, /secret-key/);
});

test('redactPayload hides secret fields', () => {
  const { redactPayload } = require('../lib/adapter');
  const out = redactPayload({ username: 'a', password: 'b', hmacSecretKey: 'c', other: 'd' });
  assert.equal(out.password, '***');
  assert.equal(out.hmacSecretKey, '***');
  assert.equal(out.username, 'a');
  assert.equal(out.other, 'd');
});

test('ensureBaseObjects does not expose secrets as states', async () => {
  const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
  await adapter.ensureBaseObjects();
  for (const secretId of ['info.hmacAccessKey', 'info.hmacSecretKey', 'info.prodSecret', 'info.vinKey', 'info.vinIv']) {
    assert.ok(!adapter._objects.has(secretId), `${secretId} must not exist`);
  }
  assert.ok(adapter._objects.has('info.connection'));
});

test('resolveVinForDevice reads via getStateAsync', async () => {
  const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
  await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
  assert.equal(await adapter.resolveVinForDevice('my_car'), 'VIN123');
});

test('sendCommand validates vin/command', async () => {
  const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
  let sent = null;
  adapter.sendTo = (from, cmd, msg, cb) => {
    sent = msg;
    if (typeof cb === 'function') {
      cb(msg);
    }
  };
  await adapter.onMessage({ command: 'sendCommand', message: {}, from: 'test', callback: () => {} });
  assert.equal(sent.ok, false);
});

test('suggestRegion maps EU countries to EU', () => {
  assert.equal(suggestRegionForCountry('DE'), 'EU');
  assert.equal(suggestRegionForCountry('DK'), 'EU');
  assert.equal(suggestRegionForCountry('AU'), 'EM');
  assert.equal(suggestRegionForCountry('CN'), 'CN');
});

test('getErrorHint maps known Zeekr errors to German hints', () => {
  assert.match(getErrorHint('0001 Invalid access key'), /Region/);
  assert.match(getErrorHint('079025 Signature authentication failed'), /prod_secret/);
  assert.match(getErrorHint('Decrypt X-VIN failed'), /VIN/);
  assert.match(getErrorHint('079021 session'), /Zweitaccount/);
});

test('jsonConfig parses and covers every native key', () => {
  const fs = require('node:fs');
  const ioPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8'));
  const jsonConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (node.items && typeof node.items === 'object') {
      for (const [key, item] of Object.entries(node.items)) {
        seen.add(key);
        walk(item);
      }
    }
  };
  walk(jsonConfig);
  for (const key of Object.keys(ioPkg.native)) {
    assert.ok(seen.has(key), `native key missing in jsonConfig: ${key}`);
  }
  for (const secret of ioPkg.protectedNative) {
    assert.ok(seen.has(secret), `protected key missing in jsonConfig: ${secret}`);
  }
});

test('typed commands cover lock/climate/charge', () => {
  const { TYPED_COMMANDS } = require('../lib/adapter');
  for (const key of ['lock', 'unlock', 'climateStart', 'climateStop', 'chargeStart', 'chargeStop']) {
    assert.ok(TYPED_COMMANDS[key], key);
    assert.equal(typeof TYPED_COMMANDS[key].command, 'string');
  }
  assert.equal(TYPED_COMMANDS.chargeStart.serviceId, 'RCS');
});

test('bridge mock mode returns fixture vehicles', () => {
  const result = spawnSync(PYTHON, ['lib/bridge.py', 'vehicles'],
    { input: JSON.stringify({ username: 'mock', password: 'mock' }), cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.vehicles) && payload.vehicles.length >= 1);
  assert.equal(payload.vehicles[0].vin, 'MOCKVIN1234567890');
  assert.equal(typeof payload.vehicles[0].chargingLimit, 'number');
});

test('bridge mock test_connection works', () => {
  const result = spawnSync(PYTHON, ['lib/bridge.py', 'test_connection'],
    { input: JSON.stringify({ username: 'mock', password: 'mock' }), cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('bridge extended normalization keeps new fields', () => {
  const result = spawnSync(PYTHON, ['-c', `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = m.normalize_vehicle({'vin': 'X'}, {'batteryLevel': 80}, {}, {}, {'tirePressureFl': 2.5, 'latitude': 52.5}, {'chargingLimit': 90}, {'enabled': True}, {}, {'lastTripDistanceKm': 12})
print(json.dumps(p))
`], { cwd: path.join(__dirname, '..') });
  assert.equal(result.status, 0, result.stderr.toString());
  const p = JSON.parse(result.stdout.toString());
  assert.equal(p.chargingLimit, 90);
  assert.equal(p.tirePressureFl, 2.5);
  assert.equal(p.lastTripDistanceKm, 12);
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
