const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/energy');

test('haversine Berlin-Mitte ~1km', () => {
    const d = E.haversineMeters(52.52, 13.405, 52.529, 13.405);
    assert.ok(d > 900 && d < 1100, d);
});

test('tariff matching by place and time', () => {
    const tariffs = E.parseTariffs([
        { name: 'home-night', lat: 52.52, lon: 13.405, radiusM: 200, pricePerKwh: 0.25, from: '22:00', to: '06:00' },
        { name: 'home-day', lat: 52.52, lon: 13.405, radiusM: 200, pricePerKwh: 0.35 },
        { name: 'ionity', lat: 51.0, lon: 13.7, radiusM: 200, pricePerKwh: 0.79 },
    ]);
    assert.equal(tariffs.length, 3);
    const night = new Date(2026, 0, 1, 23, 30);
    assert.equal(E.matchTariff(tariffs, 52.52, 13.405, night).name, 'home-night');
    const noon = new Date(2026, 0, 1, 12, 0);
    assert.equal(E.matchTariff(tariffs, 52.52, 13.405, noon).name, 'home-day');
    assert.equal(E.matchTariff(tariffs, 51.0, 13.7, noon).name, 'ionity');
    assert.equal(E.matchTariff(tariffs, 48.0, 11.0, noon), null);
});

test('session settle splits charger energy, battery gain and losses', () => {
    const t0 = Date.UTC(2026, 0, 1, 22, 0);
    const polls = [0, 1, 2].map(i => ({ ts: t0 + i * 3600000, chargePowerKw: 11, batteryLevelPct: 50 + i * 5 }));
    const res = E.settleSession({ polls, capacityKwh: 100, efficiencyPct: 88, pricePerKwh: 0.25 });
    assert.equal(res.gainPct, 10);
    assert.ok(res.chargerKwh >= 22 && res.chargerKwh < 24, res.chargerKwh);
    assert.equal(res.batteryKwh, 10);
    assert.ok(res.lossKwh > 0);
    assert.equal(res.cost, Math.round(res.chargerKwh * 0.25 * 1000) / 1000);
});

test('smart charge waits for cheap window, charges when forced', () => {
    const tariffs = E.parseTariffs([
        { name: 'night', pricePerKwh: 0.2, from: '22:00', to: '06:00' },
        { name: 'day', pricePerKwh: 0.4 },
    ]);
    const base = {
        pluggedIn: true,
        batteryPct: 50,
        targetPct: 90,
        capacityKwh: 100,
        chargePowerKw: 11,
        tariffs,
        lat: null,
        lon: null,
    };
    assert.equal(E.decideSmartCharge({ ...base, now: new Date(2026, 0, 1, 12, 0), departureHhMm: '07:00' }), 'wait');
    assert.equal(E.decideSmartCharge({ ...base, now: new Date(2026, 0, 1, 23, 0), departureHhMm: '07:00' }), 'charge');
    assert.equal(E.decideSmartCharge({ ...base, now: new Date(2026, 0, 1, 23, 30), departureHhMm: '' }), 'charge');
    assert.equal(E.decideSmartCharge({ ...base, pluggedIn: false, now: new Date() }), 'idle');
    assert.equal(E.decideSmartCharge({ ...base, batteryPct: 95, targetPct: 90, now: new Date() }), 'idle');
});
