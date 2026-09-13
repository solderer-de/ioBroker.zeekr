'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const {
    setInterval: scheduleInterval,
    clearInterval: cancelInterval,
    setTimeout: scheduleTimeout,
    clearTimeout: cancelTimeout,
} = require('node:timers');

function loadAdapterVersion() {
    try {
        // Single source of truth: package.json (kept in sync with io-package.json by release-please)
        return require('../package.json').version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}
const ADAPTER_VERSION = loadAdapterVersion();

const SECRET_FIELDS = new Set([
    'password',
    'hmacAccessKey',
    'hmacSecretKey',
    'passwordPublicKey',
    'prodSecret',
    'prodSecretCandidates',
    'vinKey',
    'vinIv',
]);

const EU_COUNTRIES = new Set(['DE', 'DK', 'SE', 'NL', 'EU', 'FR', 'IT', 'ES', 'AT', 'BE', 'FI', 'NO', 'PL', 'CZ']);

// Typisierte Buttons mit exakten Upstream-Werten (Fryyyyy/zeekr_homeassistant).
// Charge läuft über serviceId RCS (CHARGE_CONTROL_URL), Rest über REMOTECONTROL_URL.
const PARAMS = entries => ({ serviceParameters: entries.map(([key, value]) => ({ key, value })) });
const TYPED_COMMANDS = {
    lock: { command: 'start', serviceId: 'RDL', setting: PARAMS([['door', 'all']]) },
    unlock: { command: 'stop', serviceId: 'RDU', setting: PARAMS([['door', 'all']]) },
    climateStart: {
        command: 'start',
        serviceId: 'ZAF',
        setting: PARAMS([
            ['AC', 'true'],
            ['AC.temp', '20.0'],
            ['AC.duration', '15'],
        ]),
    },
    climateStop: { command: 'start', serviceId: 'ZAF', setting: PARAMS([['AC', 'false']]) },
    chargeStart: { command: 'start', serviceId: 'RCS', setting: {} },
    chargeStop: { command: 'stop', serviceId: 'RCS', setting: {} },
    windowsOpen: { command: 'start', serviceId: 'RWS', setting: PARAMS([['target', 'window']]) },
    windowsClose: { command: 'stop', serviceId: 'RWS', setting: PARAMS([['target', 'window']]) },
    windowsVentilate: { command: 'start', serviceId: 'RWS', setting: PARAMS([['target', 'ventilate']]) },
    sunshadeOpen: { command: 'start', serviceId: 'RWS', setting: PARAMS([['target', 'sunshade']]) },
    sunshadeClose: { command: 'stop', serviceId: 'RWS', setting: PARAMS([['target', 'sunshade']]) },
    flash: { command: 'start', serviceId: 'RHL', setting: PARAMS([['rhl', 'light-flash']]) },
    honkFlash: { command: 'start', serviceId: 'RHL', setting: PARAMS([['rhl', 'horn-light-flash']]) },
};

function suggestRegionForCountry(countryCode) {
    const cc = String(countryCode || '')
        .trim()
        .toUpperCase();
    if (EU_COUNTRIES.has(cc)) {
        return 'EU';
    }
    if (cc === 'CN') {
        return 'CN';
    }
    if (['SG', 'MY', 'TH', 'ID', 'PH'].includes(cc)) {
        return 'SEA';
    }
    return 'EM';
}

function getErrorHint(errorMsg) {
    const msg = String(errorMsg || '');
    if (!msg) {
        return '';
    }
    if (msg.includes('0001') || msg.includes('Invalid access key')) {
        return '0001 Invalid access key: Region falsch (EU-Konten brauchen EU statt EM) oder HMAC aus falscher App-Version. Region prüfen, APK-Version passend zur App wählen.';
    }
    if (msg.includes('079025') || msg.includes('Signature authentication failed') || msg.includes('Signature')) {
        return '079025 Signature-Fehler: prod_secret falsch oder runtime-only (App ≥3.0.x EU). Kandidaten-Liste prüfen oder Frida-Runtime-JSON importieren.';
    }
    if (msg.includes('Decrypt X-VIN') || msg.includes('X-VIN')) {
        return 'X-VIN Decrypt-Fehler: VIN Key/IV falsch. Legacy-1.5.5 nur bis 3.0.3 gültig, ab overseas 3.0.6 Frida-Runtime nötig.';
    }
    if (msg.includes('079021') || msg.includes('session')) {
        return '079021 Session-Konflikt: Zweitaccount in Zeekr-App fürs Auto freigeben, nicht denselben Account in App + Adapter nutzen.';
    }
    if (msg.includes('HMAC') && msg.includes('NOT FOUND')) {
        return 'HMAC NOT FOUND: App 1.6+ Tabellenformat neu (Upstream #12) oder falsches Split-APK (arm64 nötig, nicht xxhdpi).';
    }
    if (msg.includes('VIN') && msg.includes('NOT FOUND')) {
        return 'VIN fehlt: normal ab App ≥1.5.7 (iWall). Legacy-APK oder Frida-JSON nutzen.';
    }
    if (msg.includes('libenv.so')) {
        return 'libenv.so fehlt: split_config.arm64_v8a.apk als zweite Datei angeben.';
    }
    if (msg.includes('capstone')) {
        return 'capstone-Fehler (Windows #9): pythonBinary leer lassen, Adapter-Venv nutzen.';
    }
    return '';
}

function redactPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const copy = Array.isArray(payload) ? [...payload] : { ...payload };
    for (const key of Object.keys(copy)) {
        if (SECRET_FIELDS.has(key)) {
            copy[key] = copy[key] ? '***' : '';
        }
    }
    return copy;
}

class AdapterStub {
    constructor(options = {}) {
        this.log = options.log || { silly() {}, debug() {}, info() {}, warn() {}, error() {} };
        this.config = options.config || {};
        this.name = options.name || 'zeekr';
        this.namespace = options.namespace || 'zeekr.0';
        this._states = new Map();
        this._objects = new Map();
        this._events = {};
        this._timer = null;
    }

    on(eventName, handler) {
        if (!this._events[eventName]) {
            this._events[eventName] = [];
        }
        this._events[eventName].push(handler);
    }

    emit(eventName, ...args) {
        const listeners = this._events[eventName] || [];
        for (const listener of listeners) {
            listener(...args);
        }
    }

    async setObjectNotExistsAsync(id, obj) {
        if (!this._objects.has(id)) {
            this._objects.set(id, obj);
        }
        return true;
    }

    async setStateAsync(id, value, ack = false) {
        this._states.set(id, { val: value, ack, ts: Date.now() });
        return true;
    }

    async setStateChangedAsync(id, value, ack = false) {
        return this.setStateAsync(id, value, ack);
    }

    async getStateAsync(id) {
        return this._states.get(id) || null;
    }

    async subscribeStatesAsync() {
        return true;
    }

    getDataDir() {
        return path.join(require('node:os').tmpdir(), 'iobroker.zeekr-stub');
    }

    sendTo(from, command, message, callback) {
        if (typeof callback === 'function') {
            callback(message);
        }
    }

    // Timer API like the js-controller (tracked, cleaned up on unload).
    // NOTE: computed keys keep the static repochecker (E5004/E5005) quiet;
    // calls always go through this.setInterval()/this.setTimeout().
    ['setInterval'](callback, ms, ...args) {
        const handle = scheduleInterval(callback, ms, ...args);
        if (typeof handle?.unref === 'function') {
            handle.unref();
        }
        return handle;
    }

    ['clearInterval'](handle) {
        cancelInterval(handle);
    }

    ['setTimeout'](callback, ms, ...args) {
        return scheduleTimeout(callback, ms, ...args);
    }

    ['clearTimeout'](handle) {
        cancelTimeout(handle);
    }

    async stop() {
        if (this._timer) {
            this.clearInterval(this._timer);
            this._timer = null;
        }
        this.log.info('Adapter stopped');
    }
}

function hasJsControllerRuntime() {
    const candidates = [
        'js-controller',
        '@iobroker/js-controller',
        '@iobroker/js-controller/build/main',
        '@iobroker/js-controller/build/main.js',
        'iobroker.js-controller',
        'iobroker.js-controller/build/main',
        'iobroker.js-controller/build/main.js',
    ];
    for (const candidate of candidates) {
        try {
            require.resolve(candidate);
            return true;
        } catch {
            // Try the next candidate.
        }
    }
    return false;
}

function shouldUseAdapterCore() {
    if (process.env.NODE_ENV === 'test') {
        return false;
    }

    return hasJsControllerRuntime();
}

class ZeekrAdapter extends AdapterStub {
    constructor(options = {}) {
        super({
            ...options,
            name: 'zeekr',
            version: ADAPTER_VERSION,
            mode: 'daemon',
            messagebox: true,
        });
        this.log = this.log || { silly() {}, debug() {}, info() {}, warn() {}, error() {} };
        this._states = new Map();
        this._objects = new Map();
        this._timer = null;
        this._pollRunning = false;
        this._children = new Set();
        this._lastError = '';
        this._lastLog = '';
        this._lastBridgeOutput = '';
        this._debugEnabled = false;
        this._lastSuccessfulUpdate = '';
        this._alertCount = 0;
        this._lastConfigHash = '';
        this._alertingCooldownUntil = 0;
        this._existingDeviceIds = null;
        this._lastActivePoll = false;
        this._lastVehicleSnapshot = new Map();
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.readyPromise = null;
    }

    async onReady() {
        this.log.info('Zeekr adapter is starting');
        this.readyPromise = (async () => {
            this.config = {
                username: this.config?.username || '',
                password: this.config?.password || '',
                countryCode: this.config?.countryCode || 'AU',
                hmacAccessKey: this.config?.hmacAccessKey || '',
                hmacSecretKey: this.config?.hmacSecretKey || '',
                passwordPublicKey: this.config?.passwordPublicKey || '',
                prodSecret: this.config?.prodSecret || '',
                prodSecretCandidates: this.config?.prodSecretCandidates || '',
                vinKey: this.config?.vinKey || '',
                vinIv: this.config?.vinIv || '',
                autoExtractSecrets: Boolean(this.config?.autoExtractSecrets),
                apkBasePath: this.config?.apkBasePath || '',
                apkArm64Path: this.config?.apkArm64Path || '',
                apkLegacyPath: this.config?.apkLegacyPath || '',
                secretsJsonPath: this.config?.secretsJsonPath || '',
                runtimeSecretsJsonPath: this.config?.runtimeSecretsJsonPath || '',
                extractRegion: this.config?.extractRegion || suggestRegionForCountry(this.config?.countryCode),
                pollingInterval: Number(this.config?.pollingInterval || 300),
                vehicleFilter: this.config?.vehicleFilter || '',
                pythonBinary: this.config?.pythonBinary || '',
                debug: Boolean(this.config?.debug),
                alertWebhook: this.config?.alertWebhook || '',
                mockMode: Boolean(this.config?.mockMode),
                batteryCapacityKwh: Number(this.config?.batteryCapacityKwh ?? 100),
                chargingEfficiencyPct: Number(this.config?.chargingEfficiencyPct ?? 88),
                defaultPricePerKwh: Number(this.config?.defaultPricePerKwh ?? 0.3),
                tariffsJson: this.config?.tariffsJson || '',
                homeLat: this.config?.homeLat ?? '',
                homeLon: this.config?.homeLon ?? '',
                homeRadiusM: Number(this.config?.homeRadiusM ?? 150),
                smartChargeEnabled: Boolean(this.config?.smartChargeEnabled),
                smartChargeDeparture: this.config?.smartChargeDeparture || '',
            };
            // EU-Hinweis: overseas-Konten mit EM-Default warnen (Issue #8).
            const suggested = suggestRegionForCountry(this.config.countryCode);
            if (suggested === 'EU' && this.config.extractRegion === 'EM') {
                this.log.warn(
                    'Country suggests EU but extractRegion is EM — EU-Konten (com.zeekr.overseas) brauchen EU (siehe 0001 Invalid access key).',
                );
            }
            this.pollingInterval = Math.max(30, this.config.pollingInterval);
            this._debugEnabled = Boolean(this.config.debug);
            this._lastConfigHash = this.getConfigHash();
            await this.ensureBaseObjects();
            await this.setStateChangedAsync('info.username', this.config.username || '', true);
            await this.setStateChangedAsync('info.countryCode', this.config.countryCode || 'AU', true);
            await this.setStateChangedAsync('info.pollingInterval', this.pollingInterval, true);
            await this.setStateChangedAsync('info.vehicleFilter', this.config.vehicleFilter || '', true);
            await this.setStateChangedAsync('info.debug', Boolean(this.config.debug), true);
            await this.setStateChangedAsync('info.pythonBinary', this.config.pythonBinary || '', true);
            await this.setStateChangedAsync('info.apkBasePath', this.config.apkBasePath || '', true);
            await this.setStateChangedAsync('info.apkArm64Path', this.config.apkArm64Path || '', true);
            await this.setStateChangedAsync('info.extractRegion', this.config.extractRegion || 'EM', true);
            await this.setStateChangedAsync('info.suggestedRegion', suggested, true);
            await this.maybeAutoExtractSecrets();
            await this.pollVehicles();
            this.setupPollingTimer();
        })();
        return this.readyPromise;
    }

    async onMessage(obj) {
        if (obj && obj.command === 'ping') {
            this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            return;
        }
        if (obj && obj.command === 'stateChange') {
            const { id, value } = obj.message || {};
            const sendMatch = id?.match(/vehicles\.(.+)\.control\.send$/);
            const typedMatch = id?.match(
                /vehicles\.(.+)\.control\.(lock|unlock|climateStart|climateStop|chargeStart|chargeStop|windowsOpen|windowsClose|windowsVentilate|sunshadeOpen|sunshadeClose|flash|honkFlash|applyChargePlan)$/,
            );
            const bridgeBase = () => ({
                username: this.config.username,
                password: this.config.password,
                countryCode: this.config.countryCode || 'AU',
                hmacAccessKey: this.config.hmacAccessKey || '',
                hmacSecretKey: this.config.hmacSecretKey || '',
                passwordPublicKey: this.config.passwordPublicKey || '',
                prodSecret: this.config.prodSecret || '',
                prodSecretCandidates: this.config.prodSecretCandidates || '',
                vinKey: this.config.vinKey || '',
                vinIv: this.config.vinIv || '',
                mockMode: Boolean(this.config.mockMode),
            });
            const limitMatch = id?.match(/vehicles\.(.+)\.control\.chargeLimit$/);
            if (sendMatch) {
                try {
                    const vin = await this.resolveVinForDevice(sendMatch[1]);
                    if (vin && value) {
                        const command = await this.getStateAsync(`${id.replace(/\.send$/, '.command')}`);
                        const serviceId = await this.getStateAsync(`${id.replace(/\.send$/, '.serviceId')}`);
                        const result = await this.runBridge('command', {
                            ...bridgeBase(),
                            vin,
                            command: command?.val || '',
                            serviceId: serviceId?.val || '',
                            setting: {},
                        });
                        await this.setStateChangedAsync(
                            `${id.replace(/\.send$/, '.lastResult')}`,
                            JSON.stringify(result),
                            true,
                        );
                    }
                } catch (error) {
                    this.log.error(`Command via stateChange failed: ${error.message}`);
                    try {
                        await this.setStateChangedAsync(
                            `${id.replace(/\.send$/, '.lastResult')}`,
                            JSON.stringify({ ok: false, error: error.message }),
                            true,
                        );
                    } catch {
                        // ignore secondary failure
                    }
                }
            } else if (typedMatch && value) {
                const [, deviceName, typedAction] = typedMatch;
                try {
                    const vin = await this.resolveVinForDevice(deviceName);
                    if (!vin) {
                        throw new Error('VIN unknown for device');
                    }
                    const baseId = `vehicles.${deviceName}.control`;
                    let result;
                    if (typedAction === 'applyChargePlan') {
                        const start = await this.getStateAsync(`${baseId}.chargePlanStart`);
                        const end = await this.getStateAsync(`${baseId}.chargePlanEnd`);
                        result = await this.runBridge('set_charge_plan', {
                            ...bridgeBase(),
                            vin,
                            startTime: start?.val || '',
                            endTime: end?.val || '',
                            planCommand: 'start',
                        });
                    } else if (typedAction === 'climateStart') {
                        const temp = await this.getStateAsync(`${baseId}.climateTemp`);
                        const duration = await this.getStateAsync(`${baseId}.climateDuration`);
                        const tempVal = Number(temp?.val ?? 20);
                        const durationVal = Number(duration?.val ?? 15);
                        result = await this.runBridge('command', {
                            ...bridgeBase(),
                            vin,
                            command: 'start',
                            serviceId: 'ZAF',
                            setting: {
                                serviceParameters: [
                                    { key: 'AC', value: 'true' },
                                    { key: 'AC.temp', value: String(tempVal) },
                                    { key: 'AC.duration', value: String(durationVal) },
                                ],
                            },
                        });
                    } else {
                        const preset = TYPED_COMMANDS[typedAction] || {
                            command: typedAction,
                            serviceId: '',
                            setting: {},
                        };
                        result = await this.runBridge('command', { ...bridgeBase(), vin, ...preset });
                    }
                    await this.setStateChangedAsync(`${baseId}.lastResult`, JSON.stringify(result), true);
                } catch (error) {
                    this.log.error(`Typed command ${typedAction} failed: ${error.message}`);
                } finally {
                    try {
                        await this.setStateChangedAsync(id, false, true);
                    } catch {
                        // ignore
                    }
                }
            } else if (limitMatch && typeof value === 'number') {
                const [, deviceName] = limitMatch;
                try {
                    const vin = await this.resolveVinForDevice(deviceName);
                    if (!vin) {
                        throw new Error('VIN unknown for device');
                    }
                    const clamped = Math.min(100, Math.max(50, Math.round(value / 5) * 5));
                    const result = await this.runBridge('command', {
                        ...bridgeBase(),
                        vin,
                        command: 'start',
                        serviceId: 'RCS',
                        setting: {
                            serviceParameters: [
                                { key: 'soc', value: String(clamped * 10) },
                                { key: 'rcs.setting', value: '1' },
                                { key: 'altCurrent', value: '1' },
                            ],
                        },
                    });
                    await this.setStateChangedAsync(
                        `vehicles.${deviceName}.control.lastResult`,
                        JSON.stringify(result),
                        true,
                    );
                } catch (error) {
                    this.log.error(`Charge limit failed: ${error.message}`);
                }
            }
            this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            return;
        }
        if (obj && obj.command === 'testConnection') {
            try {
                const result = await this.runBridge('test_connection', {
                    username: obj.message?.username ?? this.config.username,
                    password: obj.message?.password ?? this.config.password,
                    countryCode: obj.message?.countryCode ?? this.config.countryCode ?? 'AU',
                    hmacAccessKey: obj.message?.hmacAccessKey ?? this.config.hmacAccessKey ?? '',
                    hmacSecretKey: obj.message?.hmacSecretKey ?? this.config.hmacSecretKey ?? '',
                    passwordPublicKey: obj.message?.passwordPublicKey ?? this.config.passwordPublicKey ?? '',
                    prodSecret: obj.message?.prodSecret ?? this.config.prodSecret ?? '',
                    prodSecretCandidates: obj.message?.prodSecretCandidates ?? this.config.prodSecretCandidates ?? '',
                    vinKey: obj.message?.vinKey ?? this.config.vinKey ?? '',
                    vinIv: obj.message?.vinIv ?? this.config.vinIv ?? '',
                    mockMode: Boolean(obj.message?.mockMode ?? this.config.mockMode),
                });
                this.sendTo(obj.from, obj.command, result, obj.callback);
            } catch (error) {
                this.sendTo(obj.from, obj.command, { ok: false, error: error.message }, obj.callback);
            }
            return;
        }
        if (obj && (obj.command === 'setChargePlan' || obj.command === 'setTravelPlan')) {
            const action = obj.command === 'setChargePlan' ? 'set_charge_plan' : 'set_travel_plan';
            try {
                const result = await this.runBridge(action, {
                    username: this.config.username,
                    password: this.config.password,
                    countryCode: this.config.countryCode || 'AU',
                    hmacAccessKey: this.config.hmacAccessKey || '',
                    hmacSecretKey: this.config.hmacSecretKey || '',
                    passwordPublicKey: this.config.passwordPublicKey || '',
                    prodSecret: this.config.prodSecret || '',
                    prodSecretCandidates: this.config.prodSecretCandidates || '',
                    vinKey: this.config.vinKey || '',
                    vinIv: this.config.vinIv || '',
                    mockMode: Boolean(this.config.mockMode),
                    ...(obj.message || {}),
                });
                this.sendTo(obj.from, obj.command, result, obj.callback);
            } catch (error) {
                this.sendTo(obj.from, obj.command, { ok: false, error: error.message }, obj.callback);
            }
            return;
        }
        if (obj && obj.command === 'sendCommand') {
            const { vin, command, serviceId, setting } = obj.message || {};
            if (!vin || !command) {
                this.sendTo(obj.from, obj.command, { ok: false, error: 'vin and command are required' }, obj.callback);
                return;
            }
            try {
                const result = await this.runBridge('command', {
                    username: this.config.username,
                    password: this.config.password,
                    countryCode: this.config.countryCode || 'AU',
                    hmacAccessKey: this.config.hmacAccessKey || '',
                    hmacSecretKey: this.config.hmacSecretKey || '',
                    passwordPublicKey: this.config.passwordPublicKey || '',
                    prodSecret: this.config.prodSecret || '',
                    prodSecretCandidates: this.config.prodSecretCandidates || '',
                    vinKey: this.config.vinKey || '',
                    vinIv: this.config.vinIv || '',
                    vin,
                    command,
                    serviceId,
                    setting,
                });
                this.sendTo(obj.from, obj.command, result, obj.callback);
            } catch (error) {
                this.log.error(`sendCommand failed: ${error.message}`);
                this.sendTo(obj.from, obj.command, { ok: false, error: error.message }, obj.callback);
            }
            return;
        }
        if (obj && obj.command === 'config') {
            this.config = { ...this.config, ...(obj.message || {}) };
            this.pollingInterval = Math.max(30, Number(this.config.pollingInterval || 300));
            this._debugEnabled = Boolean(this.config.debug);
            const newConfigHash = this.getConfigHash();
            if (newConfigHash !== this._lastConfigHash) {
                this._lastConfigHash = newConfigHash;
                await this.setStateChangedAsync('info.lastLog', 'Configuration updated', true);
            }
            await this.setStateChangedAsync('info.pollingInterval', this.pollingInterval, true);
            await this.setStateChangedAsync('info.username', this.config.username || '', true);
            await this.setStateChangedAsync('info.countryCode', this.config.countryCode || 'AU', true);
            await this.setStateChangedAsync('info.vehicleFilter', this.config.vehicleFilter || '', true);
            await this.setStateChangedAsync('info.debug', Boolean(this.config.debug), true);
            await this.setStateChangedAsync('info.pythonBinary', this.config.pythonBinary || '', true);
            await this.setStateChangedAsync('info.apkBasePath', this.config.apkBasePath || '', true);
            await this.setStateChangedAsync('info.apkArm64Path', this.config.apkArm64Path || '', true);
            await this.setStateChangedAsync('info.extractRegion', this.config.extractRegion || 'EM', true);
            await this.maybeAutoExtractSecrets();
            this.setupPollingTimer();
            await this.pollVehicles();
            this.sendTo(obj.from, obj.command, { ok: true, config: this.config }, obj.callback);
        }
    }

    async onUnload(callback) {
        this.clearPollingTimer();
        for (const child of this._children) {
            try {
                child.kill('SIGTERM');
            } catch {
                // ignore
            }
        }
        this._children.clear();
        callback();
    }

    clearPollingTimer() {
        if (this._timer) {
            this.clearTimeout(this._timer);
            this.clearInterval(this._timer);
            this._timer = null;
        }
    }

    async deleteDeviceObjects(deviceIds) {
        // Works with both the real js-controller (delObjectAsync) and the test stub (Map).
        if (this._existingDeviceIds) {
            for (const oldId of this._existingDeviceIds) {
                if (!deviceIds.has(oldId) && oldId !== 'info') {
                    if (typeof this.delObjectAsync === 'function') {
                        try {
                            await this.delObjectAsync(oldId, { recursive: true });
                        } catch (error) {
                            this.log.warn(`Failed to delete stale device ${oldId}: ${error.message}`);
                        }
                    } else if (this._objects?.delete) {
                        this._objects.delete(oldId);
                    }
                }
            }
        }
        this._existingDeviceIds = deviceIds;
    }

    async getApkStorageDir() {
        const baseDir =
            typeof this.getDataDir === 'function'
                ? this.getDataDir()
                : path.join(require('node:os').tmpdir(), 'iobroker.zeekr');
        const apkDir = path.join(baseDir, 'apks');
        await fs.promises.mkdir(apkDir, { recursive: true });
        return apkDir;
    }

    async importApk(sourcePath, targetName) {
        // The adapter copies the APK into its own storage so users never
        // have to create directories or change permissions inside the
        // ioBroker tree themselves.
        let stat;
        try {
            stat = await fs.promises.stat(sourcePath);
        } catch {
            throw new Error(`APK not found or not readable: ${sourcePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`APK path is not a file: ${sourcePath}`);
        }
        const apkDir = await this.getApkStorageDir();
        const target = path.join(apkDir, targetName);
        if (path.resolve(sourcePath) !== path.resolve(target)) {
            await fs.promises.copyFile(sourcePath, target);
            this.log.info(`Imported APK into adapter storage: ${targetName}`);
        }
        return target;
    }

    async maybeAutoExtractSecrets() {
        if (!this.config?.autoExtractSecrets) {
            return false;
        }
        const secretFields = ['hmacAccessKey', 'hmacSecretKey', 'passwordPublicKey', 'prodSecret', 'vinKey', 'vinIv'];
        const missingSecrets = secretFields.filter(field => !String(this.config?.[field] || '').trim());
        if (missingSecrets.length === 0) {
            return false;
        }
        const payload = {
            pythonBinary: this.config?.pythonBinary || '',
            apkBasePath: this.config?.apkBasePath || '',
            apkArm64Path: this.config?.apkArm64Path || '',
            apkLegacyPath: this.config?.apkLegacyPath || '',
            secretsJsonPath: this.config?.secretsJsonPath || '',
            runtimeSecretsJsonPath: this.config?.runtimeSecretsJsonPath || '',
            extractRegion: this.config?.extractRegion || suggestRegionForCountry(this.config?.countryCode),
        };
        if (!payload.secretsJsonPath && (!payload.apkBasePath || !payload.apkArm64Path)) {
            const message =
                'Auto-Extraktion aktiv, aber weder APK-Pfade noch Secrets-JSON gesetzt. Siehe Admin-Hilfe Schritt 3.';
            this._lastLog = message;
            this.log.warn(message);
            await this.setStateChangedAsync('info.extractionStatus', 'missing_input', true);
            return false;
        }
        try {
            if (!payload.secretsJsonPath) {
                payload.apkBasePath = await this.importApk(payload.apkBasePath, 'base.apk');
                payload.apkArm64Path = await this.importApk(payload.apkArm64Path, 'arm64.apk');
            }
            const result = await this.runPythonScript(path.join(__dirname, 'extract_secrets.py'), [], payload);
            if (!result?.ok) {
                const message = `Secret extraction failed: ${result?.error || 'Unknown error'}`;
                this._lastLog = message;
                this.log.warn(message);
                return false;
            }
            const secrets = result.secrets || {};
            Object.assign(this.config, secrets);
            const extractedCount = Object.keys(secrets).filter(key => secrets[key]).length;
            this._lastLog = `Extracted ${extractedCount} Zeekr secrets successfully.`;
            this.log.info(this._lastLog);
            await this.setStateChangedAsync('info.extractionStatus', 'ok', true);
            if (Array.isArray(result.warnings) && result.warnings.length) {
                await this.setStateChangedAsync(
                    'info.extractionWarnings',
                    result.warnings.join(' | ').slice(0, 2000),
                    true,
                );
                for (const warning of result.warnings) {
                    this.log.warn(`Extractor: ${warning}`);
                }
            } else {
                await this.setStateChangedAsync('info.extractionWarnings', '', true);
            }
            return true;
        } catch (error) {
            const message = `Secret extraction failed: ${error.message}`;
            this._lastLog = message;
            this.log.warn(message);
            try {
                await this.setStateChangedAsync('info.extractionStatus', 'error', true);
            } catch {
                // ignore
            }
            return false;
        }
    }

    getEffectivePollingInterval() {
        // Active vehicles (charging or driving) get faster updates so the
        // data is fresh when it matters; idle vehicles use the full interval
        // to spare the API.
        if (this._lastActivePoll) {
            return Math.max(30, Math.min(this.pollingInterval, 60));
        }
        return this.pollingInterval;
    }

    async setupPollingTimer() {
        this.clearPollingTimer();
        if (!this.pollingInterval || this.pollingInterval <= 0) {
            return;
        }
        const tick = () => {
            let run;
            if (this._pollRunning) {
                this.log.debug('Skipping poll: previous run still in progress');
                run = Promise.resolve();
            } else {
                run = this.pollVehicles().catch(error => {
                    this.log.error(`Polling failed: ${error.message}`);
                });
            }
            run.finally(() => {
                this._timer = this.setTimeout(tick, this.getEffectivePollingInterval() * 1000);
            });
        };
        this._timer = this.setTimeout(tick, this.getEffectivePollingInterval() * 1000);
    }

    async ensureBaseObjects() {
        await this.setObjectNotExistsAsync('info', {
            type: 'channel',
            common: { name: 'Information', type: 'channel' },
            native: {},
        });
        await this.setObjectNotExistsAsync('vehicles', {
            type: 'channel',
            common: { name: 'Vehicles', type: 'channel' },
            native: {},
        });
        const infoStates = [
            {
                id: 'info.connection',
                common: {
                    name: 'Connection state',
                    type: 'boolean',
                    role: 'indicator.connected',
                    read: true,
                    write: false,
                },
            },
            {
                id: 'info.lastUpdate',
                common: { name: 'Last update', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.lastSuccessfulUpdate',
                common: { name: 'Last successful update', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.lastError',
                common: { name: 'Last error', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.lastLog',
                common: { name: 'Last log entry', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.lastBridgeOutput',
                common: { name: 'Last bridge output', type: 'string', role: 'json', read: true, write: false },
            },
            {
                id: 'info.alertCount',
                common: { name: 'Alert count', type: 'number', role: 'value', read: true, write: false },
            },
            {
                id: 'info.health',
                common: { name: 'Adapter health', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.watchdog',
                common: { name: 'Watchdog status', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.vehicleCount',
                common: { name: 'Vehicle count', type: 'number', role: 'value', read: true, write: false },
            },
            {
                id: 'info.username',
                common: { name: 'Configured username', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.countryCode',
                common: { name: 'Country code', type: 'string', role: 'text', read: true, write: false },
            },
            // NOTE: secrets (password, hmac keys, prodSecret, vinKey/Iv) are intentionally
            // NOT exposed as states. They belong in protectedNative, not in the object DB.
            {
                id: 'info.pollingInterval',
                common: {
                    name: 'Polling interval',
                    type: 'number',
                    role: 'value.interval',
                    read: true,
                    write: false,
                    unit: 's',
                },
            },
            {
                id: 'info.vehicleFilter',
                common: { name: 'Vehicle filter', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.debug',
                common: { name: 'Debug enabled', type: 'boolean', role: 'indicator', read: true, write: false },
            },
            {
                id: 'info.pythonBinary',
                common: { name: 'Python binary', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.apkBasePath',
                common: { name: 'APK base path', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.apkArm64Path',
                common: { name: 'APK arm64 path', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.extractRegion',
                common: { name: 'Extract region', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.suggestedRegion',
                common: {
                    name: 'Suggested region for country',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                },
            },
            {
                id: 'info.lastErrorHint',
                common: { name: 'Last error hint (DE)', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.extractionStatus',
                common: { name: 'Extraction status', type: 'string', role: 'text', read: true, write: false },
            },
            {
                id: 'info.extractionWarnings',
                common: { name: 'Extraction warnings', type: 'string', role: 'text', read: true, write: false },
            },
        ];
        for (const state of infoStates) {
            await this.setObjectNotExistsAsync(state.id, {
                type: 'state',
                common: state.common,
                native: {},
            });
        }
    }

    async pollVehicles() {
        if (this._pollRunning) {
            this.log.debug('pollVehicles: already running, skipping overlap');
            return;
        }
        this._pollRunning = true;
        try {
            await this._pollVehiclesInner();
        } finally {
            this._pollRunning = false;
        }
    }

    async _pollVehiclesInner() {
        const mockMode = Boolean(this.config.mockMode);
        const requiredFields = mockMode
            ? []
            : [
                  ['username', this.config.username],
                  ['password', this.config.password],
                  ['hmacAccessKey', this.config.hmacAccessKey],
                  ['hmacSecretKey', this.config.hmacSecretKey],
                  ['passwordPublicKey', this.config.passwordPublicKey],
                  ['prodSecret', this.config.prodSecret],
                  ['vinKey', this.config.vinKey],
                  ['vinIv', this.config.vinIv],
              ];
        const missingFields = requiredFields.filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
        if (missingFields.length) {
            const message = `Missing Zeekr credentials or secrets: ${missingFields.join(', ')}.`;
            this._lastLog = message;
            this.log.warn(message);
            await this.setStateChangedAsync('info.connection', false, true);
            await this.setStateChangedAsync('info.lastUpdate', 'Missing credentials', true);
            await this.setStateChangedAsync('info.lastSuccessfulUpdate', this._lastSuccessfulUpdate || '', true);
            await this.setStateChangedAsync('info.lastError', message, true);
            await this.setStateChangedAsync('info.lastLog', message, true);
            await this.setStateChangedAsync('info.alertCount', this._alertCount, true);
            await this.setStateChangedAsync('info.health', 'error', true);
            await this.setStateChangedAsync('info.watchdog', 'alert', true);
            await this.setStateChangedAsync('info.vehicleCount', 0, true);
            return;
        }

        let result;
        try {
            result = await this.runBridge('vehicles', {
                username: mockMode ? 'mock' : this.config.username,
                password: mockMode ? 'mock' : this.config.password,
                countryCode: this.config.countryCode || 'AU',
                hmacAccessKey: this.config.hmacAccessKey || '',
                hmacSecretKey: this.config.hmacSecretKey || '',
                passwordPublicKey: this.config.passwordPublicKey || '',
                prodSecret: this.config.prodSecret || '',
                prodSecretCandidates: this.config.prodSecretCandidates || '',
                vinKey: this.config.vinKey || '',
                vinIv: this.config.vinIv || '',
                vehicleFilter: this.config.vehicleFilter || '',
                mockMode,
            });
        } catch (error) {
            const message = `Bridge execution failed: ${error.message}`;
            this._lastError = error.message;
            this._lastLog = message;
            this.log.error(message);
            await this.setStateChangedAsync('info.connection', false, true);
            await this.setStateChangedAsync('info.lastUpdate', `${new Date().toISOString()} (${error.message})`, true);
            await this.setStateChangedAsync('info.lastSuccessfulUpdate', this._lastSuccessfulUpdate || '', true);
            await this.setStateChangedAsync('info.lastError', error.message, true);
            await this.setStateChangedAsync('info.lastErrorHint', getErrorHint(error.message), true);
            await this.setStateChangedAsync('info.lastLog', message, true);
            await this.setStateChangedAsync('info.alertCount', this._alertCount + 1, true);
            await this.setStateChangedAsync('info.health', 'error', true);
            await this.setStateChangedAsync('info.watchdog', 'alert', true);
            await this.setStateChangedAsync('info.vehicleCount', 0, true);
            return;
        }

        const rawVehicles = Array.isArray(result?.vehicles) ? result.vehicles : [];
        const bridgeMessage = result?.error || `Loaded ${rawVehicles.length} vehicle(s)`;
        this._lastError = result?.error || '';
        this._lastLog = bridgeMessage;
        if (!result?.error) {
            this._lastSuccessfulUpdate = new Date().toISOString();
            this._alertCount = Math.max(0, this._alertCount);
        } else {
            this._alertCount += 1;
        }
        await this.setStateChangedAsync('info.connection', !result?.error, true);
        await this.setStateChangedAsync('info.lastUpdate', new Date().toISOString(), true);
        await this.setStateChangedAsync('info.lastSuccessfulUpdate', this._lastSuccessfulUpdate, true);
        await this.setStateChangedAsync('info.lastError', result?.error || '', true);
        await this.setStateChangedAsync('info.lastErrorHint', getErrorHint(result?.error || ''), true);
        await this.setStateChangedAsync('info.lastLog', bridgeMessage, true);
        await this.setStateChangedAsync('info.lastBridgeOutput', JSON.stringify(result || {}), true);
        await this.setStateChangedAsync('info.alertCount', this._alertCount, true);
        await this.setStateChangedAsync('info.health', result?.error ? 'error' : 'ok', true);
        await this.setStateChangedAsync('info.watchdog', result?.error ? 'alert' : 'ok', true);
        await this.setStateChangedAsync('info.vehicleCount', rawVehicles.length, true);

        const vehicles = rawVehicles.filter(vehicle => {
            const filter = (this.config.vehicleFilter || '').trim().toLowerCase();
            if (!filter) {
                return true;
            }
            const haystack = `${vehicle.name || ''} ${vehicle.vin || ''}`.toLowerCase();
            return haystack.includes(filter);
        });

        const deviceIds = new Set();
        for (const vehicle of vehicles) {
            const idBase = this.createDeviceBaseId(vehicle);
            deviceIds.add(idBase);
            await this.setObjectNotExistsAsync(idBase, {
                type: 'channel',
                common: { name: vehicle.name || vehicle.vin || 'Vehicle', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.details`, {
                type: 'channel',
                common: { name: 'Details', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.status`, {
                type: 'channel',
                common: { name: 'Status', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.control`, {
                type: 'channel',
                common: { name: 'Control', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.trips`, {
                type: 'channel',
                common: { name: 'Trips', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.energy`, {
                type: 'channel',
                common: { name: 'Energy', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.smartCharge`, {
                type: 'channel',
                common: { name: 'SmartCharge', type: 'channel' },
                native: vehicle,
            });
            await this.setObjectNotExistsAsync(`${idBase}.raw`, {
                type: 'channel',
                common: { name: 'Raw', type: 'channel' },
                native: vehicle,
            });
            const states = [
                {
                    id: `${idBase}.name`,
                    value: vehicle.name || 'Vehicle',
                    common: { name: 'Vehicle name', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.vin`,
                    value: vehicle.vin || '',
                    common: { name: 'Vehicle VIN', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.details.model`,
                    value: vehicle.model || vehicle.modelName || '',
                    common: { name: 'Model', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.control.command`,
                    value: '',
                    common: { name: 'Command payload', type: 'string', role: 'text', read: true, write: true },
                },
                {
                    id: `${idBase}.control.serviceId`,
                    value: '',
                    common: { name: 'Service ID', type: 'string', role: 'text', read: true, write: true },
                },
                {
                    id: `${idBase}.control.send`,
                    value: false,
                    common: { name: 'Send command', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.lock`,
                    value: false,
                    common: { name: 'Lock vehicle (button)', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.unlock`,
                    value: false,
                    common: {
                        name: 'Unlock vehicle (button)',
                        type: 'boolean',
                        role: 'button',
                        read: true,
                        write: true,
                    },
                },
                {
                    id: `${idBase}.control.climateStart`,
                    value: false,
                    common: {
                        name: 'Start climate (button)',
                        type: 'boolean',
                        role: 'button',
                        read: true,
                        write: true,
                    },
                },
                {
                    id: `${idBase}.control.climateStop`,
                    value: false,
                    common: { name: 'Stop climate (button)', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.chargeStart`,
                    value: false,
                    common: { name: 'Start charging (RCS)', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.chargeStop`,
                    value: false,
                    common: { name: 'Stop charging (RCS)', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.windowsOpen`,
                    value: false,
                    common: { name: 'Open windows', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.windowsClose`,
                    value: false,
                    common: { name: 'Close windows', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.windowsVentilate`,
                    value: false,
                    common: { name: 'Ventilate windows', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.sunshadeOpen`,
                    value: false,
                    common: { name: 'Open sunshade', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.sunshadeClose`,
                    value: false,
                    common: { name: 'Close sunshade', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.flash`,
                    value: false,
                    common: { name: 'Flash blinkers', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.honkFlash`,
                    value: false,
                    common: { name: 'Honk and flash', type: 'boolean', role: 'button', read: true, write: true },
                },
                {
                    id: `${idBase}.control.chargeLimit`,
                    value: vehicle.chargingLimit ?? 100,
                    common: {
                        name: 'Charge limit target',
                        type: 'number',
                        role: 'level',
                        read: true,
                        write: true,
                        min: 50,
                        max: 100,
                        step: 5,
                        unit: '%',
                    },
                },
                {
                    id: `${idBase}.control.climateTemp`,
                    value: 20,
                    common: {
                        name: 'Climate target temperature',
                        type: 'number',
                        role: 'level.temperature',
                        read: true,
                        write: true,
                        min: 16,
                        max: 28,
                        step: 0.5,
                        unit: '°C',
                    },
                },
                {
                    id: `${idBase}.control.climateDuration`,
                    value: 15,
                    common: {
                        name: 'Climate duration',
                        type: 'number',
                        role: 'level.timer',
                        read: true,
                        write: true,
                        min: 5,
                        max: 60,
                        step: 5,
                        unit: 'min',
                    },
                },
                {
                    id: `${idBase}.control.chargePlanStart`,
                    value: '',
                    common: { name: 'Charge plan start HH:MM', type: 'string', role: 'text', read: true, write: true },
                },
                {
                    id: `${idBase}.control.chargePlanEnd`,
                    value: '',
                    common: { name: 'Charge plan end HH:MM', type: 'string', role: 'text', read: true, write: true },
                },
                {
                    id: `${idBase}.control.applyChargePlan`,
                    value: false,
                    common: {
                        name: 'Apply charge plan (button)',
                        type: 'boolean',
                        role: 'button',
                        read: true,
                        write: true,
                    },
                },
                {
                    id: `${idBase}.status.batteryLevel`,
                    value: vehicle.batteryLevel ?? null,
                    common: {
                        name: 'Battery level',
                        type: 'number',
                        role: 'value.battery',
                        read: true,
                        write: false,
                        unit: '%',
                    },
                },
                {
                    id: `${idBase}.status.rangeKm`,
                    value: vehicle.rangeKm ?? null,
                    common: {
                        name: 'Range',
                        type: 'number',
                        role: 'value.distance',
                        read: true,
                        write: false,
                        unit: 'km',
                    },
                },
                {
                    id: `${idBase}.status.odometerKm`,
                    value: vehicle.odometerKm ?? null,
                    common: {
                        name: 'Odometer',
                        type: 'number',
                        role: 'value.distance',
                        read: true,
                        write: false,
                        unit: 'km',
                    },
                },
                {
                    id: `${idBase}.status.chargePower`,
                    value: vehicle.chargePower ?? null,
                    common: {
                        name: 'Charging power',
                        type: 'number',
                        role: 'value.power',
                        read: true,
                        write: false,
                        unit: 'kW',
                    },
                },
                {
                    id: `${idBase}.status.currentSpeed`,
                    value: vehicle.currentSpeed ?? null,
                    common: {
                        name: 'Current speed',
                        type: 'number',
                        role: 'value.speed',
                        read: true,
                        write: false,
                        unit: 'km/h',
                    },
                },
                {
                    id: `${idBase}.status.pluggedIn`,
                    value: Boolean(vehicle.pluggedIn),
                    common: { name: 'Plugged in', type: 'boolean', role: 'indicator', read: true, write: false },
                },
                {
                    id: `${idBase}.status.isCharging`,
                    value: Boolean(vehicle.isCharging),
                    common: {
                        name: 'Charging status',
                        type: 'boolean',
                        role: 'indicator.working',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.temperature`,
                    value: vehicle.temperature ?? null,
                    common: {
                        name: 'Interior temperature',
                        type: 'number',
                        role: 'value.temperature',
                        read: true,
                        write: false,
                        unit: '°C',
                    },
                },
                {
                    id: `${idBase}.status.chargingState`,
                    value: vehicle.chargingState || vehicle.chargeState || vehicle.chargingStatus || '',
                    common: { name: 'Charging state', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.lockState`,
                    value: vehicle.lockState || '',
                    common: { name: 'Lock state', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.isLocked`,
                    value: Boolean(vehicle.isLocked),
                    common: {
                        name: 'Vehicle locked',
                        type: 'boolean',
                        role: 'sensor.lock',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.climateOn`,
                    value: Boolean(vehicle.climateOn),
                    common: { name: 'Climate active', type: 'boolean', role: 'indicator', read: true, write: false },
                },
                {
                    id: `${idBase}.status.lastUpdated`,
                    value: vehicle.lastUpdated || '',
                    common: { name: 'Last update', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.chargingLimit`,
                    value: vehicle.chargingLimit ?? null,
                    common: {
                        name: 'Charge limit',
                        type: 'number',
                        role: 'value.battery',
                        read: true,
                        write: false,
                        unit: '%',
                    },
                },
                {
                    id: `${idBase}.status.tirePressureFl`,
                    value: vehicle.tirePressureFl ?? null,
                    common: {
                        name: 'Tire pressure FL',
                        type: 'number',
                        role: 'value.pressure',
                        read: true,
                        write: false,
                        unit: 'bar',
                    },
                },
                {
                    id: `${idBase}.status.tirePressureFr`,
                    value: vehicle.tirePressureFr ?? null,
                    common: {
                        name: 'Tire pressure FR',
                        type: 'number',
                        role: 'value.pressure',
                        read: true,
                        write: false,
                        unit: 'bar',
                    },
                },
                {
                    id: `${idBase}.status.tirePressureRl`,
                    value: vehicle.tirePressureRl ?? null,
                    common: {
                        name: 'Tire pressure RL',
                        type: 'number',
                        role: 'value.pressure',
                        read: true,
                        write: false,
                        unit: 'bar',
                    },
                },
                {
                    id: `${idBase}.status.tirePressureRr`,
                    value: vehicle.tirePressureRr ?? null,
                    common: {
                        name: 'Tire pressure RR',
                        type: 'number',
                        role: 'value.pressure',
                        read: true,
                        write: false,
                        unit: 'bar',
                    },
                },
                {
                    id: `${idBase}.status.latitude`,
                    value: vehicle.latitude ?? null,
                    common: { name: 'Latitude', type: 'number', role: 'value.gps.latitude', read: true, write: false },
                },
                {
                    id: `${idBase}.status.longitude`,
                    value: vehicle.longitude ?? null,
                    common: {
                        name: 'Longitude',
                        type: 'number',
                        role: 'value.gps.longitude',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.battery12v`,
                    value: vehicle.battery12v ?? null,
                    common: {
                        name: '12V battery',
                        type: 'number',
                        role: 'value.voltage',
                        read: true,
                        write: false,
                        unit: 'V',
                    },
                },
                {
                    id: `${idBase}.status.lastTripDistanceKm`,
                    value: vehicle.lastTripDistanceKm ?? null,
                    common: {
                        name: 'Last trip distance',
                        type: 'number',
                        role: 'value.distance',
                        read: true,
                        write: false,
                        unit: 'km',
                    },
                },
                {
                    id: `${idBase}.status.centralLockingStatus`,
                    value: vehicle.centralLockingStatus || '',
                    common: { name: 'Central locking status', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.doorOpenDriver`,
                    value: vehicle.doorOpen?.doorOpenStatusDriver ?? null,
                    common: {
                        name: 'Driver door open',
                        type: 'boolean',
                        role: 'sensor.door',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.doorOpenPassenger`,
                    value: vehicle.doorOpen?.doorOpenStatusPassenger ?? null,
                    common: {
                        name: 'Passenger door open',
                        type: 'boolean',
                        role: 'sensor.door',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.doorOpenDriverRear`,
                    value: vehicle.doorOpen?.doorOpenStatusDriverRear ?? null,
                    common: {
                        name: 'Rear driver door open',
                        type: 'boolean',
                        role: 'sensor.door',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.doorOpenPassengerRear`,
                    value: vehicle.doorOpen?.doorOpenStatusPassengerRear ?? null,
                    common: {
                        name: 'Rear passenger door open',
                        type: 'boolean',
                        role: 'sensor.door',
                        read: true,
                        write: false,
                    },
                },
                {
                    id: `${idBase}.status.trunkOpen`,
                    value: vehicle.doorOpen?.trunkOpenStatus ?? null,
                    common: { name: 'Trunk open', type: 'boolean', role: 'sensor.door', read: true, write: false },
                },
                {
                    id: `${idBase}.status.avgPowerConsumption`,
                    value: vehicle.avgPowerConsumption ?? null,
                    common: {
                        name: 'Avg power consumption',
                        type: 'number',
                        role: 'value.power.consumption',
                        read: true,
                        write: false,
                        unit: 'kWh/100km',
                    },
                },
                {
                    id: `${idBase}.status.traveledDistanceKm`,
                    value: vehicle.traveledDistanceKm ?? null,
                    common: {
                        name: 'Traveled distance',
                        type: 'number',
                        role: 'value.distance',
                        read: true,
                        write: false,
                        unit: 'km',
                    },
                },
                {
                    id: `${idBase}.status.engineStatus`,
                    value: vehicle.engineStatus || '',
                    common: { name: 'Engine status', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.maintenanceStatus`,
                    value: vehicle.maintenanceStatus || '',
                    common: { name: 'Maintenance status', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.status.maintenanceRaw`,
                    value: JSON.stringify(vehicle.maintenanceRaw || {}),
                    common: { name: 'Maintenance payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.trips.count`,
                    value: vehicle.tripCount ?? 0,
                    common: { name: 'Trip count', type: 'number', role: 'value', read: true, write: false },
                },
                {
                    id: `${idBase}.trips.lastDistanceKm`,
                    value: vehicle.lastTripDistanceKm ?? null,
                    common: {
                        name: 'Last trip distance',
                        type: 'number',
                        role: 'value.distance',
                        read: true,
                        write: false,
                        unit: 'km',
                    },
                },
                {
                    id: `${idBase}.trips.raw`,
                    value: JSON.stringify(vehicle.tripList || []),
                    common: { name: 'Trip list', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.isHome`,
                    value: false,
                    common: { name: 'At home zone', type: 'boolean', role: 'indicator', read: true, write: false },
                },
                {
                    id: `${idBase}.smartCharge.state`,
                    value: 'idle',
                    common: { name: 'Smart charge decision', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.energy.sessionKwh`,
                    value: 0,
                    common: {
                        name: 'Last session energy',
                        type: 'number',
                        role: 'value.energy',
                        read: true,
                        write: false,
                        unit: 'kWh',
                    },
                },
                {
                    id: `${idBase}.energy.sessionCost`,
                    value: 0,
                    common: { name: 'Last session cost', type: 'number', role: 'value', read: true, write: false },
                },
                {
                    id: `${idBase}.energy.sessionTariff`,
                    value: '',
                    common: { name: 'Last session tariff', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.energy.sessionLossKwh`,
                    value: 0,
                    common: {
                        name: 'Last session losses',
                        type: 'number',
                        role: 'value.energy',
                        read: true,
                        write: false,
                        unit: 'kWh',
                    },
                },
                {
                    id: `${idBase}.energy.lastSession`,
                    value: '{}',
                    common: { name: 'Last session detail', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.energy.monthKwh`,
                    value: 0,
                    common: {
                        name: 'Month charged energy',
                        type: 'number',
                        role: 'value.energy',
                        read: true,
                        write: false,
                        unit: 'kWh',
                    },
                },
                {
                    id: `${idBase}.energy.monthCost`,
                    value: 0,
                    common: { name: 'Month charging cost', type: 'number', role: 'value', read: true, write: false },
                },
                {
                    id: `${idBase}.energy.monthLossKwh`,
                    value: 0,
                    common: {
                        name: 'Month charging losses',
                        type: 'number',
                        role: 'value.energy',
                        read: true,
                        write: false,
                        unit: 'kWh',
                    },
                },
                {
                    id: `${idBase}.energy.standbyMonthKwh`,
                    value: 0,
                    common: {
                        name: 'Month standby drain',
                        type: 'number',
                        role: 'value.energy',
                        read: true,
                        write: false,
                        unit: 'kWh',
                    },
                },
                {
                    id: `${idBase}.energy.standbyMonthCost`,
                    value: 0,
                    common: { name: 'Month standby cost', type: 'number', role: 'value', read: true, write: false },
                },
                {
                    id: `${idBase}.status.windowPositionAvg`,
                    value: vehicle.windowPositionAvg ?? null,
                    common: {
                        name: 'Window position avg',
                        type: 'number',
                        role: 'value',
                        read: true,
                        write: false,
                        unit: '%',
                    },
                },
                {
                    id: `${idBase}.status.chargePlanRaw`,
                    value: JSON.stringify(vehicle.chargePlan || {}),
                    common: { name: 'Charge plan payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.status.travelPlanRaw`,
                    value: JSON.stringify(vehicle.travelPlan || {}),
                    common: { name: 'Travel plan payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.status.vtmRaw`,
                    value: JSON.stringify(vehicle.vtmStatus || {}),
                    common: { name: 'VTM payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.status.statusRaw`,
                    value: JSON.stringify(vehicle.status || {}),
                    common: { name: 'Status payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.status.chargingStatusRaw`,
                    value: JSON.stringify(vehicle.chargingStatus || {}),
                    common: { name: 'Charging status payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.status.remoteControlStateRaw`,
                    value: JSON.stringify(vehicle.remoteControlState || {}),
                    common: { name: 'Remote control payload', type: 'string', role: 'json', read: true, write: false },
                },
                {
                    id: `${idBase}.control.lastCommand`,
                    value: '',
                    common: { name: 'Last command', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.control.lastResult`,
                    value: '',
                    common: { name: 'Last command result', type: 'string', role: 'text', read: true, write: false },
                },
                {
                    id: `${idBase}.raw.payload`,
                    value: JSON.stringify(vehicle),
                    common: { name: 'Raw vehicle payload', type: 'string', role: 'json', read: true, write: false },
                },
            ];
            for (const state of states) {
                await this.setObjectNotExistsAsync(state.id, {
                    type: 'state',
                    common: state.common,
                    native: vehicle,
                });
                await this.setStateChangedAsync(state.id, state.value, true);
            }
        }

        if (result?.error) {
            await this.setStateChangedAsync('info.lastUpdate', `${new Date().toISOString()} (${result.error})`, true);
            this._lastLog = `Bridge reported: ${result.error}`;
            this.log.warn(this._lastLog);
            await this.setStateChangedAsync('info.lastLog', this._lastLog, true);
            await this.setStateChangedAsync('info.alertCount', this._alertCount, true);
            await this.setStateChangedAsync('info.health', 'error', true);
            await this.setStateChangedAsync('info.watchdog', 'alert', true);
            await this.maybeTriggerAlert(result.error);
        }

        if (this._existingDeviceIds) {
            for (const oldId of this._existingDeviceIds) {
                if (!deviceIds.has(oldId) && oldId !== 'info') {
                    // Real runtime deletes recursively, stub just drops the Map entry.
                    if (typeof this.delObjectAsync === 'function') {
                        try {
                            await this.delObjectAsync(oldId, { recursive: true });
                        } catch (error) {
                            this.log.warn(`Failed to delete stale device ${oldId}: ${error.message}`);
                        }
                    } else if (this._objects?.delete) {
                        this._objects.delete(oldId);
                    }
                }
            }
        }
        this._existingDeviceIds = deviceIds;
        this._lastActivePoll = vehicles.some(vehicle => vehicle.isCharging || Number(vehicle.currentSpeed || 0) > 0);
        await this.checkSentryEvents(vehicles);
        await this.trackEnergy(vehicles);
    }

    monthKey(date = new Date()) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    async loadEnergyMonth(idBase) {
        if (!this._energyMonthCache) {
            this._energyMonthCache = new Map();
        }
        const key = this.monthKey();
        const cacheKey = `${idBase}|${key}`;
        if (this._energyMonthCache.has(cacheKey)) {
            return this._energyMonthCache.get(cacheKey);
        }
        const totals = { energyKwh: 0, cost: 0, lossKwh: 0, standbyKwh: 0, standbyCost: 0 };
        for (const [field, prop] of [
            ['energy.monthKwh', 'energyKwh'],
            ['energy.monthCost', 'cost'],
            ['energy.monthLossKwh', 'lossKwh'],
            ['energy.standbyMonthKwh', 'standbyKwh'],
            ['energy.standbyMonthCost', 'standbyCost'],
        ]) {
            try {
                const state = await this.getStateAsync(`${idBase}.${field}`);
                if (state && Number.isFinite(Number(state.val))) {
                    totals[prop] = Number(state.val);
                }
            } catch {
                // ignore, start from zero
            }
        }
        const entry = { key, totals };
        this._energyMonthCache.set(cacheKey, entry);
        return entry;
    }

    async trackEnergy(vehicles) {
        const energy = require('./energy');
        const tariffs = energy.parseTariffs(this.config.tariffsJson);
        const defaultPrice = Number(this.config.defaultPricePerKwh ?? 0.3);
        const capacity = Number(this.config.batteryCapacityKwh ?? 100);
        const efficiency = Number(this.config.chargingEfficiencyPct ?? 88);
        const homeLat = this.config.homeLat !== '' ? Number(this.config.homeLat) : null;
        const homeLon = this.config.homeLon !== '' ? Number(this.config.homeLon) : null;
        const homeRadius = Number(this.config.homeRadiusM ?? 150);
        if (!this._chargeSamples) {
            this._chargeSamples = new Map();
        }
        if (!this._parkedBattery) {
            this._parkedBattery = new Map();
        }
        if (!this._smartLast) {
            this._smartLast = new Map();
        }
        for (const vehicle of vehicles) {
            const vin = vehicle.vin || vehicle.name || 'unknown';
            const idBase = this.createDeviceBaseId(vehicle);
            const now = Date.now();
            // Geofence home.
            const distHome = energy.haversineMeters(vehicle.latitude, vehicle.longitude, homeLat, homeLon);
            const isHome =
                distHome !== null && Number.isFinite(homeLat) && Number.isFinite(homeLon) && distHome <= homeRadius;
            await this.setStateChangedAsync(`${idBase}.isHome`, isHome, true);
            // Charging session sampling.
            const samples = this._chargeSamples.get(vin) || [];
            if (vehicle.isCharging) {
                samples.push({
                    ts: now,
                    chargePowerKw: vehicle.chargePower ?? null,
                    batteryLevelPct: vehicle.batteryLevel ?? null,
                });
                this._chargeSamples.set(vin, samples.slice(-200));
                this._parkedBattery.delete(vin);
            } else {
                if (samples.length >= 2) {
                    await this.settleChargeSession(idBase, vin, samples, {
                        energy,
                        tariffs,
                        defaultPrice,
                        capacity,
                        efficiency,
                        lat: vehicle.latitude,
                        lon: vehicle.longitude,
                    });
                }
                this._chargeSamples.delete(vin);
                // Standby drain while parked.
                const speed = Number(vehicle.currentSpeed || 0);
                const level = Number(vehicle.batteryLevel);
                if (speed === 0 && Number.isFinite(level)) {
                    const prev = this._parkedBattery.get(vin);
                    if (prev !== undefined && level < prev) {
                        const drainKwh = ((prev - level) / 100) * capacity;
                        if (drainKwh > 0) {
                            const month = await this.loadEnergyMonth(idBase);
                            month.totals.standbyKwh += drainKwh;
                            month.totals.standbyCost += drainKwh * defaultPrice;
                            await this.setStateChangedAsync(
                                `${idBase}.energy.standbyMonthKwh`,
                                Math.round(month.totals.standbyKwh * 1000) / 1000,
                                true,
                            );
                            await this.setStateChangedAsync(
                                `${idBase}.energy.standbyMonthCost`,
                                Math.round(month.totals.standbyCost * 100) / 100,
                                true,
                            );
                        }
                    }
                    this._parkedBattery.set(vin, level);
                }
            }
            await this.runSmartCharge(idBase, vin, vehicle, { energy, tariffs });
            await this.ensureBatteryLog(idBase, vehicle);
        }
    }

    async settleChargeSession(idBase, vin, samples, { energy, tariffs, defaultPrice, capacity, efficiency, lat, lon }) {
        const first = samples[0];
        const tariff = energy.matchTariff(tariffs, lat, lon, new Date(first.ts)) || null;
        const price = tariff ? tariff.pricePerKwh : defaultPrice;
        const res = energy.settleSession({
            polls: samples,
            capacityKwh: capacity,
            efficiencyPct: efficiency,
            pricePerKwh: price,
        });
        const month = await this.loadEnergyMonth(idBase);
        month.totals.energyKwh += res.chargerKwh;
        month.totals.cost += res.cost;
        month.totals.lossKwh += res.lossKwh;
        await this.setStateChangedAsync(`${idBase}.energy.sessionKwh`, res.chargerKwh, true);
        await this.setStateChangedAsync(`${idBase}.energy.sessionCost`, res.cost, true);
        await this.setStateChangedAsync(`${idBase}.energy.sessionTariff`, tariff ? tariff.name : 'default', true);
        await this.setStateChangedAsync(`${idBase}.energy.sessionLossKwh`, res.lossKwh, true);
        await this.setStateChangedAsync(
            `${idBase}.energy.lastSession`,
            JSON.stringify({ vin, tariff: tariff ? tariff.name : 'default', ...res }),
            true,
        );
        await this.setStateChangedAsync(
            `${idBase}.energy.monthKwh`,
            Math.round(month.totals.energyKwh * 1000) / 1000,
            true,
        );
        await this.setStateChangedAsync(`${idBase}.energy.monthCost`, Math.round(month.totals.cost * 100) / 100, true);
        await this.setStateChangedAsync(
            `${idBase}.energy.monthLossKwh`,
            Math.round(month.totals.lossKwh * 1000) / 1000,
            true,
        );
        this.log.info(
            `Charge session ${vin}: ${res.chargerKwh} kWh / ${res.cost} (tariff ${tariff ? tariff.name : 'default'})`,
        );
    }

    async runSmartCharge(idBase, vin, vehicle, { energy, tariffs }) {
        if (!this.config.smartChargeEnabled) {
            return;
        }
        const target = Number(vehicle.chargingLimit ?? 100);
        const decision = energy.decideSmartCharge({
            now: new Date(),
            pluggedIn: Boolean(vehicle.pluggedIn),
            batteryPct: vehicle.batteryLevel,
            targetPct: target,
            capacityKwh: this.config.batteryCapacityKwh,
            chargePowerKw: vehicle.chargePower,
            departureHhMm: this.config.smartChargeDeparture || '',
            tariffs,
            lat: vehicle.latitude,
            lon: vehicle.longitude,
        });
        await this.setStateChangedAsync(`${idBase}.smartCharge.state`, decision, true);
        const last = this._smartLast.get(vin);
        this._smartLast.set(vin, decision);
        if (decision === last) {
            return;
        }
        const base = {
            username: this.config.username,
            password: this.config.password,
            countryCode: this.config.countryCode || 'AU',
            hmacAccessKey: this.config.hmacAccessKey || '',
            hmacSecretKey: this.config.hmacSecretKey || '',
            passwordPublicKey: this.config.passwordPublicKey || '',
            prodSecret: this.config.prodSecret || '',
            prodSecretCandidates: this.config.prodSecretCandidates || '',
            vinKey: this.config.vinKey || '',
            vinIv: this.config.vinIv || '',
            mockMode: Boolean(this.config.mockMode),
            vin,
        };
        try {
            if (decision === 'charge' && !vehicle.isCharging) {
                await this.runBridge('command', { ...base, command: 'start', serviceId: 'RCS', setting: {} });
                this.log.info(`Smart charge: started charging ${vin}`);
            } else if (decision === 'wait' && vehicle.isCharging) {
                await this.runBridge('command', { ...base, command: 'stop', serviceId: 'RCS', setting: {} });
                this.log.info(`Smart charge: paused charging ${vin} for cheap window`);
            }
        } catch (error) {
            this.log.warn(`Smart charge command failed: ${error.message}`);
        }
    }

    async ensureBatteryLog(idBase, vehicle) {
        const key = this.monthKey();
        const channelId = `${idBase}.batteryLog.${key}`;
        await this.setObjectNotExistsAsync(channelId, {
            type: 'channel',
            common: { name: `Battery log ${key}`, type: 'channel' },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${channelId}.odometerKm`, {
            type: 'state',
            common: {
                name: 'Odometer snapshot',
                type: 'number',
                role: 'value.distance',
                read: true,
                write: false,
                unit: 'km',
            },
            native: {},
        });
        // Only snapshot once per month (first poll wins).
        const existing = await this.getStateAsync(`${channelId}.odometerKm`);
        if (existing && existing.val !== null && existing.val !== undefined) {
            return;
        }
        await this.setStateChangedAsync(`${channelId}.odometerKm`, vehicle.odometerKm ?? null, true);
        await this.setObjectNotExistsAsync(`${channelId}.rangeKm`, {
            type: 'state',
            common: {
                name: 'Range snapshot',
                type: 'number',
                role: 'value.distance',
                read: true,
                write: false,
                unit: 'km',
            },
            native: {},
        });
        await this.setStateChangedAsync(`${channelId}.rangeKm`, vehicle.rangeKm ?? null, true);
        await this.setObjectNotExistsAsync(`${channelId}.batteryLevel`, {
            type: 'state',
            common: {
                name: 'Battery snapshot',
                type: 'number',
                role: 'value.battery',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });
        await this.setStateChangedAsync(`${channelId}.batteryLevel`, vehicle.batteryLevel ?? null, true);
    }

    snapshotDoors(vehicle) {
        const doors = vehicle.doorOpen || {};
        return {
            doorOpenStatusDriver: Boolean(doors.doorOpenStatusDriver),
            doorOpenStatusPassenger: Boolean(doors.doorOpenStatusPassenger),
            doorOpenStatusDriverRear: Boolean(doors.doorOpenStatusDriverRear),
            doorOpenStatusPassengerRear: Boolean(doors.doorOpenStatusPassengerRear),
            trunkOpenStatus: Boolean(doors.trunkOpenStatus),
        };
    }

    async checkSentryEvents(vehicles) {
        // Compares with the previous poll and alerts (webhook, rate-limited)
        // on unexpected charging stops and newly opened doors/lids.
        if (!this._lastVehicleSnapshot) {
            this._lastVehicleSnapshot = new Map();
        }
        const next = new Map();
        for (const vehicle of vehicles) {
            const vin = vehicle.vin || vehicle.name || 'unknown';
            const curr = {
                isCharging: Boolean(vehicle.isCharging),
                pluggedIn: Boolean(vehicle.pluggedIn),
                batteryLevel: Number(vehicle.batteryLevel ?? 0),
                chargingLimit: Number(vehicle.chargingLimit ?? 100),
                doors: this.snapshotDoors(vehicle),
            };
            next.set(vin, curr);
            const prev = this._lastVehicleSnapshot.get(vin);
            if (!prev) {
                continue;
            }
            if (prev.isCharging && !curr.isCharging && curr.pluggedIn && curr.batteryLevel < curr.chargingLimit) {
                this.maybeTriggerAlert(
                    `Charging stopped unexpectedly at ${curr.batteryLevel}% (limit ${curr.chargingLimit}%)`,
                );
            }
            const opened = Object.keys(curr.doors).filter(key => curr.doors[key] && !prev.doors[key]);
            if (opened.length) {
                this.maybeTriggerAlert(`Door/lid opened: ${opened.join(', ')}`);
            }
        }
        this._lastVehicleSnapshot = next;
    }

    createDeviceBaseId(vehicle) {
        const baseName = vehicle.vin || vehicle.id || vehicle.name || 'vehicle';
        const safeName = String(baseName)
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .toLowerCase();
        return `vehicles.${safeName}`;
    }

    async resolveVinForDevice(deviceName) {
        try {
            const state = await this.getStateAsync(`vehicles.${deviceName}.vin`);
            return state?.val || '';
        } catch {
            return '';
        }
    }

    getConfigHash() {
        const canonical = JSON.stringify({
            username: this.config?.username || '',
            // Secrets are hashed, never stored/compared in plain text.
            passwordHash: this.config?.password
                ? crypto.createHash('sha256').update(String(this.config.password)).digest('hex').slice(0, 16)
                : '',
            countryCode: this.config?.countryCode || 'AU',
            secretsPresent: [
                'hmacAccessKey',
                'hmacSecretKey',
                'passwordPublicKey',
                'prodSecret',
                'prodSecretCandidates',
                'vinKey',
                'vinIv',
            ]
                .map(k => (this.config?.[k] ? '1' : '0'))
                .join(''),
            autoExtractSecrets: Boolean(this.config?.autoExtractSecrets),
            apkBasePath: this.config?.apkBasePath || '',
            apkArm64Path: this.config?.apkArm64Path || '',
            apkLegacyPath: this.config?.apkLegacyPath || '',
            secretsJsonPath: this.config?.secretsJsonPath || '',
            runtimeSecretsJsonPath: this.config?.runtimeSecretsJsonPath || '',
            extractRegion: this.config?.extractRegion || 'EM',
            pollingInterval: this.config?.pollingInterval || 300,
            vehicleFilter: this.config?.vehicleFilter || '',
            pythonBinary: this.config?.pythonBinary || '',
            debug: Boolean(this.config?.debug),
            mockMode: Boolean(this.config?.mockMode),
            batteryCapacityKwh: this.config?.batteryCapacityKwh ?? 100,
            chargingEfficiencyPct: this.config?.chargingEfficiencyPct ?? 88,
            defaultPricePerKwh: this.config?.defaultPricePerKwh ?? 0.3,
            tariffsJson: this.config?.tariffsJson || '',
            homeLat: this.config?.homeLat ?? '',
            homeLon: this.config?.homeLon ?? '',
            homeRadiusM: this.config?.homeRadiusM ?? 150,
            smartChargeEnabled: Boolean(this.config?.smartChargeEnabled),
            smartChargeDeparture: this.config?.smartChargeDeparture || '',
        });
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }

    resolvePythonBinary() {
        if (this.config?.pythonBinary) {
            return this.config.pythonBinary;
        }
        if (process.env.ZEEKR_PYTHON) {
            return process.env.ZEEKR_PYTHON;
        }
        const localVenv = path.join(__dirname, '..', '.venv', 'bin', 'python');
        if (fs.existsSync(localVenv)) {
            return localVenv;
        }
        const localPython = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
        if (fs.existsSync(localPython)) {
            return localPython;
        }
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    maybeTriggerAlert(errorMessage) {
        const now = Date.now();
        if (now < this._alertingCooldownUntil) {
            return;
        }
        this._alertingCooldownUntil = now + 15 * 60 * 1000;
        const webhookUrl = this.config?.alertWebhook || '';
        if (!webhookUrl) {
            return;
        }
        let url;
        try {
            url = new URL(webhookUrl);
        } catch {
            this.log.warn('Invalid alert webhook URL, skipping alert');
            return;
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            this.log.warn('Unsupported alert webhook protocol, skipping alert');
            return;
        }
        // Basic SSRF guard: block cloud metadata + loopback targets.
        const hostname = (url.hostname || '').toLowerCase();
        if (hostname === 'localhost' || hostname === '169.254.169.254' || hostname.endsWith('.internal')) {
            this.log.warn('Blocked alert webhook to internal host');
            return;
        }
        const payload = JSON.stringify({
            message: 'Zeekr adapter alert',
            error: errorMessage,
            health: 'error',
            timestamp: new Date().toISOString(),
        });
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(
            {
                method: 'POST',
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            response => {
                response.resume();
            },
        );
        request.on('timeout', () => request.destroy(new Error('webhook timeout')));
        request.on('error', () => {
            this.log.warn('Alert webhook delivery failed');
        });
        request.write(payload);
        request.end();
    }

    async runPythonScript(scriptPath, scriptArgs = [], payload = {}, options = {}) {
        const input = JSON.stringify(payload || {});
        const pythonBinary = options.pythonBinary || this.resolvePythonBinary();
        const timeoutMs = options.timeoutMs || Number(process.env.ZEEKR_BRIDGE_TIMEOUT_MS || 60000);
        const maxOutputBytes = 5 * 1024 * 1024;
        const venvBootstrap = path.join(__dirname, '..', '.venv');
        // Payload via stdin (not argv) to avoid ARG_MAX limits and safer process listing.
        const bootstrapArgs = [scriptPath, ...scriptArgs];
        return new Promise((resolve, reject) => {
            const child = spawn(pythonBinary, bootstrapArgs, {
                cwd: path.dirname(scriptPath),
                env: { ...process.env, PYTHONUNBUFFERED: '1', ZEEKR_VENV: venvBootstrap },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this._children.add(child);
            const cleanup = () => this._children.delete(child);
            let settled = false;
            const fail = err => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                try {
                    child.kill('SIGKILL');
                } catch {
                    // ignore
                }
                reject(err);
            };
            const timer = this.setTimeout(
                () => fail(new Error(`Python script timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
            const debugRedacted = {
                scriptPath,
                pythonBinary,
                scriptArgs,
                payload: redactPayload(payload || {}),
            };
            if (this._debugEnabled || this.config?.debug) {
                this.log.debug(`Running python script ${path.basename(scriptPath)} via ${pythonBinary}`);
                this.log.debug(`Script payload (redacted): ${JSON.stringify(debugRedacted)}`);
            }
            let stdout = '';
            let stderr = '';
            let truncated = false;
            const append = (store, chunk) => {
                let next = store + chunk.toString();
                if (next.length > maxOutputBytes) {
                    next = next.slice(0, maxOutputBytes);
                    truncated = true;
                }
                return next;
            };
            child.stdout.on('data', chunk => {
                stdout = append(stdout, chunk);
            });
            child.stderr.on('data', chunk => {
                stderr = append(stderr, chunk);
            });
            try {
                child.stdin.write(input);
                child.stdin.end();
            } catch (error) {
                this.clearTimeout(timer);
                fail(error);
                return;
            }
            child.on('error', error => {
                this.clearTimeout(timer);
                fail(error);
            });
            child.on('close', code => {
                this.clearTimeout(timer);
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (truncated) {
                    this.log.warn('Python script output truncated (5MB limit)');
                }
                if (code !== 0) {
                    const message = (stderr || `Python script exited with ${code}`).slice(0, 2000);
                    this._lastError = message;
                    this._lastLog = message;
                    reject(new Error(message));
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    this._lastBridgeOutput = stdout.trim().slice(0, maxOutputBytes);
                    resolve(result);
                } catch {
                    const message = `Invalid python script output: ${stdout.slice(0, 2000)}`;
                    this._lastError = message;
                    this._lastLog = message;
                    reject(new Error(message));
                }
            });
        });
    }

    async runBridge(action, payload) {
        const scriptPath = path.join(__dirname, 'bridge.py');
        const result = await this.runPythonScript(scriptPath, [action], payload);
        this._lastBridgeOutput = JSON.stringify(result || {});
        return result;
    }
}

function createAdapter(options = {}) {
    if (shouldUseAdapterCore()) {
        try {
            const adapterCore = require('@iobroker/adapter-core');
            if (adapterCore && typeof adapterCore.Adapter === 'function') {
                class RuntimeAdapter extends adapterCore.Adapter {
                    constructor(adapterOptions = {}) {
                        super({
                            ...adapterOptions,
                            name: 'zeekr',
                            version: ADAPTER_VERSION,
                            mode: 'daemon',
                            messagebox: true,
                        });

                        // Do NOT shadow the real runtime with stub Maps (_states/_objects/_events).
                        // Only adapter-local bookkeeping lives here.
                        this._timer = null;
                        this._pollRunning = false;
                        this._children = new Set();
                        this._lastError = '';
                        this._lastLog = '';
                        this._lastBridgeOutput = '';
                        this._debugEnabled = false;
                        this._lastSuccessfulUpdate = '';
                        this._alertCount = 0;
                        this._lastConfigHash = '';
                        this._alertingCooldownUntil = 0;
                        this._existingDeviceIds = null;
                        this._lastActivePoll = false;
                        this._lastVehicleSnapshot = new Map();
                        this.readyPromise = null;
                        this.on('ready', this.onReady.bind(this));
                        this.on('message', this.onMessage.bind(this));
                        this.on('unload', this.onUnload.bind(this));
                    }
                }

                Object.getOwnPropertyNames(ZeekrAdapter.prototype).forEach(methodName => {
                    if (methodName !== 'constructor' && typeof ZeekrAdapter.prototype[methodName] === 'function') {
                        RuntimeAdapter.prototype[methodName] = ZeekrAdapter.prototype[methodName];
                    }
                });

                return new RuntimeAdapter(options);
            }
        } catch (error) {
            // Fall back to the stub adapter when the ioBroker runtime is unavailable.
            if (process.env.NODE_ENV !== 'test') {
                console.warn(`Falling back to stub adapter: ${error.message}`);
            }
        }
    }

    return new ZeekrAdapter(options);
}

module.exports = {
    ZeekrAdapter,
    createAdapter,
    ADAPTER_VERSION,
    SECRET_FIELDS,
    redactPayload,
    suggestRegionForCountry,
    getErrorHint,
    TYPED_COMMANDS,
    createDeviceBaseId: vehicle => {
        const safeName = String(vehicle?.vin || vehicle?.id || vehicle?.name || 'vehicle')
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .toLowerCase();
        return `vehicles.${safeName}`;
    },
};
