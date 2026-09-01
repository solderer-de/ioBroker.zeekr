#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-solderer-de/iobroker-adapter-zeekr}"
VERSION=""
ADAPTER_NAME="${ADAPTER_NAME:-zeekr}"
if command -v node >/dev/null 2>&1 && [ -f package.json ]; then
  VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
fi
INSTALL_URL="${1:-https://github.com/${REPO}}"
if [ -n "$VERSION" ]; then
  echo "Using adapter version ${VERSION}"
fi
IOBROKER_ROOT="${IOBROKER_ROOT:-/opt/iobroker}"
NODE_MODULES_DIR="${IOBROKER_ROOT}/node_modules"
ADAPTER_DIR="${NODE_MODULES_DIR}/iobroker.zeekr"

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

if [ -d "$ADAPTER_DIR" ]; then
  echo "Removing stale adapter directory: $ADAPTER_DIR"
  $SUDO rm -rf "$ADAPTER_DIR"
fi

if [ -d "${NODE_MODULES_DIR}/.bin" ]; then
  find "${NODE_MODULES_DIR}" -maxdepth 1 -type d -name 'iobroker.zeekr*' -print0 | while IFS= read -r -d '' dir; do
    echo "Removing stale adapter directory: $dir"
    $SUDO rm -rf "$dir"
  done
fi

echo "Running ioBroker repair"
$SUDO iobroker fix

git config --global url."https://github.com/".insteadOf ssh://git@github.com/
git config --global url."https://github.com/".insteadOf git@github.com:

echo "Installing adapter ${ADAPTER_NAME} from $INSTALL_URL"
$SUDO iobroker url "$INSTALL_URL" "$ADAPTER_NAME" --host iobroker --debug
