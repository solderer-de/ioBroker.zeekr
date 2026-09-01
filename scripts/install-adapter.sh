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

INSTALL_URL="${1:-https://github.com/${REPO}}"

if [ -n "$VERSION" ]; then
  echo "Using adapter version ${VERSION}"
fi

git config --global url."https://github.com/".insteadOf ssh://git@github.com/
git config --global url."https://github.com/".insteadOf git@github.com:

echo "Installing adapter ${ADAPTER_NAME} from ${INSTALL_URL}"
iobroker url "$INSTALL_URL" "$ADAPTER_NAME" --host "$HOST" --debug
