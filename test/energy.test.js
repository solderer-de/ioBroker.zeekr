const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/energy');

// Windows runners provide `python`, not `python3`.
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

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

test('bridge mock works with pip-less venv (no traceback, exit 0)', () => {
    const { spawnSync, execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brokenvenv-'));
    try {
        execFileSync(PYTHON, ['-m', 'venv', '--without-pip', venvDir], { stdio: 'ignore' });
    } catch {
        return;
    }
    const result = spawnSync(PYTHON, ['lib/bridge.py', 'vehicles'], {
        input: JSON.stringify({ username: 'mock', password: 'mock' }),
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, ZEEKR_VENV: venvDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mock, true);
});

test('day entries accumulate and sum over ranges', () => {
    const days = {};
    E.addDayEntry(days, '2026-11-08', { kwh: 10.5, cost: 3.15, tripKm: 163, tripCount: 1 });
    E.addDayEntry(days, '2026-11-08', { kwh: 2, bogus: 99 });
    assert.equal(days['2026-11-08'].kwh, 12.5);
    assert.equal(days['2026-11-08'].tripKm, 163);
    assert.equal(days['2026-11-08'].bogus, undefined);
    const week = E.sumDayRange(days, ['2026-11-02', '2026-11-08']);
    assert.equal(week.kwh, 12.5);
    assert.equal(week.tripCount, 1);
    assert.match(E.dayKeyLocal(new Date(2026, 10, 9)), /^2026-11-09$/);
    assert.equal(E.lastNDayKeys(3, new Date(2026, 10, 9)).length, 3);
});

test('zones parse and match first hit', () => {
    const zones = E.parseZones('[{"name":"Office","lat":52.5,"lon":13.4},{"name":"Bad"}]');
    assert.equal(zones.length, 1);
    assert.equal(zones[0].radiusM, 150);
    assert.equal(E.matchZone(zones, 52.5005, 13.4005), 'Office');
    assert.equal(E.matchZone(zones, 48, 11), null);
    assert.equal(E.matchZone(zones, null, 13), null);
    assert.deepEqual(E.parseZones('broken'), []);
});

test('trip cost and CSV builders quote delimiters', () => {
    assert.equal(E.tripCostKwh(38, 0.3), 11.4);
    assert.equal(E.tripCostKwh(null, 0.3), 0);
    assert.equal(E.tripCostKwh(5, null), 0);
    const csv = E.sessionsToCsv([
        { vin: 'V', startTime: 'a', endTime: 'b', kwh: 10, cost: 3, tariff: 'A;B', pricePerKwh: 0.3, lossKwh: 1 },
    ]);
    const lines = csv.split('\n');
    assert.equal(lines[0], 'vin;startTime;endTime;kwh;cost;tariff;pricePerKwh;lossKwh');
    assert.match(lines[1], /"A;B"/);
    const trips = E.tripsToCsv([
        {
            vin: 'V',
            startTime: 'a',
            endTime: 'b',
            distanceKm: 4,
            durationMin: 13,
            avgSpeedKmh: 17,
            usedKwh: 1,
            consumptionKwh100km: 25,
            cost: 0.3,
            startLevel: 83,
            endLevel: 82,
        },
    ]);
    assert.match(trips.split('\n')[0], /^vin;startTime;endTime;distanceKm/);
});
