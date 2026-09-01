#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-solderer-de/iobroker.zeekr}"
VERSION=""
ADAPTER_NAME="${ADAPTER_NAME:-zeekr}"
if command -v node >/dev/null 2>&1 && [ -f package.json ]; then
  VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
fi
if [ -n "$VERSION" ]; then
  INSTALL_URL="${1:-https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${VERSION}}"
else
  INSTALL_URL="${1:-https://codeload.github.com/${REPO}/tar.gz/refs/tags/v0.1.39}"
fi
IOBROKER_ROOT="${IOBROKER_ROOT:-/opt/iobroker}"
NODE_MODULES_DIR="${IOBROKER_ROOT}/node_modules"
ADAPTER_DIR="${NODE_MODULES_DIR}/iobroker.zeekr"
LEGACY_ADAPTER_DIRS=(
  "${NODE_MODULES_DIR}/iobroker.zekr"
  "${NODE_MODULES_DIR}/iobroker-adapter-zeekr"
)

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

for stale_dir in "$ADAPTER_DIR" "${LEGACY_ADAPTER_DIRS[@]}"; do
  if [ -d "$stale_dir" ]; then
    echo "Removing stale adapter directory: $stale_dir"
    $SUDO rm -rf "$stale_dir"
  fi
done

if [ -d "${NODE_MODULES_DIR}/.bin" ]; then
  find "${NODE_MODULES_DIR}" -maxdepth 1 -type d \( -name 'iobroker.zeekr*' -o -name 'iobroker.zekr*' -o -name 'iobroker-adapter-zeekr*' \) -print0 | while IFS= read -r -d '' dir; do
    echo "Removing stale adapter directory: $dir"
    $SUDO rm -rf "$dir"
  done
fi

echo "Running ioBroker repair"
$SUDO iobroker fix
 
echo "Restarting ioBroker to refresh adapter metadata"
$SUDO iobroker restart || true
 
echo "Installing adapter ${ADAPTER_NAME} from $INSTALL_URL"
$SUDO iobroker url "$INSTALL_URL" "$ADAPTER_NAME" --host iobroker --debug
