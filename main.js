'use strict';

class AdapterStub {
  constructor(options = {}) {
    this.options = options;
    this.log = { silly() {}, debug() {}, info() {}, warn() {}, error() {} };
    this._events = {};
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

  setStateChangedAsync() { return Promise.resolve(true); }
  setStateAsync() { return Promise.resolve(true); }
  subscribeStatesAsync() { return Promise.resolve(true); }
  sendTo() {}
}

class ZeekrAdapter extends AdapterStub {
  constructor(options = {}) {
    super({
      ...options,
      name: 'zeekr',
      version: '0.1.9',
      mode: 'daemon',
    });
  }

  async onReady() {
    this.log.info('Zeekr adapter ready');
    await this.setStateChangedAsync('info.connection', true, true);
  }

  async onMessage(obj) {
    if (obj && obj.command === 'ping') {
      this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
    }
  }

  async onUnload(callback) {
    callback();
  }
}

if (require.main === module) {
  const adapter = new ZeekrAdapter();
  adapter.emit('ready');
}

module.exports = new ZeekrAdapter();
