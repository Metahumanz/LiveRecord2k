#!/bin/sh
set -eu
export BILI_RECORD_APP_ROOT="${BILI_RECORD_APP_ROOT:-/usr/lib/bili-record-2k}"
export BILI_RECORD_SERVER_ENTRY="${BILI_RECORD_SERVER_ENTRY:-/usr/lib/bili-record-2k/server.bundle.cjs}"
exec /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/server.bundle.cjs "$@"
