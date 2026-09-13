# ioBroker Zeekr Adapter

<p align="center">
  <img src="admin/zeekr.svg" alt="Zeekr logo" width="160" height="160" />
</p>

This repository contains an ioBroker adapter for [Zeekr electric vehicles](https://www.zeekr.com). It follows the standard ioBroker adapter structure and exposes vehicle state data as datapoints.

## Features

- Standard ioBroker adapter layout with a configuration UI
- Zeekr username/password plus the Zeekr-specific secrets required by the upstream zeekr_ev_api client are configurable in the ioBroker admin interface
- Optional automatic secret extraction from a `zeekr_secrets.json` file or directly from the Zeekr APKs on the ioBroker host
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

## Installation

Install the adapter from the ioBroker repositories: open the Admin UI, go to Adapters, search for `Zeekr` and install it. Afterwards create a new instance and configure it (see below).

If the adapter misbehaves after an update, run `iobroker fix` on the host.

## Configure the instance

Open the ioBroker Admin UI, create a new instance of the `Zeekr` adapter, and configure:

- username: your Zeekr account email or login name
- password: your Zeekr account password
- countryCode: ISO country code used by the upstream Zeekr API client (defaults to `AU`)
- hmacAccessKey: HMAC access key required by the upstream client
- hmacSecretKey: HMAC secret key required by the upstream client
- passwordPublicKey: password encryption public key required by the upstream client
- prodSecret: production secret required by the upstream client
- vinKey: VIN encryption key required by the upstream client
- vinIv: VIN encryption IV required by the upstream client
- polling interval: refresh interval in seconds
- vehicle filter: optional substring filter for one or more vehicles; it only decides which vehicles are exposed as datapoints
- pythonBinary: optional override for the Python executable used by the adapter bridge and secret extractor
- autoExtractSecrets: if enabled, the adapter will try to extract missing secrets from the APKs or from a `zeekr_secrets.json` file when the adapter starts
- apkBasePath/apkArm64Path: optional paths to the Zeekr APK files for automated extraction
- secretsJsonPath: optional path to a `zeekr_secrets.json` created by the extractor
- extractRegion: region used by the upstream extractor (`EM`, `SEA`, `EU`, `CN`)
- debug: enable verbose bridge logging

## Automatic secret extraction

The adapter can automate the extraction flow from the upstream `zeekr_key_extractor` tool. For this to work, you need either:

- the full Zeekr base APK and the matching ARM64 split APK on the ioBroker host, or
- a pre-generated `zeekr_secrets.json` file.

### How to obtain the APKs from a phone or emulator

1. On the Android phone or emulator, install the Zeekr app from the Play Store or from the APK package you already have.
2. Export the installed app package from the device/emulator. Typical ways are:
   - use `adb shell pm path <package>` and `adb pull` to copy the APK from the device
   - use an emulator snapshot or Android backup tool to export the app package
   - if you already have the APK from another source, use that file directly
3. If you use `adb`, the typical workflow is:
   - `adb devices`
   - `adb shell pm path com.zeekr.global` (most markets) or `adb shell pm path com.zeekr.overseas` (EU)
   - `adb pull /data/app/<...>/base.apk base.apk`
   - `adb pull /data/app/<...>/split_config.arm64_v8a.apk arm64.apk`
4. Put the two files anywhere the `iobroker` user can read, e.g. your home directory or `/tmp`. No special directories or permissions are needed.
5. In the adapter admin UI, enable `autoExtractSecrets` and enter the file paths in `apkBasePath` and `apkArm64Path`. The adapter copies the APKs into its own storage and runs the extraction itself.
6. Set `extractRegion` to the region that matches your Zeekr account (`EM`, `SEA`, `EU`, or `CN`).
7. Save the adapter configuration and restart the instance. The adapter imports the APKs, installs the extractor dependencies, runs the extractor, and fills in the missing secrets automatically.

### Alternative: use a secrets JSON file

If you already have a `zeekr_secrets.json` from the extractor, you can skip the APK step completely and provide its absolute path in `secretsJsonPath`.

This removes the need to copy the six secrets manually into the admin page once the APKs or the JSON file are available on the host.

## Configuration

The adapter exposes the following configuration fields:

- `username`
- `password`
- `countryCode`
- `hmacAccessKey`
- `hmacSecretKey`
- `passwordPublicKey`
- `prodSecret`
- `vinKey`
- `vinIv`
- `pollingInterval`
- `vehicleFilter`
- `pythonBinary` (optional)
- `autoExtractSecrets` (boolean)
- `apkBasePath` / `apkArm64Path` (optional)
- `secretsJsonPath` (optional)
- `extractRegion`
- `debug` (boolean)

## Datapoints

The adapter creates a vehicle channel for each discovered vehicle with the following subchannels:

- `status`: battery, range, odometer, charging power, speed, plug state, charging state, lock state, climate state, charge limit, tire pressures, GPS, 12V battery, central locking, doors/trunk open states, consumption, engine/maintenance states, and timestamps
- `control`: command payload, service ID, send button, typed buttons (lock, climate, charge, windows, sunshade, lights), writable charge limit, climate temp/duration, charge/travel plan inputs, last command, and last result
- `trips`: trip count, last trip distance, and trip list (logbook)
- `raw`: raw payloads from the bridge
- `details`: additional metadata such as model information

Polling is adaptive: charging or driving vehicles are polled every 60s (min 30s), idle ones at the configured interval. Unexpected charging stops and newly opened doors trigger the alert webhook (rate-limited).

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

- [x] erweiterte Datenpunkte (VTM/Reifendruck/GPS/12V, Lade-Limit, Lade-/Travel-Pläne, letzte Trips)
- [x] typisierte Controls (Lock/Unlock, Klima Start/Stopp, Charge Start/Stopp via RCS, Charge-/Travel-Plan)
- [x] Live-Validierung ohne Account (Mock-Modus + `testConnection`-Message)
- [ ] Live-Validierung gegen echten Account (Command-Defaults pro Modell verifizieren)
- [ ] weitere Datenpunkte nach Bedarf

## Live-Validierung am echten Auto (Checkliste)

1. Mock-Modus ausschalten, Zugang + Keys eintragen, `testConnection`-Message prüfen (`ok: true`).
2. Lesend prüfen: Batterie, Reichweite, Türen/Kofferraum (auf/zu testen), GPS, Lade-Limit.
3. Je Button einmal schalten und `control.lastResult` prüfen: Lock/Unlock, Klima Start/Stopp, Charge Start/Stopp, Fenster, Sonnenschutz, Licht/Hupe.
4. Lade-Limit auf z.B. 80 setzen und `status.chargingLimit` gegenprüfen.
5. Ergebnisse als Issue melden (Modell, App-Version, Region), damit Defaults nachgeschärft werden.

## Disclaimer

Unofficial community project. Not affiliated with Zeekr or Geely.

- Personal and educational use only, at your own risk.
- The adapter talks to undocumented Zeekr APIs and derives keys from the official Android app (see `wysie/zeekr_key_extractor`). Reverse engineering and API use may violate Zeekr's terms and local law; check before use.
- Never commit APKs, `zeekr_secrets.json`, credentials, or tokens. Secrets belong in ioBroker `protectedNative`, never in git, logs, or states (enforced by CI secret scan).
- No APKs or keys are shipped in this repository.

## Credits

- [Fryyyyy](https://github.com/Fryyyyy) for the [Zeekr EV API](https://github.com/Fryyyyy/zeekr_ev_api) and the [Zeekr Home Assistant integration](https://github.com/Fryyyyy/zeekr_homeassistant)
- [wysie](https://github.com/wysie) for the [Zeekr key extractor](https://github.com/wysie/zeekr_key_extractor)

## Changelog

### 0.1.50

- Valid lock role, leaner CI, correct authors and credits

### 0.1.49

- Valid lock role (`sensor.lock`), leaner CI (single test workflow)

### 0.1.48

- Shared ESLint config, admin translations for all languages, dependabot automerge

### 0.1.47

- Repository listing fixes (news cleanup, dependabot limits)

### 0.1.46

- Correct Zeekr logo icon (re-rendered from SVG)

### 0.1.45

- Repository compliance for the ioBroker listing (translations, license schema, encrypted secrets)
- Simplified admin with Zugang/Keys/Erweitert tabs
- Green CI on Ubuntu/Windows, secret scan, upstream dependency checks

### 0.1.44

- EU key wizard with region preset, prod-secret candidates loop and error hints
- Typed charging/climate controls (lock, climate, RCS charge) and charge/travel plans
- Mock mode with testConnection for validation without a real account
- ioBroker repository compliance (vehicle type, news, encrypted secrets)

See [GitHub releases](https://github.com/solderer-de/ioBroker.zeekr/releases) for the full history. Releases are created automatically with release-please.

## License

Copyright (c) 2026 solderer-de <npm@schoebel-online.net>

MIT — see [LICENSE](LICENSE). This is an unofficial community project, not affiliated with Zeekr or Geely.
