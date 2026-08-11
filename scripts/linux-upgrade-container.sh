#!/bin/sh
set -eu

PACKAGE_TYPE=${1:?package type is required}
OLD_PACKAGE=${2:?old package path is required}
NEW_PACKAGE=${3:?new package path is required}
OLD_VERSION=${4:?old version is required}
NEW_VERSION=${5:?new version is required}

export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl ffmpeg fontconfig fonts-noto-cjk openssl passwd python3 tar util-linux >/dev/null

mkdir -p /run/systemd/system /run/bili-record-2k-test

cat >/usr/local/bin/systemctl <<'SYSTEMCTL'
#!/bin/sh
set -eu

STATE_ROOT=/run/bili-record-2k-test
SERVICE_NAME=bili-record-2k.service
UPDATE_SERVICE=bili-record-2k-update.service

service_pid() {
  [ -f "$STATE_ROOT/service.pid" ] && cat "$STATE_ROOT/service.pid" || true
}

service_alive() {
  pid=$(service_pid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_main_service() {
  if service_alive; then
    return 0
  fi
  rm -f "$STATE_ROOT/service.pid"
  set -a
  [ ! -f /etc/bili-record-2k/environment ] || . /etc/bili-record-2k/environment
  set +a
  export NODE_ENV=production
  export BILI_RECORD_NO_OPEN=1
  export BILI_RECORD_APP_ROOT=/usr/lib/bili-record-2k
  export BILI_RECORD_SERVER_ENTRY=/usr/lib/bili-record-2k/server.bundle.cjs
  export BILI_RECORD_UPDATE_DIR=/var/lib/bili-record-2k-updates
  setpriv --reuid=bili-record-2k --regid=bili-record-2k --init-groups -- \
    /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/server.bundle.cjs --prod --no-open \
    >"$STATE_ROOT/service.log" 2>&1 &
  echo "$!" >"$STATE_ROOT/service.pid"
}

stop_main_service() {
  pid=$(service_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _round in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$STATE_ROOT/service.pid"
}

start_update_service() {
  if [ -f "$STATE_ROOT/update.pid" ]; then
    pid=$(cat "$STATE_ROOT/update.pid" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  rm -f "$STATE_ROOT/update.exit"
  (
    /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/linux-update.cjs >"$STATE_ROOT/update.log" 2>&1
    echo 0 >"$STATE_ROOT/update.exit"
  ) || echo $? >"$STATE_ROOT/update.exit" &
  echo "$!" >"$STATE_ROOT/update.pid"
}

last_arg=''
for arg in "$@"; do
  last_arg=$arg
done

case "${1:-}" in
  daemon-reload|enable)
    exit 0
    ;;
  start)
    case "$last_arg" in
      "$SERVICE_NAME") start_main_service ;;
      "$UPDATE_SERVICE") start_update_service ;;
      *) exit 0 ;;
    esac
    ;;
  stop)
    [ "$last_arg" = "$SERVICE_NAME" ] && stop_main_service
    ;;
  restart)
    if [ "$last_arg" = "$SERVICE_NAME" ]; then
      stop_main_service
      start_main_service
    fi
    ;;
  is-active)
    if [ "$last_arg" = "$SERVICE_NAME" ]; then
      service_alive
      exit $?
    fi
    exit 0
    ;;
  show)
    if [ "${2:-}" = "$SERVICE_NAME" ]; then
      service_pid
    else
      echo 0
    fi
    ;;
  status)
    cat "$STATE_ROOT/service.log" 2>/dev/null || true
    ;;
esac
SYSTEMCTL
chmod 0755 /usr/local/bin/systemctl

wait_for_service() {
  expected_version=$1
  for _round in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:3263/api/state >/tmp/bili-record-2k-state.json 2>/dev/null; then
      actual_version=$(/usr/lib/bili-record-2k/bin/node -e "const state=require('/tmp/bili-record-2k-state.json'); process.stdout.write(String(state.version || ''))")
      if [ "$actual_version" = "$expected_version" ]; then
        return 0
      fi
    fi
    sleep 1
  done
  cat /run/bili-record-2k-test/service.log 2>/dev/null || true
  echo "service did not become healthy at version $expected_version" >&2
  return 1
}

install_package() {
  package_path=$1
  package_type=$2
  if [ "$package_type" = deb ]; then
    dpkg -i "$package_path"
  else
    install_root=$(mktemp -d)
    tar -xzf "$package_path" -C "$install_root"
    sh "$install_root/install.sh"
    rm -rf "$install_root"
  fi
}

install_package "$OLD_PACKAGE" "$PACKAGE_TYPE"
wait_for_service "$OLD_VERSION"

/usr/lib/bili-record-2k/bin/node <<'NODE'
const fs = require('node:fs');
const path = '/var/lib/bili-record-2k/BiliRecord2K/settings.json';
const payload = JSON.parse(fs.readFileSync(path, 'utf8'));
payload.settings.targetQn = 20000;
fs.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
NODE
chown bili-record-2k:bili-record-2k /var/lib/bili-record-2k/BiliRecord2K/settings.json
cp /etc/bili-record-2k/environment /tmp/bili-record-2k-environment.before

openssl genpkey -algorithm ED25519 -out /tmp/bili-record-2k-update-private.pem
openssl pkey -in /tmp/bili-record-2k-update-private.pem -pubout -out /usr/lib/bili-record-2k/update-public-key.pem
cp "$NEW_PACKAGE" "/var/lib/bili-record-2k-updates/$(basename "$NEW_PACKAGE")"
chown root:bili-record-2k "/var/lib/bili-record-2k-updates/$(basename "$NEW_PACKAGE")"
chmod 0640 "/var/lib/bili-record-2k-updates/$(basename "$NEW_PACKAGE")"

cat >/tmp/bili-record-2k-queue-update.cjs <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const [packageType, packagePath, version] = process.argv.slice(2);
const signed = {
  schemaVersion: 1,
  app: 'bili-record-2k',
  version,
  files: [{
    name: path.basename(packagePath),
    platform: 'linux',
    kind: packageType,
    arch: process.arch,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex')
  }]
};
const request = {
  schemaVersion: 2,
  app: 'bili-record-2k',
  requestId: crypto.randomUUID(),
  version,
  packageType,
  packagePath,
  signed,
  signatureAlgorithm: 'ed25519',
  signature: crypto.sign(null, Buffer.from(stable(signed)), fs.readFileSync('/tmp/bili-record-2k-update-private.pem')).toString('base64')
};
const target = '/var/lib/bili-record-2k-updates/apply-request.json';
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
fs.linkSync(temporary, target);
fs.unlinkSync(temporary);
NODE
chown bili-record-2k:bili-record-2k /tmp/bili-record-2k-queue-update.cjs /tmp/bili-record-2k-update-private.pem
setpriv --reuid=bili-record-2k --regid=bili-record-2k --init-groups -- \
  /usr/lib/bili-record-2k/bin/node /tmp/bili-record-2k-queue-update.cjs \
  "$PACKAGE_TYPE" "/var/lib/bili-record-2k-updates/$(basename "$NEW_PACKAGE")" "$NEW_VERSION"

systemctl start bili-record-2k-update.service
for _round in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60; do
  [ -f /run/bili-record-2k-test/update.exit ] && break
  sleep 1
done
[ -f /run/bili-record-2k-test/update.exit ] || { cat /run/bili-record-2k-test/update.log >&2 || true; exit 1; }
[ "$(cat /run/bili-record-2k-test/update.exit)" = 0 ] || { cat /run/bili-record-2k-test/update.log >&2 || true; exit 1; }

if [ "$PACKAGE_TYPE" = deb ]; then
  [ "$(dpkg-query -W -f='${Status} ${Version}' bili-record-2k)" = "install ok installed $NEW_VERSION" ]
else
  actual_installed_version=$(/usr/lib/bili-record-2k/bin/node -e 'process.stdout.write(require("/usr/lib/bili-record-2k/version.json").version)')
  [ "$actual_installed_version" = "$NEW_VERSION" ]
fi
wait_for_service "$NEW_VERSION"

/usr/lib/bili-record-2k/bin/node <<'NODE'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync('/var/lib/bili-record-2k/BiliRecord2K/settings.json', 'utf8'));
const status = JSON.parse(fs.readFileSync('/var/lib/bili-record-2k-updates/last-update-status.json', 'utf8'));
if (settings.settings.targetQn !== 20000) throw new Error('existing settings were reset during upgrade');
if (status.status !== 'success') throw new Error(`unexpected update status: ${status.status}`);
NODE
cmp /tmp/bili-record-2k-environment.before /etc/bili-record-2k/environment
systemctl stop bili-record-2k.service || true
