#!/bin/sh
set -eu

PACKAGE_TYPE="${1:-deb}"
SERVICE_USER=bili-record-2k
SERVICE_GROUP=bili-record-2k
STATE_ROOT=/var/lib/bili-record-2k
UPDATE_ROOT=/var/lib/bili-record-2k-updates
CONFIG_ROOT=/etc/bili-record-2k
ENV_FILE="$CONFIG_ROOT/environment"
INITIAL_PASSWORD_FILE="$CONFIG_ROOT/initial-admin-password"

if [ "${BILI_RECORD_UPDATE_APPLYING:-0}" != "1" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if systemctl is-active --quiet bili-record-2k.service; then
    systemctl stop bili-record-2k.service
  fi
fi

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
for hardware_group in video render; do
  if getent group "$hardware_group" >/dev/null 2>&1; then
    # systemd initializes the user's supplementary groups for User=, so keep
    # Jetson's V4L2/DRM device access available to the service process.
    usermod -a -G "$hardware_group" "$SERVICE_USER"
  fi
done

install -d -m 0755 -o root -g root "$STATE_ROOT"
for protected_child in "$STATE_ROOT/BiliRecord2K" "$STATE_ROOT/recordings"; do
  if [ -L "$protected_child" ]; then
    echo "Refusing unsafe symbolic-link state directory: $protected_child" >&2
    exit 1
  fi
done
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_ROOT/BiliRecord2K"
install -d -m 0770 -o root -g "$SERVICE_GROUP" "$UPDATE_ROOT"
install -d -m 2770 -o root -g "$SERVICE_GROUP" "$STATE_ROOT/recordings"
install -d -m 0750 -o root -g "$SERVICE_GROUP" "$CONFIG_ROOT"

if [ -L "$ENV_FILE" ] || { [ -e "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; }; then
  echo "Refusing unsafe environment file: $ENV_FILE" >&2
  exit 1
fi
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
  chmod 0640 "$ENV_FILE"
  chown root:"$SERVICE_GROUP" "$ENV_FILE"
  echo "BiliRecord2K initial username: admin"
  echo "BiliRecord2K initial password: $INITIAL_PASSWORD"
fi

chmod 0640 "$ENV_FILE"
chown root:"$SERVICE_GROUP" "$ENV_FILE"
/usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/bootstrap-config.cjs
for state_file in "$STATE_ROOT/BiliRecord2K/settings.json" "$STATE_ROOT/BiliRecord2K/settings.json.backup"; do
  if [ -f "$state_file" ]; then
    chmod 0600 "$state_file"
    chown "$SERVICE_USER":"$SERVICE_GROUP" "$state_file"
  fi
done
chmod 0640 "$ENV_FILE"
chown root:"$SERVICE_GROUP" "$ENV_FILE"
rm -f "$INITIAL_PASSWORD_FILE"

read_recording_output_dir() {
  /usr/lib/bili-record-2k/bin/node - "$STATE_ROOT/BiliRecord2K/settings.json" <<'NODE'
const fs = require('node:fs');
const settingsPath = process.argv[2];
const store = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const outputDir = String(store?.settings?.outputDir || '').trim();
if (!outputDir) process.exitCode = 1;
else process.stdout.write(outputDir);
NODE
}

check_recording_directory_access() {
  target_path=$1
  [ -n "$target_path" ] || {
    echo '录像保存目录为空，无法验证服务用户权限。' >&2
    return 1
  }
  command -v runuser >/dev/null 2>&1 || {
    echo '缺少 runuser，无法以 bili-record-2k 服务用户验证录像目录权限。' >&2
    return 1
  }
  runuser -u "$SERVICE_USER" -- sh -eu -c '
    target_path=$1
    probe_dir=
    cleanup() {
      if [ -n "$probe_dir" ] && [ -d "$probe_dir" ]; then
        rm -f -- "$probe_dir/write-test" >/dev/null 2>&1 || true
        rmdir -- "$probe_dir" >/dev/null 2>&1 || true
      fi
    }
    trap cleanup 0 HUP INT TERM

    mkdir -p -- "$target_path"
    [ -d "$target_path" ]
    probe_dir=$(mktemp -d "${target_path%/}/.bili-record-2k-permission-check.XXXXXX")
    probe_payload="bili-record-2k permission probe"
    printf "%s\\n" "$probe_payload" >"$probe_dir/write-test"
    [ -s "$probe_dir/write-test" ]
    [ "$(cat "$probe_dir/write-test")" = "$probe_payload" ]
    rm -f -- "$probe_dir/write-test"
    [ ! -e "$probe_dir/write-test" ]
    rmdir -- "$probe_dir"
    probe_dir=
  ' sh "$target_path"
}

RECORDING_OUTPUT_DIR=$(read_recording_output_dir) || {
  echo '无法读取已持久化的录像保存目录，安装已停止。' >&2
  exit 1
}
if ! check_recording_directory_access "$RECORDING_OUTPUT_DIR"; then
  echo "录像保存目录无法由 $SERVICE_USER 创建、写入并删除测试文件：$RECORDING_OUTPUT_DIR" >&2
  echo "请为 $SERVICE_USER:$SERVICE_GROUP 授予该目录的实际写权限（SMB 挂载请检查 uid/gid、file_mode、dir_mode），然后重新安装。" >&2
  exit 1
fi
echo "录像保存目录权限验证通过（$SERVICE_USER）：$RECORDING_OUTPUT_DIR"

chmod 0755 /usr/bin/bili-record-2k /usr/bin/bili-record-2k-update
chmod 0755 /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/linux-update.cjs /usr/lib/bili-record-2k/provision.sh /usr/lib/bili-record-2k/bootstrap-config.cjs
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
