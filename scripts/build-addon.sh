#!/usr/bin/env bash
# Build the matter-homematic CCU/RaspberryMatic addon tarball.
#
# Output: dist-addon/matter-homematic-${VERSION}.tar.gz
#
# Layout inside the tarball:
#   ./update_script               <- run by CCU WebUI installer
#   ./rc.d/matter-homematic       <- service script copied to /usr/local/etc/config/rc.d/
#   ./www/index.html              <- WebUI tile copied to /usr/local/etc/config/addons/www/matter-homematic/
#   ./www/update-check.cgi
#   ./matter-homematic/dist/index.js  <- single-file esbuild bundle (app + all deps)
#   ./matter-homematic/node/bin/node  <- bundled Node runtime
#   ./matter-homematic/html/      <- web UI assets
#   ./matter-homematic/config.example.json
#   ./matter-homematic/package.json
#   ./matter-homematic/VERSION
#
# Runtime strategy (the RedMatic pattern — bring your own node):
# The CCU3 firmware ships Node 8 and glibc 2.27. Official Node >= 18 armv7l
# builds need glibc >= 2.28 and never run there; the unofficial armv6l
# Node 18 build is the newest upstream binary that does (armv6 code runs on
# the armv7 CPU). Node 20/22 armv6l builds need glibc 2.28 too — there is no
# stock Node >= 20 binary for this firmware.
#
# Node 18 cannot require() ESM, and matter.js 0.16.x CJS requires the
# ESM-only @noble/curves 2.x. So the app is esbuild-bundled to a single CJS
# file at build time, which compiles the ESM deps away (and removes the need
# to ship node_modules at all). rc.d falls back to system node on platforms
# that can't execute the bundled binary (e.g. x86_64 RaspberryMatic).

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT_DIR}"

NODE_VERSION=18.20.8
NODE_TARBALL="node-v${NODE_VERSION}-linux-armv6l.tar.xz"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_SHA256=8f9acd04d60219af8f8a3024b297f9e5c0be218bd9f196f211ce9aa7f75392c7
NODE_CACHE_DIR="${ROOT_DIR}/build-cache"

VERSION=$(cat addon/VERSION | tr -d '[:space:]')
if [ -z "${VERSION}" ]; then
  echo "addon/VERSION is empty" >&2
  exit 1
fi

STAGING="${ROOT_DIR}/build/staging"
PAYLOAD="${STAGING}/matter-homematic"
OUT_DIR="${ROOT_DIR}/dist-addon"
TARBALL="${OUT_DIR}/matter-homematic-${VERSION}.tar.gz"

echo "==> Cleaning previous build"
rm -rf "${ROOT_DIR}/build"
mkdir -p "${PAYLOAD}" "${STAGING}/rc.d" "${STAGING}/www" "${OUT_DIR}"

echo "==> Compiling TypeScript"
npm run --silent build

echo "==> Bundling app to single CJS file (target: node18)"
mkdir -p "${PAYLOAD}/dist"
# bun/bun:sqlite are optional matter.js storage backends behind a runtime
# Bun check that never triggers on Node — safe to leave unresolved.
npx esbuild "${ROOT_DIR}/dist/index.js" --bundle --platform=node \
    --target=node18 --format=cjs --external:bun --external:bun:sqlite \
    --log-level=warning --outfile="${PAYLOAD}/dist/index.js"

echo "==> Staging payload"
cp -R "${ROOT_DIR}/html" "${PAYLOAD}/html"
cp "${ROOT_DIR}/package.json" "${PAYLOAD}/package.json"
cp "${ROOT_DIR}/config.example.json" "${PAYLOAD}/config.example.json"
cp "${ROOT_DIR}/README.md" "${PAYLOAD}/README.md" 2>/dev/null || true
cp "${ROOT_DIR}/addon/VERSION" "${PAYLOAD}/VERSION"

echo "==> Bundling Node ${NODE_VERSION} runtime (linux-armv6l)"
mkdir -p "${NODE_CACHE_DIR}"
if [ ! -f "${NODE_CACHE_DIR}/${NODE_TARBALL}" ]; then
  curl -fsSL -o "${NODE_CACHE_DIR}/${NODE_TARBALL}.tmp" "${NODE_URL}"
  mv "${NODE_CACHE_DIR}/${NODE_TARBALL}.tmp" "${NODE_CACHE_DIR}/${NODE_TARBALL}"
fi
echo "${NODE_SHA256}  ${NODE_CACHE_DIR}/${NODE_TARBALL}" | shasum -a 256 -c - >/dev/null
# Only the node binary itself is needed — skip npm/corepack/headers.
mkdir -p "${PAYLOAD}/node/bin"
tar -xJf "${NODE_CACHE_DIR}/${NODE_TARBALL}" -C "${PAYLOAD}/node/bin" \
    --strip-components=2 "node-v${NODE_VERSION}-linux-armv6l/bin/node"
chmod 755 "${PAYLOAD}/node/bin/node"
touch "${PAYLOAD}/node/.nobackup"

echo "==> Staging addon installer"
cp "${ROOT_DIR}/addon/update_script" "${STAGING}/update_script"
cp "${ROOT_DIR}/addon/rc.d/matter-homematic" "${STAGING}/rc.d/matter-homematic"
cp "${ROOT_DIR}/addon/www/index.html" "${STAGING}/www/index.html"
cp "${ROOT_DIR}/addon/www/update-check.cgi" "${STAGING}/www/update-check.cgi"
chmod +x "${STAGING}/update_script" \
         "${STAGING}/rc.d/matter-homematic" \
         "${STAGING}/www/update-check.cgi"

echo "==> Creating tarball"
( cd "${STAGING}" && tar czf "${TARBALL}" \
    --owner=0 --group=0 \
    update_script rc.d www matter-homematic )

echo "==> Cleaning staging"
rm -rf "${ROOT_DIR}/build"

SIZE=$(du -h "${TARBALL}" | awk '{print $1}')
echo
echo "Built ${TARBALL} (${SIZE})"
