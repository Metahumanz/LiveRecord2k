#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Please run this installer as root: sudo ./install.sh' >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -d "$SCRIPT_DIR/payload/usr/lib/bili-record-2k" ]; then
  echo 'The Linux package payload is incomplete.' >&2
  exit 1
fi

cp -a "$SCRIPT_DIR/payload/." /
chmod 0755 /usr/bin/bili-record-2k /usr/bin/bili-record-2k-update
exec /usr/lib/bili-record-2k/provision.sh tarball
