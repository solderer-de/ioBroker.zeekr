'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

  sendTo(from, command, message, callback) {
    if (typeof callback === 'function') {
      callback(message);
    }
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.log.info('Adapter stopped');
  }
}

let AdapterBase = AdapterStub;
if (process.env.NODE_ENV !== 'test') {
  try {
    const adapterCore = require('@iobroker/adapter-core');
    if (adapterCore && typeof adapterCore.Adapter === 'function') {
      AdapterBase = adapterCore.Adapter;
    }
  } catch {
    AdapterBase = AdapterStub;
  }
}

class ZeekrAdapter extends AdapterBase {
  constructor(options = {}) {
    super({
      ...options,
      name: 'zeekr',
      version: '0.1.0',
      mode: 'daemon',
      messagebox: false,
    });
    this.log = this.log || { silly() {}, debug() {}, info() {}, warn() {}, error() {} };
    this._states = new Map();
    this._objects = new Map();
    this._timer = null;
    this._lastError = '';
    this._lastLog = '';
    this._lastBridgeOutput = '';
    this._debugEnabled = false;
    this._lastSuccessfulUpdate = '';
    this._alertCount = 0;
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
        pollingInterval: Number(this.config?.pollingInterval || 300),
        vehicleFilter: this.config?.vehicleFilter || '',
        pythonBinary: this.config?.pythonBinary || '',
        debug: Boolean(this.config?.debug),
      };
      this.pollingInterval = Math.max(30, this.config.pollingInterval);
      this._debugEnabled = Boolean(this.config.debug);
      await this.ensureBaseObjects();
      await this.setStateChangedAsync('info.username', this.config.username || '', true);
      await this.setStateChangedAsync('info.pollingInterval', this.pollingInterval, true);
      await this.setStateChangedAsync('info.vehicleFilter', this.config.vehicleFilter || '', true);
      await this.setStateChangedAsync('info.debug', Boolean(this.config.debug), true);
      await this.setStateChangedAsync('info.pythonBinary', this.config.pythonBinary || '', true);
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
      const match = id?.match(/vehicles\.(.+)\.control\.send$/);
      if (match) {
        const vin = this.resolveVinForDevice(match[1]);
        if (vin && value) {
          const command = await this.getStateAsync(`${id.replace(/\.send$/, '.command')}`);
          const serviceId = await this.getStateAsync(`${id.replace(/\.send$/, '.serviceId')}`);
          const result = await this.runBridge('command', {
            username: this.config.username,
            password: this.config.password,
            vin,
            command: command?.val || '',
            serviceId: serviceId?.val || '',
            setting: {},
          });
          await this.setStateChangedAsync(`${id.replace(/\.send$/, '.lastResult')}`, JSON.stringify(result), true);
        }
      }
      this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
      return;
    }
    if (obj && obj.command === 'sendCommand') {
      const { vin, command, serviceId, setting } = obj.message || {};
      const result = await this.runBridge('command', {
        username: this.config.username,
        password: this.config.password,
        vin,
        command,
        serviceId,
        setting,
      });
      this.sendTo(obj.from, obj.command, result, obj.callback);
      return;
    }
    if (obj && obj.command === 'config') {
      this.config = { ...this.config, ...(obj.message || {}) };
      this.pollingInterval = Math.max(30, Number(this.config.pollingInterval || 300));
      this._debugEnabled = Boolean(this.config.debug);
      await this.setStateChangedAsync('info.pollingInterval', this.pollingInterval, true);
      await this.setStateChangedAsync('info.username', this.config.username || '', true);
      await this.setStateChangedAsync('info.vehicleFilter', this.config.vehicleFilter || '', true);
      await this.setStateChangedAsync('info.debug', Boolean(this.config.debug), true);
      await this.setStateChangedAsync('info.pythonBinary', this.config.pythonBinary || '', true);
      this.setupPollingTimer();
      await this.pollVehicles();
      this.sendTo(obj.from, obj.command, { ok: true, config: this.config }, obj.callback);
    }
  }

  async onUnload(callback) {
    this.clearPollingTimer();
    callback();
  }

  clearPollingTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  setupPollingTimer() {
    this.clearPollingTimer();
    if (!this.pollingInterval || this.pollingInterval <= 0) {
      return;
    }
    this._timer = setInterval(() => {
      this.pollVehicles().catch((error) => {
        this.log.error(`Polling failed: ${error.message}`);
      });
    }, this.pollingInterval * 1000);
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
      { id: 'info.connection', common: { name: 'Connection state', type: 'boolean', role: 'indicator.connected', read: true, write: false } },
      { id: 'info.lastUpdate', common: { name: 'Last update', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.lastSuccessfulUpdate', common: { name: 'Last successful update', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.lastError', common: { name: 'Last error', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.lastLog', common: { name: 'Last log entry', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.lastBridgeOutput', common: { name: 'Last bridge output', type: 'string', role: 'json', read: true, write: false } },
      { id: 'info.alertCount', common: { name: 'Alert count', type: 'number', role: 'value', read: true, write: false } },
      { id: 'info.health', common: { name: 'Adapter health', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.vehicleCount', common: { name: 'Vehicle count', type: 'number', role: 'value', read: true, write: false } },
      { id: 'info.username', common: { name: 'Configured username', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.pollingInterval', common: { name: 'Polling interval', type: 'number', role: 'value.interval', read: true, write: false, unit: 's' } },
      { id: 'info.vehicleFilter', common: { name: 'Vehicle filter', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.debug', common: { name: 'Debug enabled', type: 'boolean', role: 'indicator', read: true, write: false } },
      { id: 'info.pythonBinary', common: { name: 'Python binary', type: 'string', role: 'text', read: true, write: false } },
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
    if (!this.config.username || !this.config.password) {
      const message = 'No Zeekr credentials configured yet.';
      this._lastLog = message;
      this.log.warn(message);
      await this.setStateChangedAsync('info.connection', false, true);
      await this.setStateChangedAsync('info.lastUpdate', 'Missing credentials', true);
      await this.setStateChangedAsync('info.lastSuccessfulUpdate', this._lastSuccessfulUpdate || '', true);
      await this.setStateChangedAsync('info.lastError', 'Missing credentials', true);
      await this.setStateChangedAsync('info.lastLog', message, true);
      await this.setStateChangedAsync('info.alertCount', this._alertCount, true);
      await this.setStateChangedAsync('info.health', 'error', true);
      await this.setStateChangedAsync('info.vehicleCount', 0, true);
      return;
    }

    let result;
    try {
      result = await this.runBridge('vehicles', {
        username: this.config.username,
        password: this.config.password,
        vehicleFilter: this.config.vehicleFilter || '',
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
      await this.setStateChangedAsync('info.lastLog', message, true);
      await this.setStateChangedAsync('info.alertCount', this._alertCount + 1, true);
      await this.setStateChangedAsync('info.health', 'error', true);
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
    await this.setStateChangedAsync('info.lastLog', bridgeMessage, true);
    await this.setStateChangedAsync('info.lastBridgeOutput', JSON.stringify(result || {}), true);
    await this.setStateChangedAsync('info.alertCount', this._alertCount, true);
    await this.setStateChangedAsync('info.health', result?.error ? 'error' : 'ok', true);
    await this.setStateChangedAsync('info.vehicleCount', rawVehicles.length, true);

    const vehicles = rawVehicles.filter((vehicle) => {
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
      await this.setObjectNotExistsAsync(`${idBase}.raw`, {
        type: 'channel',
        common: { name: 'Raw', type: 'channel' },
        native: vehicle,
      });
      const states = [
        { id: `${idBase}.name`, value: vehicle.name || 'Vehicle', common: { name: 'Vehicle name', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.vin`, value: vehicle.vin || '', common: { name: 'Vehicle VIN', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.details.model`, value: vehicle.model || vehicle.modelName || '', common: { name: 'Model', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.control.command`, value: '', common: { name: 'Command payload', type: 'string', role: 'text', read: true, write: true } },
        { id: `${idBase}.control.serviceId`, value: '', common: { name: 'Service ID', type: 'string', role: 'text', read: true, write: true } },
        { id: `${idBase}.control.send`, value: false, common: { name: 'Send command', type: 'boolean', role: 'button', read: true, write: true } },
        { id: `${idBase}.status.batteryLevel`, value: vehicle.batteryLevel ?? null, common: { name: 'Battery level', type: 'number', role: 'value.battery', read: true, write: false, unit: '%' } },
        { id: `${idBase}.status.rangeKm`, value: vehicle.rangeKm ?? null, common: { name: 'Range', type: 'number', role: 'value.distance', read: true, write: false, unit: 'km' } },
        { id: `${idBase}.status.odometerKm`, value: vehicle.odometerKm ?? null, common: { name: 'Odometer', type: 'number', role: 'value.distance', read: true, write: false, unit: 'km' } },
        { id: `${idBase}.status.chargePower`, value: vehicle.chargePower ?? null, common: { name: 'Charging power', type: 'number', role: 'value.power', read: true, write: false, unit: 'kW' } },
        { id: `${idBase}.status.currentSpeed`, value: vehicle.currentSpeed ?? null, common: { name: 'Current speed', type: 'number', role: 'value.speed', read: true, write: false, unit: 'km/h' } },
        { id: `${idBase}.status.pluggedIn`, value: Boolean(vehicle.pluggedIn), common: { name: 'Plugged in', type: 'boolean', role: 'indicator', read: true, write: false } },
        { id: `${idBase}.status.isCharging`, value: Boolean(vehicle.isCharging), common: { name: 'Charging status', type: 'boolean', role: 'indicator.working', read: true, write: false } },
        { id: `${idBase}.status.temperature`, value: vehicle.temperature ?? null, common: { name: 'Interior temperature', type: 'number', role: 'value.temperature', read: true, write: false, unit: '°C' } },
        { id: `${idBase}.status.chargingState`, value: vehicle.chargingState || vehicle.chargeState || vehicle.chargingStatus || '', common: { name: 'Charging state', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.status.lockState`, value: vehicle.lockState || '', common: { name: 'Lock state', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.status.isLocked`, value: Boolean(vehicle.isLocked), common: { name: 'Vehicle locked', type: 'boolean', role: 'indicator.locked', read: true, write: false } },
        { id: `${idBase}.status.climateOn`, value: Boolean(vehicle.climateOn), common: { name: 'Climate active', type: 'boolean', role: 'indicator', read: true, write: false } },
        { id: `${idBase}.status.lastUpdated`, value: vehicle.lastUpdated || '', common: { name: 'Last update', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.status.statusRaw`, value: JSON.stringify(vehicle.status || {}), common: { name: 'Status payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.status.chargingStatusRaw`, value: JSON.stringify(vehicle.chargingStatus || {}), common: { name: 'Charging status payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.status.remoteControlStateRaw`, value: JSON.stringify(vehicle.remoteControlState || {}), common: { name: 'Remote control payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.control.lastCommand`, value: '', common: { name: 'Last command', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.control.lastResult`, value: '', common: { name: 'Last command result', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.raw.payload`, value: JSON.stringify(vehicle), common: { name: 'Raw vehicle payload', type: 'string', role: 'json', read: true, write: false } },
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
    }

    if (this._existingDeviceIds) {
      for (const oldId of this._existingDeviceIds) {
        if (!deviceIds.has(oldId) && oldId !== 'info') {
          this._objects.delete(oldId);
        }
      }
    }
    this._existingDeviceIds = deviceIds;
  }

  createDeviceBaseId(vehicle) {
    const baseName = vehicle.vin || vehicle.id || vehicle.name || 'vehicle';
    const safeName = String(baseName).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    return `vehicles.${safeName}`;
  }

  resolveVinForDevice(deviceName) {
    const state = this._states.get(`vehicles.${deviceName}.vin`);
    return state?.val || '';
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

  async runBridge(action, payload) {
    const scriptPath = path.join(__dirname, 'bridge.py');
    const input = JSON.stringify(payload || {});
    const pythonBinary = this.resolvePythonBinary();
    const venvBootstrap = path.join(__dirname, '..', '.venv');
    const bootstrapArgs = [scriptPath, action, input];
    return new Promise((resolve, reject) => {
      const child = spawn(pythonBinary, bootstrapArgs, {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, PYTHONUNBUFFERED: '1', ZEEKR_VENV: venvBootstrap },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (this._debugEnabled || this.config?.debug) {
        this.log.debug(`Running bridge ${action} via ${pythonBinary}`);
      }
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code !== 0) {
          const message = stderr || `Bridge exited with ${code}`;
          this._lastError = message;
          this._lastLog = message;
          reject(new Error(message));
          return;
        }
        try {
          const payload = JSON.parse(stdout);
          this._lastBridgeOutput = stdout.trim();
          resolve(payload);
        } catch (error) {
          const message = `Invalid bridge output: ${stdout}`;
          this._lastError = message;
          this._lastLog = message;
          reject(new Error(message));
        }
      });
    });
  }
}

function createAdapter() {
  return new ZeekrAdapter();
}

module.exports = {
  ZeekrAdapter,
  createAdapter,
  createDeviceBaseId: (vehicle) => {
    const safeName = String(vehicle?.vin || vehicle?.id || vehicle?.name || 'vehicle').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    return `vehicles.${safeName}`;
  },
};
