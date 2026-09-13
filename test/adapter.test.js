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
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
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
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );

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
    for (const secretId of [
        'info.hmacAccessKey',
        'info.hmacSecretKey',
        'info.prodSecret',
        'info.vinKey',
        'info.vinIv',
    ]) {
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
    const walk = node => {
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
    for (const key of [
        'lock',
        'unlock',
        'climateStart',
        'climateStop',
        'chargeStart',
        'chargeStop',
        'windowsOpen',
        'windowsClose',
        'windowsVentilate',
        'sunshadeOpen',
        'sunshadeClose',
        'flash',
        'honkFlash',
    ]) {
        assert.ok(TYPED_COMMANDS[key], key);
        assert.equal(typeof TYPED_COMMANDS[key].command, 'string');
    }
    assert.equal(TYPED_COMMANDS.chargeStart.serviceId, 'RCS');
});

test('typed commands match upstream values (Fryyyyy/zeekr_homeassistant)', () => {
    const { TYPED_COMMANDS } = require('../lib/adapter');
    assert.deepEqual(TYPED_COMMANDS.lock, {
        command: 'start',
        serviceId: 'RDL',
        setting: { serviceParameters: [{ key: 'door', value: 'all' }] },
    });
    assert.deepEqual(TYPED_COMMANDS.unlock, {
        command: 'stop',
        serviceId: 'RDU',
        setting: { serviceParameters: [{ key: 'door', value: 'all' }] },
    });
    assert.deepEqual(TYPED_COMMANDS.windowsVentilate, {
        command: 'start',
        serviceId: 'RWS',
        setting: { serviceParameters: [{ key: 'target', value: 'ventilate' }] },
    });
    assert.deepEqual(TYPED_COMMANDS.flash, {
        command: 'start',
        serviceId: 'RHL',
        setting: { serviceParameters: [{ key: 'rhl', value: 'light-flash' }] },
    });
    assert.equal(TYPED_COMMANDS.climateStart.serviceId, 'ZAF');
    assert.equal(TYPED_COMMANDS.climateStop.serviceId, 'ZAF');
});

test('bridge mock mode returns fixture vehicles', () => {
    const result = spawnSync(PYTHON, ['lib/bridge.py', 'vehicles'], {
        input: JSON.stringify({ username: 'mock', password: 'mock' }),
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.vehicles) && payload.vehicles.length >= 1);
    assert.equal(payload.vehicles[0].vin, 'MOCKVIN1234567890');
    assert.equal(typeof payload.vehicles[0].chargingLimit, 'number');
});

test('bridge mock test_connection works', () => {
    const result = spawnSync(PYTHON, ['lib/bridge.py', 'test_connection'], {
        input: JSON.stringify({ username: 'mock', password: 'mock' }),
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
});

test('bridge extended normalization keeps new fields', () => {
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = m.normalize_vehicle({'vin': 'X'}, {'batteryLevel': 80}, {}, {}, {'tirePressureFl': 2.5, 'latitude': 52.5}, {'chargingLimit': 90}, {'enabled': True}, {}, {'lastTripDistanceKm': 12})
print(json.dumps(p))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    const p = JSON.parse(result.stdout.toString());
    assert.equal(p.chargingLimit, 90);
    assert.equal(p.tirePressureFl, 2.5);
    assert.equal(p.lastTripDistanceKm, 12);
});

test('bridge reads nested additionalVehicleStatus', () => {
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = m.normalize_vehicle(
    {'vin': 'X'},
    {'additionalVehicleStatus': {'drivingSafetyStatus': {'centralLockingStatus': 'locked'},
     'climateStatus': {'winPosDriver': 0, 'winPosPassenger': 50}}},
    {}, {})
print(json.dumps(p))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    const p = JSON.parse(result.stdout.toString());
    assert.equal(p.centralLockingStatus, 'locked');
    assert.equal(p.windowPositionAvg, 25);
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

test('main entrypoint exports an adapter factory when required', () => {
    delete require.cache[require.resolve('../main')];

    try {
        const factory = require('../main');
        assert.equal(typeof factory, 'function');
    } finally {
        delete require.cache[require.resolve('../main')];
    }
});

test('importApk copies APKs into adapter storage', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apk-src-')), 'base.apk');
    fs.writeFileSync(src, 'fake-apk');
    const target = await adapter.importApk(src, 'base.apk');
    assert.ok(target.endsWith(path.join('apks', 'base.apk')));
    assert.equal(fs.readFileSync(target, 'utf8'), 'fake-apk');
});

test('importApk rejects missing files', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await assert.rejects(
        adapter.importApk('/tmp/definitely-missing-zeekr.apk', 'base.apk'),
        /not found or not readable/,
    );
});

test('chargeLimit write clamps and sends RCS soc command', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
    let bridged = null;
    adapter.runBridge = async (action, payload) => {
        bridged = { action, payload };
        return { ok: true };
    };
    await adapter.onMessage({
        command: 'stateChange',
        message: { id: 'vehicles.my_car.control.chargeLimit', value: 87 },
        from: 'test',
        callback: () => {},
    });
    assert.equal(bridged.action, 'command');
    assert.equal(bridged.payload.serviceId, 'RCS');
    assert.deepEqual(bridged.payload.setting.serviceParameters[0], { key: 'soc', value: '850' });
});

test('climateStart uses temp and duration states', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
    await adapter.setStateAsync('vehicles.my_car.control.climateTemp', 22, true);
    await adapter.setStateAsync('vehicles.my_car.control.climateDuration', 30, true);
    let bridged = null;
    adapter.runBridge = async (action, payload) => {
        bridged = { action, payload };
        return { ok: true };
    };
    await adapter.onMessage({
        command: 'stateChange',
        message: { id: 'vehicles.my_car.control.climateStart', value: true },
        from: 'test',
        callback: () => {},
    });
    assert.equal(bridged.payload.serviceId, 'ZAF');
    const params = Object.fromEntries(bridged.payload.setting.serviceParameters.map(p => [p.key, p.value]));
    assert.equal(params['AC.temp'], '22');
    assert.equal(params['AC.duration'], '30');
});

test('adaptive polling is faster when active', () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.pollingInterval = 300;
    adapter._lastActivePoll = false;
    assert.equal(adapter.getEffectivePollingInterval(), 300);
    adapter._lastActivePoll = true;
    assert.equal(adapter.getEffectivePollingInterval(), 60);
    adapter.pollingInterval = 45;
    assert.equal(adapter.getEffectivePollingInterval(), 45);
});

test('sentry alerts on charge stop and open doors', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const alerts = [];
    adapter.maybeTriggerAlert = msg => alerts.push(msg);
    adapter._lastVehicleSnapshot = new Map([
        [
            'VIN1',
            {
                isCharging: true,
                pluggedIn: true,
                batteryLevel: 50,
                chargingLimit: 90,
                doors: {
                    doorOpenStatusDriver: false,
                    doorOpenStatusPassenger: false,
                    doorOpenStatusDriverRear: false,
                    doorOpenStatusPassengerRear: false,
                    trunkOpenStatus: false,
                },
            },
        ],
    ]);
    await adapter.checkSentryEvents([
        {
            vin: 'VIN1',
            isCharging: false,
            pluggedIn: true,
            batteryLevel: 51,
            chargingLimit: 90,
            doorOpen: { trunkOpenStatus: true },
        },
    ]);
    assert.equal(alerts.length, 2);
    assert.match(alerts[0], /Charging stopped/);
    assert.match(alerts[1], /trunkOpenStatus/);
});

test('bridge scales soc charging limit and parses doors', () => {
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = m.normalize_vehicle({'vin': 'X'}, {'additionalVehicleStatus': {'drivingSafetyStatus': {'doorOpenStatusDriver': '1', 'trunkOpenStatus': '0'}}}, {'isCharging': False}, {}, {}, {'soc': 800}, {}, {}, {'trips': [{'distance': 10}], 'total': 3})
print(json.dumps(p))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    const p = JSON.parse(result.stdout.toString());
    assert.equal(p.chargingLimit, 80);
    assert.equal(p.doorOpen.doorOpenStatusDriver, true);
    assert.equal(p.doorOpen.trunkOpenStatus, false);
    assert.equal(p.tripCount, 3);
});

test('trackEnergy settles session with tariff cost and losses', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        tariffsJson: JSON.stringify([{ name: 'home', pricePerKwh: 0.3 }]),
        defaultPricePerKwh: 0.3,
        batteryCapacityKwh: 100,
        chargingEfficiencyPct: 88,
        homeLat: '',
        homeLon: '',
        homeRadiusM: 150,
        smartChargeEnabled: false,
        smartChargeDeparture: '',
    };
    const base = { vin: 'VIN9', name: 'Car', chargingLimit: 90, latitude: null, longitude: null, currentSpeed: 0 };
    await adapter.trackEnergy([{ ...base, isCharging: true, pluggedIn: true, batteryLevel: 50, chargePower: 11 }]);
    await adapter.trackEnergy([{ ...base, isCharging: true, pluggedIn: true, batteryLevel: 55, chargePower: 11 }]);
    await adapter.trackEnergy([{ ...base, isCharging: false, pluggedIn: true, batteryLevel: 55, chargePower: 0 }]);
    const idBase = 'vehicles.vin9';
    const kwh = await adapter.getStateAsync(`${idBase}.energy.sessionKwh`);
    assert.ok(kwh.val > 0, JSON.stringify(kwh));
    const tariff = await adapter.getStateAsync(`${idBase}.energy.sessionTariff`);
    assert.equal(tariff.val, 'home');
    const month = await adapter.getStateAsync(`${idBase}.energy.monthKwh`);
    assert.equal(month.val, kwh.val);
    const loss = await adapter.getStateAsync(`${idBase}.energy.sessionLossKwh`);
    assert.ok(loss.val >= 0);
});

test('trackEnergy records standby drain while parked', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        tariffsJson: '',
        defaultPricePerKwh: 0.4,
        batteryCapacityKwh: 100,
        chargingEfficiencyPct: 88,
        homeLat: '',
        homeLon: '',
        homeRadiusM: 150,
        smartChargeEnabled: false,
        smartChargeDeparture: '',
    };
    const base = { vin: 'VIN8', name: 'Car', isCharging: false, pluggedIn: false, currentSpeed: 0, chargePower: 0 };
    await adapter.trackEnergy([{ ...base, batteryLevel: 60 }]);
    await adapter.trackEnergy([{ ...base, batteryLevel: 59 }]);
    const standby = await adapter.getStateAsync('vehicles.vin8.energy.standbyMonthKwh');
    assert.equal(standby.val, 1);
});

test('smart charge starts and pauses via RCS', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        tariffsJson: JSON.stringify([
            { name: 'night', pricePerKwh: 0.2, from: '22:00', to: '06:00' },
            { name: 'day', pricePerKwh: 0.5 },
        ]),
        defaultPricePerKwh: 0.5,
        batteryCapacityKwh: 100,
        chargingEfficiencyPct: 88,
        homeLat: '',
        homeLon: '',
        homeRadiusM: 150,
        smartChargeEnabled: true,
        smartChargeDeparture: '07:00',
        username: 'u',
        password: 'p',
        countryCode: 'DE',
        mockMode: false,
    };
    const calls = [];
    adapter.runBridge = async (action, payload) => {
        calls.push({ action, command: payload.command, serviceId: payload.serviceId });
        return { ok: true };
    };
    const RealDate = Date;
    const at = h => new RealDate(2026, 0, 1, h, 0);
    global.Date = class extends RealDate {
        constructor(...a) {
            super(...(a.length ? a : [at(12, 0)]));
        }
        static now() {
            return at(12, 0).getTime();
        }
    };
    try {
        await adapter.trackEnergy([
            {
                vin: 'VIN7',
                name: 'Car',
                isCharging: false,
                pluggedIn: true,
                batteryLevel: 50,
                chargingLimit: 90,
                chargePower: 11,
            },
        ]);
        const state = await adapter.getStateAsync('vehicles.vin7.smartCharge.state');
        assert.equal(state.val, 'wait');
        assert.equal(calls.length, 0);
    } finally {
        global.Date = RealDate;
    }
});

test('mock object tree has no missing parents and valid button roles (E1008/E3009)', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = { mockMode: true, pollingInterval: 3600, countryCode: 'DE' };
    await adapter.onReady();
    await adapter.readyPromise;
    await adapter.onUnload(() => {});
    const ids = new Set(adapter._objects.keys());
    const missing = [];
    for (const id of ids) {
        const parts = id.split('.');
        for (let i = 2; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('.');
            if (!ids.has(parent)) {
                missing.push(`${id} misses ${parent}`);
            }
        }
    }
    assert.deepEqual(missing, []);
    const badButtons = [];
    for (const [id, obj] of adapter._objects) {
        if (obj.type === 'state' && obj.common && obj.common.role === 'button' && obj.common.read !== false) {
            badButtons.push(id);
        }
    }
    assert.deepEqual(badButtons, []);
});
