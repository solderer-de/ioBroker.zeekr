#!/usr/bin/env python3
import json
import os
import sys


try:
    import venv
except ImportError:  # pragma: no cover - very old Python fallback
    venv = None


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
    # Pinned install from requirements.txt (single source of truth).
    # Falls back to a pinned version if requirements.txt is missing.
    req_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'requirements.txt')
    target = ['-r', req_file] if os.path.exists(req_file) else ['zeekr-ev-api==0.1.15']
    subprocess.check_call([python_exe, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'] + target, timeout=180)


ensure_runtime_dependencies()


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


def normalize_vehicle(vehicle_info, status=None, charging_status=None, remote_state=None):
    if hasattr(vehicle_info, '__dict__'):
        vehicle_dict = {key: getattr(vehicle_info, key) for key in dir(vehicle_info) if not key.startswith('_')}
    elif isinstance(vehicle_info, dict):
        vehicle_dict = vehicle_info
    else:
        vehicle_dict = {}

    status_payload = status if isinstance(status, dict) else {}
    charging_payload = charging_status if isinstance(charging_status, dict) else {}
    remote_payload = remote_state if isinstance(remote_state, dict) else {}
    combined_payload = {
        'vehicle': vehicle_dict,
        'status': status_payload,
        'charging': charging_payload,
        'remote': remote_payload,
    }

    # Explicit priority: vehicle -> status -> charging -> remote. No blind deep-scan
    # for generic keys like 'range'/'power'/'id' anymore (false-positive source).
    name = get_first(vehicle_dict, status_payload, charging_payload, remote_payload,
                     keys=['vehicleName', 'displayName', 'name', 'modelName'], default='Vehicle')
    vin = get_first(vehicle_dict, status_payload,
                    keys=['vin', 'VIN', 'vehicleId', 'vehicle_id'], default='') or ''
    battery = coerce_number(get_first(vehicle_dict, status_payload, charging_payload,
                                      keys=['batteryLevel', 'battery_level', 'stateOfCharge', 'soc']))
    range_km = coerce_number(get_first(vehicle_dict, status_payload,
                                       keys=['rangeKm', 'range_km', 'drivingRange', 'remainingRange', 'distanceToEmpty']))
    odometer = coerce_number(get_first(vehicle_dict, status_payload,
                                       keys=['odometerKm', 'odometer_km', 'mileage', 'odometerValue']))
    charge_power = coerce_number(get_first(charging_payload, status_payload,
                                           keys=['chargePower', 'chargingPower', 'chargingPowerKw']))
    current_speed = coerce_number(get_first(vehicle_dict, status_payload,
                                            keys=['currentSpeed', 'vehicleSpeed', 'travelSpeed', 'speed']))
    plugged_in = get_first(charging_payload, status_payload, vehicle_dict,
                           keys=['pluggedIn', 'isPluggedIn', 'chargingCableConnected'])
    charging = get_first(charging_payload, status_payload,
                         keys=['isCharging', 'is_charging', 'charging'])
    temperature = coerce_number(get_first(status_payload, vehicle_dict,
                                          keys=['insideTemperature', 'inside_temp', 'cabinTemperature', 'temperature']))
    charging_state = get_first(charging_payload, status_payload,
                               keys=['chargingState', 'chargeState', 'chargeStatus'])
    if not isinstance(charging_state, str):
        charging_state = ''
    lock_state = get_first(status_payload, remote_payload, vehicle_dict,
                           keys=['lockState', 'doorLockStatus', 'lock_status', 'lockStatus'])
    if not isinstance(lock_state, str):
        lock_state = str(lock_state) if lock_state is not None else ''
    is_locked = get_first(status_payload, remote_payload, vehicle_dict,
                          keys=['isLocked', 'is_locked', 'vehicleLocked', 'locked'])
    # 'locked' string handling: only exact 'locked' => True, 'unlocked' => False.
    if isinstance(is_locked, str) and is_locked.strip().lower() in {'locked', 'unlocked'}:
        is_locked_bool = is_locked.strip().lower() == 'locked'
    elif lock_state and not isinstance(is_locked, bool) and is_locked is None:
        is_locked_bool = lock_state.strip().lower() == 'locked'
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
        'status': status_payload,
        'chargingStatus': charging_payload,
        'remoteControlState': remote_payload,
        'raw': combined_payload,
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
    vin_key = payload.get('vinKey') or payload.get('vin_key') or os.getenv('ZEEKR_VIN_KEY') or ''
    vin_iv = payload.get('vinIv') or payload.get('vin_iv') or os.getenv('ZEEKR_VIN_IV') or ''

    if not username or not password:
        print(json.dumps({"error": "Missing Zeekr credentials", "vehicles": [], "connection": False}))
        return 0

    try:
        from zeekr_ev_api.client import ZeekrClient, ZeekrException  # type: ignore
    except ImportError:
        print(json.dumps({"error": "Python dependency zeekr_ev_api not installed", "vehicles": []}))
        return 0

    try:
        client = ZeekrClient(
            username=username,
            password=password,
            country_code=country_code,
            hmac_access_key=hmac_access_key,
            hmac_secret_key=hmac_secret_key,
            password_public_key=password_public_key,
            prod_secret=prod_secret,
            vin_key=vin_key,
            vin_iv=vin_iv,
        )
        client.login()
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
        vehicles = client.get_vehicle_list()
        normalized = []
        for vehicle in vehicles:
            status = {}
            charging_status = {}
            remote_state = {}
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
            normalized.append(normalize_vehicle(vehicle.data or {}, status, charging_status, remote_state))
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
