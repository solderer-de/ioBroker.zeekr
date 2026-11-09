'use strict';

// Pure helpers for energy statistics, tariffs, geofencing and smart charging.
// No ioBroker dependencies: fully unit-testable.

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const a = [lat1, lon1, lat2, lon2].map(toNumber);
    if (a.some(v => v === null)) {
        return null;
    }
    const [la1, lo1, la2, lo2] = a.map(deg => (deg * Math.PI) / 180);
    const dLa = la2 - la1;
    const dLo = lo2 - lo1;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function parseTariffs(raw) {
    if (!raw) {
        return [];
    }
    let list = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) {
        return [];
    }
    return list
        .map(entry => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const price = toNumber(entry.pricePerKwh ?? entry.price);
            if (price === null || price < 0) {
                return null;
            }
            return {
                name: String(entry.name || 'tariff'),
                lat: toNumber(entry.lat),
                lon: toNumber(entry.lon ?? entry.lng),
                radiusM: toNumber(entry.radiusM ?? entry.radius) ?? 150,
                pricePerKwh: price,
                from: typeof entry.from === 'string' ? entry.from : '',
                to: typeof entry.to === 'string' ? entry.to : '',
            };
        })
        .filter(Boolean);
}

function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function parseHhMm(text) {
    const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''));
    if (!match) {
        return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
        return null;
    }
    return hours * 60 + minutes;
}

function inWindow(nowMinutes, fromText, toText) {
    const from = parseHhMm(fromText);
    const to = parseHhMm(toText);
    if (from === null || to === null) {
        return true;
    }
    if (from <= to) {
        return nowMinutes >= from && nowMinutes < to;
    }
    return nowMinutes >= from || nowMinutes < to;
}

function matchTariff(tariffs, lat, lon, date) {
    const now = minutesOfDay(date);
    let best = null;
    for (const tariff of tariffs) {
        if (!locationMatches(tariff, lat, lon)) {
            continue;
        }
        if (!inWindow(now, tariff.from, tariff.to)) {
            continue;
        }
        if (!best || tariff.pricePerKwh < best.pricePerKwh) {
            best = tariff;
        }
    }
    return best;
}

function integrateSession(polls) {
    // polls: [{ts, chargePowerKw, batteryLevelPct}] in order.
    // Returns charger-side kWh integrated from power, plus battery gain.
    let energyKwh = 0;
    for (let i = 1; i < polls.length; i++) {
        const prev = polls[i - 1];
        const curr = polls[i];
        const power = toNumber(curr.chargePowerKw ?? prev.chargePowerKw);
        const dtHours = (curr.ts - prev.ts) / 3600000;
        if (power !== null && power > 0 && dtHours > 0 && dtHours < 6) {
            energyKwh += power * dtHours;
        }
    }
    const first = polls[0];
    const last = polls[polls.length - 1];
    const gainPct =
        first && last && first.batteryLevelPct !== null && last.batteryLevelPct !== null
            ? last.batteryLevelPct - first.batteryLevelPct
            : null;
    return { energyKwh, gainPct };
}

function settleSession({ polls, capacityKwh, efficiencyPct, pricePerKwh }) {
    // Real cost math: charger energy covers battery gain plus losses.
    // chargerKwh = max(integrated power, gain / efficiency).
    const { energyKwh, gainPct } = integrateSession(polls);
    const capacity = toNumber(capacityKwh) || 0;
    const efficiency = Math.min(1, Math.max(0.5, (toNumber(efficiencyPct) ?? 88) / 100));
    const gainKwh = gainPct !== null && capacity > 0 ? (gainPct / 100) * capacity : null;
    const fromGain = gainKwh !== null && gainKwh > 0 ? gainKwh / efficiency : 0;
    const chargerKwh = Math.max(energyKwh, fromGain);
    const batteryKwh = gainKwh !== null && gainKwh > 0 ? gainKwh : chargerKwh * efficiency;
    const lossKwh = Math.max(0, chargerKwh - batteryKwh);
    const price = toNumber(pricePerKwh) || 0;
    return {
        chargerKwh: round3(chargerKwh),
        batteryKwh: round3(batteryKwh),
        lossKwh: round3(lossKwh),
        cost: round3(chargerKwh * price),
        gainPct,
    };
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function locationMatches(tariff, lat, lon) {
    if (tariff.lat === null || tariff.lon === null) {
        return true;
    }
    const distance = haversineMeters(lat, lon, tariff.lat, tariff.lon);
    return distance !== null && distance <= tariff.radiusM;
}

function cheapestMatching(tariffs, lat, lon, date) {
    const nowMinutes = minutesOfDay(date);
    let best = null;
    for (const tariff of tariffs) {
        if (!locationMatches(tariff, lat, lon)) {
            continue;
        }
        if (!inWindow(nowMinutes, tariff.from, tariff.to)) {
            continue;
        }
        if (!best || tariff.pricePerKwh < best.pricePerKwh) {
            best = tariff;
        }
    }
    return best;
}

function cheaperWindowAhead(tariffs, lat, lon, currentPrice, nowDate, latestStartDate) {
    // True if a strictly cheaper matching window starts before latestStart.
    const horizon = Math.min(latestStartDate.getTime(), nowDate.getTime() + 72 * 3600000);
    for (let ts = nowDate.getTime() + 30 * 60000; ts <= horizon; ts += 30 * 60000) {
        const probe = new Date(ts);
        for (const tariff of tariffs) {
            if (!locationMatches(tariff, lat, lon)) {
                continue;
            }
            if (tariff.pricePerKwh < currentPrice - 1e-9 && inWindow(minutesOfDay(probe), tariff.from, tariff.to)) {
                return true;
            }
        }
    }
    return false;
}

function decideSmartCharge({
    now,
    pluggedIn,
    batteryPct,
    targetPct,
    capacityKwh,
    chargePowerKw,
    departureHhMm,
    tariffs,
    lat,
    lon,
}) {
    // Returns 'charge' | 'wait' | 'idle'. Charges inside the cheapest window
    // before departure that still fits the missing energy.
    if (!pluggedIn) {
        return 'idle';
    }
    const missingPct = (toNumber(targetPct) ?? 100) - (toNumber(batteryPct) ?? 0);
    if (missingPct <= 0) {
        return 'idle';
    }
    const list = Array.isArray(tariffs) ? tariffs : [];
    const powerKw = toNumber(chargePowerKw);
    const capacity = toNumber(capacityKwh) || 0;
    const hoursNeeded = powerKw && powerKw > 0 && capacity > 0 ? (missingPct / 100) * (capacity / powerKw) : 2;
    const departure = parseHhMm(departureHhMm);
    if (!list.length) {
        return 'charge';
    }
    const current = matchTariff(list, lat, lon, now);
    if (current === null) {
        return 'charge';
    }
    if (departure === null) {
        // No departure constraint: use the cheapest tariff available now.
        const cheapest = cheapestMatching(list, lat, lon, now);
        if (cheapest && current.pricePerKwh <= cheapest.pricePerKwh) {
            return 'charge';
        }
        return 'wait';
    }
    let latestStart = new Date(now.getTime());
    const depToday = new Date(now.getTime());
    depToday.setHours(Math.floor(departure / 60), departure % 60, 0, 0);
    if (depToday.getTime() <= now.getTime()) {
        // Departure time already passed today: it means tomorrow.
        depToday.setDate(depToday.getDate() + 1);
    }
    latestStart = new Date(depToday.getTime() - hoursNeeded * 3600000);
    if (latestStart.getTime() <= now.getTime()) {
        latestStart = new Date(now.getTime() + 15 * 60000);
    }
    if (cheaperWindowAhead(list, lat, lon, current.pricePerKwh, now, latestStart)) {
        return 'wait';
    }
    return 'charge';
}

module.exports = {
    haversineMeters,
    parseTariffs,
    parseHhMm,
    inWindow,
    matchTariff,
    integrateSession,
    settleSession,
    decideSmartCharge,
    dayKeyLocal,
    lastNDayKeys,
    emptyDayEntry,
    addDayEntry,
    sumDayRange,
    parseZones,
    matchZone,
    tripCostKwh,
    sessionsToCsv,
    tripsToCsv,
};

function dayKeyLocal(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function lastNDayKeys(n, refDate = new Date()) {
    const keys = [];
    for (let i = 0; i < n; i++) {
        keys.push(dayKeyLocal(new Date(refDate.getTime() - i * 86400000)));
    }
    return keys;
}

function emptyDayEntry() {
    return { kwh: 0, cost: 0, lossKwh: 0, tripKm: 0, tripCount: 0, tripUsedKwh: 0, tripCost: 0 };
}

function addDayEntry(days, key, patch) {
    if (!days || typeof days !== 'object') {
        return emptyDayEntry();
    }
    const entry = { ...emptyDayEntry(), ...(days[key] || {}) };
    for (const [field, value] of Object.entries(patch || {})) {
        if (typeof entry[field] === 'number' && Number.isFinite(Number(value))) {
            entry[field] = Math.round((entry[field] + Number(value)) * 1000) / 1000;
        }
    }
    days[key] = entry;
    return entry;
}

function sumDayRange(days, keys) {
    const total = emptyDayEntry();
    for (const key of keys || []) {
        const entry = days && days[key];
        if (!entry) {
            continue;
        }
        for (const field of Object.keys(total)) {
            if (Number.isFinite(Number(entry[field]))) {
                total[field] = Math.round((total[field] + Number(entry[field])) * 1000) / 1000;
            }
        }
    }
    return total;
}

function parseZones(raw) {
    if (!raw) {
        return [];
    }
    let list = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) {
        return [];
    }
    return list
        .filter(
            z =>
                z &&
                typeof z.name === 'string' &&
                z.name.trim() &&
                Number.isFinite(Number(z.lat)) &&
                Number.isFinite(Number(z.lon)),
        )
        .map(z => ({
            name: String(z.name).trim().slice(0, 60),
            lat: Number(z.lat),
            lon: Number(z.lon),
            radiusM: Number(z.radiusM) > 0 ? Number(z.radiusM) : 150,
        }));
}

function matchZone(zones, lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        return null;
    }
    for (const zone of zones || []) {
        const dist = haversineMeters(la, lo, zone.lat, zone.lon);
        if (dist !== null && dist <= zone.radiusM) {
            return zone.name;
        }
    }
    return null;
}

function tripCostKwh(usedKwh, pricePerKwh) {
    const kwh = toNumber(usedKwh);
    const price = toNumber(pricePerKwh);
    if (kwh === null || price === null || kwh <= 0) {
        return 0;
    }
    return Math.round(kwh * price * 1000) / 1000;
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sessionsToCsv(sessions) {
    const header = 'vin;startTime;endTime;kwh;cost;tariff;pricePerKwh;lossKwh';
    const lines = (sessions || []).map(s =>
        [s.vin, s.startTime, s.endTime, s.kwh, s.cost, s.tariff, s.pricePerKwh, s.lossKwh].map(csvCell).join(';'),
    );
    return [header, ...lines].join('\n');
}

function tripsToCsv(trips) {
    const header =
        'vin;startTime;endTime;distanceKm;durationMin;avgSpeedKmh;usedKwh;consumptionKwh100km;cost;startLevel;endLevel';
    const lines = (trips || []).map(t =>
        [
            t.vin,
            t.startTime,
            t.endTime,
            t.distanceKm,
            t.durationMin,
            t.avgSpeedKmh,
            t.usedKwh,
            t.consumptionKwh100km,
            t.cost,
            t.startLevel,
            t.endLevel,
        ]
            .map(csvCell)
            .join(';'),
    );
    return [header, ...lines].join('\n');
}
