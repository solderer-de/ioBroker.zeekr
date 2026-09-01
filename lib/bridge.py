#!/usr/bin/env python3
import json
import os
import sys


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
        normalized = []
        for vehicle in vehicles:
            normalized.append({
                "name": getattr(vehicle, 'name', None) or getattr(vehicle, 'model_name', None) or 'Vehicle',
                "vin": getattr(vehicle, 'vin', None) or getattr(vehicle, 'id', None) or '',
                "batteryLevel": getattr(vehicle, 'battery_level', None),
                "rangeKm": getattr(vehicle, 'range_km', None),
                "odometerKm": getattr(vehicle, 'odometer_km', None),
                "isCharging": getattr(vehicle, 'is_charging', None) or False,
                "raw": getattr(vehicle, 'raw', None),
            })
        print(json.dumps({"vehicles": normalized}))
        return 0
    except Exception as exc:  # pragma: no cover - bridge should not crash the adapter
        print(json.dumps({"error": str(exc), "vehicles": []}))
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
