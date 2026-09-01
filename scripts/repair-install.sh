#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${1:-https://github.com/solderer-de/iobroker-adapter-zeekr/releases/download/v0.1.25/iobroker-adapter-zeekr-v0.1.25.tgz}"
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

echo "Installing adapter from $INSTALL_URL"
$SUDO iobroker url "$INSTALL_URL" --host iobroker --debug
