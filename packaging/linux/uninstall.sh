#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Please run this uninstaller as root: sudo ./uninstall.sh' >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now bili-record-2k-update.path bili-record-2k.service 2>/dev/null || true
fi
rm -f /usr/bin/bili-record-2k /usr/bin/bili-record-2k-update
rm -rf /usr/lib/bili-record-2k
rm -f /usr/lib/systemd/system/bili-record-2k.service
rm -f /usr/lib/systemd/system/bili-record-2k-update.service
rm -f /usr/lib/systemd/system/bili-record-2k-update.path
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
echo 'BiliRecord2K program files were removed.'
echo 'Recordings and configuration under /var/lib/bili-record-2k and /etc/bili-record-2k were preserved.'
