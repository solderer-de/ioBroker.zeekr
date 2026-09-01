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

## Local ioBroker installation

To try the adapter in a local ioBroker instance, install it from the repository directory or from a local archive:

```bash
cd /path/to/iobroker-adapter-zeekr
npm ci
pip3 install zeekr-ev-api
```

Then make the adapter available to ioBroker, for example by linking it into the ioBroker modules directory:

```bash
mkdir -p /opt/iobroker/node_modules
ln -s /path/to/iobroker-adapter-zeekr /opt/iobroker/node_modules/iobroker.zekr
```

After that, restart ioBroker and add a new instance of the `Zeekr` adapter in the admin UI. Configure the credentials and polling interval there.

## Configuration

In the ioBroker admin UI, enter:

- username (Zeekr account email)
- password (Zeekr account password)
- polling interval (seconds)
- optional vehicle filter
- optional debug logging

## Commands

The adapter accepts a lightweight `sendCommand` message with:

- `vin`: target vehicle VIN
- `command`: remote-control command (for example `start` or `stop` depending on the target action)
- `serviceId`: Zeekr service identifier (for example `RCS` for charge control or other remote-control services)
- `setting`: payload object forwarded to the Zeekr API

The command is routed through the Python bridge and forwarded to the underlying `zeekr_ev_api` client.

## Release and Maintenance

- The repository includes GitHub Actions for CI and release creation.
- Releases are now automated with `release-please`: conventional commits on `main` open or update a release PR, and publishing that release triggers the asset build workflow.
- The release workflow builds a tar archive and attaches it to the GitHub release automatically.
- A scheduled upstream sync workflow checks the reference repository for new commits and opens a tracking issue when changes are detected.

## Roadmap

- expose additional datapoints from the Zeekr API
- add controls for charging and climate operations
- connect the adapter to a dedicated GitHub release workflow
