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

## Installation in a local ioBroker instance

The adapter is designed to be installed directly into an ioBroker host.

Important: the adapter repository is published at `solderer-de/iobroker.zeekr`. For `iobroker url` installs, use a direct tarball URL from `codeload.github.com` rather than a GitHub repository URL or a GitHub release asset URL. The ioBroker CLI treats GitHub repository URLs as Git dependencies and can fall back to SSH-based installs; that is what triggers the `Permission denied (publickey)` failures on this host. A `codeload` tarball URL installs the package as a normal tarball and avoids that Git fallback.

For tarball-based installs, pass the adapter name explicitly as the second argument. `iobroker url <url> zeekr ...` is the reliable form for this adapter. Without the explicit adapter name, the CLI can treat the full URL as the adapter identifier and fail later in the install/upload step even though the npm tarball install itself succeeded.

### Install via CLI (recommended)

Use this exact install form:

```bash
iobroker url https://codeload.github.com/solderer-de/iobroker.zeekr/tar.gz/refs/tags/v0.1.40 zeekr --host iobroker --debug
```

The second argument (`zeekr`) is required for this adapter. This is the concrete install command for the current release.

### Install via ioBroker Admin UI

If you prefer the Admin UI, use the same GitHub release asset URL in the "Adapter from URL install" field. If you upload a file instead, upload the tarball from the release; it must contain the adapter package root with `io-package.json`, `package.json`, `main.js`, `lib/`, `admin/`, and `img/`.

After installation, restart ioBroker and create a new instance of the `Zeekr` adapter.

### Repairing a broken or half-installed adapter

If a previous install left a stale `node_modules/iobroker.zeekr` directory behind, `iobroker del zeekr` can fail with:

```text
Cannot find module 'iobroker.zeekr/io-package.json'
```

In that case, remove the stale module directory from the ioBroker host and reinstall the adapter from the current codeload tarball URL:

```bash
sudo rm -rf /opt/iobroker/node_modules/iobroker.zeekr
sudo iobroker fix
sudo iobroker url https://codeload.github.com/solderer-de/iobroker.zeekr/tar.gz/refs/tags/v0.1.40 zeekr --host iobroker --debug
```

The repository also ships helper scripts for this case:

```bash
./scripts/repair-install.sh
./scripts/install-adapter.sh
```

Both scripts use the same `codeload` tarball URL format and pass the adapter name `zeekr` explicitly for a clean, SSH-free installation path.

### Option B: Install directly from a local checkout

If you want to test the adapter from a local repository checkout, run:

```bash
cd /path/to/iobroker.zeekr
npm ci
```

Then make the adapter visible to ioBroker on a typical Linux host:

```bash
mkdir -p /opt/iobroker/node_modules
ln -s /path/to/iobroker.zeekr /opt/iobroker/node_modules/iobroker.zeekr
```

If you run ioBroker in Docker or a different base path, adapt the target directory accordingly.

### 3. Restart ioBroker

Restart the ioBroker service or container so the adapter is discovered.

### 4. Add an instance in the admin UI

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
   - `adb shell pm path com.zeekr.app` (or the package name used by your Zeekr app build)
   - `adb pull /data/app/<...>/base.apk /tmp/base.apk`
   - `adb pull /data/app/<...>/split_config.arm64_v8a.apk /tmp/arm64.apk`
4. Copy the resulting files to a location readable by the `iobroker` user on the ioBroker host, for example:
   - `sudo mkdir -p /opt/iobroker/iobroker-data/zeekr`
   - `sudo cp /tmp/base.apk /opt/iobroker/iobroker-data/zeekr/base.apk`
   - `sudo cp /tmp/arm64.apk /opt/iobroker/iobroker-data/zeekr/arm64.apk`
5. Make sure the files are readable by the `iobroker` user:
   - `sudo chown iobroker:iobroker /opt/iobroker/iobroker-data/zeekr/base.apk /opt/iobroker/iobroker-data/zeekr/arm64.apk`
   - `sudo chmod 644 /opt/iobroker/iobroker-data/zeekr/base.apk /opt/iobroker/iobroker-data/zeekr/arm64.apk`
6. In the adapter admin UI, enable `autoExtractSecrets` and enter the absolute paths in `apkBasePath` and `apkArm64Path`.
7. Set `extractRegion` to the region that matches your Zeekr account (`EM`, `SEA`, `EU`, or `CN`).
8. Save the adapter configuration and restart the instance. The adapter will then try to clone the extractor tool into `.tools/zeekr_key_extractor`, install its Python dependencies, run the extractor, and populate the missing secrets automatically.

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

- [x] erweiterte Datenpunkte (VTM/Reifendruck/GPS/12V, Lade-Limit, Lade-/Travel-Pläne, letzte Trips)
- [x] typisierte Controls (Lock/Unlock, Klima Start/Stopp, Charge Start/Stopp via RCS, Charge-/Travel-Plan)
- [x] Live-Validierung ohne Account (Mock-Modus + `testConnection`-Message)
- [ ] Live-Validierung gegen echten Account (Command-Defaults pro Modell verifizieren)
- [ ] weitere Datenpunkte nach Bedarf

## Disclaimer

Unofficial community project. Not affiliated with Zeekr or Geely.

- Personal and educational use only, at your own risk.
- The adapter talks to undocumented Zeekr APIs and derives keys from the official Android app (see `wysie/zeekr_key_extractor`). Reverse engineering and API use may violate Zeekr's terms and local law; check before use.
- Never commit APKs, `zeekr_secrets.json`, credentials, or tokens. Secrets belong in ioBroker `protectedNative`, never in git, logs, or states (enforced by CI secret scan).
- No APKs or keys are shipped in this repository.

## Changelog

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

Copyright (c) 2026 solderer-de

MIT — see [LICENSE](LICENSE). This is an unofficial community project, not affiliated with Zeekr or Geely.
