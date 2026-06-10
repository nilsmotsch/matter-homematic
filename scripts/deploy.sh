#!/usr/bin/env bash
# Fast local deploy: rebuild the esbuild bundle and push just dist/index.js to
# an already-installed CCU addon, then restart the service and tail the log.
#
# This is the quick iteration path — it does NOT reinstall the addon (node
# runtime, html, rc.d are untouched). For a clean/first install, build the
# full tarball with `npm run build:addon` and install it via the CCU WebUI.
#
# Credentials live in .env.local (gitignored):
#   CCU_HOST=192.168.1.100
#   CCU_SSH_USER=root
#   CCU_SSH_PASSWORD=...
#
# Usage:
#   scripts/deploy.sh            # build + deploy + restart + tail log
#   scripts/deploy.sh --no-build # skip rebuild, push existing bundle
#   scripts/deploy.sh --logs     # just tail the remote log, no deploy

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT_DIR}"

ENV_FILE="${ROOT_DIR}/.env.local"
if [ ! -f "${ENV_FILE}" ]; then
  echo "error: ${ENV_FILE} not found (need CCU_HOST / CCU_SSH_USER / CCU_SSH_PASSWORD)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

: "${CCU_HOST:?set CCU_HOST in .env.local}"
: "${CCU_SSH_USER:=root}"
: "${CCU_SSH_PASSWORD:?set CCU_SSH_PASSWORD in .env.local}"

command -v sshpass >/dev/null 2>&1 || { echo "error: sshpass not installed (brew install sshpass)" >&2; exit 1; }

ADDON_DIR="/usr/local/addons/matter-homematic"
RCD="/usr/local/etc/config/rc.d/matter-homematic"
LOGFILE="/usr/local/etc/config/addons/matter-homematic/matter-homematic.log"
BUNDLE="${ROOT_DIR}/build/deploy/index.js"

export SSHPASS="${CCU_SSH_PASSWORD}"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${CCU_SSH_USER}@${CCU_HOST}"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o ConnectTimeout=15"

tail_log() {
  echo "==> Tailing ${LOGFILE} (Ctrl-C to stop)"
  ${SSH} "tail -n 40 -f ${LOGFILE}"
}

if [ "${1:-}" = "--logs" ]; then
  tail_log
  exit 0
fi

if [ "${1:-}" != "--no-build" ]; then
  echo "==> Compiling TypeScript"
  npm run --silent build
  echo "==> Bundling app to single CJS file (target: node18)"
  mkdir -p "$(dirname "${BUNDLE}")"
  npx esbuild "${ROOT_DIR}/dist/index.js" --bundle --platform=node \
    --target=node18 --format=cjs --external:bun --external:bun:sqlite \
    --log-level=warning --outfile="${BUNDLE}"
fi

[ -f "${BUNDLE}" ] || { echo "error: ${BUNDLE} missing — run without --no-build" >&2; exit 1; }
echo "==> Bundle: $(du -h "${BUNDLE}" | cut -f1)"

echo "==> Uploading bundle to ${CCU_HOST}"
${SCP} "${BUNDLE}" "${CCU_SSH_USER}@${CCU_HOST}:/tmp/matter-homematic-index.js"

echo "==> Swapping bundle + restarting service"
${SSH} "set -e; \
  cp ${ADDON_DIR}/dist/index.js ${ADDON_DIR}/dist/index.js.bak 2>/dev/null || true; \
  mv /tmp/matter-homematic-index.js ${ADDON_DIR}/dist/index.js; \
  ${RCD} restart"

echo "==> Restart issued; verifying process"
sleep 5
${SSH} "ps w | grep '[m]atter-homematic/dist/index.js' || echo '(process not found yet)'"

echo "==> Recent log (run 'scripts/deploy.sh --logs' to follow live)"
${SSH} "tail -n 30 ${LOGFILE}"
