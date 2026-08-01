#!/bin/sh
set -eu

PACKAGE_TYPE="${1:-deb}"
SERVICE_USER=bili-record-2k
SERVICE_GROUP=bili-record-2k
STATE_ROOT=/var/lib/bili-record-2k
CONFIG_ROOT=/etc/bili-record-2k
ENV_FILE="$CONFIG_ROOT/environment"
INITIAL_PASSWORD_FILE="$CONFIG_ROOT/initial-admin-password"

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
for hardware_group in video render; do
  if getent group "$hardware_group" >/dev/null 2>&1; then
    usermod -a -G "$hardware_group" "$SERVICE_USER"
  fi
done

install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT/BiliRecord2K"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT/BiliRecord2K/updates"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT/recordings"
install -d -m 0750 -o root -g "$SERVICE_GROUP" "$CONFIG_ROOT"

if [ ! -f "$ENV_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    INITIAL_PASSWORD="$(openssl rand -hex 18)"
  else
    INITIAL_PASSWORD="$(tr -d '-' </proc/sys/kernel/random/uuid)"
  fi
  umask 077
  {
    echo 'BILI_RECORD_CONFIG_DIR=/var/lib/bili-record-2k'
    echo 'BILI_RECORD_OUTPUT_DIR=/var/lib/bili-record-2k/recordings'
    echo 'BILI_RECORD_HOST=127.0.0.1'
    echo 'BILI_RECORD_PORT=3263'
    echo 'BILI_RECORD_AUTH_USERNAME=admin'
    echo "BILI_RECORD_AUTH_PASSWORD=$INITIAL_PASSWORD"
    echo 'BILI_RECORD_AUTO_UPDATE=1'
    echo 'BILI_RECORD_MANAGED_UPDATE=1'
    echo 'BILI_RECORD_SYSTEMD=1'
  } >"$ENV_FILE"
  printf '%s\n' "$INITIAL_PASSWORD" >"$INITIAL_PASSWORD_FILE"
  chmod 0640 "$ENV_FILE"
  chown root:"$SERVICE_GROUP" "$ENV_FILE"
  chmod 0600 "$INITIAL_PASSWORD_FILE"
  echo "BiliRecord2K initial username: admin"
  echo "BiliRecord2K initial password: $INITIAL_PASSWORD"
  echo "The password is also stored in $INITIAL_PASSWORD_FILE (root only)."
fi

if ! grep -q '^BILI_RECORD_MANAGED_UPDATE=' "$ENV_FILE"; then
  printf '%s\n' 'BILI_RECORD_MANAGED_UPDATE=1' >>"$ENV_FILE"
fi
if ! grep -q '^BILI_RECORD_SYSTEMD=' "$ENV_FILE"; then
  printf '%s\n' 'BILI_RECORD_SYSTEMD=1' >>"$ENV_FILE"
fi
chmod 0640 "$ENV_FILE"
chown root:"$SERVICE_GROUP" "$ENV_FILE"

chmod 0755 /usr/bin/bili-record-2k /usr/bin/bili-record-2k-update
chmod 0755 /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/linux-update.cjs /usr/lib/bili-record-2k/provision.sh
chown -R root:root /usr/lib/bili-record-2k

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable bili-record-2k.service bili-record-2k-update.path || true
  if [ "${BILI_RECORD_UPDATE_APPLYING:-0}" != "1" ] && [ -d /run/systemd/system ]; then
    systemctl restart bili-record-2k.service || true
    systemctl start bili-record-2k-update.path || true
  fi
fi

echo "BiliRecord2K $PACKAGE_TYPE installation configured."
