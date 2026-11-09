#!/usr/bin/env bash
# webxr-host toolchain bootstrap. Idempotent. Installs into tools/sdk and
# third_party only; nothing global, no sudo. Versions and licences: THIRD_PARTY_NOTICES.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/tools/sdk"; TP="$ROOT/third_party"
mkdir -p "$SDK" "$TP"
log(){ printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
dl(){ # dl <url> <out>
  [ -f "$2" ] && return 0
  log "download $(basename "$2")"; curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}

# The build machine: macOS (arm64 or x64) or Linux (x64; the NDK and build-tools ship x86_64 Linux binaries only,
# so an arm64 Linux box needs x86_64 emulation through binfmt).
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) JDK_OS=mac; JDK_ARCH=aarch64; CLT_OS=mac; JDK_HOME="$SDK/jdk/Contents/Home";;
  Darwin-x86_64) JDK_OS=mac; JDK_ARCH=x64; CLT_OS=mac; JDK_HOME="$SDK/jdk/Contents/Home";;
  Linux-x86_64) JDK_OS=linux; JDK_ARCH=x64; CLT_OS=linux; JDK_HOME="$SDK/jdk";;
  Linux-aarch64) JDK_OS=linux; JDK_ARCH=aarch64; CLT_OS=linux; JDK_HOME="$SDK/jdk";;
  *) fail "unsupported build machine $(uname -s) $(uname -m)";;
esac

# 1. JDK 17 (Temurin, for this machine)
if [ ! -x "$JDK_HOME/bin/java" ]; then
  dl "https://api.adoptium.net/v3/binary/latest/17/ga/$JDK_OS/$JDK_ARCH/jdk/hotspot/normal/eclipse" "$SDK/jdk17.tar.gz"
  mkdir -p "$SDK/jdk.tmp" && tar -xzf "$SDK/jdk17.tar.gz" -C "$SDK/jdk.tmp"
  rm -rf "$SDK/jdk"; mv "$SDK/jdk.tmp"/jdk-17* "$SDK/jdk"; rm -rf "$SDK/jdk.tmp"
fi
export JAVA_HOME="$JDK_HOME"; ok "jdk $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# 2. Android cmdline-tools + sdkmanager packages
ANDROID_HOME="$SDK/android"; mkdir -p "$ANDROID_HOME"
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKM" ]; then
  dl "https://dl.google.com/android/repository/commandlinetools-$CLT_OS-11076708_latest.zip" "$SDK/cmdline-tools.zip"
  rm -rf "$ANDROID_HOME/cmdline-tools"; mkdir -p "$ANDROID_HOME/cmdline-tools"
  unzip -q "$SDK/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
export ANDROID_HOME
NDK_VER="27.2.12479018"
need_pkgs=()
[ -d "$ANDROID_HOME/platform-tools" ] || need_pkgs+=("platform-tools")
[ -d "$ANDROID_HOME/platforms/android-34" ] || need_pkgs+=("platforms;android-34")
[ -d "$ANDROID_HOME/build-tools/34.0.0" ] || need_pkgs+=("build-tools;34.0.0")
[ -d "$ANDROID_HOME/ndk/$NDK_VER" ] || need_pkgs+=("ndk;$NDK_VER")
if [ ${#need_pkgs[@]} -gt 0 ]; then
  log "sdkmanager ${need_pkgs[*]}"
  yes | "$SDKM" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
  "$SDKM" --sdk_root="$ANDROID_HOME" "${need_pkgs[@]}"
fi
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_VER"
ok "ndk $(cat "$ANDROID_NDK_HOME/source.properties" | grep Revision | cut -d= -f2)"
ok "platform-tools $("$ANDROID_HOME/platform-tools/adb" --version | head -1)"

# 3. Gradle 8.9 distribution (for the wrapper's first run; wrapper files are committed)
if [ ! -d "$SDK/gradle-8.9" ]; then
  dl "https://services.gradle.org/distributions/gradle-8.9-bin.zip" "$SDK/gradle-8.9.zip"
  unzip -q "$SDK/gradle-8.9.zip" -d "$SDK"
fi
ok "gradle $SDK/gradle-8.9"

# A file's SHA-256 against the pinned one: sha256sum on Linux (coreutils), shasum on macOS (Perl's); either missing
# must read as a missing tool, never as a checksum mismatch.
sha256_ok() {
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null; then echo "$1  $2" | shasum -a 256 -c - >/dev/null
  else fail "no sha256sum or shasum to check $2"; fi
}
# 4. V8 prebuilt: NativeScript/v8-buildscripts release v8-14.9.207.39-9, V8 14.9.207.39 as a static monolith for
#    arm64-v8a (built against the NDK's libc++, pointer compression and 31-bit smis on, no sandbox, no ICU, the
#    inspector and the startup snapshot built in). Linked into libwebxrhost.so, which is 16 KB aligned (Android 15+
#    devices with 16 KB pages; Play) where the old shared libv8android.so was 4 KB aligned.
V8_REL="v8-14.9.207.39-9"; V8_TGZ="v8-14.9.207.39-android-arm64-v8a.tar.gz"
V8_SHA="c2f32d86b01ce9e684de433181a98c6f3abe911693483cb9683c3a1c0669e525"
if [ ! -f "$TP/v8/lib/arm64-v8a/libv8_monolith.a" ]; then
  dl "https://github.com/NativeScript/v8-buildscripts/releases/download/$V8_REL/$V8_TGZ" "$TP/v8-android.tgz"
  sha256_ok "$V8_SHA" "$TP/v8-android.tgz" || fail "V8 tarball checksum mismatch"
  rm -rf "$TP/v8.tmp" "$TP/v8"; mkdir -p "$TP/v8.tmp" "$TP/v8/lib/arm64-v8a"
  tar -xzf "$TP/v8-android.tgz" -C "$TP/v8.tmp"
  cp -R "$TP/v8.tmp/android-arm64-v8a/include" "$TP/v8/include"
  cp "$TP/v8.tmp/android-arm64-v8a/lib/libv8_monolith.a" "$TP/v8/lib/arm64-v8a/"
  rm -rf "$TP/v8.tmp"
fi
ok "v8 $(grep -E 'define V8_(MAJOR|MINOR|BUILD)' "$TP/v8/include/v8-version.h" | awk '{print $3}' | paste -sd. -) (static)"

# 5. OpenXR loader AAR 1.1.49 (Khronos, Maven Central)
if [ ! -f "$TP/openxr/lib/arm64-v8a/libopenxr_loader.so" ]; then
  dl "https://repo1.maven.org/maven2/org/khronos/openxr/openxr_loader_for_android/1.1.49/openxr_loader_for_android-1.1.49.aar" "$TP/openxr_loader.aar"
  rm -rf "$TP/openxr.tmp" "$TP/openxr"; mkdir -p "$TP/openxr.tmp" "$TP/openxr/lib/arm64-v8a"
  unzip -q "$TP/openxr_loader.aar" -d "$TP/openxr.tmp"
  cp -R "$TP/openxr.tmp/prefab/modules/headers/include" "$TP/openxr/include"
  cp "$TP/openxr.tmp/prefab/modules/openxr_loader/libs/android.arm64-v8a/libopenxr_loader.so" "$TP/openxr/lib/arm64-v8a/"
  rm -rf "$TP/openxr.tmp"
fi
ok "openxr $(grep -m1 'XR_CURRENT_API_VERSION XR_MAKE_VERSION' "$TP/openxr/include/openxr/openxr.h" | sed 's/.*VERSION(//;s/)//')"

# 5b. libwebp 1.5.0 source (decoder only is built; the game ships .webp logos)
if [ ! -f "$TP/libwebp/CMakeLists.txt" ]; then
  rm -rf "$TP/libwebp"; curl -sL https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.5.0.tar.gz | tar xz -C "$TP" && mv "$TP/libwebp-1.5.0" "$TP/libwebp"
fi
ok "libwebp"

# 5c. libopus 1.5.2 source (its decoder: WebM audio, host/audio/decode.cpp)
if [ ! -f "$TP/opus/CMakeLists.txt" ]; then
  rm -rf "$TP/opus"; curl -fsSL https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz | tar xz -C "$TP" && mv "$TP/opus-1.5.2" "$TP/opus"
fi
ok "opus"

# 6. stb single headers (pinned commit)
STB_SHA="f0569113c93ad095470c54bf34a17b36646bbbb5"
mkdir -p "$TP/stb"
for f in stb_image.h stb_image_write.h stb_vorbis.c stb_truetype.h; do
  dl "https://raw.githubusercontent.com/nothings/stb/$STB_SHA/$f" "$TP/stb/$f"
done
ok "stb"

# 6b. dr_mp3 single header (pinned commit: v0.7.4; MP3 decode with the LAME tag's delay/padding, host/audio/decode.cpp)
DRLIBS_SHA="aec2dd20667f54acfdb66031217df6d240f56c52"
mkdir -p "$TP/dr_libs"
dl "https://raw.githubusercontent.com/mackron/dr_libs/$DRLIBS_SHA/dr_mp3.h" "$TP/dr_libs/dr_mp3.h"
ok "dr_mp3"

# 7. Oboe 1.9.3 source (CMake add_subdirectory)
if [ ! -d "$TP/oboe/src" ]; then
  dl "https://github.com/google/oboe/archive/refs/tags/1.9.3.tar.gz" "$TP/oboe-1.9.3.tar.gz"
  rm -rf "$TP/oboe"; mkdir -p "$TP/oboe.tmp"; tar -xzf "$TP/oboe-1.9.3.tar.gz" -C "$TP/oboe.tmp"
  mv "$TP/oboe.tmp"/oboe-* "$TP/oboe"; rm -rf "$TP/oboe.tmp"
fi
ok "oboe"

# 7b. --emulator: the Android emulator, an arm64 Android 14 image and the AVD the phone build is tried on (WP-20).
if [ "${1:-}" = "--emulator" ] || [ "${2:-}" = "--emulator" ]; then
  IMG="system-images;android-34;google_apis;arm64-v8a"
  [ -x "$ANDROID_HOME/emulator/emulator" ] && [ -d "$ANDROID_HOME/system-images/android-34/google_apis/arm64-v8a" ] || "$SDKM" --sdk_root="$ANDROID_HOME" "emulator" "$IMG"
  [ -d "$HOME/.android/avd/webxr-phone.avd" ] || echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n webxr-phone -k "$IMG" -d pixel_7
  ok "emulator: AVD webxr-phone ($IMG, Pixel 7)"
fi

# 8. env.sh is committed and repo-relative; nothing to generate.
ok "tools/env.sh (committed, repo-relative)"
log "done"
