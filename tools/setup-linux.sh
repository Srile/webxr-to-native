#!/usr/bin/env bash
# Experimental Linux host (host/linux/, WP-18): its third-party pieces. Idempotent; no sudo (it prints the one
# package line to install when something is missing).
#  - V8 from Homebrew (Linuxbrew: the same `v8` formula as the mac host; checked, not installed: `brew install v8`)
#  - GLFW, EGL + GLES (libglvnd, Mesa or NVIDIA behind it), libcurl, libpulse, X11, CMake, Ninja, pkg-config from
#    the distribution (checked)
#  - the shared sources every host builds from, pinned as tools/setup.sh pins them: stb, dr_mp3 0.7.4, libwebp 1.5.0, libopus 1.5.2, the OpenXR
#    headers (out of the Khronos loader AAR), WAMR 2.4.5 + SIMDe 0.8.2 (host.json wasm.interpreter)
#  - --angle: ANGLE's libEGL.so + libGLESv2.so (Vulkan backend) out of the pinned Electron release into
#    third_party/angle-linux, for -DHOST_LINUX_ANGLE=ON (the mac/win GL stack, for parity checks)
#  - --sources: only the shared sources (the host unit tests, -DHOST_TESTS=ON, need nothing else)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
log(){ printf '\033[1;34m[setup-linux]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
dl(){ [ -f "$2" ] && return 0; log "download $(basename "$2")"; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
sha(){ echo "$1  $2" | sha256sum -c - >/dev/null || fail "checksum mismatch: $2"; }
[ "$(uname -s)" = Linux ] || fail "tools/setup-linux.sh is for Linux (the mac host: tools/setup-mac.sh)"
case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) fail "unsupported architecture $(uname -m)";; esac

SOURCES_ONLY=0; [ "${1:-}" = "--sources" ] && SOURCES_ONLY=1
for t in curl unzip tar sha256sum; do command -v "$t" >/dev/null || fail "$t missing (Debian/Ubuntu: sudo apt install curl unzip tar coreutils)"; done
if [ $SOURCES_ONLY = 0 ]; then
# 1. distribution packages
missing=()
for t in cmake ninja pkg-config; do command -v "$t" >/dev/null || missing+=("$t"); done
for m in glfw3 egl glesv2 libcurl libpulse x11; do pkg-config --exists "$m" 2>/dev/null || missing+=("pc:$m"); done
if [ ${#missing[@]} -gt 0 ]; then
  printf '  \033[31m✗\033[0m missing: %s\n' "${missing[*]}"
  echo "    Debian/Ubuntu: sudo apt install build-essential cmake ninja-build pkg-config curl unzip libglfw3-dev libegl-dev libgles-dev libx11-dev libcurl4-openssl-dev libpulse-dev"
  echo "    Fedora:        sudo dnf install gcc-c++ cmake ninja-build pkgconf curl unzip glfw-devel libglvnd-devel libX11-devel libcurl-devel pulseaudio-libs-devel"
  echo "    Arch:          sudo pacman -S base-devel cmake ninja pkgconf curl unzip glfw libglvnd libx11 curl libpulse"
  exit 1
fi
ok "system: glfw $(pkg-config --modversion glfw3), egl $(pkg-config --modversion egl), glesv2 $(pkg-config --modversion glesv2), curl $(pkg-config --modversion libcurl), pulse $(pkg-config --modversion libpulse)"

# 2. V8 (Homebrew bottle: x86_64_linux and arm64_linux). Read from the filesystem, not through brew: brew refuses
# to run as root (a CI container), and the prefix's opt/v8 link names the installed version.
BREW="$(command -v brew || echo /home/linuxbrew/.linuxbrew/bin/brew)"
[ -x "$BREW" ] || fail "Homebrew missing: https://brew.sh (Linux install), then: brew install v8"
V8_PREFIX="${V8_PREFIX:-$(cd "$(dirname "$(readlink -f "$BREW")")/../.." 2>/dev/null && pwd)/opt/v8}"
[ -d "$V8_PREFIX" ] || V8_PREFIX=/home/linuxbrew/.linuxbrew/opt/v8
[ -f "$V8_PREFIX/lib/libv8.so" ] || fail "v8 missing at $V8_PREFIX: brew install v8"
ok "v8 $(basename "$(readlink -f "$V8_PREFIX")") ($V8_PREFIX)"
fi

# 3. the shared sources (pins as in tools/setup.sh and tools/setup-ios.sh)
STB_SHA="f0569113c93ad095470c54bf34a17b36646bbbb5"
mkdir -p "$TP/stb"
for f in stb_image.h stb_image_write.h stb_vorbis.c stb_truetype.h; do dl "https://raw.githubusercontent.com/nothings/stb/$STB_SHA/$f" "$TP/stb/$f"; done
ok "stb"
DRLIBS_SHA="aec2dd20667f54acfdb66031217df6d240f56c52"
mkdir -p "$TP/dr_libs"; dl "https://raw.githubusercontent.com/mackron/dr_libs/$DRLIBS_SHA/dr_mp3.h" "$TP/dr_libs/dr_mp3.h"
ok "dr_mp3"
NANOSVG_SHA="239e102ec2c691f2902e20ace2ed36ee4a35cfe6"
mkdir -p "$TP/nanosvg"
for f in nanosvg.h nanosvgrast.h; do dl "https://raw.githubusercontent.com/memononen/nanosvg/$NANOSVG_SHA/src/$f" "$TP/nanosvg/$f"; done
ok "nanosvg"
if [ ! -f "$TP/libwebp/CMakeLists.txt" ]; then
  rm -rf "$TP/libwebp"; curl -fsSL https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.5.0.tar.gz | tar xz -C "$TP" && mv "$TP/libwebp-1.5.0" "$TP/libwebp"
fi
ok "libwebp"
if [ ! -f "$TP/opus/CMakeLists.txt" ]; then
  rm -rf "$TP/opus"; curl -fsSL https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz | tar xz -C "$TP" && mv "$TP/opus-1.5.2" "$TP/opus"
fi
ok "opus"
if [ ! -f "$TP/openxr/include/openxr/openxr.h" ]; then
  dl "https://repo1.maven.org/maven2/org/khronos/openxr/openxr_loader_for_android/1.1.49/openxr_loader_for_android-1.1.49.aar" "$TP/openxr_loader.aar"
  rm -rf "$TP/openxr.tmp"; mkdir -p "$TP/openxr.tmp" "$TP/openxr"
  unzip -q "$TP/openxr_loader.aar" -d "$TP/openxr.tmp"
  rm -rf "$TP/openxr/include"; cp -R "$TP/openxr.tmp/prefab/modules/headers/include" "$TP/openxr/include"; rm -rf "$TP/openxr.tmp"
fi
ok "openxr headers $(grep -m1 'XR_CURRENT_API_VERSION XR_MAKE_VERSION' "$TP/openxr/include/openxr/openxr.h" | sed 's/.*VERSION(//;s/)//')"
fetch_src() {  # name version url sha dir (the VERSION stamp as tools/setup-ios.sh writes it: "<name> <version>")
  if [ "$(cat "$TP/$5/VERSION" 2>/dev/null)" != "$1 $2" ]; then
    local tgz="$TP/$1-$2.tar.gz"; dl "$3" "$tgz"; sha "$4" "$tgz"
    rm -rf "$TP/$5" "$TP/$5.tmp"; mkdir -p "$TP/$5.tmp"; tar -xzf "$tgz" -C "$TP/$5.tmp" --strip-components 1
    echo "$1 $2" > "$TP/$5.tmp/VERSION"; mv "$TP/$5.tmp" "$TP/$5"
  fi
  ok "$(cat "$TP/$5/VERSION")"
}
fetch_src wamr 2.4.5 https://github.com/bytecodealliance/wasm-micro-runtime/archive/refs/tags/WAMR-2.4.5.tar.gz 1ab09d51099f276ca4a1d6629f6b589aab2bd0caa01445e05031a4bed22c199b wamr
fetch_src simde 0.8.2 https://github.com/simd-everywhere/simde/archive/refs/tags/v0.8.2.tar.gz ed2a3268658f2f2a9b5367628a85ccd4cf9516460ed8604eed369653d49b25fb simde

# 4. --angle: Electron's ANGLE for Linux (the release the mac and win hosts take theirs from)
if [ "${1:-}" = "--angle" ]; then
  ELECTRON=37.2.0
  case "$ARCH" in
    x64) ESHA=485c4e31fa3507cdde41bf6775ce3aec3f7fb43137cfa0c69a29f81d98b14873;;
    arm64) ESHA=560084caf6c41a9e717c09a83398dec4245726812fb93c2c38f8dc4fb92750cf;;
  esac
  ZIP="$TP/electron-v$ELECTRON-linux-$ARCH.zip"; ANGLE="$TP/angle-linux"
  if [ ! -f "$ANGLE/libGLESv2.so" ] || [ "$(cat "$ANGLE/VERSION" 2>/dev/null)" != "electron $ELECTRON $ARCH" ]; then
    dl "https://github.com/electron/electron/releases/download/v$ELECTRON/electron-v$ELECTRON-linux-$ARCH.zip" "$ZIP"; sha "$ESHA" "$ZIP"
    rm -rf "$ANGLE" "$ANGLE.tmp"; mkdir -p "$ANGLE.tmp"
    # ANGLE, the Vulkan loader it ships beside itself, and its SwiftShader Vulkan (HOST_ANGLE_DEVICE=swiftshader)
    unzip -q -j "$ZIP" libEGL.so libGLESv2.so libvulkan.so.1 libvk_swiftshader.so vk_swiftshader_icd.json LICENSES.chromium.html -d "$ANGLE.tmp"
    echo "electron $ELECTRON $ARCH" > "$ANGLE.tmp/VERSION"; mv "$ANGLE.tmp" "$ANGLE"
  fi
  ok "angle $(cat "$ANGLE/VERSION") ($ANGLE)"
fi
log "done"
