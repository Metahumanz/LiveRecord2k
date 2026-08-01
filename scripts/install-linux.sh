#!/bin/sh
set -eu

APP_NAME=BiliRecord2K
REPOSITORY=${BILI_RECORD_REPOSITORY:-Metahumanz/LiveRecord2k}
MANIFEST_URL=${BILI_RECORD_MANIFEST_URL:-https://github.com/$REPOSITORY/releases/latest/download/update.json}
SERVER_HOST=${BILI_RECORD_HOST:-0.0.0.0}
SERVER_PORT=${BILI_RECORD_PORT:-3263}
ADMIN_USERNAME=${BILI_RECORD_AUTH_USERNAME:-admin}
ADMIN_PASSWORD=${BILI_RECORD_AUTH_PASSWORD:-}
AUTO_UPDATE=${BILI_RECORD_AUTO_UPDATE:-1}
TEMP_ROOT=
TTY_STATE=

usage() {
  cat <<'EOF'
BiliRecord2K Linux 一键安装器

用法：
  curl -fsSL https://raw.githubusercontent.com/Metahumanz/LiveRecord2k/main/scripts/install-linux.sh | sudo sh

可选环境变量：
  BILI_RECORD_AUTH_PASSWORD  非交互安装密码（至少 8 位）
  BILI_RECORD_AUTH_USERNAME  管理用户名，默认 admin
  BILI_RECORD_HOST           监听地址，默认 0.0.0.0
  BILI_RECORD_PORT           监听端口，默认 3263
  BILI_RECORD_AUTO_UPDATE    1 开启自动更新，0 关闭
  BILI_RECORD_MANIFEST_URL   自定义 update.json 地址
EOF
}

cleanup() {
  if [ -n "$TTY_STATE" ] && [ -r /dev/tty ]; then
    stty "$TTY_STATE" </dev/tty >/dev/null 2>&1 || true
  fi
  if [ -n "$TEMP_ROOT" ] && [ -d "$TEMP_ROOT" ]; then
    rm -rf -- "$TEMP_ROOT"
  fi
}

fail() {
  printf '\n安装失败：%s\n' "$1" >&2
  exit 1
}

trap cleanup 0
trap 'exit 130' HUP INT TERM

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  fail '请使用 sudo 运行，例如：curl -fsSL <脚本地址> | sudo sh'
fi

command -v systemctl >/dev/null 2>&1 || fail '没有检测到 systemd；请使用支持 systemd 的 Linux 发行版。'
[ -d /run/systemd/system ] || fail 'systemd 当前没有运行；不能在容器/chroot 中安装这个服务。'

case "$SERVER_HOST" in
  0.0.0.0|127.0.0.1|localhost|::) ;;
  *) fail 'BILI_RECORD_HOST 只允许 0.0.0.0、127.0.0.1、localhost 或 ::。' ;;
esac
case "$SERVER_PORT" in
  ''|*[!0-9]*) fail 'BILI_RECORD_PORT 必须是 1 到 65535 的数字。' ;;
esac
if [ "$SERVER_PORT" -lt 1 ] || [ "$SERVER_PORT" -gt 65535 ]; then
  fail 'BILI_RECORD_PORT 必须是 1 到 65535 的数字。'
fi
case "$ADMIN_USERNAME" in
  ''|*[!A-Za-z0-9_.@-]*) fail '管理用户名只能包含字母、数字、点、下划线、@ 和连字符。' ;;
esac
case "$AUTO_UPDATE" in
  0|1) ;;
  *) fail 'BILI_RECORD_AUTO_UPDATE 只能是 0 或 1。' ;;
esac

read_password() {
  [ -r /dev/tty ] || fail '当前没有交互终端；请设置 BILI_RECORD_AUTH_PASSWORD 后重新运行。'
  TTY_STATE=$(stty -g </dev/tty)
  while :; do
    printf '请设置 WebUI 管理密码（至少 8 位）：' >/dev/tty
    stty -echo </dev/tty
    IFS= read -r ADMIN_PASSWORD </dev/tty || exit 1
    stty "$TTY_STATE" </dev/tty
    printf '\n请再次输入密码：' >/dev/tty
    stty -echo </dev/tty
    IFS= read -r ADMIN_PASSWORD_CONFIRM </dev/tty || exit 1
    stty "$TTY_STATE" </dev/tty
    printf '\n' >/dev/tty
    if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
      printf '密码不足 8 位，请重新输入。\n' >/dev/tty
      continue
    fi
    if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
      printf '两次密码不一致，请重新输入。\n' >/dev/tty
      continue
    fi
    ADMIN_PASSWORD_CONFIRM=
    break
  done
}

if [ -z "$ADMIN_PASSWORD" ]; then
  read_password
elif [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
  fail 'BILI_RECORD_AUTH_PASSWORD 至少需要 8 位。'
fi

printf '\n[1/6] 检测系统与安装依赖...\n'
PACKAGE_KIND=tarball
if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
  PACKAGE_KIND=deb
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl jq ffmpeg
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ca-certificates curl jq tar shadow-utils
  command -v ffmpeg >/dev/null 2>&1 || dnf install -y ffmpeg || fail '当前软件源没有 FFmpeg，请先为发行版启用 FFmpeg 软件源。'
elif command -v yum >/dev/null 2>&1; then
  yum install -y ca-certificates curl jq tar shadow-utils
  command -v ffmpeg >/dev/null 2>&1 || yum install -y ffmpeg || fail '当前软件源没有 FFmpeg，请先为发行版启用 FFmpeg 软件源。'
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive install ca-certificates curl jq tar shadow ffmpeg
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm ca-certificates curl jq tar shadow ffmpeg
else
  fail '不支持当前包管理器；请使用 Debian/Ubuntu、Fedora/RHEL、openSUSE 或 Arch Linux。'
fi

for required_command in curl jq sha256sum ffmpeg tar; do
  command -v "$required_command" >/dev/null 2>&1 || fail "缺少必要命令：$required_command"
done

MACHINE_ARCH=$(uname -m)
case "$MACHINE_ARCH" in
  x86_64|amd64) RELEASE_ARCH=x64 ;;
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  *) fail "暂不支持的 CPU 架构：$MACHINE_ARCH" ;;
esac

TEMP_ROOT=$(mktemp -d /tmp/bili-record-2k-install.XXXXXX)
MANIFEST_PATH=$TEMP_ROOT/update.json

printf '\n[2/6] 获取最新版本清单...\n'
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  "$MANIFEST_URL" -o "$MANIFEST_PATH"
jq -e '.version and (.files | type == "array")' "$MANIFEST_PATH" >/dev/null || fail '更新清单格式无效。'
LATEST_VERSION=$(jq -r '.version' "$MANIFEST_PATH")
PACKAGE_ENTRY=$(jq -r \
  --arg kind "$PACKAGE_KIND" \
  --arg arch "$RELEASE_ARCH" \
  '.files[] | select(.platform == "linux" and .kind == $kind and (.arch == $arch or .arch == "all")) | [.url, .sha256, .name] | @tsv' \
  "$MANIFEST_PATH" | head -n 1)
[ -n "$PACKAGE_ENTRY" ] || fail "最新版本 $LATEST_VERSION 没有适用于 Linux $RELEASE_ARCH 的 $PACKAGE_KIND 安装包。"
PACKAGE_URL=$(printf '%s\n' "$PACKAGE_ENTRY" | cut -f 1)
PACKAGE_SHA256=$(printf '%s\n' "$PACKAGE_ENTRY" | cut -f 2)
PACKAGE_NAME=$(printf '%s\n' "$PACKAGE_ENTRY" | cut -f 3)
case "$PACKAGE_URL" in
  https://*) ;;
  *) fail '安装包下载地址不是 HTTPS，已拒绝继续。' ;;
esac
case "$PACKAGE_NAME" in
  ''|.|..|*/*|*\\*) fail '更新清单中的安装包文件名不安全。' ;;
esac
case "$PACKAGE_SHA256" in
  *[!A-Fa-f0-9]*|'') fail '更新清单中的 SHA-256 无效。' ;;
esac
[ "${#PACKAGE_SHA256}" -eq 64 ] || fail '更新清单中的 SHA-256 长度无效。'
PACKAGE_SHA256=$(printf '%s' "$PACKAGE_SHA256" | tr 'A-F' 'a-f')

printf '\n[3/6] 下载并校验 BiliRecord2K %s...\n' "$LATEST_VERSION"
PACKAGE_PATH=$TEMP_ROOT/$PACKAGE_NAME
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 1800 \
  "$PACKAGE_URL" -o "$PACKAGE_PATH"
ACTUAL_SHA256=$(sha256sum "$PACKAGE_PATH" | awk '{print $1}')
[ "$ACTUAL_SHA256" = "$PACKAGE_SHA256" ] || fail "安装包 SHA-256 校验失败，已拒绝安装。"

escape_environment_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

printf '\n[4/6] 写入服务配置...\n'
install -d -m 0750 /etc/bili-record-2k
ENV_PATH=/etc/bili-record-2k/environment
PASSWORD_ESCAPED=$(escape_environment_value "$ADMIN_PASSWORD")
USERNAME_ESCAPED=$(escape_environment_value "$ADMIN_USERNAME")
umask 077
{
  printf '%s\n' 'BILI_RECORD_CONFIG_DIR=/var/lib/bili-record-2k'
  printf '%s\n' 'BILI_RECORD_OUTPUT_DIR=/var/lib/bili-record-2k/recordings'
  printf 'BILI_RECORD_HOST="%s"\n' "$SERVER_HOST"
  printf 'BILI_RECORD_PORT="%s"\n' "$SERVER_PORT"
  printf 'BILI_RECORD_AUTH_USERNAME="%s"\n' "$USERNAME_ESCAPED"
  printf 'BILI_RECORD_AUTH_PASSWORD="%s"\n' "$PASSWORD_ESCAPED"
  printf 'BILI_RECORD_AUTO_UPDATE="%s"\n' "$AUTO_UPDATE"
  printf '%s\n' 'BILI_RECORD_MANAGED_UPDATE=1'
  printf '%s\n' 'BILI_RECORD_SYSTEMD=1'
} >"$ENV_PATH"
chmod 0600 "$ENV_PATH"
rm -f /etc/bili-record-2k/initial-admin-password

printf '\n[5/6] 安装程序与 systemd 服务...\n'
if [ "$PACKAGE_KIND" = deb ]; then
  apt-get install -y "$PACKAGE_PATH"
else
  EXTRACT_ROOT=$TEMP_ROOT/extracted
  mkdir -p "$EXTRACT_ROOT"
  tar -xzf "$PACKAGE_PATH" -C "$EXTRACT_ROOT"
  [ -f "$EXTRACT_ROOT/install.sh" ] || fail '通用 Linux 包缺少 install.sh。'
  sh "$EXTRACT_ROOT/install.sh"
fi

systemctl daemon-reload
systemctl enable bili-record-2k.service bili-record-2k-update.path >/dev/null
systemctl restart bili-record-2k.service
systemctl restart bili-record-2k-update.path

printf '\n[6/6] 检查服务状态...\n'
SERVICE_READY=0
if [ "$SERVER_HOST" = :: ]; then
  CHECK_URL="http://[::1]:$SERVER_PORT/api/state"
else
  CHECK_URL="http://127.0.0.1:$SERVER_PORT/api/state"
fi
for wait_round in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --fail --silent --max-time 2 "$CHECK_URL" >/dev/null 2>&1; then
    SERVICE_READY=1
    break
  fi
  sleep 1
done
if [ "$SERVICE_READY" -ne 1 ]; then
  systemctl --no-pager --full status bili-record-2k.service || true
  fail '服务安装完成但健康检查失败，请查看：journalctl -u bili-record-2k -n 100'
fi

PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
printf '\n============================================================\n'
printf '%s %s 安装成功\n' "$APP_NAME" "$LATEST_VERSION"
printf '管理用户名：%s\n' "$ADMIN_USERNAME"
if [ "$SERVER_HOST" = 0.0.0.0 ] || [ "$SERVER_HOST" = :: ]; then
  if [ -n "$PUBLIC_IP" ]; then
    printf '访问地址：http://%s:%s\n' "$PUBLIC_IP" "$SERVER_PORT"
  else
    printf '访问地址：http://服务器IP:%s\n' "$SERVER_PORT"
  fi
  printf '注意：公网长期使用请配置 HTTPS 反向代理，不要依赖明文 HTTP。\n'
  printf '如果外部无法连接，请在云安全组/防火墙中放行 TCP %s；脚本不会自动修改防火墙规则。\n' "$SERVER_PORT"
else
  printf '服务仅监听本机：http://127.0.0.1:%s\n' "$SERVER_PORT"
  printf 'SSH 转发示例：ssh -L %s:127.0.0.1:%s 用户@服务器IP\n' "$SERVER_PORT" "$SERVER_PORT"
fi
printf '服务状态：systemctl status bili-record-2k\n'
printf '实时日志：journalctl -u bili-record-2k -f\n'
printf '配置文件：%s\n' "$ENV_PATH"
printf '============================================================\n'
