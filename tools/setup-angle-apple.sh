#!/usr/bin/env bash
# setup-angle-apple.sh [slice ...] [--build]: ANGLE (GLES 3 on Metal) built from source for visionOS, the GPU behind the
# vision host where the iOS build has raylib-iOS's prebuilt xcframeworks (tools/setup-ios.sh) and the xros SDK
# has only Apple's software OpenGL ES. Slices: xros-arm64 (device), xrsim-arm64 (simulator); ios-arm64 and
# iossim-arm64 build the same way when asked for (the prebuilt stays the iOS default).
#
# Output: third_party/angle-apple/lib/<slice>/{libEGL.dylib, libGLESv2.dylib} (install names @rpath/...),
# include/ (EGL, GLES2, GLES3, KHR headers with ANGLE's extensions), VERSION. The checkout lives in
# third_party/angle-src (gitignored): depot_tools' `fetch angle` at the pinned commit, target_os ios, with the
# same xros patch to Chromium's build/ tree that tools/setup-v8-apple.sh applies to V8's (tools/patches/v8-apple).
#
# Why the same commit as the iOS prebuilt: one ANGLE behaviour across ios and vision (shader translator, Metal
# backend workarounds); this script pins it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
PATCHES="$ROOT/tools/patches/v8-apple"          # the xros target for Chromium's build/ tree (shared with V8)
PATCHES_ANGLE="$ROOT/tools/patches/angle-apple"  # what only ANGLE's bundling needs on xros
OUTDIR="$TP/angle-apple"
SRC="$TP/angle-src"
ANGLE_COMMIT=${ANGLE_COMMIT:-170484eea03a4255a388072add4232e1fadfbee4}   # upstream ANGLE 2.1.28853, the commit raylib-iOS 6.0.7 packaged for iOS
DEPOT_TOOLS_REV=${DEPOT_TOOLS_REV:-3a8af1e64be01a524f7d1c46daf8c2dcac63ff85}
JOBS=${ANGLE_APPLE_JOBS:-6}
log() { printf '\033[1;34m[setup-angle-apple]\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

# 0. the prebuilt slices (xros-arm64, xrsim-arm64): the GitHub release angle-apple-2.1.28853 of webxr-to-native holds
#    what steps 1-5 produce at the pinned commit (one archive per slice, one for the headers, each with LICENSES/).
#    Downloaded and checked against the SHA-256 below, which skips the 12 GB checkout and ~20 min per slice.
#    --build (or a slice without a prebuilt, or another ANGLE_COMMIT) builds from source as below.
PREBUILT_URL=${PREBUILT_URL:-https://github.com/Srile/webxr-to-native/releases/download}
PREBUILT_TAG=angle-apple-2.1.28853
prebuilt_sha() {
  case "$1" in
    angle-apple-2.1.28853-include.tar.gz)     echo 3780ebd335bd6e4316812638b7db558c6b58b15209c309ff93d9b8ffff2c3901;;
    angle-apple-2.1.28853-xros-arm64.tar.gz)  echo 0dd8179e1fe2cc99c7756438c91fc48e14db853f58b10a70167aa0959b0589dc;;
    angle-apple-2.1.28853-xrsim-arm64.tar.gz) echo fc3c1e9a07eef4e7991ce251ab118acb58496882f66fe06a6dba3f3f911598d2;;
  esac
}
fetch_prebuilt() {  # fetch_prebuilt <archive>: download, verify, unpack into $OUTDIR
  local f=$1 sha tmp="$TP/$1.part"; sha=$(prebuilt_sha "$f"); [ -n "$sha" ] || return 1
  curl -fsSL --retry 3 -o "$tmp" "$PREBUILT_URL/$PREBUILT_TAG/$f" || { rm -f "$tmp"; return 1; }
  echo "$sha  $tmp" | shasum -a 256 -c - >/dev/null 2>&1 || { rm -f "$tmp"; log "checksum mismatch: $f"; return 1; }
  mkdir -p "$OUTDIR" && tar -xzf "$tmp" -C "$OUTDIR" && rm -f "$tmp"
}
BUILD=0; REST=(); for a in "$@"; do if [ "$a" = "--build" ]; then BUILD=1; else REST+=("$a"); fi; done
set -- ${REST[@]+"${REST[@]}"}
if [ "$BUILD" = 0 ] && [ "${1:-}" != "--checkout-only" ] && [ "$ANGLE_COMMIT" = 170484eea03a4255a388072add4232e1fadfbee4 ]; then
  WANT=("$@"); [ ${#WANT[@]} -gt 0 ] || WANT=(xrsim-arm64 xros-arm64)
  missing=()
  for slice in "${WANT[@]}"; do
    if [ -f "$OUTDIR/$slice/libGLESv2.framework/libGLESv2" ] && [ "$(cat "$OUTDIR/$slice/COMMIT" 2>/dev/null)" = "$ANGLE_COMMIT" ]; then continue; fi
    log "$slice: prebuilt"; if fetch_prebuilt "$PREBUILT_TAG-$slice.tar.gz"; then ok "$slice: prebuilt"; else missing+=("$slice"); fi
  done
  if [ ${#missing[@]} -eq 0 ] && [ ! -f "$OUTDIR/include/GLES3/gl3.h" ]; then fetch_prebuilt "$PREBUILT_TAG-include.tar.gz" || missing=(include); fi
  if [ ${#missing[@]} -eq 0 ]; then ok "ANGLE $ANGLE_COMMIT (prebuilt) → $OUTDIR"; exit 0; fi
  log "no prebuilt for ${missing[*]}: building from source"
fi

# 1. depot_tools (shared with the V8 build)
if [ ! -d "$TP/depot_tools" ]; then log "clone depot_tools"; git clone -q https://chromium.googlesource.com/chromium/tools/depot_tools.git "$TP/depot_tools"; fi
if [ -n "$DEPOT_TOOLS_REV" ]; then git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV" 2>/dev/null || { git -C "$TP/depot_tools" fetch -q origin; git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV"; }; fi
[ -f "$TP/depot_tools/python3_bin_reldir.txt" ] || { log "bootstrap depot_tools"; "$TP/depot_tools/ensure_bootstrap"; }
export DEPOT_TOOLS_UPDATE=0 VPYTHON_BYPASS="manually managed python not supported by chrome operations"
export PATH="$TP/depot_tools/$(cat "$TP/depot_tools/python3_bin_reldir.txt"):$TP/depot_tools:$PATH"
ok "depot_tools $(git -C "$TP/depot_tools" rev-parse --short HEAD)"

# 2. the checkout at the pinned commit, target_os ios
if [ ! -d "$SRC" ]; then
  mkdir -p "$SRC"; log "fetch angle (no history) into $SRC"
  (cd "$SRC" && fetch --no-history angle)
fi
grep -q "target_os" "$SRC/.gclient" || printf "target_os = ['ios']\n" >> "$SRC/.gclient"
if [ ! -f "$SRC/.synced-$ANGLE_COMMIT" ]; then
  log "checkout $ANGLE_COMMIT + gclient sync"
  git -C "$SRC" fetch -q --depth 1 origin "$ANGLE_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
  (cd "$SRC" && gclient sync -D --no-history --nohooks)
  (cd "$SRC" && gclient runhooks)
  touch "$SRC/.synced-$ANGLE_COMMIT"
fi
ok "ANGLE $(git -C "$SRC" rev-parse --short HEAD)"

# 3. the xros patch to build/ (paths relative to angle/): applied once, checked by reverse dry-run
for p in "$PATCHES"/*.patch "$PATCHES_ANGLE"/*.patch; do
  [ -f "$p" ] || continue
  if patch -p1 -d "$SRC" -R --dry-run -s -f < "$p" >/dev/null 2>&1; then ok "patched: $(basename "$p")"
  else patch -p1 -d "$SRC" -N -s < "$p" || fail "patch failed: $p (ANGLE's build/ revision differs from V8's; adapt a copy under tools/patches/angle-apple)"; ok "patch applied: $(basename "$p")"; fi
done
[ "${1:-}" = "--checkout-only" ] && exit 0

# 4. per slice: gn gen + ninja libEGL libGLESv2 (ios_framework_bundle targets on target_os ios), the frameworks
#    copied out. Metal only: no GL/Vulkan/SwiftShader backends, no tests, no trace, no frame capture.
COMMON_ARGS='target_os="ios" target_cpu="arm64" is_debug=false is_component_build=false is_official_build=false
  angle_enable_metal=true angle_enable_gl=false angle_enable_vulkan=false angle_enable_swiftshader=false
  angle_enable_null=false angle_build_tests=false angle_enable_trace=false angle_has_frame_capture=false
  angle_enable_cl=false symbol_level=0 dcheck_always_on=false treat_warnings_as_errors=false
  ios_enable_code_signing=false use_remoteexec=false use_siso=false'
slice_args() {
  case "$1" in
    ios-arm64)    echo 'target_platform="iphoneos" target_environment="device"    ios_deployment_target="15.0"';;
    iossim-arm64) echo 'target_platform="iphoneos" target_environment="simulator" ios_deployment_target="15.0"';;
    xros-arm64)   echo 'target_platform="xros"     target_environment="device"    ios_deployment_target="2.0" use_lld=false';;  # Apple's ld: Chromium's compiler-rt xros builtins carry minos 26.5, which lld refuses against 2.0
    xrsim-arm64)  echo 'target_platform="xros"     target_environment="simulator" ios_deployment_target="2.0"';;
    *) fail "unknown slice $1 (ios-arm64 | iossim-arm64 | xros-arm64 | xrsim-arm64)";;
  esac
}
SLICES=("$@"); [ ${#SLICES[@]} -gt 0 ] || SLICES=(xrsim-arm64 xros-arm64)
for slice in "${SLICES[@]}"; do
  DST="$OUTDIR/$slice"
  if [ -f "$DST/libGLESv2.framework/libGLESv2" ] && [ "$(cat "$DST/COMMIT" 2>/dev/null)" = "$ANGLE_COMMIT" ]; then ok "$slice: built ($DST)"; continue; fi
  OUT="$SRC/out/$slice"; ARGS="$COMMON_ARGS $(slice_args "$slice")"
  log "$slice: gn gen"
  (cd "$SRC" && gn gen "$OUT" --args="$ARGS") || fail "$slice: gn gen failed"
  log "$slice: ninja -j $JOBS libEGL libGLESv2 (20-40 min)"
  (cd "$SRC" && ninja -C "$OUT" -j "$JOBS" libEGL libGLESv2) || fail "$slice: ninja failed"
  mkdir -p "$DST"; rm -rf "$DST/libEGL.framework" "$DST/libGLESv2.framework"
  for n in libEGL libGLESv2; do
    [ -d "$OUT/$n.framework" ] || fail "$slice: $OUT/$n.framework missing (ios_framework_bundle output moved?)"
    cp -R "$OUT/$n.framework" "$DST/$n.framework"
  done
  echo "$ANGLE_COMMIT" > "$DST/COMMIT"; echo "$ARGS" > "$DST/args.gn"
  ok "$slice: $(otool -L "$DST/libGLESv2.framework/libGLESv2" | sed -n 2p | tr -d '\t') ($(du -sh "$DST/libGLESv2.framework" | cut -f1))"
  (cd "$DST/libGLESv2.framework" && vtool -show-build libGLESv2 2>/dev/null | grep -E 'platform|minos' | tr '\n' ' '); echo
  [ -n "${ANGLE_APPLE_KEEP_OUT:-}" ] || rm -rf "$OUT"
done
# 5. headers (ANGLE's EGL/GLES headers carry its extensions) and VERSION
rm -rf "$OUTDIR/include"; mkdir -p "$OUTDIR/include"
for d in EGL GLES2 GLES3 KHR; do cp -R "$SRC/include/$d" "$OUTDIR/include/$d"; done
{ echo "ANGLE $ANGLE_COMMIT (tools/setup-angle-apple.sh)"; echo "depot_tools $(git -C "$TP/depot_tools" rev-parse HEAD)"
  echo "Xcode $(xcodebuild -version | tr '\n' ' ')"; echo "slices: $(ls "$OUTDIR" | grep -v -e include -e VERSION | tr '\n' ' ')"
  echo "gn: $COMMON_ARGS"; } > "$OUTDIR/VERSION"
ok "$(head -1 "$OUTDIR/VERSION")"
