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

let AdapterBase;
try {
  ({ Adapter: AdapterBase } = require('@iobroker/adapter-core'));
} catch {
  AdapterBase = AdapterStub;
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
    this.on('ready', this.onReady.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.log.info('Zeekr adapter is starting');
    this.config = {
      username: this.config?.username || '',
      password: this.config?.password || '',
      pollingInterval: Number(this.config?.pollingInterval || 300),
      vehicleFilter: this.config?.vehicleFilter || '',
      debug: Boolean(this.config?.debug),
    };
    this.pollingInterval = Math.max(30, this.config.pollingInterval);
    await this.ensureBaseObjects();
    await this.setStateChangedAsync('info.username', this.config.username || '', true);
    await this.setStateChangedAsync('info.pollingInterval', this.pollingInterval, true);
    await this.setStateChangedAsync('info.vehicleFilter', this.config.vehicleFilter || '', true);
    await this.pollVehicles();
    this._timer = setInterval(() => {
      this.pollVehicles().catch((error) => {
        this.log.error(`Polling failed: ${error.message}`);
      });
    }, this.pollingInterval * 1000);
  }

  async onMessage(obj) {
    if (obj && obj.command === 'ping') {
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
      this.sendTo(obj.from, obj.command, { ok: true, config: this.config }, obj.callback);
    }
  }

  async onUnload(callback) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    callback();
  }

  async ensureBaseObjects() {
    await this.setObjectNotExistsAsync('info', {
      type: 'channel',
      common: { name: 'Information', type: 'channel' },
      native: {},
    });
    const infoStates = [
      { id: 'info.connection', common: { name: 'Connection state', type: 'boolean', role: 'indicator.connected', read: true, write: false } },
      { id: 'info.lastUpdate', common: { name: 'Last update', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.vehicleCount', common: { name: 'Vehicle count', type: 'number', role: 'value', read: true, write: false } },
      { id: 'info.username', common: { name: 'Configured username', type: 'string', role: 'text', read: true, write: false } },
      { id: 'info.pollingInterval', common: { name: 'Polling interval', type: 'number', role: 'value.interval', read: true, write: false, unit: 's' } },
      { id: 'info.vehicleFilter', common: { name: 'Vehicle filter', type: 'string', role: 'text', read: true, write: false } },
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
      this.log.warn('No Zeekr credentials configured yet.');
      await this.setStateChangedAsync('info.connection', false, true);
      await this.setStateChangedAsync('info.lastUpdate', 'Missing credentials', true);
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
      this.log.error(`Bridge execution failed: ${error.message}`);
      await this.setStateChangedAsync('info.connection', false, true);
      await this.setStateChangedAsync('info.lastUpdate', `${new Date().toISOString()} (${error.message})`, true);
      await this.setStateChangedAsync('info.vehicleCount', 0, true);
      return;
    }

    const rawVehicles = Array.isArray(result?.vehicles) ? result.vehicles : [];
    await this.setStateChangedAsync('info.connection', !result?.error, true);
    await this.setStateChangedAsync('info.lastUpdate', new Date().toISOString(), true);
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
      await this.setObjectNotExistsAsync(`${idBase}.commands`, {
        type: 'channel',
        common: { name: 'Commands', type: 'channel' },
        native: vehicle,
      });
      const states = [
        { id: `${idBase}.name`, value: vehicle.name || 'Vehicle', common: { name: 'Vehicle name', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.vin`, value: vehicle.vin || '', common: { name: 'Vehicle VIN', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.batteryLevel`, value: vehicle.batteryLevel ?? null, common: { name: 'Battery level', type: 'number', role: 'value.battery', read: true, write: false, unit: '%' } },
        { id: `${idBase}.rangeKm`, value: vehicle.rangeKm ?? null, common: { name: 'Range', type: 'number', role: 'value.distance', read: true, write: false, unit: 'km' } },
        { id: `${idBase}.odometerKm`, value: vehicle.odometerKm ?? null, common: { name: 'Odometer', type: 'number', role: 'value.distance', read: true, write: false, unit: 'km' } },
        { id: `${idBase}.chargePower`, value: vehicle.chargePower ?? null, common: { name: 'Charging power', type: 'number', role: 'value.power', read: true, write: false, unit: 'kW' } },
        { id: `${idBase}.currentSpeed`, value: vehicle.currentSpeed ?? null, common: { name: 'Current speed', type: 'number', role: 'value.speed', read: true, write: false, unit: 'km/h' } },
        { id: `${idBase}.pluggedIn`, value: Boolean(vehicle.pluggedIn), common: { name: 'Plugged in', type: 'boolean', role: 'indicator', read: true, write: false } },
        { id: `${idBase}.isCharging`, value: Boolean(vehicle.isCharging), common: { name: 'Charging status', type: 'boolean', role: 'indicator.working', read: true, write: false } },
        { id: `${idBase}.temperature`, value: vehicle.temperature ?? null, common: { name: 'Interior temperature', type: 'number', role: 'value.temperature', read: true, write: false, unit: '°C' } },
        { id: `${idBase}.statusRaw`, value: JSON.stringify(vehicle.status || {}), common: { name: 'Status payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.chargingStatusRaw`, value: JSON.stringify(vehicle.chargingStatus || {}), common: { name: 'Charging status payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.remoteControlStateRaw`, value: JSON.stringify(vehicle.remoteControlState || {}), common: { name: 'Remote control payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.raw`, value: JSON.stringify(vehicle), common: { name: 'Raw vehicle payload', type: 'string', role: 'json', read: true, write: false } },
        { id: `${idBase}.commands.lastCommand`, value: '', common: { name: 'Last command', type: 'string', role: 'text', read: true, write: false } },
        { id: `${idBase}.commands.lastResult`, value: '', common: { name: 'Last command result', type: 'string', role: 'text', read: true, write: false } },
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
      this.log.warn(`Bridge reported: ${result.error}`);
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

  resolvePythonBinary() {
    if (process.env.ZEEKR_PYTHON) {
      return process.env.ZEEKR_PYTHON;
    }
    const localVenv = path.join(__dirname, '..', '.venv', 'bin', 'python');
    if (fs.existsSync(localVenv)) {
      return localVenv;
    }
    return 'python3';
  }

  async runBridge(action, payload) {
    const scriptPath = path.join(__dirname, 'bridge.py');
    const input = JSON.stringify(payload || {});
    const pythonBinary = this.resolvePythonBinary();
    return new Promise((resolve, reject) => {
      const child = spawn(pythonBinary, [scriptPath, action, input], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
          reject(new Error(stderr || `Bridge exited with ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Invalid bridge output: ${stdout}`));
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
