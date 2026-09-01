#!/usr/bin/env python3
import json
import os
import sys


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

    status_payload = status or {}
    charging_payload = charging_status or {}
    remote_payload = remote_state or {}
    combined_payload = {
        'vehicle': vehicle_dict,
        'status': status_payload,
        'charging': charging_payload,
        'remote': remote_payload,
    }

    name = find_value(combined_payload, ['name', 'vehicleName', 'displayName', 'modelName']) or 'Vehicle'
    vin = find_value(combined_payload, ['vin', 'VIN', 'vehicleId', 'id', 'vehicle_id']) or ''
    battery = find_value(combined_payload, ['batteryLevel', 'battery_level', 'stateOfCharge', 'soc', 'battery'])
    range_km = find_value(combined_payload, ['rangeKm', 'range_km', 'drivingRange', 'remainingRange', 'range', 'distanceToEmpty'])
    odometer = find_value(combined_payload, ['odometerKm', 'odometer_km', 'mileage', 'odometer', 'odometerValue'])
    charge_power = find_value(combined_payload, ['chargePower', 'chargingPower', 'power', 'chargingPowerKw'])
    current_speed = find_value(combined_payload, ['speed', 'currentSpeed', 'vehicleSpeed', 'travelSpeed'])
    plugged_in = find_value(combined_payload, ['pluggedIn', 'isPluggedIn', 'plugged', 'chargingCableConnected'])
    charging = find_value(combined_payload, ['isCharging', 'chargingStatus', 'charging', 'is_charging', 'chargeStatus'])
    temperature = find_value(combined_payload, ['insideTemperature', 'inside_temp', 'temperature', 'cabinTemperature'])
    charging_state = find_value(combined_payload, ['chargingState', 'chargeState', 'chargingStatus', 'chargeStatus'])
    lock_state = find_value(combined_payload, ['lockState', 'doorLockStatus', 'lock_status', 'lockStatus'])
    is_locked = find_value(combined_payload, ['isLocked', 'locked', 'is_locked', 'vehicleLocked', 'lockState'])
    climate_on = find_value(combined_payload, ['climateOn', 'climate', 'airConditioning', 'hvacOn'])
    last_updated = find_value(combined_payload, ['lastUpdated', 'updatedAt', 'timestamp', 'updateTime', 'time'])

    return {
        'name': name,
        'vin': vin,
        'batteryLevel': battery,
        'rangeKm': range_km,
        'odometerKm': odometer,
        'chargePower': charge_power,
        'currentSpeed': current_speed,
        'pluggedIn': coerce_bool(plugged_in),
        'isCharging': coerce_bool(charging),
        'temperature': temperature,
        'chargingState': charging_state,
        'lockState': lock_state,
        'isLocked': coerce_bool(is_locked),
        'climateOn': coerce_bool(climate_on),
        'lastUpdated': last_updated,
        'status': status_payload,
        'chargingStatus': charging_payload,
        'remoteControlState': remote_payload,
        'raw': combined_payload,
    }


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else 'vehicles'
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    username = payload.get('username') or os.getenv('ZEEKR_USERNAME') or ''
    password = payload.get('password') or os.getenv('ZEEKR_PASSWORD') or ''

    if not username or not password:
        print(json.dumps({"error": "Missing Zeekr credentials", "vehicles": [], "connection": False}))
        return 0

    try:
        from zeekr_ev_api.client import ZeekrClient, ZeekrException  # type: ignore
    except ImportError:
        print(json.dumps({"error": "Python dependency zeekr_ev_api not installed", "vehicles": []}))
        return 0

    try:
        client = ZeekrClient(username=username, password=password)
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
