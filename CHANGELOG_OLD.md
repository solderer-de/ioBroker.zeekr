# Changelog (older entries)

Moved here from `README.md` to keep the main changelog short (repochecker W6019). Newest first.

### 0.1.68

- Repository bot fixes: news trimmed to 7 entries (dropped versions stay in the changelog history), ABRP tab label in translations, fuller news translations

### 0.1.67

- CI fix: `common.news` trimmed to the 20-entry schema gate (oldest entry stays in the changelog history) plus a unit test guarding the limit

### 0.1.66

- Trunk unlock corrected to `start` (upstream zeekr_homeassistant #162, live-tested on 7X); new 079012 token-expiry hint; repochecker text fixes (tariffs help without JSON blob, no install-from-GitHub wording)

### 0.1.65

- ABRP trims pasted API key whitespace (copy-paste artifacts no longer cause 401)

### 0.1.64

- CI lint fix only (same ABRP single-token feature as 0.1.63, whose tag missed the lint gate and never reached npm)

### 0.1.63

- ABRP usability: single-car setups paste just the user token (VIN comes from the vehicle data), per-VIN map only for several cars

### 0.1.62

- ABRP logs a warning when the token field is not valid `{"VIN": "token"}` JSON instead of skipping silently

### 0.1.61

- ABRP diagnostics: startup log census (`ABRP: enabled/apiKey/userTokens`) and `info.abrpApiKeyPresent`/`info.abrpUserTokensPresent` states prove which credentials the process received (presence only, never values)

### 0.1.60

- CI formatting fix only (same ABRP upload as 0.1.59, whose tag failed the lint gate and never reached npm)

### 0.1.59

- ABRP upload: SoC, position, speed and range go to A Better Routeplanner after every poll (ABRP tab: telemetry API key + per-VIN user tokens in protectedNative, `sendAbrpTelemetry` message for manual upload)

### 0.1.58

- Climate status fix: remotely started air conditioning is detected via nested `preClimateActive` — the climate switch mirrors the real running state instead of jumping back to off

### 0.1.57

- Security fix: instance config access uses Foreign (absolute) object IDs only — a relative-ID bug wrote plaintext secrets into a shadow object instead of the instance config

### 0.1.56

- More curated states: odometer, tyre pressure (kPa to bar) and temperature, 12V battery, doors/windows/trunk/hood, service distance/days, repair mode, derived isLocked; raw duplication removed from object tree

### 0.1.55

- Raw layer: every vehicle value as its own state under `all.*` (objects become channels, arrays JSON)

### 0.1.54

- Secrets survive reinstalls (encrypted storage via updateConfig, self-healing local backup), EU overseas field mapping (battery, range, position, engine), extraction sources logged and exposed

### 0.1.53

- Secrets backup with direct download and PC import, presence states, restructured Admin (APKs/Energy tabs), robust venv handling (auto re-exec into fresh venvs)

### 0.1.52

- APK upload straight from the browser (no host file transfer needed)

### 0.1.51

- Real charging costs with losses and per-charger/time tariffs, geofence, smart charging, battery log

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
