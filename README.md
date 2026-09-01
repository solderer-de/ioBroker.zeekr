# ioBroker Zeekr Adapter

This repository contains a starter ioBroker adapter for Zeekr electric vehicles. It follows the standard ioBroker adapter structure and exposes vehicle state data as datapoints.

## Features

- Standard ioBroker adapter layout with configuration UI
- Credentials and polling interval configurable in the ioBroker admin interface
- Vehicle discovery via a Python bridge that can reuse the existing Zeekr backend library
- A basic datapoint model for vehicle name, VIN, battery level, range, odometer and charging state

## Requirements

- Node.js 20+
- Python 3 with the Zeekr API package installed

Install the Python dependency:

```bash
pip install -r requirements.txt
```

## Development

```bash
npm test
```

## Configuration

In the ioBroker admin UI, enter:

- username (Zeekr account email)
- password (Zeekr account password)
- polling interval (seconds)
- optional vehicle filter
- optional debug logging

## Roadmap

- expose additional datapoints from the Zeekr API
- add controls for charging and climate operations
- connect the adapter to a dedicated GitHub release workflow
