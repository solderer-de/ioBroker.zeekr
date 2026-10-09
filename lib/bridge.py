#!/usr/bin/env python3
import json
import os
import sys


try:
    import venv
except ImportError:  # pragma: no cover - very old Python fallback
    venv = None


def _venv_python_exe():
    """Pfad zum Python des Adapter-venvs (gesetzt via ZEEKR_VENV)."""
    venv_dir = os.environ.get('ZEEKR_VENV')
    if not venv_dir:
        return None
    if os.name == 'nt':
        candidate = os.path.join(venv_dir, 'Scripts', 'python.exe')
    else:
        candidate = os.path.join(venv_dir, 'bin', 'python')
    if os.path.exists(candidate):
        return candidate
    return None


def _reexec_into_venv(action, payload):
    """Nach ensure(): Laeuft dieses Skript nicht selbst im venv-Python (z.B.
    frisch installierter Adapter, dessen .venv gerade erst angelegt wurde),
    dort neu starten. stdin ist dann schon verbraucht, der Payload wandert
    deshalb ueber die Env-Variable ZEEKR_PAYLOAD_RAW mit."""
    target = _venv_python_exe()
    if not target:
        return False
    # Achtung: kein samefile-Vergleich der Binaries — .venv/bin/python ist
    # (per symlinks=True) oft ein Symlink auf genau dieses System-Python.
    # Entscheidend ist sys.prefix: zeigt es nicht ins venv, laufen wir
    # ausserhalb und muessen wechseln.
    venv_dir = os.environ.get('ZEEKR_VENV') or ''
    try:
        in_venv = bool(venv_dir) and os.path.abspath(sys.prefix) == os.path.abspath(venv_dir)
    except OSError:
        in_venv = False
    if in_venv:
        return False
    env = dict(os.environ)
    env['ZEEKR_PAYLOAD_RAW'] = json.dumps(payload if isinstance(payload, dict) else {})
    try:
        # execve (nicht execv): nur so kommt ZEEKR_PAYLOAD_RAW im Kind an.
        os.execve(target, [target, os.path.abspath(__file__), action], env)
    except OSError:
        return False
    return False  # unreachable — execv ersetzt den Prozess


def ensure_runtime_dependencies():
    venv_dir = os.environ.get('ZEEKR_VENV')
    if not venv_dir:
        return
    if not os.path.isdir(venv_dir):
        if venv is None:
            return
        venv.EnvBuilder(with_pip=True, clear=False, symlinks=True).create(venv_dir)
    if os.name == 'nt':
        python_exe = os.path.join(venv_dir, 'Scripts', 'python.exe')
    else:
        python_exe = os.path.join(venv_dir, 'bin', 'python')
    if not os.path.exists(python_exe):
        return
    import subprocess
    # A venv created without ensurepip support (e.g. missing python3-venv on
    # Debian) has no pip at all — bootstrap it instead of crashing.
    probe = subprocess.run([python_exe, '-m', 'pip', '--version'], capture_output=True, timeout=60)
    if probe.returncode != 0:
        subprocess.check_call([python_exe, '-m', 'ensurepip', '--default-pip'], timeout=120)
    # Pinned install from requirements.txt (single source of truth).
    # Falls back to a pinned version if requirements.txt is missing.
    req_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'requirements.txt')
    target = ['-r', req_file] if os.path.exists(req_file) else ['zeekr-ev-api==0.1.15']
    subprocess.check_call([python_exe, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'] + target, timeout=180)


def get_first(*sources, keys, default=None):
    """Explicit lookup across dicts in priority order. No deep-recursive guessing."""
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            if value is not None and value != '':
                return value
    return default


def coerce_number(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        cleaned = value.strip().replace(',', '.').rstrip('%')
        try:
            num = float(cleaned)
            return int(num) if num.is_integer() else num
        except ValueError:
            return None
    return None


def find_value(payload, keys):
    if payload is None:
        return None
    if isinstance(payload, dict):
        for key in keys:
            if key in payload and payload[key] is not None:
                return payload[key]
        for value in payload.values():
            result = find_value(value, keys)
            if result is not None:
                return result
    elif isinstance(payload, list):
        for value in payload:
            result = find_value(value, keys)
            if result is not None:
                return result
    return None


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {'1', 'true', 'yes', 'y', 'on', 'active', 'charging', 'plugged', 'locked'}:
            return True
        if normalized in {'0', 'false', 'no', 'n', 'off', 'inactive', 'unplugged', 'unlocked', 'none', 'null', ''}:
            return False
    return bool(value)


MOCK_VEHICLES = [
    {
        'name': 'Mock Zeekr 001',
        'vin': 'MOCKVIN1234567890',
        'batteryLevel': 78,
        'rangeKm': 420,
        'odometerKm': 12345,
        'chargePower': 11,
        'currentSpeed': 0,
        'pluggedIn': True,
        'isCharging': True,
        'temperature': 21.5,
        'chargingState': 'charging',
        'lockState': 'locked',
        'isLocked': True,
        'climateOn': False,
        'lastUpdated': '2026-01-01T00:00:00Z',
        'chargingLimit': 90,
        'tirePressureFl': 2.5,
        'tirePressureFr': 2.5,
        'tirePressureRl': 2.4,
        'tirePressureRr': 2.4,
        'latitude': 52.52,
        'longitude': 13.405,
        'battery12v': 14.1,
        'chargePlan': {'enabled': False},
        'travelPlan': {'enabled': False},
        'lastTripDistanceKm': 42.5,
        'centralLockingStatus': 'locked',
        'windowPositionAvg': 0,
        'doorOpen': {'doorOpenStatusDriver': False, 'doorOpenStatusPassenger': False,
                     'doorOpenStatusDriverRear': False, 'doorOpenStatusPassengerRear': False,
                     'trunkOpenStatus': False},
        'avgPowerConsumption': 18.5,
        'traveledDistanceKm': 120.3,
        'engineStatus': 'off',
        'maintenanceStatus': 'ok',
        'maintenanceRaw': {'mock': True},
        'tripCount': 1,
        'tripList': [{'distance': 42.5}],
        'status': {'mock': True},
        'chargingStatus': {'mock': True},
        'remoteControlState': {'mock': True},
        'vtmStatus': {'mock': True},
        'chargingLimitRaw': {'mock': True},
        'chargePlanRaw': {'mock': True},
        'travelPlanRaw': {'mock': True},
        'journeySummary': {'mock': True},
        'raw': {'mock': True},
    }
]


def normalize_vehicle(vehicle_info, status=None, charging_status=None, remote_state=None,
                      vtm_status=None, charging_limit=None, charge_plan=None,
                      travel_plan=None, journey_summary=None):
    if hasattr(vehicle_info, '__dict__'):
        vehicle_dict = {key: getattr(vehicle_info, key) for key in dir(vehicle_info) if not key.startswith('_')}
    elif isinstance(vehicle_info, dict):
        vehicle_dict = vehicle_info
    else:
        vehicle_dict = {}

    status_payload = status if isinstance(status, dict) else {}
    charging_payload = charging_status if isinstance(charging_status, dict) else {}
    remote_payload = remote_state if isinstance(remote_state, dict) else {}
    vtm_payload = vtm_status if isinstance(vtm_status, dict) else {}
    limit_payload = charging_limit if isinstance(charging_limit, dict) else {}
    charge_plan_payload = charge_plan if isinstance(charge_plan, dict) else {}
    travel_plan_payload = travel_plan if isinstance(travel_plan, dict) else {}
    journey_payload = journey_summary if isinstance(journey_summary, dict) else {}

    # additionalVehicleStatus (drivingSafetyStatus, electricVehicleStatus,
    # climateStatus) liegt teils eine Ebene tiefer -> als Fallback mit einbeziehen.
    # Explizite Priorität: vehicle -> status -> charging -> remote, danach nested.
    nested_subs = []
    for container in (status_payload, vtm_payload, charging_payload, vehicle_dict):
        if not isinstance(container, dict):
            continue
        add = container.get('additionalVehicleStatus')
        if isinstance(add, dict):
            for sub in add.values():
                if isinstance(sub, dict) and sub not in nested_subs:
                    nested_subs.append(sub)
    # basicVehicleStatus (speed, engineStatus) und position (lat/lon) liegen
    # ebenfalls verschachtelt (EU/Overseas-API) — explizit als Quelle.
    basic_payload = status_payload.get('basicVehicleStatus')
    if not isinstance(basic_payload, dict):
        basic_payload = {}
    position_payload = basic_payload.get('position')
    if not isinstance(position_payload, dict):
        position_payload = {}
    name = get_first(vehicle_dict, status_payload, charging_payload, remote_payload,
                     keys=['vehicleName', 'displayName', 'name', 'modelName'], default='Vehicle')
    vin = get_first(vehicle_dict, status_payload,
                    keys=['vin', 'VIN', 'vehicleId', 'vehicle_id'], default='') or ''
    battery = coerce_number(get_first(vehicle_dict, status_payload, charging_payload, *nested_subs,
                                      keys=['batteryLevel', 'battery_level', 'stateOfCharge', 'soc', 'chargeLevel']))
    range_km = coerce_number(get_first(vehicle_dict, status_payload, *nested_subs,
                                       keys=['rangeKm', 'range_km', 'drivingRange', 'remainingRange',
                                             'distanceToEmpty', 'distanceToEmptyOnBatteryOnly',
                                             'distanceToEmptyOnBattery', 'remainingMileage']))
    odometer = coerce_number(get_first(vehicle_dict, status_payload, *nested_subs,
                                       keys=['odometerKm', 'odometer_km', 'mileage', 'odometerValue', 'odometer']))
    charge_power = coerce_number(get_first(charging_payload, status_payload,
                                           keys=['chargePower', 'chargingPower', 'chargingPowerKw']))
    current_speed = coerce_number(get_first(vehicle_dict, status_payload, *nested_subs, basic_payload,
                                            keys=['currentSpeed', 'vehicleSpeed', 'travelSpeed', 'speed']))
    plugged_in = get_first(charging_payload, status_payload, vehicle_dict,
                           keys=['pluggedIn', 'isPluggedIn', 'chargingCableConnected'])
    charging = get_first(charging_payload, status_payload,
                         keys=['isCharging', 'is_charging', 'charging'])
    temperature = coerce_number(get_first(status_payload, vehicle_dict, *nested_subs,
                                          keys=['insideTemperature', 'inside_temp', 'cabinTemperature',
                                                'temperature', 'interiorTemp', 'exteriorTemp']))
    charging_state = get_first(charging_payload, status_payload,
                               keys=['chargingState', 'chargeState', 'chargeStatus'])
    if not isinstance(charging_state, str):
        charging_state = ''
    # Türen/Kofferraum: nur Felder mit eindeutiger Semantik werden kuratiert:
    # *OpenStatus (1 = offen), *LockStatus (1 = verriegelt). Unklare Enums
    # (winStatus, sunroofOpenStatus, tankFlapStatus) bleiben in der Roh-Schicht.
    def _is_open(value):
        if isinstance(value, bool):
            return value
        return str(value if value is not None else '').strip().lower() in {
            '1', 'true', 'open', 'opened', 'yes', 'on'}

    def _is_locked(value):
        if isinstance(value, bool):
            return value
        return str(value if value is not None else '').strip().lower() in {
            '1', 'true', 'locked', 'yes', 'on'}

    door_open_keys = ['doorOpenStatusDriver', 'doorOpenStatusPassenger',
                      'doorOpenStatusDriverRear', 'doorOpenStatusPassengerRear']
    door_lock_keys = ['doorLockStatusDriver', 'doorLockStatusPassenger',
                      'doorLockStatusDriverRear', 'doorLockStatusPassengerRear']
    door_open = {}
    for door_key in door_open_keys + ['trunkOpenStatus']:
        raw_door = get_first(status_payload, vtm_payload, *nested_subs, keys=[door_key])
        if raw_door is None:
            door_open[door_key] = None
        else:
            door_open[door_key] = _is_open(raw_door)
    doors_open = any(door_open.get(key) for key in door_open_keys)
    door_locks = [get_first(status_payload, vtm_payload, *nested_subs, keys=[key]) for key in door_lock_keys]
    door_locks_known = [flag for flag in door_locks if flag is not None and str(flag).strip() != '']
    doors_locked = all(_is_locked(flag) for flag in door_locks_known) if door_locks_known else False
    trunk_open = bool(door_open.get('trunkOpenStatus'))
    trunk_locked = _is_locked(get_first(status_payload, vtm_payload, *nested_subs, keys=['trunkLockStatus']))
    hood_open = _is_open(get_first(status_payload, vtm_payload, *nested_subs,
                                   keys=['engineHoodOpenStatus', 'hoodOpenStatus', 'bonnetOpenStatus']))
    # Komfort-Status (Sitz/Lenkrad/Defrost/Lüftung/Akku-Vorwärmung): coerce_bool
    # versteht alle beobachteten Formen (true/false, 0/1, "0"/"2"/"").
    seat_heating = any(coerce_bool(get_first(status_payload, vtm_payload, *nested_subs, keys=[key]))
                       for key in ['drvHeatSts', 'passHeatingSts', 'rlHeatingSts', 'rrHeatingSts'])
    steering_heating = coerce_bool(get_first(status_payload, vtm_payload, *nested_subs,
                                             keys=['steerWhlHeatingSts', 'steeringHeating',
                                                   'steeringWheelHeating']))
    defrost_active = coerce_bool(get_first(status_payload, vtm_payload, *nested_subs,
                                           keys=['defrost', 'defrostActive', 'defrosting']))
    vent_active = coerce_bool(get_first(status_payload, vtm_payload, *nested_subs,
                                        keys=['ventilateStatus', 'ventilationActive', 'ventActive']))
    battery_preheat = coerce_bool(get_first(status_payload, vtm_payload, *nested_subs,
                                            keys=['hvBatteryPreHeatingActive', 'batteryPreheatActive',
                                                  'batteryPreheating']))
    central_locking = get_first(
        status_payload, vtm_payload, vehicle_dict, *nested_subs,
        keys=['centralLockingStatus', 'doorLockStatus'])
    if not isinstance(central_locking, str):
        central_locking = str(central_locking) if central_locking is not None else ''
    lock_state = get_first(status_payload, remote_payload, vehicle_dict,
                           keys=['lockState', 'doorLockStatus', 'lock_status', 'lockStatus'])
    if not isinstance(lock_state, str):
        lock_state = str(lock_state) if lock_state is not None else ''
    is_locked = get_first(status_payload, remote_payload, vehicle_dict,
                          keys=['isLocked', 'is_locked', 'vehicleLocked', 'locked'])
    # 'locked' string handling: only exact 'locked' => True, 'unlocked' => False.
    # Without an explicit flag, derive from door locks, then central locking,
    # then lock state text (all fall back to False = unknown).
    if isinstance(is_locked, str) and is_locked.strip().lower() in {'locked', 'unlocked'}:
        is_locked_bool = is_locked.strip().lower() == 'locked'
    elif is_locked is None:
        if door_locks_known:
            is_locked_bool = doors_locked
        elif central_locking is not None and str(central_locking).strip() != '':
            is_locked_bool = _is_locked(central_locking)
        elif lock_state:
            is_locked_bool = str(lock_state).strip().lower() == 'locked'
        else:
            is_locked_bool = False
    else:
        is_locked_bool = coerce_bool(is_locked)
    climate_on = get_first(remote_payload, status_payload,
                           keys=['climateOn', 'hvacOn', 'airConditioning'])
    last_updated = get_first(vehicle_dict, status_payload, charging_payload,
                             keys=['lastUpdated', 'updatedAt', 'updateTime'])
    if not isinstance(last_updated, str):
        last_updated = str(last_updated) if last_updated is not None else ''

    # Charging bool: ignore dict payloads (old code: bool({}) == True bug).
    if isinstance(charging, dict):
        charging_bool = False
    else:
        charging_bool = coerce_bool(charging)

    # --- Roadmap: erweiterte Datenpunkte (alles optional, None wenn fehlt) ---
    charging_limit = coerce_number(get_first(
        limit_payload, charging_payload, status_payload,
        keys=['chargingLimit', 'chargeLimit', 'socLimit', 'targetSoc', 'maxSoc', 'limitSoc', 'soc']))
    if charging_limit is not None and charging_limit > 100:
        # API liefert SoC-Limit mal 10 (z.B. 800 -> 80 %).
        charging_limit = charging_limit / 10.0
    def _tire_pressure(primary_keys, kpa_key):
        direct = coerce_number(get_first(vtm_payload, status_payload, keys=primary_keys))
        if direct is not None:
            return direct
        # EU overseas reports tyre pressure in kPa (e.g. 275) under tyreStatus*,
        # states expect bar -> convert only this source.
        kpa = coerce_number(get_first(vtm_payload, status_payload, *nested_subs, keys=[kpa_key]))
        return kpa / 100.0 if kpa is not None else None

    tire_fl = _tire_pressure(['tirePressureFl', 'tyrePressureFl', 'flTirePressure', 'tireFl'], 'tyreStatusDriver')
    tire_fr = _tire_pressure(['tirePressureFr', 'tyrePressureFr', 'frTirePressure', 'tireFr'], 'tyreStatusPassenger')
    tire_rl = _tire_pressure(['tirePressureRl', 'tyrePressureRl', 'rlTirePressure', 'tireRl'], 'tyreStatusDriverRear')
    tire_rr = _tire_pressure(['tirePressureRr', 'tyrePressureRr', 'rrTirePressure', 'tireRr'], 'tyreStatusPassengerRear')
    latitude = coerce_number(get_first(vtm_payload, status_payload, position_payload, vehicle_dict,
                                         *nested_subs, keys=['latitude', 'lat', 'vehicleLat']))
    longitude = coerce_number(get_first(vtm_payload, status_payload, position_payload, vehicle_dict,
                                        *nested_subs, keys=['longitude', 'lon', 'lng', 'vehicleLon']))
    # 12V board battery hides two levels deep (maintenanceStatus.mainBatteryStatus).
    main_battery_payload = {}
    for sub in nested_subs:
        candidate = sub.get('mainBatteryStatus') if isinstance(sub, dict) else None
        if isinstance(candidate, dict):
            main_battery_payload = candidate
            break
    battery_12v = coerce_number(get_first(vtm_payload, status_payload, main_battery_payload,
                                          keys=['battery12v', 'voltage12v', 'lowVoltageBattery', 'auxBattery', 'voltage']))
    last_trip = coerce_number(get_first(journey_payload, keys=['lastTripDistanceKm', 'lastTripDistance', 'lastDistance']))
    if last_trip is None:
        trips = journey_payload.get('trips') if isinstance(journey_payload.get('trips'), list) else None
        if trips:
            last_trip = coerce_number((trips[0] or {}).get('distance') if isinstance(trips[0], dict) else None)
    win_positions = []
    for win_key in ['winPosDriver', 'winPosPassenger', 'winPosDriverRear', 'winPosPassengerRear']:
        win_positions.append(coerce_number(get_first(
            status_payload, vtm_payload, *nested_subs, keys=[win_key])))
    win_positions = [v for v in win_positions if v is not None]
    window_position_avg = sum(win_positions) / len(win_positions) if win_positions else None
    windows_open = any(value > 0 for value in win_positions)
    avg_consumption = coerce_number(get_first(
        status_payload, vtm_payload, *nested_subs,
        keys=['averPowerConsumption', 'avgPowerConsumption', 'powerConsumption',
              'averageConsumption', 'consumption']))
    traveled_distance = coerce_number(get_first(
        status_payload, vtm_payload, vehicle_dict, *nested_subs,
        keys=['traveledDistance', 'tripDistance', 'totalTripDistance']))
    engine_status = get_first(status_payload, vtm_payload, *nested_subs, basic_payload,
                              keys=['engineStatus', 'runningStatus'])
    if not isinstance(engine_status, str):
        engine_status = str(engine_status) if engine_status is not None else ''
    maintenance = get_first(status_payload, vtm_payload, vehicle_dict, *nested_subs,
                            keys=['maintenanceStatus', 'maintenance'])
    if isinstance(maintenance, dict):
        maintenance_raw = maintenance
        maintenance = maintenance.get('status') or maintenance.get('state') or ''
    else:
        maintenance_raw = {}
    if not isinstance(maintenance, str):
        maintenance = str(maintenance) if maintenance is not None else ''
    # Service interval: plain numbers with known units (km / days). Fluid
    # levels and warning enums stay in the raw layer (unknown scales).
    service_distance = coerce_number(get_first(
        status_payload, vtm_payload, *nested_subs,
        keys=['distanceToService', 'distanceToNextService', 'serviceDistanceKm', 'nextServiceKm']))
    service_days = coerce_number(get_first(
        status_payload, vtm_payload, *nested_subs,
        keys=['daysToService', 'daysToNextService', 'nextServiceDays']))
    repair_mode = get_first(
        status_payload, vtm_payload, *nested_subs,
        keys=['repairModeActive', 'repairMode'])
    trip_list = journey_payload.get('trips') if isinstance(journey_payload.get('trips'), list) else []
    trip_count = journey_payload.get('total') or journey_payload.get('count') or len(trip_list)
    try:
        trip_count = int(trip_count)
    except (TypeError, ValueError):
        trip_count = len(trip_list)

    return {
        'name': name,
        'vin': vin,
        'batteryLevel': battery,
        'rangeKm': range_km,
        'odometerKm': odometer,
        'chargePower': charge_power,
        'currentSpeed': current_speed,
        'pluggedIn': coerce_bool(plugged_in),
        'isCharging': charging_bool,
        'temperature': temperature,
        'chargingState': charging_state,
        'lockState': lock_state,
        'isLocked': is_locked_bool,
        'climateOn': coerce_bool(climate_on),
        'lastUpdated': last_updated,
        'chargingLimit': charging_limit,
        'tirePressureFl': tire_fl,
        'tirePressureFr': tire_fr,
        'tirePressureRl': tire_rl,
        'tirePressureRr': tire_rr,
        'latitude': latitude,
        'longitude': longitude,
        'battery12v': battery_12v,
        'chargePlan': charge_plan_payload,
        'travelPlan': travel_plan_payload,
        'lastTripDistanceKm': last_trip,
        'centralLockingStatus': central_locking,
        'windowPositionAvg': window_position_avg,
        'doorOpen': door_open,
        'doorsOpen': doors_open,
        'doorsLocked': doors_locked,
        'trunkOpen': trunk_open,
        'trunkLocked': trunk_locked,
        'hoodOpen': hood_open,
        'windowsOpen': windows_open,
        'seatHeatingActive': seat_heating,
        'steeringHeatingActive': steering_heating,
        'defrostActive': defrost_active,
        'ventActive': vent_active,
        'batteryPreheatActive': battery_preheat,
        'avgPowerConsumption': avg_consumption,
        'traveledDistanceKm': traveled_distance,
        'engineStatus': engine_status,
        'maintenanceStatus': maintenance,
        'maintenanceRaw': maintenance_raw,
        'distanceToService': service_distance,
        'daysToService': service_days,
        'repairModeActive': coerce_bool(repair_mode),
        'tripCount': trip_count,
        'tripList': trip_list,
        'status': status_payload,
        'chargingStatus': charging_payload,
        'remoteControlState': remote_payload,
        'vtmStatus': vtm_payload,
        'chargingLimitRaw': limit_payload,
        'chargePlanRaw': charge_plan_payload,
        'travelPlanRaw': travel_plan_payload,
        'journeySummary': journey_payload,
    }


def load_payload() -> tuple[str, dict]:
    action = sys.argv[1] if len(sys.argv) > 1 else 'vehicles'
    # New path: JSON via stdin (avoids ARG_MAX + leaking secrets in ps).
    # Old path (argv[2]) kept for backward compatibility with tests.
    raw = ''
    if len(sys.argv) > 2:
        raw = sys.argv[2]
    elif not sys.stdin.isatty():
        try:
            raw = sys.stdin.read() or ''
        except Exception:
            raw = ''
    if not raw.strip():
        # Re-exec-Pfad: Payload kam via Env-Variable mit (stdin verbraucht).
        raw = os.environ.get('ZEEKR_PAYLOAD_RAW') or ''
    if not raw.strip():
        return action, {}
    try:
        return action, json.loads(raw)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON payload", "vehicles": [], "connection": False}))
        raise SystemExit(0)


def main() -> int:
    action, payload = load_payload()

    username = payload.get('username') or os.getenv('ZEEKR_USERNAME') or ''
    password = payload.get('password') or os.getenv('ZEEKR_PASSWORD') or ''
    country_code = payload.get('countryCode') or payload.get('country_code') or os.getenv('ZEEKR_COUNTRY_CODE') or 'AU'
    hmac_access_key = payload.get('hmacAccessKey') or payload.get('hmac_access_key') or os.getenv('ZEEKR_HMAC_ACCESS_KEY') or ''
    hmac_secret_key = payload.get('hmacSecretKey') or payload.get('hmac_secret_key') or os.getenv('ZEEKR_HMAC_SECRET_KEY') or ''
    password_public_key = payload.get('passwordPublicKey') or payload.get('password_public_key') or os.getenv('ZEEKR_PASSWORD_PUBLIC_KEY') or ''
    prod_secret = payload.get('prodSecret') or payload.get('prod_secret') or os.getenv('ZEEKR_PROD_SECRET') or ''
    prod_candidates_raw = payload.get('prodSecretCandidates') or payload.get('prod_secret_candidates') or ''
    if isinstance(prod_candidates_raw, str):
        prod_candidates = [c.strip() for c in prod_candidates_raw.split(',') if c.strip()]
    elif isinstance(prod_candidates_raw, list):
        prod_candidates = [str(c).strip() for c in prod_candidates_raw if str(c).strip()]
    else:
        prod_candidates = []
    # Primär zuerst, dann Kandidaten (3.0.3 hat mehrere). Duplikate raus.
    prod_try_list = []
    for cand in [prod_secret] + prod_candidates:
        if cand and cand not in prod_try_list:
            prod_try_list.append(cand)
    if not prod_try_list:
        prod_try_list = ['']
    vin_key = payload.get('vinKey') or payload.get('vin_key') or os.getenv('ZEEKR_VIN_KEY') or ''
    vin_iv = payload.get('vinIv') or payload.get('vin_iv') or os.getenv('ZEEKR_VIN_IV') or ''

    if not username or not password:
        print(json.dumps({"error": "Missing Zeekr credentials", "vehicles": [], "connection": False}))
        return 0

    mock_mode = bool(payload.get('mockMode')) or username == 'mock' or os.getenv('ZEEKR_MOCK') == '1'
    if mock_mode:
        if action == 'test_connection':
            print(json.dumps({"ok": True, "mock": True, "vehicleCount": len(MOCK_VEHICLES)}))
            return 0
        if action in ('vehicles', 'command', 'set_charge_plan', 'set_travel_plan'):
            if action == 'vehicles':
                print(json.dumps({"vehicles": MOCK_VEHICLES, "mock": True}))
                return 0
            print(json.dumps({"ok": True, "mock": True}))
            return 0

    try:
        from zeekr_ev_api.client import ZeekrClient, ZeekrException  # type: ignore
    except ImportError:
        # Only touch venv/pip/network when the import really fails — a
        # system-wide install or a pre-seeded venv then just works.
        try:
            ensure_runtime_dependencies()
        except Exception as exc:
            print(json.dumps({
                "error": (
                    f"Python dependency setup failed: {exc}. "
                    "On Debian/Ubuntu install python3-venv and python3-pip, "
                    "delete the adapter .venv directory and restart the instance."
                ),
                "vehicles": [],
                "connection": False,
            }))
            return 0
        # ensure() hat das venv ggf. gerade erst angelegt/befuellt — laeuft
        # dieses Skript noch unter System-Python, ins venv wechseln, sonst
        # schlaegt der zweite Import zwangslaeufig wieder fehl.
        _reexec_into_venv(action, payload)
        try:
            from zeekr_ev_api.client import ZeekrClient, ZeekrException  # type: ignore
        except ImportError as import_error:
            # Diagnose mitschicken: Welches Python lief, was schlug fehl?
            # (Der Adapter nutzt denselben String als Log-Meldung.)
            print(json.dumps({
                "error": (
                    "Python dependency zeekr_ev_api not installed "
                    f"(python={sys.executable}, import_error={import_error}, "
                    f"path={os.pathsep.join(sys.path[:4])}). "
                    "Install requirements.txt into the adapter venv: "
                    ".venv/bin/pip install -r requirements.txt"
                ),
                "vehicles": [],
            }))
            return 0

    try:
        last_login_error = None
        client = None
        for prod_candidate in prod_try_list:
            try:
                client = ZeekrClient(
                    username=username,
                    password=password,
                    country_code=country_code,
                    hmac_access_key=hmac_access_key,
                    hmac_secret_key=hmac_secret_key,
                    password_public_key=password_public_key,
                    prod_secret=prod_candidate,
                    vin_key=vin_key,
                    vin_iv=vin_iv,
                )
                client.login()
                prod_secret = prod_candidate
                break
            except Exception as exc:
                last_login_error = exc
                # Nur bei Signatur-Fehlern nächsten Kandidaten versuchen, sonst sofort raus.
                msg = str(exc)
                if '079025' in msg or 'Signature' in msg or 'signature' in msg:
                    continue
                raise
        if client is None:
            raise last_login_error or RuntimeError('Login failed')
        if action == 'test_connection':
            try:
                count = len(client.get_vehicle_list())
            except Exception:
                count = -1
            print(json.dumps({"ok": True, "vehicleCount": count}))
            return 0
        if action == 'command':
            vin = payload.get('vin') or ''
            command = payload.get('command') or ''
            service_id = payload.get('serviceId') or ''
            setting = payload.get('setting') or {}
            vehicle = next((item for item in client.get_vehicle_list() if getattr(item, 'vin', None) == vin), None)
            if vehicle is None:
                print(json.dumps({"error": "Vehicle not found", "ok": False}))
                return 0
            ok = vehicle.do_remote_control(command, service_id, setting)
            print(json.dumps({"ok": ok}))
            return 0
        if action in ('set_charge_plan', 'set_travel_plan'):
            vin = payload.get('vin') or ''
            vehicle = next((item for item in client.get_vehicle_list() if getattr(item, 'vin', None) == vin), None)
            if vehicle is None:
                print(json.dumps({"error": "Vehicle not found", "ok": False}))
                return 0
            try:
                if action == 'set_charge_plan':
                    ok = vehicle.set_charge_plan(
                        start_time=payload.get('startTime') or '',
                        end_time=payload.get('endTime') or '',
                        command=payload.get('planCommand') or payload.get('command') or 'start',
                        bc_cycle_active=bool(payload.get('bcCycleActive')),
                        bc_temp_active=bool(payload.get('bcTempActive')),
                    )
                else:
                    ok = vehicle.set_travel_plan(
                        command=payload.get('planCommand') or payload.get('command') or 'start',
                        start_time=payload.get('startTime') or '',
                        scheduled_time=payload.get('scheduledTime') or '',
                        ac_preconditioning=bool(payload.get('acPreconditioning', True)),
                        steering_wheel_heating=bool(payload.get('steeringWheelHeating')),
                    )
            except TypeError as exc:
                print(json.dumps({"error": f"Plan API mismatch (ev-api update?): {exc}", "ok": False}))
                return 0
            print(json.dumps({"ok": bool(ok)}))
            return 0
        vehicles = client.get_vehicle_list()
        normalized = []
        for vehicle in vehicles:
            status = {}
            charging_status = {}
            remote_state = {}
            vtm_status = {}
            charging_limit = {}
            charge_plan = {}
            travel_plan = {}
            journey = {}
            try:
                status = vehicle.get_status() or {}
            except Exception:  # pragma: no cover - bridge should not crash on one vehicle
                status = {}
            try:
                charging_status = vehicle.get_charging_status() or {}
            except Exception:
                charging_status = {}
            try:
                remote_state = vehicle.get_remote_control_state() or {}
            except Exception:
                remote_state = {}
            try:
                vtm_status = vehicle.get_vtm_status() or {}
            except Exception:
                vtm_status = {}
            try:
                charging_limit = vehicle.get_charging_limit() or {}
            except Exception:
                charging_limit = {}
            try:
                charge_plan = vehicle.get_charge_plan() or {}
            except Exception:
                charge_plan = {}
            try:
                travel_plan = vehicle.get_travel_plan() or {}
            except Exception:
                travel_plan = {}
            try:
                journey = vehicle.get_journey_log(page_size=10, current_page=1) or {}
            except Exception:
                journey = {}
            normalized.append(normalize_vehicle(
                vehicle.data or {}, status, charging_status, remote_state,
                vtm_status, charging_limit, charge_plan, travel_plan, journey))
        print(json.dumps({"vehicles": normalized}))
        return 0
    except ZeekrException as exc:
        print(json.dumps({"error": str(exc), "vehicles": [], "connection": False}))
        return 0
    except Exception as exc:  # pragma: no cover - bridge should not crash the adapter
        print(json.dumps({"error": str(exc), "vehicles": [], "connection": False}))
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
