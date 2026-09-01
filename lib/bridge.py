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


def normalize_vehicle(vehicle):
    if hasattr(vehicle, '__dict__'):
        vehicle_dict = {key: getattr(vehicle, key) for key in dir(vehicle) if not key.startswith('_')}
    elif isinstance(vehicle, dict):
        vehicle_dict = vehicle
    else:
        vehicle_dict = {}

    name = find_value(vehicle_dict, ['name', 'vehicleName', 'displayName', 'modelName']) or 'Vehicle'
    vin = find_value(vehicle_dict, ['vin', 'VIN', 'vehicleId', 'id', 'vehicle_id']) or ''
    battery = find_value(vehicle_dict, ['batteryLevel', 'battery_level', 'stateOfCharge', 'soc'])
    range_km = find_value(vehicle_dict, ['rangeKm', 'range_km', 'drivingRange', 'remainingRange'])
    odometer = find_value(vehicle_dict, ['odometerKm', 'odometer_km', 'mileage', 'odometer'])
    charge_power = find_value(vehicle_dict, ['chargePower', 'chargingPower', 'power'])
    current_speed = find_value(vehicle_dict, ['speed', 'currentSpeed', 'vehicleSpeed'])
    plugged_in = find_value(vehicle_dict, ['pluggedIn', 'isPluggedIn'])
    charging = find_value(vehicle_dict, ['isCharging', 'chargingStatus', 'charging'])
    temperature = find_value(vehicle_dict, ['insideTemperature', 'inside_temp', 'temperature'])

    return {
        'name': name,
        'vin': vin,
        'batteryLevel': battery,
        'rangeKm': range_km,
        'odometerKm': odometer,
        'chargePower': charge_power,
        'currentSpeed': current_speed,
        'pluggedIn': plugged_in,
        'isCharging': bool(charging),
        'temperature': temperature,
        'raw': vehicle_dict,
    }


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else 'vehicles'
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    username = payload.get('username') or os.getenv('ZEEKR_USERNAME') or ''
    password = payload.get('password') or os.getenv('ZEEKR_PASSWORD') or ''

    if not username or not password:
        print(json.dumps({"error": "Missing Zeekr credentials", "vehicles": []}))
        return 0

    try:
        import zeekr_ev_api  # type: ignore
    except ImportError:
        print(json.dumps({"error": "Python dependency zeekr_ev_api not installed", "vehicles": []}))
        return 0

    try:
        client = zeekr_ev_api.Client(username=username, password=password)  # type: ignore[attr-defined]
        vehicles = []
        if hasattr(client, 'get_vehicles'):
            vehicles = client.get_vehicles()
        elif hasattr(client, 'vehicles'):
            vehicles = client.vehicles
        elif hasattr(client, 'list_vehicles'):
            vehicles = client.list_vehicles()
        if not isinstance(vehicles, list):
            vehicles = []
        normalized = [normalize_vehicle(vehicle) for vehicle in vehicles]
        print(json.dumps({"vehicles": normalized}))
        return 0
    except Exception as exc:  # pragma: no cover - bridge should not crash the adapter
        print(json.dumps({"error": str(exc), "vehicles": []}))
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
