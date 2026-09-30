#!/usr/bin/env bash
# Build on Ubuntu ARM64 with gcc, make, pkg-config and
# libass/freetype/fontconfig/harfbuzz/GnuTLS development packages.
set -euo pipefail
build_dir=${1:?Specify an isolated build directory}
mkdir -p "$build_dir"
cd "$build_dir"
curl -fL https://ffmpeg.org/releases/ffmpeg-6.1.4.tar.xz -o ffmpeg-6.1.4.tar.xz
printf '%s\n' 'a231e3d5742c44b1cdaebfb98ad7b6200d12763e0b6db9e1e2c5891f2c083a18  ffmpeg-6.1.4.tar.xz' | sha256sum -c -
tar -xf ffmpeg-6.1.4.tar.xz
cd ffmpeg-6.1.4
pkg-config --exists gnutls || { echo 'GnuTLS development package is required for HTTPS recording' >&2; exit 1; }
./configure --disable-debug --disable-doc --disable-ffplay --disable-shared --enable-static --enable-gpl --enable-libass --enable-libfreetype --enable-libfontconfig --enable-libharfbuzz --enable-gnutls --enable-small
make -j"${BR2K_BUILD_JOBS:-4}" ffmpeg ffprobe
# FFmpeg libraries are static; system font/audio libraries remain dynamic.
./ffmpeg -version
ldd ./ffmpeg
./ffmpeg -hide_banner -protocols | sed -n '/^Input:/,/^Output:/p' | grep -Eq '^[[:space:]]+https$' || { echo 'Built FFmpeg is missing HTTPS input' >&2; exit 1; }
