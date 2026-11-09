#!/usr/bin/env bash
# Fast compile check of host/ for arm64 Android without Gradle: build-android/libwebxrhost.so
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; source "$ROOT/tools/env.sh"
B="$ROOT/build-android"; mkdir -p "$B"
if [ ! -f "$B/build.ninja" ]; then
  cmake -G Ninja -S "$ROOT/host" -B "$B" -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-29 -DANDROID_STL=c++_shared -DCMAKE_BUILD_TYPE=Debug >/dev/null
fi
ninja -C "$B" "$@" 2>&1 | grep -vE "^\[|^ninja: no work" || true
ls -la "$B/libwebxrhost.so" | awk '{print "libwebxrhost.so", $5, "bytes"}'
