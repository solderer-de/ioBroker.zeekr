# ioBroker Zeekr Adapter

This repository contains an ioBroker adapter for Zeekr electric vehicles. It follows the standard ioBroker adapter structure and exposes vehicle state data as datapoints.

## Features

- Standard ioBroker adapter layout with a configuration UI
- Credentials, polling interval, vehicle filter, and debug mode configurable in the ioBroker admin interface
- Vehicle discovery and status polling via a Python bridge that uses the Zeekr API client
- Datapoints for vehicle identity, battery level, range, odometer, charging state, lock state, climate state, and raw payloads
- Health and alert states such as `info.health`, `info.alertCount`, and `info.lastSuccessfulUpdate`
- Automatic bootstrap of a local Python runtime and Zeekr dependency on first use

## Requirements

- Node.js 18+ (20+ recommended)
- Python 3

No manual Python package installation is required. The adapter creates a local virtual environment on first run and installs the Zeekr dependency automatically.

## Development

Run the test suite locally:

```bash
npm test
```

## Installation in a local ioBroker instance

The adapter is designed to be installed directly into an ioBroker host.

Important: ioBroker's URL install logic expects the GitHub repository name to follow the pattern `iobroker.<adaptername>`. For this adapter the repository is therefore published as `solderer-de/iobroker.zekr`, not `solderer-de/iobroker-adapter-zeekr`.

### Option A: Install from file or URL in the ioBroker Admin UI

This is the preferred method for a real installation.

1. Create a release archive from the repository, or use the latest GitHub release asset.
2. In ioBroker Admin, open the adapter tab and choose either:
  - "Adapter from file install" and upload the archive, or
  - "Adapter from URL install" and provide the direct URL to the release archive.
3. The archive must contain the adapter package root with `io-package.json`, `package.json`, `main.js`, `lib/`, `admin/`, and `img/`.
4. After installation, restart ioBroker and create a new instance of the `Zeekr` adapter.

For example, use the GitHub archive URL:

```text
https://github.com/solderer-de/iobroker.zekr/archive/refs/tags/v0.1.4.tar.gz
```

The equivalent CLI command is:

```bash
iobroker url https://github.com/solderer-de/iobroker.zekr/archive/refs/tags/v0.1.4.tar.gz --host iobroker --debug
```

Use the command exactly once; the install target is the URL, not an additional `iobroker` argument.

### Option B: Install directly from a local checkout

If you want to test the adapter from a local repository checkout, run:

```bash
cd /path/to/iobroker.zekr
npm ci
```

Then make the adapter visible to ioBroker on a typical Linux host:

```bash
mkdir -p /opt/iobroker/node_modules
ln -s /path/to/iobroker.zekr /opt/iobroker/node_modules/iobroker.zekr
```

If you run ioBroker in Docker or a different base path, adapt the target directory accordingly.

### 3. Restart ioBroker

Restart the ioBroker service or container so the adapter is discovered.

### 4. Add an instance in the admin UI

Open the ioBroker Admin UI, create a new instance of the `Zeekr` adapter, and configure:

- username: your Zeekr account email or login name
- password: your Zeekr account password
- polling interval: refresh interval in seconds
- vehicle filter: optional substring filter for one or more vehicles
- debug: enable verbose bridge logging
- pythonBinary: optional override for the Python executable if needed

## Configuration

The adapter exposes the following configuration fields:

- `username`
- `password`
- `pollingInterval`
- `vehicleFilter`
- `pythonBinary` (optional)
- `debug` (boolean)

## Datapoints

The adapter creates a vehicle channel for each discovered vehicle with the following subchannels:

- `status`: battery, range, odometer, charging power, speed, plug state, charging state, lock state, climate state, and timestamps
- `control`: command payload, service ID, send button, last command, and last result
- `raw`: raw payloads from the bridge
- `details`: additional metadata such as model information

The adapter also exposes root states under `info` for connection status, health, errors, logs, and the last successful update.

## Commands

The adapter accepts a lightweight `sendCommand` message with:

- `vin`: target vehicle VIN
- `command`: remote-control command (for example `start` or `stop`, depending on the target action)
- `serviceId`: Zeekr service identifier (for example `RCS` for charge control or other remote-control services)
- `setting`: payload object forwarded to the Zeekr API

The command is routed through the Python bridge and forwarded to the underlying `zeekr_ev_api` client.

## Release and Maintenance

- The repository includes GitHub Actions for CI and release creation.
- Releases are automated with `release-please`; publishing a release triggers the asset build workflow.
- The release workflow builds a tar archive and attaches it to the GitHub release automatically.
- A scheduled upstream sync workflow checks the reference repository for new commits and opens a tracking issue when changes are detected.

## Roadmap

- expose additional datapoints from the Zeekr API
- add controls for charging and climate operations
- improve live validation against a real Zeekr account
