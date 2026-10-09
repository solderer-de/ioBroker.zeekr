const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createDeviceBaseId, ZeekrAdapter, suggestRegionForCountry, getErrorHint } = require('../lib/adapter');
const {
    collectSecretBackup,
    parseSecretBackup,
    computeSecretsPresence,
    resolveInstanceDataDir,
    SECRET_BACKUP_TYPE,
} = require('../lib/adapter');

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

test('bridge normalization reads EU overseas nested fields', () => {
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
    {'vehicleName': 'Vehicle', 'vin': 'L6TZC2S57TN148853'},
    {'basicVehicleStatus': {'position': {'latitude': '51.3429106', 'longitude': '12.3867253'}, 'speed': 0, 'engineStatus': 'engine-off'},
     'additionalVehicleStatus': {'electricVehicleStatus': {'chargeLevel': '97.0', 'distanceToEmptyOnBatteryOnly': '648', 'isCharging': False}}},
    {},
    {}
)
print(json.dumps(payload))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );

    assert.equal(result.status, 0, result.stderr.toString());
    const payload = JSON.parse(result.stdout.toString());
    assert.equal(payload.batteryLevel, 97);
    assert.equal(payload.rangeKm, 648);
    assert.equal(payload.latitude, 51.3429106);
    assert.equal(payload.longitude, 12.3867253);
    assert.equal(payload.engineStatus, 'engine-off');
    assert.ok(!('raw' in payload), 'no duplicated raw container');
});

test('bridge normalization reads odometer, tyre kPa and cabin temp', () => {
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
    {'vehicleName': 'Vehicle', 'vin': 'L6TZC2S57TN148853'},
    {'additionalVehicleStatus': {
        'maintenanceStatus': {'odometer': 32, 'tyreStatusDriver': 275, 'tyreStatusPassenger': 286, 'tyreStatusDriverRear': 282, 'tyreStatusPassengerRear': 282,
                              'mainBatteryStatus': {'voltage': 14.325}, 'distanceToService': 32000, 'daysToService': 701,
                              'repairModeActive': True},
        'climateStatus': {'interiorTemp': 15.3, 'exteriorTemp': 9.1}}},
    {},
    {}
)
print(json.dumps(payload))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );

    assert.equal(result.status, 0, result.stderr.toString());
    const payload = JSON.parse(result.stdout.toString());
    assert.equal(payload.odometerKm, 32);
    assert.equal(payload.tirePressureFl, 2.75);
    assert.equal(payload.tirePressureFr, 2.86);
    assert.equal(payload.tirePressureRl, 2.82);
    assert.equal(payload.tirePressureRr, 2.82);
    assert.equal(payload.temperature, 15.3);
    assert.equal(payload.battery12v, 14.325);
    assert.equal(payload.distanceToService, 32000);
    assert.equal(payload.daysToService, 701);
    assert.equal(payload.repairModeActive, true);
});

test('bridge normalizes comfort active flags', () => {
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
    {'vin': 'V1'},
    {'additionalVehicleStatus': {
        'maintenanceStatus': {},
        'climateStatus': {'drvHeatSts': 0, 'steerWhlHeatingSts': '2', 'defrost': '0', 'ventilateStatus': ''}}},
    {},
    {}
)
print(json.dumps(payload))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );

    assert.equal(result.status, 0, result.stderr.toString());
    const payload = JSON.parse(result.stdout.toString());
    assert.equal(payload.seatHeatingActive, false);
    assert.equal(payload.defrostActive, false);
    assert.equal(payload.ventActive, false);
    assert.equal(payload.batteryPreheatActive, false);
    assert.ok(!('steeringHeatingActive' in payload), 'no unreliable steering flag');
});

test('bridge maps nested preClimateActive to climateOn', () => {
    const run = status => {
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
payload = module.normalize_vehicle({'vin': 'V1'}, ${status}, {}, {})
print(json.dumps(payload))
`,
            ],
            { cwd: path.join(__dirname, '..') },
        );
        assert.equal(result.status, 0, result.stderr.toString());
        return JSON.parse(result.stdout.toString());
    };

    const on = run(`{'additionalVehicleStatus': {'climateStatus': {'preClimateActive': True}}}`);
    assert.equal(on.climateOn, true);
    const off = run(`{'additionalVehicleStatus': {'climateStatus': {'preClimateActive': False}}}`);
    assert.equal(off.climateOn, false);
    const missing = run(`{'additionalVehicleStatus': {'climateStatus': {}}}`);
    assert.equal(missing.climateOn, false);
});

test('bridge derives door/window booleans from safety fields', () => {
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
    {'vehicleName': 'Vehicle', 'vin': 'V1'},
    {'additionalVehicleStatus': {
        'drivingSafetyStatus': {'doorOpenStatusDriver': 0, 'doorOpenStatusPassenger': '1', 'doorOpenStatusDriverRear': 0, 'doorOpenStatusPassengerRear': 0,
                                'doorLockStatusDriver': 1, 'doorLockStatusPassenger': 1, 'doorLockStatusDriverRear': 1, 'doorLockStatusPassengerRear': 1,
                                'trunkOpenStatus': 0, 'trunkLockStatus': 1, 'engineHoodOpenStatus': 0},
        'climateStatus': {'winPosDriver': 0, 'winPosPassenger': 10, 'winPosDriverRear': 0, 'winPosPassengerRear': 0}}},
    {},
    {}
)
print(json.dumps(payload))
`,
        ],
        { cwd: path.join(__dirname, '..') },
    );

    assert.equal(result.status, 0, result.stderr.toString());
    const payload = JSON.parse(result.stdout.toString());
    assert.equal(payload.doorsOpen, true);
    assert.equal(payload.doorsLocked, true);
    assert.equal(payload.trunkOpen, false);
    assert.equal(payload.trunkLocked, true);
    assert.equal(payload.hoodOpen, false);
    assert.equal(payload.windowsOpen, true);
    assert.equal(payload.doorOpen.doorOpenStatusPassenger, true);
    assert.equal(payload.doorOpen.trunkOpenStatus, false);
    assert.equal(payload.isLocked, true);
});

test('bridge isLocked prefers explicit flag, falls back to locks then central', () => {
    const run = status => {
        const result = spawnSync(
            PYTHON,
            [
                '-c',
                `import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('bridge', pathlib.Path('lib/bridge.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.normalize_vehicle({'vin': 'V1'}, ${status}, {}, {})))`,
            ],
            { cwd: path.join(__dirname, '..') },
        );
        assert.equal(result.status, 0, result.stderr.toString());
        return JSON.parse(result.stdout.toString());
    };
    // Explicit flag wins over open doors.
    assert.equal(
        run(`{"isLocked": False, "additionalVehicleStatus": {"drivingSafetyStatus": {"doorLockStatusDriver": 1}}}`)
            .isLocked,
        false,
    );
    // Central locking alone locks.
    assert.equal(
        run(`{"additionalVehicleStatus": {"drivingSafetyStatus": {"centralLockingStatus": "1"}}}`).isLocked,
        true,
    );
    // Nothing known stays unlocked, never crashes.
    assert.equal(run(`{}`).isLocked, false);
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
    assert.match(getErrorHint('0001 Invalid access key'), /region/i);
    assert.match(getErrorHint('079025 Signature authentication failed'), /prod_secret/);
    assert.match(getErrorHint('Decrypt X-VIN failed'), /VIN/);
    assert.match(getErrorHint('079021 session'), /second.*account/i);
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

test('experimental commands exist for new openzeekr actions', () => {
    const { EXPERIMENTAL_COMMANDS } = require('../lib/adapter');
    assert.deepEqual(EXPERIMENTAL_COMMANDS.trunkUnlock, {
        command: 'stop',
        serviceId: 'RDU',
        setting: { serviceParameters: [{ key: 'target', value: 'trunk' }] },
    });
    assert.deepEqual(EXPERIMENTAL_COMMANDS.sentryOn, {
        command: 'start',
        serviceId: 'RSM',
        setting: { serviceParameters: [{ key: 'rsm', value: '6' }] },
    });
    for (const key of [
        'trunkUnlock',
        'trunkLock',
        'frunk',
        'chargeLidOpen',
        'defrostOn',
        'defrostOff',
        'sunroofOpen',
        'sunroofClose',
        'sentryOn',
        'sentryOff',
        'engineStart',
        'engineStop',
        'wake',
    ]) {
        assert.ok(EXPERIMENTAL_COMMANDS[key], key);
    }
});

test('experimental button triggers bridge with preset', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
    let bridged = null;
    adapter.runBridge = async (action, payload) => {
        bridged = { action, payload };
        return { ok: true };
    };
    await adapter.onMessage({
        command: 'stateChange',
        message: { id: 'vehicles.my_car.control.sentryOn', value: true },
        from: 'test',
        callback: () => {},
    });
    assert.equal(bridged.payload.serviceId, 'RSM');
    assert.equal(bridged.payload.command, 'start');
});

test('onStateChange triggers typed command on direct write', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
    let bridged = null;
    adapter.runBridge = async (action, payload) => {
        bridged = { action, payload };
        return { ok: true };
    };
    await adapter.onStateChange('zeekr.0.vehicles.my_car.control.lock', { val: true, ack: false });
    assert.ok(bridged, 'bridge was called');
    assert.equal(bridged.payload.serviceId, 'RDL');
});

test('onStateChange ignores ack confirmations', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    let bridged = 0;
    adapter.runBridge = async () => {
        bridged += 1;
        return { ok: true };
    };
    await adapter.onStateChange('zeekr.0.vehicles.my_car.control.lock', { val: true, ack: true });
    await adapter.onStateChange('zeekr.0.vehicles.my_car.control.lock', null);
    await adapter.onStateChange('zeekr.0.info.connection', { val: false, ack: false });
    assert.equal(bridged, 0);
});

test('experimental presets match verified openzeekr values', () => {
    const { EXPERIMENTAL_COMMANDS } = require('../lib/adapter');
    assert.deepEqual(EXPERIMENTAL_COMMANDS.sentryOn, {
        command: 'start',
        serviceId: 'RSM',
        setting: { serviceParameters: [{ key: 'rsm', value: '6' }] },
    });
    assert.deepEqual(EXPERIMENTAL_COMMANDS.trunkLock, {
        command: 'start',
        serviceId: 'RDL_2',
        setting: { serviceParameters: [{ key: 'target', value: 'trunk' }] },
    });
    assert.deepEqual(EXPERIMENTAL_COMMANDS.frunk, {
        command: 'start',
        serviceId: 'RDU',
        setting: { serviceParameters: [{ key: 'target', value: 'hood' }] },
    });
    assert.deepEqual(EXPERIMENTAL_COMMANDS.engineStart, {
        command: 'start',
        serviceId: 'RES',
        setting: { serviceParameters: [{ key: 'engStrtType', value: '1' }] },
    });
    for (const key of [
        'trunkOpen',
        'chargeLidClose',
        'batteryPreheatOn',
        'batteryPreheatOff',
        'seatHeatOn',
        'seatHeatOff',
        'steeringHeatOn',
        'steeringHeatOff',
        'fridgeOn',
        'fridgeOff',
        'cabinVentOn',
        'cabinVentOff',
    ]) {
        assert.ok(EXPERIMENTAL_COMMANDS[key], key);
    }
});

test('chargeCurrent write sends RCS current command', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.setStateAsync('vehicles.my_car.vin', 'VIN123', true);
    let bridged = null;
    adapter.runBridge = async (action, payload) => {
        bridged = { action, payload };
        return { ok: true };
    };
    await adapter.onStateChange('zeekr.0.vehicles.my_car.control.chargeCurrent', { val: 20, ack: false });
    assert.equal(bridged.payload.serviceId, 'RCS');
    assert.deepEqual(bridged.payload.setting.serviceParameters[0], { key: 'rcs.ac.current', value: '20' });
});

test('browser upload reassembles chunks into adapter storage', async () => {
    const fs = require('node:fs');
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const payload = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(300000, 0x41), Buffer.alloc(100000, 0x42)]);
    const b64 = payload.toString('base64');
    const mid = Math.ceil(b64.length / 2);
    const upId = 'test-upload-reassemble';
    await adapter.abortUpload(upId);
    const r1 = await adapter.storeUploadedChunk({
        uploadId: upId,
        filename: 'base.apk',
        chunkIndex: 0,
        chunkTotal: 2,
        data: b64.slice(0, mid),
    });
    assert.equal(r1.complete, false);
    const r2 = await adapter.storeUploadedChunk({
        uploadId: upId,
        filename: 'base.apk',
        chunkIndex: 1,
        chunkTotal: 2,
        data: b64.slice(mid),
    });
    assert.equal(r2.complete, true);
    const stored = await adapter.resolveStoredFile('base.apk');
    assert.ok(stored);
    const storedBytes = fs.readFileSync(stored);
    assert.equal(storedBytes.length, payload.length);
    assert.ok(storedBytes.equals(payload));
    const state = await adapter.getStateAsync('info.apkUpload');
    assert.match(state.val, /base\.apk uploaded/);
    await fs.promises.unlink(stored);
});

test('browser upload rejects bad filenames, order and magic', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await assert.rejects(
        adapter.storeUploadedChunk({
            uploadId: 'x1',
            filename: 'evil.exe',
            chunkIndex: 0,
            chunkTotal: 1,
            data: 'eA==',
        }),
        /not allowed/,
    );
    await assert.rejects(
        adapter.storeUploadedChunk({
            uploadId: 'x2',
            filename: 'arm64.apk',
            chunkIndex: 1,
            chunkTotal: 2,
            data: 'eA==',
        }),
        /must start with chunk 0/,
    );
    await assert.rejects(
        adapter.storeUploadedChunk({
            uploadId: 'x3',
            filename: 'arm64.apk',
            chunkIndex: 0,
            chunkTotal: 1,
            data: Buffer.from('not a zip').toString('base64'),
        }),
        /not a valid APK/,
    );
});

test('auto extraction falls back to uploaded files', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        autoExtractSecrets: true,
        hmacAccessKey: '',
        hmacSecretKey: '',
        passwordPublicKey: '',
        prodSecret: '',
        vinKey: '',
        vinIv: '',
        apkBasePath: '',
        apkArm64Path: '',
        apkLegacyPath: '',
        secretsJsonPath: '',
        runtimeSecretsJsonPath: '',
        extractRegion: 'EU',
    };
    const dir = await adapter.getApkStorageDir();
    const header = Buffer.from('PK\x03\x04');
    await fs.promises.writeFile(path.join(dir, 'base.apk'), Buffer.concat([header, Buffer.from('b')]));
    await fs.promises.writeFile(path.join(dir, 'arm64.apk'), Buffer.concat([header, Buffer.from('a')]));
    let seen = null;
    adapter.runPythonScript = async (_script, _args, payload) => {
        seen = payload;
        return { ok: true, secrets: { hmacAccessKey: 'k' } };
    };
    const ok = await adapter.maybeAutoExtractSecrets();
    assert.equal(ok, true);
    assert.ok(seen.apkBasePath.endsWith(path.join('apks', 'base.apk')));
    assert.ok(seen.apkArm64Path.endsWith(path.join('apks', 'arm64.apk')));
    await fs.promises.unlink(path.join(dir, 'base.apk'));
    await fs.promises.unlink(path.join(dir, 'arm64.apk'));
});

test('uploadApkChunk message forwards result via sendTo', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    let sent = null;
    adapter.sendTo = (from, command, message, callback) => {
        sent = message;
        if (callback) {
            callback(message);
        }
    };
    const data = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('z')]).toString('base64');
    await adapter.onMessage({
        command: 'uploadApkChunk',
        message: { uploadId: 'test-msg-upload', filename: 'legacy.apk', chunkIndex: 0, chunkTotal: 1, data },
        from: 'test',
        callback: () => {},
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.complete, true);
    const stored = await adapter.resolveStoredFile('legacy.apk');
    await require('node:fs').promises.unlink(stored);
});

test('completed upload persists path into instance config', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {};
    const written = {};
    adapter.getForeignObjectAsync = async () => ({ native: { username: 'u' } });
    adapter.extendForeignObjectAsync = async (_id, obj) => {
        Object.assign(written, obj.native);
        return true;
    };
    const data = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('q')]).toString('base64');
    const res = await adapter.storeUploadedChunk({
        uploadId: 'test-persist-path',
        filename: 'arm64.apk',
        chunkIndex: 0,
        chunkTotal: 1,
        data,
    });
    assert.equal(res.complete, true);
    assert.match(written.apkArm64Path || '', /arm64\.apk$/);
    assert.match(adapter.config.apkArm64Path || '', /arm64\.apk$/);
    const stored = await adapter.resolveStoredFile('arm64.apk');
    await require('node:fs').promises.unlink(stored);
});

test('runExtraction message triggers secret extraction', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const secretsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zeekr-secrets-')), 'zeekr_secrets.json');
    fs.writeFileSync(secretsFile, JSON.stringify({ hmac_access_key: 'k', hmac_secret_key: 's' }));
    adapter.config = {
        autoExtractSecrets: true,
        hmacAccessKey: '',
        hmacSecretKey: '',
        passwordPublicKey: 'p',
        prodSecret: 'p',
        vinKey: 'v',
        vinIv: 'i',
        apkBasePath: '',
        apkArm64Path: '',
        apkLegacyPath: '',
        secretsJsonPath: secretsFile,
        runtimeSecretsJsonPath: '',
        extractRegion: 'EU',
    };
    let sent = null;
    adapter.sendTo = (from, command, message, callback) => {
        sent = message;
        if (callback) {
            callback(message);
        }
    };
    await adapter.onMessage({ command: 'runExtraction', message: {}, from: 'test', callback: () => {} });
    assert.equal(sent.ok, true);
    assert.deepEqual(sent.missing, []);
    fs.rmSync(path.dirname(secretsFile), { recursive: true, force: true });
});

test('extract_secrets user strings are English-only', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'extract_secrets.py'), 'utf8');
    const warnings = [...src.matchAll(/warnings\.append\((['"])((?:\\\1|(?!\1).)*)\1\)/g)].map(m => m[2]);
    assert.ok(warnings.length > 0, 'expected warning literals');
    for (const text of warnings) {
        assert.ok(!/[äöüÄÖÜß]/.test(text), `German text in warning: ${text.slice(0, 60)}`);
    }
});

test('old APK pair paths are passed to the extractor', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeekr-oldapk-'));
    const baseApk = path.join(tmp, 'base.apk');
    const arm64Apk = path.join(tmp, 'arm64.apk');
    fs.writeFileSync(baseApk, 'fake');
    fs.writeFileSync(arm64Apk, 'fake');
    adapter.config = {
        autoExtractSecrets: true,
        hmacAccessKey: '',
        hmacSecretKey: '',
        passwordPublicKey: 'p',
        prodSecret: 'p',
        vinKey: '',
        vinIv: '',
        apkBasePath: baseApk,
        apkArm64Path: arm64Apk,
        apkLegacyPath: '',
        apkOldBasePath: '/tmp/old-base.apk',
        apkOldArm64Path: '/tmp/old-arm64.apk',
        secretsJsonPath: '',
        runtimeSecretsJsonPath: '',
        extractRegion: 'EU',
    };
    let seen = null;
    adapter.runPythonScript = async (_script, _args, payload) => {
        seen = payload;
        return { ok: true, secrets: {}, warnings: [] };
    };
    await adapter.maybeAutoExtractSecrets();
    assert.equal(seen.apkOldBasePath, '/tmp/old-base.apk');
    assert.equal(seen.apkOldArm64Path, '/tmp/old-arm64.apk');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('extract_secrets merge fills only missing keys', () => {
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location('extract_secrets', pathlib.Path('lib/extract_secrets.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
base = {'hmacAccessKey': 'new-hmac', 'hmacSecretKey': '', 'passwordPublicKey': 'rsa', 'prodSecret': '', 'vinKey': '', 'vinIv': ''}
old = {'hmacAccessKey': 'old-hmac', 'hmacSecretKey': 'old-secret', 'prodSecret': 'old-prod', 'vinKey': 'old-key', 'vinIv': 'old-iv'}
missing = m._missing_secret_keys(base)
assert missing == ['hmacSecretKey', 'prodSecret', 'vinKey', 'vinIv'], missing
merged = m._merge_secrets(base, old, only_keys=missing)
assert merged['hmacAccessKey'] == 'new-hmac'
assert merged['hmacSecretKey'] == 'old-secret'
assert merged['prodSecret'] == 'old-prod'
assert m._missing_secret_keys(merged) == []
print('merge-ok')
`,
        ],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /merge-ok/);
});

test('missing HMAC hint mentions mandatory signing and older APK', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        username: 'u',
        password: 'p',
        hmacAccessKey: '',
        hmacSecretKey: '',
        passwordPublicKey: 'p',
        prodSecret: 'p',
        vinKey: 'v',
        vinIv: 'i',
    };
    await adapter.pollVehicles();
    const state = await adapter.getStateAsync('info.lastError');
    assert.match(state.val, /HMAC keys are mandatory/);
    assert.match(state.val, /older APK pair/);
});

test('extract_secrets inspects APK version, package and libenv', () => {
    const result = spawnSync(
        PYTHON,
        [
            '-c',
            `
import importlib.util, io, json, pathlib, struct, zipfile
spec = importlib.util.spec_from_file_location('extract_secrets', pathlib.Path('lib/extract_secrets.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def utf16(s):
    return struct.pack('<H', len(s)) + s.encode('utf-16-le')

def build_manifest(package, version):
    strings = [package, version, 'manifest', 'package', 'versionName']
    pool_data = b''.join(utf16(s) for s in strings)
    offsets = []
    off = 0
    for s in strings:
        offsets.append(off)
        off += 2 + len(s.encode('utf-16-le'))
    n = len(strings)
    pool = struct.pack('<HHI', 0x0001, 28 + 4 * n, 28 + 4 * n + len(pool_data))
    pool += struct.pack('<IIIII', n, 0, 0, 28 + 4 * n, 0)
    pool += struct.pack(f'<{n}I', *offsets) + pool_data
    # root <manifest> start element with package + versionName attributes
    attrs = b''
    for name_i, val in ((3, 0), (4, 1)):
        attrs += struct.pack('<iiihBBi', -1, name_i, -1, 8, 0, 0x03, val)
    elem = struct.pack('<HHI', 0x0102, 28, 28 + len(attrs))
    elem += struct.pack('<iiHHHHHH', -1, 2, 20, 20, 2, 0xFFFF, 0xFFFF, 0xFFFF) + attrs
    header = struct.pack('<HHI', 0x0003, 8, 8 + len(pool) + len(elem))
    return header + pool + elem

pkg, ver = m._read_axml_info(build_manifest('com.zeekr.overseas', '3.1.0'))
assert (pkg, ver) == ('com.zeekr.overseas', '3.1.0'), (pkg, ver)
assert m._read_axml_info(b'garbage') == ('', '')
assert m._version_at_least('3.1.0', 3, 1) is True
assert m._version_at_least('3.0.9', 3, 1) is False
assert m._version_at_least('', 3, 1) is False
assert m._version_at_least('2.9.9', 3, 1) is False

import tempfile, os
tmp = tempfile.mkdtemp()
base = os.path.join(tmp, 'base.apk')
arm64 = os.path.join(tmp, 'arm64.apk')
with zipfile.ZipFile(base, 'w') as z:
    z.writestr('AndroidManifest.xml', build_manifest('com.zeekr.global', '1.5.5'))
with zipfile.ZipFile(arm64, 'w') as z:
    z.writestr('lib/arm64-v8a/libenv.so', b'x')
info = m._inspect_apk(pathlib.Path(base), pathlib.Path(arm64))
assert info == {'package': 'com.zeekr.global', 'version': '1.5.5', 'hasLibenv': True}, info
with zipfile.ZipFile(arm64, 'w') as z:
    z.writestr('lib/xxhdpi/nothing.so', b'x')
info = m._inspect_apk(pathlib.Path(base), pathlib.Path(arm64))
assert info['hasLibenv'] is False, info
print('inspect-ok')
`,
        ],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /inspect-ok/);
});

test('extracted secrets are persisted into instance config', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {
        autoExtractSecrets: true,
        hmacAccessKey: '',
        hmacSecretKey: '',
        passwordPublicKey: '',
        prodSecret: 'manual-prod',
        vinKey: '',
        vinIv: '',
        apkBasePath: '',
        apkArm64Path: '',
        apkLegacyPath: '',
        secretsJsonPath: '',
        runtimeSecretsJsonPath: '',
        extractRegion: 'EU',
    };
    let stored = null;
    adapter.getForeignObjectAsync = async () => ({ native: { username: 'u', prodSecret: 'manual-prod' } });
    adapter.extendForeignObjectAsync = async (_id, obj) => {
        stored = obj.native;
        return true;
    };
    adapter.runPythonScript = async () => ({
        ok: true,
        secrets: { hmacAccessKey: 'k', hmacSecretKey: '' },
        warnings: [],
    });
    const ok = await adapter.maybeAutoExtractSecrets();
    assert.equal(ok, true);
    assert.equal(stored.hmacAccessKey, 'k');
    assert.equal(stored.username, 'u');
    assert.equal(stored.prodSecret, 'manual-prod');
    assert.equal(adapter.config.hmacAccessKey, 'k');
});

test('persist uses callback-style object API as fallback', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {};
    let stored = null;
    const seen = [];
    adapter.getForeignObject = (id, callback) => {
        seen.push(id);
        callback(null, { native: { username: 'u' } });
    };
    adapter.extendForeignObject = (id, obj, callback) => {
        seen.push(id);
        stored = obj.native;
        callback(null);
    };
    await adapter.persistSecretsToConfig({ hmacAccessKey: 'k', hmacSecretKey: '' });
    assert.deepEqual(seen, ['system.adapter.zeekr.0', 'system.adapter.zeekr.0', 'system.adapter.zeekr.0']);
    assert.equal(stored.hmacAccessKey, 'k');
    assert.equal(stored.username, 'u');
    assert.equal(adapter.config.hmacAccessKey, 'k');
});
test('empty chargingState never writes objects as state values', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = { mockMode: true, countryCode: 'DE' };
    const chargingStatus = {
        chargerState: 'idle',
        chargeVoltage: 0,
        chargeCurrent: 0,
        chargeSpeed: 0,
        chargePower: 0,
        dcChargePowerLimitSts: 0,
        updateTime: '2026-10-07',
    };
    adapter.runBridge = async () => ({
        vehicles: [
            {
                name: 'Car',
                vin: 'VIN1',
                chargingState: '',
                chargingStatus,
                status: {},
                remoteControlState: {},
            },
        ],
    });
    await adapter.pollVehicles();
    const state = await adapter.getStateAsync('vehicles.vin1.status.chargingState');
    assert.equal(state.val, '');
    const raw = await adapter.getStateAsync('vehicles.vin1.status.chargingStatusRaw');
    assert.equal(typeof raw.val, 'string');
});

test('collectSecretBackup gathers secrets and identity without values leaking elsewhere', () => {
    const backup = collectSecretBackup({
        username: 'user@example.com',
        password: 's3cret',
        hmacAccessKey: 'ak',
        hmacSecretKey: '',
        countryCode: 'DE',
        pollingInterval: 300,
    });
    assert.equal(backup.type, SECRET_BACKUP_TYPE);
    assert.deepEqual(backup.secrets, { password: 's3cret', hmacAccessKey: 'ak' });
    assert.deepEqual(backup.identity, { username: 'user@example.com', countryCode: 'DE' });
});

test('parseSecretBackup validates type and drops unknown keys', () => {
    const { secrets, identity } = parseSecretBackup({
        type: SECRET_BACKUP_TYPE,
        version: 1,
        secrets: { password: 's3cret', evil: 'x', hmacAccessKey: '' },
        identity: { username: 'user@example.com', other: 'y' },
    });
    assert.deepEqual(secrets, { password: 's3cret' });
    assert.deepEqual(identity, { username: 'user@example.com' });
    assert.throws(() => parseSecretBackup({ type: 'nope', secrets: {} }), /Not an iobroker.zeekr secrets backup/);
    assert.throws(() => parseSecretBackup({ type: SECRET_BACKUP_TYPE, secrets: {} }), /no secrets/);
    assert.throws(() => parseSecretBackup('junk'), /not a JSON object/);
});

test('computeSecretsPresence reports groups without values', () => {
    assert.deepEqual(computeSecretsPresence({}), {
        password: false,
        hmac: false,
        prodSecret: false,
        passwordPublicKey: false,
        vinKeys: false,
    });
    const presence = computeSecretsPresence({
        password: 's3cret',
        hmacAccessKey: 'ak',
        hmacSecretKey: 'sk',
        prodSecretCandidates: 'a,b',
        vinKey: 'k',
        vinIv: '',
    });
    assert.deepEqual(presence, {
        password: true,
        hmac: true,
        prodSecret: true,
        passwordPublicKey: false,
        vinKeys: false,
    });
});

test('resolveInstanceDataDir prefers the real instance dir, rejects junk', () => {
    const path = require('node:path');
    const fakeLoader = () => ({
        getAbsoluteInstanceDataDir: namespace => path.join('/data', namespace),
    });
    const dir = resolveInstanceDataDir('zeekr.0', fakeLoader);
    assert.ok(dir && path.isAbsolute(dir), `expected absolute dir, got ${dir}`);
    assert.ok(dir.endsWith('zeekr.0'), `expected namespace suffix, got ${dir}`);
    assert.equal(resolveInstanceDataDir(), null);
    assert.equal(resolveInstanceDataDir(''), null);
    assert.equal(resolveInstanceDataDir(123), null);
    assert.equal(
        resolveInstanceDataDir('zeekr.0', () => {
            throw new Error('no core');
        }),
        null,
    );
});

test('applyBackupData restores secrets into config and presence states', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = { username: '', password: '', countryCode: 'AU' };
    let written = null;
    adapter.getForeignObjectAsync = async () => ({ native: { username: '', password: '' } });
    adapter.extendForeignObjectAsync = async (id, obj) => {
        written = obj.native;
    };
    const count = await adapter.applyBackupData(
        parseSecretBackup({
            type: SECRET_BACKUP_TYPE,
            version: 1,
            secrets: { password: 's3cret', hmacAccessKey: 'ak', hmacSecretKey: 'sk' },
            identity: { username: 'user@example.com', countryCode: 'DE' },
        }),
    );
    assert.equal(count, 3);
    assert.equal(adapter.config.password, 's3cret');
    assert.equal(adapter.config.countryCode, 'DE');
    assert.equal(written.hmacAccessKey, 'ak');
    const hmac = await adapter.getStateAsync('info.secretsPresent.hmac');
    assert.equal(hmac.val, true);
    const vin = await adapter.getStateAsync('info.secretsPresent.vinKeys');
    assert.equal(vin.val, false);
});

test('saveBackupFileQuiet and restoreMissingSecretsFromBackup roundtrip gaps', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const target = require('node:path').join(
        fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'zeekr-backup-')),
        'secrets-backup.json',
    );
    const makeAdapter = config => {
        const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
        adapter.config = { ...config, secretsBackupPath: target };
        adapter.getForeignObjectAsync = async () => ({ native: {} });
        adapter.extendForeignObjectAsync = async () => {};
        return adapter;
    };
    const full = makeAdapter({
        username: 'user@example.com',
        password: 's3cret',
        countryCode: 'DE',
        hmacAccessKey: 'ak',
        hmacSecretKey: 'sk',
        prodSecret: 'ps',
    });
    assert.equal(await full.saveBackupFileQuiet(), 4);
    assert.ok(fs.existsSync(target));
    const wiped = makeAdapter({ username: '', password: '', countryCode: 'AU' });
    assert.equal(await wiped.restoreMissingSecretsFromBackup(), 5);
    assert.equal(wiped.config.password, 's3cret');
    assert.equal(wiped.config.hmacAccessKey, 'ak');
    assert.equal(wiped.config.countryCode, 'AU');
    // Nothing missing anymore — second run restores nothing.
    assert.equal(await wiped.restoreMissingSecretsFromBackup(), 0);
    // Empty config + no file → 0, no crash.
    fs.rmSync(target);
    const empty = makeAdapter({});
    assert.equal(await empty.saveBackupFileQuiet(), 0);
    assert.equal(await empty.restoreMissingSecretsFromBackup(), 0);
});

test('toggle switches translate into momentary commands and mirror status', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = { username: 'u', password: 'p', countryCode: 'DE' };
    await adapter.setStateChangedAsync('vehicles.car1.vin', 'VIN1', true);
    const calls = [];
    adapter.runBridge = async (action, payload) => {
        calls.push({ action, ...payload });
        return { ok: true };
    };
    await adapter.handleControlWrite('zeekr.0.vehicles.car1.control.climateToggle', true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'start');
    assert.equal(calls[0].serviceId, 'ZAF');
    await adapter.handleControlWrite('zeekr.0.vehicles.car1.control.lockToggle', false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, 'stop');
    await adapter.handleControlWrite('zeekr.0.vehicles.car1.control.seatHeatToggle', true);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].serviceId, 'ZAF');
    await adapter.handleControlWrite('zeekr.0.vehicles.car1.control.sentryToggle', true);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].serviceId, 'RSM');
    // Mirror: poll writes toggle states from live status.
    adapter.runBridge = async () => ({
        vehicles: [{ name: 'Car', vin: 'VIN1', climateOn: true, isLocked: false, isCharging: false }],
    });
    adapter.config.mockMode = true;
    await adapter.pollVehicles();
    assert.equal((await adapter.getStateAsync('vehicles.vin1.control.climateToggle')).val, true);
    assert.equal((await adapter.getStateAsync('vehicles.vin1.control.lockToggle')).val, false);
});

test('audit: every payload leaf lands in datapoints with correct value and type', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = { mockMode: true, countryCode: 'DE' };
    const vehicle = {
        name: 'Audit Car',
        vin: 'AUDITVIN123456789',
        batteryLevel: 97,
        rangeKm: 648,
        odometerKm: 32,
        chargePower: 0,
        currentSpeed: 0,
        pluggedIn: false,
        isCharging: false,
        temperature: 15.3,
        chargingState: { chargerState: '0', nested: { deep: 'x' } },
        lockState: '',
        isLocked: true,
        climateOn: false,
        lastUpdated: '2026-10-08',
        chargingLimit: 84,
        tirePressureFl: 2.75,
        latitude: 51.3429106,
        longitude: 12.3867253,
        battery12v: null,
        chargePlan: { vin: 'AUDITVIN123456789', timerId: '2', command: 'stop' },
        travelPlan: { timerId: '4', scheduleList: [] },
        lastTripDistanceKm: null,
        centralLockingStatus: '1',
        windowPositionAvg: 0,
        doorOpen: { doorOpenStatusDriver: false, trunkOpenStatus: false },
        avgPowerConsumption: 19.2,
        traveledDistanceKm: null,
        engineStatus: 'engine-off',
        maintenanceStatus: '',
        maintenanceRaw: {},
        tripCount: 0,
        tripList: [{ distance: 12 }],
        status: {
            basicVehicleStatus: { speed: 0 },
            additionalVehicleStatus: {
                electricVehicleStatus: { chargeLevel: '97.0', dcChargeIAct: '-1638.0' },
                climateStatus: { interiorTemp: 15.3, winPosDriver: 0 },
            },
        },
        chargingStatus: { chargeCurrent: 0 },
        remoteControlState: { privacyMode: '0', campingModeState: '1' },
        vtmStatus: {},
        chargingLimitRaw: { soc: 84 },
        chargePlanRaw: {},
        travelPlanRaw: {},
        journeySummary: {},
    };
    adapter.runBridge = async () => ({ vehicles: [vehicle] });
    await adapter.pollVehicles();
    const base = 'vehicles.auditvin123456789';
    const get = async id => (await adapter.getStateAsync(id))?.val;
    // Curated layer carries the mapped values.
    assert.equal(await get(`${base}.status.batteryLevel`), 97);
    assert.equal(await get(`${base}.status.rangeKm`), 648);
    assert.equal(await get(`${base}.status.odometerKm`), 32);
    assert.equal(await get(`${base}.status.tirePressureFl`), 2.75);
    assert.equal(await get(`${base}.status.temperature`), 15.3);
    assert.equal(await get(`${base}.status.latitude`), 51.3429106);
    // Raw layer mirrors every leaf 1:1.
    assert.equal(await get(`${base}.all.batteryLevel`), 97);
    assert.equal(await get(`${base}.all.status.additionalVehicleStatus.electricVehicleStatus.chargeLevel`), '97.0');
    assert.equal(await get(`${base}.all.status.additionalVehicleStatus.electricVehicleStatus.dcChargeIAct`), '-1638.0');
    assert.equal(await get(`${base}.all.status.additionalVehicleStatus.climateStatus.interiorTemp`), 15.3);
    assert.equal(await get(`${base}.all.chargePlan.timerId`), '2');
    assert.equal(await get(`${base}.all.remoteControlState.privacyMode`), '0');
    assert.equal(await get(`${base}.all.chargingLimitRaw.soc`), 84);
    assert.match(await get(`${base}.all.tripList`), /"distance":12/);
    // Invariant: no state ever holds a plain object as value.
    for (const [id, state] of adapter._states) {
        assert.ok(
            state.val === null || ['string', 'number', 'boolean'].includes(typeof state.val),
            `${id} holds forbidden value type ${typeof state.val}`,
        );
    }
});

test('syncAllVehicleStates exposes every leaf, objects become channels', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    await adapter.syncAllVehicleStates('vehicles.car1', {
        batteryLevel: 97,
        isCharging: false,
        name: 'Car',
        chargingState: { chargerState: '0', nested: { deep: 1 } },
        tripList: [{ distance: 12 }],
        missing: null,
    });
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.batteryLevel')).val, 97);
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.isCharging')).val, false);
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.name')).val, 'Car');
    // Objects must never become state values (state-DB crash class).
    assert.equal(await adapter.getStateAsync('vehicles.car1.all.chargingState'), null);
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.chargingState.chargerState')).val, '0');
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.chargingState.nested.deep')).val, 1);
    // Arrays become JSON strings, nulls stay visible.
    assert.match((await adapter.getStateAsync('vehicles.car1.all.tripList')).val, /"distance":12/);
    assert.equal((await adapter.getStateAsync('vehicles.car1.all.missing')).val, null);
});

test('writeSecretsToObject prefers updateConfig (encrypted server roundtrip)', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {};
    let captured = null;
    adapter.updateConfig = async cfg => {
        captured = cfg;
    };
    let extended = 0;
    adapter.extendForeignObjectAsync = async () => {
        extended += 1;
    };
    await adapter.writeSecretsToObject({ hmacAccessKey: 'ak', prodSecret: 'ps' }, 'stored');
    assert.deepEqual(captured, { hmacAccessKey: 'ak', prodSecret: 'ps' });
    assert.equal(extended, 0);
    assert.equal(adapter.config.hmacAccessKey, 'ak');
});

test('instance object access always uses absolute Foreign IDs (no shadow objects)', async () => {
    const adapter = new ZeekrAdapter({ log: { silly() {}, debug() {}, info() {}, warn() {}, error() {} } });
    adapter.config = {};
    const calls = [];
    // Both variants exist: only Foreign (absolute) may be used.
    adapter.getObjectAsync = async id => {
        calls.push(['relative-get', id]);
        return { native: {} };
    };
    adapter.extendObjectAsync = async id => {
        calls.push(['relative-extend', id]);
    };
    adapter.getForeignObjectAsync = async id => {
        calls.push(['foreign-get', id]);
        return { native: {} };
    };
    adapter.extendForeignObjectAsync = async id => {
        calls.push(['foreign-extend', id]);
    };
    await adapter.writeSecretsToObject({ hmacAccessKey: 'ak' }, 'stored');
    // get (read) + extend (write) + get (verify) — all absolute Foreign IDs.
    assert.deepEqual(calls, [
        ['foreign-get', 'system.adapter.zeekr.0'],
        ['foreign-extend', 'system.adapter.zeekr.0'],
        ['foreign-get', 'system.adapter.zeekr.0'],
    ]);
});
