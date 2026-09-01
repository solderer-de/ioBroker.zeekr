#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-solderer-de/iobroker-adapter-zeekr}"
VERSION="${VERSION:-}"
ADAPTER_NAME="${ADAPTER_NAME:-zeekr}"
HOST="${HOST:-iobroker}"

if [ -z "$VERSION" ]; then
  if command -v node >/dev/null 2>&1 && [ -f package.json ]; then
    VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  fi
fi

if [ -n "$VERSION" ]; then
  INSTALL_URL="${1:-https://github.com/${REPO}/releases/download/v${VERSION}/iobroker-adapter-zeekr-v${VERSION}.tgz}"
else
  INSTALL_URL="${1:-https://github.com/${REPO}/releases/download/v0.1.25/iobroker-adapter-zeekr-v0.1.25.tgz}"
fi

echo "Installing adapter ${ADAPTER_NAME} from ${INSTALL_URL}"
iobroker url "$INSTALL_URL" "$ADAPTER_NAME" --host "$HOST" --debug
