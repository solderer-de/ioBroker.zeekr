'use strict';

// ABRP (A Better Routeplanner) telemetry upload.
//
// Endpoint (Iternio Telemetry API):
//   POST https://api.iternio.com/1/tlm/send?api_key=<API_KEY>&token=<USER_TOKEN>&tlm=<urlencoded JSON>
// The api_key identifies the application (free telemetry key from
// abetterrouteplanner.com/resources/api), the user token identifies one
// vehicle (ABRP app -> live data / generic, or OAuth2). Minimal working
// payload is {utc, soc}; everything else is optional (server answers with
// a "missing" hint but accepts the data).
//
// Sign conventions (ABRP): power is negative while charging, speed in km/h,
// odometer in km, temperatures in °C, booleans as 0/1.

const https = require('node:https');

const ABRP_SEND_HOST = 'api.iternio.com';
const ABRP_SEND_PATH = '/1/tlm/send';
const ABRP_TIMEOUT_MS = 10000;

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

// Pure: parse a VIN -> user-token map from a JSON text field.
// Returns {} for empty/invalid input (never throws).
function parseAbrpTokens(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    const tokens = {};
    for (const [vin, token] of Object.entries(parsed)) {
        if (typeof vin === 'string' && typeof token === 'string' && token.trim() !== '') {
            tokens[vin.trim().toUpperCase()] = token.trim();
        }
    }
    return tokens;
}

// Pure: build the tlm payload from a normalized vehicle object.
// Only includes fields with real values; returns {tlm, hasSoc}.
function buildAbrpTelemetry(vehicle, options) {
    const opts = options || {};
    const source = vehicle || {};
    const tlm = {};
    const lastUpdatedMs = finiteNumber(source.lastUpdated);
    const nowMs = Number(opts.nowMs) || Date.now();
    tlm.utc = Math.floor((lastUpdatedMs !== null ? lastUpdatedMs : nowMs) / 1000);
    const soc = finiteNumber(source.batteryLevel);
    if (soc !== null) {
        tlm.soc = soc;
    }
    const charging = Boolean(source.isCharging);
    tlm.is_charging = charging ? 1 : 0;
    const chargePowerKw = finiteNumber(source.chargePower);
    if (charging && chargePowerKw !== null && chargePowerKw > 0) {
        // ABRP expects negative power while charging.
        tlm.power = -chargePowerKw;
    }
    const speedKmh = finiteNumber(source.currentSpeed);
    if (speedKmh !== null) {
        tlm.speed = speedKmh;
        tlm.is_parked = speedKmh === 0 ? 1 : 0;
    }
    const lat = finiteNumber(source.latitude);
    const lon = finiteNumber(source.longitude);
    if (lat !== null && lon !== null) {
        tlm.lat = lat;
        tlm.lon = lon;
    }
    const odometerKm = finiteNumber(source.odometerKm);
    if (odometerKm !== null) {
        tlm.odometer = odometerKm;
    }
    const rangeKm = finiteNumber(source.rangeKm);
    if (rangeKm !== null) {
        tlm.est_battery_range = rangeKm;
    }
    const capacityKwh = finiteNumber(opts.capacityKwh);
    if (capacityKwh !== null && capacityKwh > 0) {
        tlm.capacity = capacityKwh;
    }
    return { tlm, hasSoc: soc !== null };
}

// Pure: build the full send URL (tlm JSON is URL-encoded).
function buildAbrpSendUrl(apiKey, userToken, tlm) {
    const params = new URLSearchParams({
        api_key: String(apiKey || ''),
        token: String(userToken || ''),
        tlm: JSON.stringify(tlm || {}),
    });
    return `https://${ABRP_SEND_HOST}${ABRP_SEND_PATH}?${params.toString()}`;
}

// Default transport using built-in https (10s timeout). Host is fixed to
// api.iternio.com so there is no open-redirect/SSRF surface.
function defaultAbrpRequest(url) {
    return new Promise(resolve => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            resolve({ ok: false, error: `invalid ABRP URL: ${error.message}` });
            return;
        }
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== ABRP_SEND_HOST) {
            resolve({ ok: false, error: `unexpected ABRP host: ${parsed.hostname}` });
            return;
        }
        const request = https.request(
            {
                method: 'POST',
                hostname: parsed.hostname,
                port: 443,
                path: `${parsed.pathname}${parsed.search}`,
                timeout: ABRP_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            },
            response => {
                let body = '';
                response.on('data', chunk => {
                    body += chunk;
                    if (body.length > 8192) {
                        body = body.slice(0, 8192);
                    }
                });
                response.on('end', () => {
                    const status = response.statusCode || 0;
                    if (status >= 200 && status < 300) {
                        resolve({ ok: true, status, body: body.slice(0, 2048) });
                    } else {
                        resolve({ ok: false, error: `ABRP http ${status}: ${body.slice(0, 256)}` });
                    }
                });
            },
        );
        request.on('timeout', () => request.destroy(new Error('ABRP timeout')));
        request.on('error', error => resolve({ ok: false, error: `ABRP send failed: ${error.message}` }));
        request.end();
    });
}

// Send one telemetry payload. The request function is injectable for tests.
async function postAbrpTelemetry(url, requestFn) {
    const send = typeof requestFn === 'function' ? requestFn : defaultAbrpRequest;
    try {
        return await send(url);
    } catch (error) {
        return { ok: false, error: `ABRP send failed: ${error.message}` };
    }
}

module.exports = {
    ABRP_SEND_HOST,
    ABRP_SEND_PATH,
    ABRP_TIMEOUT_MS,
    parseAbrpTokens,
    buildAbrpTelemetry,
    buildAbrpSendUrl,
    postAbrpTelemetry,
    defaultAbrpRequest,
};
