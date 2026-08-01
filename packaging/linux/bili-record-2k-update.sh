#!/bin/sh
set -eu
exec /usr/lib/bili-record-2k/bin/node /usr/lib/bili-record-2k/linux-update.cjs "$@"
