#!/bin/sh
set -eu

APP_NAME=BiliRecord2K
REPOSITORY=${BILI_RECORD_REPOSITORY:-Metahumanz/LiveRecord2k}
MANIFEST_URL=${BILI_RECORD_MANIFEST_URL:-https://github.com/$REPOSITORY/releases/latest/download/update.json}
HOST_WAS_SUPPLIED=0
PORT_WAS_SUPPLIED=0
USERNAME_WAS_SUPPLIED=0
PASSWORD_WAS_SUPPLIED=0
AUTO_UPDATE_WAS_SUPPLIED=0
[ "${BILI_RECORD_HOST+x}" = x ] && HOST_WAS_SUPPLIED=1
[ "${BILI_RECORD_PORT+x}" = x ] && PORT_WAS_SUPPLIED=1
[ "${BILI_RECORD_AUTH_USERNAME+x}" = x ] && USERNAME_WAS_SUPPLIED=1
[ "${BILI_RECORD_AUTH_PASSWORD+x}" = x ] && PASSWORD_WAS_SUPPLIED=1
[ "${BILI_RECORD_AUTO_UPDATE+x}" = x ] && AUTO_UPDATE_WAS_SUPPLIED=1
SETTINGS_PATH=/var/lib/bili-record-2k/BiliRecord2K/settings.json
HAS_EXISTING_SETTINGS=0
[ -f "$SETTINGS_PATH" ] && HAS_EXISTING_SETTINGS=1
SERVER_HOST=${BILI_RECORD_HOST:-127.0.0.1}
SERVER_PORT=${BILI_RECORD_PORT:-3263}
ADMIN_USERNAME=${BILI_RECORD_AUTH_USERNAME:-admin}
ADMIN_PASSWORD=${BILI_RECORD_AUTH_PASSWORD:-}
RECORDING_OUTPUT_DIR=${BILI_RECORD_OUTPUT_DIR:-}
AUTO_UPDATE=${BILI_RECORD_AUTO_UPDATE:-1}
DOWNLOAD_MIRROR=${BILI_RECORD_DOWNLOAD_MIRROR-https://gh-proxy.com/}
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
  BILI_RECORD_HOST           监听地址；首次交互安装可选择，默认 127.0.0.1
                             已安装时沿用已保存值；非交互安装可显式设为 0.0.0.0
  BILI_RECORD_PORT           监听端口，默认 3263
  BILI_RECORD_OUTPUT_DIR     录像保存目录（可选，必须为服务器上的绝对路径）
  BILI_RECORD_AUTO_UPDATE    1 开启自动更新，0 关闭
  BILI_RECORD_MANIFEST_URL   自定义 update.json 地址
  BILI_RECORD_DOWNLOAD_MIRROR
                             GitHub 下载镜像前缀，默认 https://gh-proxy.com/
                             设置为 direct、off 或空值可关闭镜像
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

validate_install_options() {
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
  if [ -n "$RECORDING_OUTPUT_DIR" ]; then
    case "$RECORDING_OUTPUT_DIR" in
      /*) ;;
      *) fail 'BILI_RECORD_OUTPUT_DIR 必须是服务器上的绝对路径。' ;;
    esac
  fi
  case "$DOWNLOAD_MIRROR" in
    ''|direct|off) DOWNLOAD_MIRROR= ;;
    *[[:space:]]*) fail 'BILI_RECORD_DOWNLOAD_MIRROR 不能包含空白字符。' ;;
    https://*) ;;
    *) fail 'BILI_RECORD_DOWNLOAD_MIRROR 必须是 HTTPS 地址，或设置为 direct 关闭。' ;;
  esac
  case "$MANIFEST_URL" in
    https://*) ;;
    *) fail 'BILI_RECORD_MANIFEST_URL 必须是 HTTPS 地址。' ;;
  esac
}

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

printf '\n[1/6] 检测系统与安装依赖...\n'
PACKAGE_KIND=tarball
if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
  PACKAGE_KIND=deb
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl jq openssl python3 ffmpeg fonts-noto-cjk gstreamer1.0-tools gstreamer1.0-plugins-base
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ca-certificates curl jq openssl python3 tar shadow-utils util-linux fontconfig gstreamer1 gstreamer1-plugins-base
  dnf install -y google-noto-sans-cjk-fonts || dnf install -y google-noto-cjk-fonts || \
    fail '当前软件源缺少 Noto Sans CJK 字体，请先启用相应字体软件源。'
  command -v ffmpeg >/dev/null 2>&1 || dnf install -y ffmpeg || fail '当前软件源没有 FFmpeg，请先为发行版启用 FFmpeg 软件源。'
elif command -v yum >/dev/null 2>&1; then
  yum install -y ca-certificates curl jq openssl python3 tar shadow-utils util-linux fontconfig gstreamer1 gstreamer1-plugins-base
  yum install -y google-noto-sans-cjk-fonts || yum install -y google-noto-cjk-fonts || \
    fail '当前软件源缺少 Noto Sans CJK 字体，请先启用相应字体软件源。'
  command -v ffmpeg >/dev/null 2>&1 || yum install -y ffmpeg || fail '当前软件源没有 FFmpeg，请先为发行版启用 FFmpeg 软件源。'
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive install ca-certificates curl jq openssl python3 tar shadow ffmpeg noto-sans-cjk-fonts gstreamer gstreamer-plugins-base
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm ca-certificates curl jq openssl python tar shadow ffmpeg noto-fonts-cjk gstreamer gst-plugins-base
else
  fail '不支持当前包管理器；请使用 Debian/Ubuntu、Fedora/RHEL、openSUSE 或 Arch Linux。'
fi

for required_command in curl jq openssl python3 base64 sha256sum ffmpeg tar fc-match; do
  command -v "$required_command" >/dev/null 2>&1 || fail "缺少必要命令：$required_command"
done
fc-match -f '%{family}' 'Noto Sans CJK SC' | grep -qi 'Noto Sans CJK SC' || \
  fail '没有检测到可验证的 Noto Sans CJK SC 字体。'

# A reinstall must not silently turn a privately bound, password-protected
# service into the installer defaults.  Read only the persisted public
# settings here; the password remains a one-way hash and is preserved unless
# the caller explicitly supplies BILI_RECORD_AUTH_PASSWORD.
inherit_existing_settings() {
  [ "$HAS_EXISTING_SETTINGS" -eq 1 ] || return 0
  jq -e '(.settings // {}) | type == "object"' "$SETTINGS_PATH" >/dev/null 2>&1 || \
    fail '已有 settings.json 无法解析，拒绝用默认安装参数覆盖它。'
  if [ "$HOST_WAS_SUPPLIED" -eq 0 ]; then
    PERSISTED_HOST=$(jq -r '.settings.serverHost // empty' "$SETTINGS_PATH") || fail '无法读取已有监听地址。'
    [ -z "$PERSISTED_HOST" ] || SERVER_HOST=$PERSISTED_HOST
  fi
  if [ "$PORT_WAS_SUPPLIED" -eq 0 ]; then
    PERSISTED_PORT=$(jq -r '.settings.serverPort // empty' "$SETTINGS_PATH") || fail '无法读取已有监听端口。'
    [ -z "$PERSISTED_PORT" ] || SERVER_PORT=$PERSISTED_PORT
  fi
  if [ "$USERNAME_WAS_SUPPLIED" -eq 0 ]; then
    PERSISTED_USERNAME=$(jq -r '.settings.accessUsername // empty' "$SETTINGS_PATH") || fail '无法读取已有管理用户名。'
    [ -z "$PERSISTED_USERNAME" ] || ADMIN_USERNAME=$PERSISTED_USERNAME
  fi
  if [ "$AUTO_UPDATE_WAS_SUPPLIED" -eq 0 ]; then
    PERSISTED_AUTO_UPDATE=$(jq -r 'if .settings.autoUpdateEnabled == true then "1" elif .settings.autoUpdateEnabled == false then "0" else empty end' "$SETTINGS_PATH") || \
      fail '无法读取已有自动更新设置。'
    [ -z "$PERSISTED_AUTO_UPDATE" ] || AUTO_UPDATE=$PERSISTED_AUTO_UPDATE
  fi
}

choose_listen_host() {
  # Preserve an existing WebUI bind address on reinstall, and let automation
  # supply BILI_RECORD_HOST without ever waiting for a terminal response.
  [ "$HOST_WAS_SUPPLIED" -eq 0 ] || return 0
  [ "$HAS_EXISTING_SETTINGS" -eq 0 ] || return 0
  if [ ! -r /dev/tty ]; then
    printf '%s\n' '未检测到交互终端，WebUI 将仅监听本机 127.0.0.1:3263；如需外部访问，请设置 BILI_RECORD_HOST=0.0.0.0。' >&2
    return 0
  fi
  while :; do
    printf '\n请选择 WebUI 监听地址：\n' >/dev/tty
    printf '  1) 仅本机访问  127.0.0.1:3263（默认，推荐配合 SSH 隧道或反向代理）\n' >/dev/tty
    printf '  2) 所有网卡    0.0.0.0:3263（局域网/公网直连；请设置密码和防火墙）\n' >/dev/tty
    printf '请输入 1 或 2 [1]：' >/dev/tty
    IFS= read -r LISTEN_CHOICE </dev/tty || exit 1
    case "$LISTEN_CHOICE" in
      ''|1)
        SERVER_HOST=127.0.0.1
        return 0
        ;;
      2)
        SERVER_HOST=0.0.0.0
        return 0
        ;;
      *)
        printf '请输入 1 或 2。\n' >/dev/tty
        ;;
    esac
  done
}

inherit_existing_settings
choose_listen_host
validate_install_options
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ "$HAS_EXISTING_SETTINGS" -eq 1 ] && [ "$PASSWORD_WAS_SUPPLIED" -eq 0 ]; then
    : # Keep the existing password hash; it cannot and must not be recovered.
  else
    read_password
  fi
elif [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
  fail 'BILI_RECORD_AUTH_PASSWORD 至少需要 8 位。'
fi

MACHINE_ARCH=$(uname -m)
case "$MACHINE_ARCH" in
  x86_64|amd64) RELEASE_ARCH=x64 ;;
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  *) fail "暂不支持的 CPU 架构：$MACHINE_ARCH" ;;
esac

TEMP_ROOT=$(mktemp -d /tmp/bili-record-2k-install.XXXXXX)
MANIFEST_PATH=$TEMP_ROOT/update.json

printf '\n[2/6] 获取最新版本清单...\n'
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-filesize 2097152 \
  --retry 3 --connect-timeout 15 --max-time 120 \
  "$MANIFEST_URL" -o "$MANIFEST_PATH"
jq -e '.schemaVersion == 3 and .signatureAlgorithm == "ed25519" and (.signature | type == "string") and (.signed.files | type == "array")' "$MANIFEST_PATH" >/dev/null || fail '更新清单缺少官方签名。'
PUBLIC_KEY_PATH=$TEMP_ROOT/update-public-key.pem
SIGNED_PAYLOAD_PATH=$TEMP_ROOT/update-signed.json
SIGNATURE_PATH=$TEMP_ROOT/update-signature.bin
printf '%s\n' \
  '-----BEGIN PUBLIC KEY-----' \
  'MCowBQYDK2VwAyEAtw1n+yFGBOlnGb0ru4hmM7K7q2YK5jFJ0GnWW5BIiu0=' \
  '-----END PUBLIC KEY-----' >"$PUBLIC_KEY_PATH"
jq -j -cS '.signed' "$MANIFEST_PATH" >"$SIGNED_PAYLOAD_PATH" || fail '更新清单签名内容无效。'
jq -r '.signature' "$MANIFEST_PATH" | base64 -d >"$SIGNATURE_PATH" || fail '更新清单签名编码无效。'

# OpenSSL 1.1.1 implements Ed25519 through EVP_DigestVerify, but its
# pkeyutl utility cannot use Ed25519 at all.  Call the stable EVP API through
# Python's standard ctypes module so Ubuntu 20.04/L4T can verify exactly the
# same raw signature without requiring an OpenSSL 3.x command-line feature.
verify_ed25519_signature() {
  python3 - "$PUBLIC_KEY_PATH" "$SIGNED_PAYLOAD_PATH" "$SIGNATURE_PATH" <<'PY'
import ctypes
import ctypes.util
import pathlib
import sys


def fail(message):
    print(f'Ed25519 verification unavailable: {message}', file=sys.stderr)
    raise SystemExit(1)


def load_libcrypto():
    candidates = []
    discovered = ctypes.util.find_library('crypto')
    if discovered:
        candidates.append(discovered)
    candidates.extend(('libcrypto.so.3', 'libcrypto.so.1.1', 'libcrypto.so'))
    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            return ctypes.CDLL(candidate)
        except OSError:
            continue
    fail('未找到 libcrypto（需要 OpenSSL 1.1.1 或更高版本）。')


public_key_path, message_path, signature_path = map(pathlib.Path, sys.argv[1:4])
try:
    public_key = public_key_path.read_bytes()
    message = message_path.read_bytes()
    signature = signature_path.read_bytes()
except OSError as error:
    fail(str(error))
if len(signature) != 64:
    fail('签名长度不是 Ed25519 所需的 64 字节。')

crypto = load_libcrypto()
crypto.BIO_new_mem_buf.argtypes = (ctypes.c_void_p, ctypes.c_int)
crypto.BIO_new_mem_buf.restype = ctypes.c_void_p
crypto.BIO_free.argtypes = (ctypes.c_void_p,)
crypto.BIO_free.restype = ctypes.c_int
crypto.PEM_read_bio_PUBKEY.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_void_p)
crypto.PEM_read_bio_PUBKEY.restype = ctypes.c_void_p
crypto.EVP_PKEY_free.argtypes = (ctypes.c_void_p,)
crypto.EVP_PKEY_free.restype = None
crypto.EVP_MD_CTX_new.argtypes = ()
crypto.EVP_MD_CTX_new.restype = ctypes.c_void_p
crypto.EVP_MD_CTX_free.argtypes = (ctypes.c_void_p,)
crypto.EVP_MD_CTX_free.restype = None
crypto.EVP_DigestVerifyInit.argtypes = (
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_void_p,
)
crypto.EVP_DigestVerifyInit.restype = ctypes.c_int
crypto.EVP_DigestVerify.argtypes = (
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.c_size_t,
)
crypto.EVP_DigestVerify.restype = ctypes.c_int

public_key_buffer = ctypes.create_string_buffer(public_key)
message_buffer = ctypes.create_string_buffer(message)
signature_buffer = ctypes.create_string_buffer(signature)
bio = crypto.BIO_new_mem_buf(public_key_buffer, len(public_key))
if not bio:
    fail('无法读取内置公钥。')
pkey = None
context = None
try:
    pkey = crypto.PEM_read_bio_PUBKEY(bio, None, None, None)
    if not pkey:
        fail('内置公钥不是有效的 PEM 公钥。')
    context = crypto.EVP_MD_CTX_new()
    if not context:
        fail('无法创建 Ed25519 验证上下文。')
    if crypto.EVP_DigestVerifyInit(context, None, None, None, pkey) != 1:
        fail('当前 libcrypto 不支持 Ed25519 EVP 验证。')
    if crypto.EVP_DigestVerify(context, signature_buffer, len(signature), message_buffer, len(message)) != 1:
        fail('签名不匹配。')
finally:
    if context:
        crypto.EVP_MD_CTX_free(context)
    if pkey:
        crypto.EVP_PKEY_free(pkey)
    crypto.BIO_free(bio)
PY
}
verify_ed25519_signature || fail '更新清单未通过官方 Ed25519 签名验证。'
LATEST_VERSION=$(jq -r '.signed.version' "$MANIFEST_PATH")
PACKAGE_ENTRY=$(jq -r \
  --arg kind "$PACKAGE_KIND" \
  --arg arch "$RELEASE_ARCH" \
  '.signed.files[] | select(.platform == "linux" and .kind == $kind and (.arch == $arch or .arch == "all")) | [.url, .sha256, .name] | @tsv' \
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

download_and_verify() {
  download_source=$1
  download_url=$2
  rm -f -- "$PACKAGE_PATH"
  printf '  尝试%s...\n' "$download_source"
  if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-filesize 8589934592 \
    --retry 3 --connect-timeout 15 --max-time 1800 \
    "$download_url" -o "$PACKAGE_PATH"; then
    printf '  %s下载失败。\n' "$download_source" >&2
    rm -f -- "$PACKAGE_PATH"
    return 1
  fi
  ACTUAL_SHA256=$(sha256sum "$PACKAGE_PATH" | awk '{print $1}')
  if [ "$ACTUAL_SHA256" != "$PACKAGE_SHA256" ]; then
    printf '  %s返回的文件未通过官方 SHA-256 校验。\n' "$download_source" >&2
    rm -f -- "$PACKAGE_PATH"
    return 1
  fi
  PACKAGE_DOWNLOAD_SOURCE=$download_source
  return 0
}

PACKAGE_DOWNLOADED=0
if [ -n "$DOWNLOAD_MIRROR" ]; then
  case "$PACKAGE_URL" in
    https://github.com/*)
      MIRROR_PACKAGE_URL=${DOWNLOAD_MIRROR%/}/$PACKAGE_URL
      if download_and_verify "GitHub 镜像 $DOWNLOAD_MIRROR" "$MIRROR_PACKAGE_URL"; then
        PACKAGE_DOWNLOADED=1
      else
        printf '  镜像不可用或内容异常，自动回退 GitHub 官方源。\n' >&2
      fi
      ;;
  esac
fi
if [ "$PACKAGE_DOWNLOADED" -ne 1 ]; then
  download_and_verify "GitHub 官方源" "$PACKAGE_URL" || fail '安装包下载失败或 SHA-256 校验不通过，已拒绝安装。'
fi
printf '  下载完成，来源：%s；SHA-256 校验通过。\n' "$PACKAGE_DOWNLOAD_SOURCE"

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
  # Do not overwrite an existing SMB/custom recording root on reinstall.  A
  # supplied BILI_RECORD_OUTPUT_DIR is explicit; otherwise the default only
  # applies when there is no persisted settings file yet.
  if [ -n "$RECORDING_OUTPUT_DIR" ]; then
    OUTPUT_DIR_ESCAPED=$(escape_environment_value "$RECORDING_OUTPUT_DIR")
    printf 'BILI_RECORD_OUTPUT_DIR="%s"\n' "$OUTPUT_DIR_ESCAPED"
  elif [ ! -f "$SETTINGS_PATH" ]; then
    printf '%s\n' 'BILI_RECORD_OUTPUT_DIR=/var/lib/bili-record-2k/recordings'
  fi
  printf 'BILI_RECORD_HOST="%s"\n' "$SERVER_HOST"
  printf 'BILI_RECORD_PORT="%s"\n' "$SERVER_PORT"
  printf 'BILI_RECORD_AUTH_USERNAME="%s"\n' "$USERNAME_ESCAPED"
  if [ -n "$ADMIN_PASSWORD" ]; then
    printf 'BILI_RECORD_AUTH_PASSWORD="%s"\n' "$PASSWORD_ESCAPED"
  fi
  printf 'BILI_RECORD_AUTO_UPDATE="%s"\n' "$AUTO_UPDATE"
  printf '%s\n' 'BILI_RECORD_MANAGED_UPDATE=1'
  printf '%s\n' 'BILI_RECORD_SYSTEMD=1'
  printf '%s\n' 'BILI_RECORD_APPLY_BOOTSTRAP=1'
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
elif [ "$SERVER_HOST" = localhost ]; then
  CHECK_URL="http://localhost:$SERVER_PORT/api/state"
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
