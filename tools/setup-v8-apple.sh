#!/usr/bin/env bash
# V8 for Apple platforms, built from source (the one rule exception WP-17 allows): static libv8_monolith.a for
#   ios-arm64 (iPhone/iPad), iossim-arm64 (iOS simulator), xros-arm64 (Apple Vision Pro), xrsim-arm64 (visionOS simulator)
# into third_party/v8-apple/{include,lib/<slice>,VERSION}. Jitless (no executable memory on iOS/visionOS), no
# WebAssembly (host/js/wasm_interp.cpp: WAMR supplies it), pointer compression on, i18n with the data compiled
# in, the system libc++ (the host links it too: use_custom_libcxx=false is what keeps the ABI shared).
# Chromium's GN tree knows no xros target: tools/patches/v8-apple/*.patch teach build/config/ios the "xros"
# platform. Stages, each idempotent and skippable: depot_tools → checkout (third_party/v8-src) → patches → slices.
#   tools/setup-v8-apple.sh [slice ...] [--build]   default: all four slices; the prebuilt release unless --build
#   V8_APPLE_JOBS=6 (ninja -j), V8_APPLE_KEEP_OUT=1 keeps out/<slice> after the archive is copied (else deleted: ~3 GB each)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
PATCHES="$ROOT/tools/patches/v8-apple"
DEST="$TP/v8-apple"
SRC="$TP/v8-src"
V8_TAG=15.6.75.19                         # newest tag on branch-heads/15.6 (the mac host runs Homebrew 15.6.75.x)
DEPOT_TOOLS_REV=${DEPOT_TOOLS_REV:-3a8af1e64be01a524f7d1c46daf8c2dcac63ff85}  # pinned; recorded in VERSION
JOBS=${V8_APPLE_JOBS:-6}
log(){ printf '\033[1;34m[setup-v8-apple]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

# 0. the prebuilt slices: the GitHub release v8-apple-$V8_TAG of webxr-to-native holds what steps 1-5 produce at
#    these pins (one archive per slice, one for the headers and ICU data, each with its LICENSES/). Downloaded and
#    checked against the SHA-256 below, which skips the ~5 GB checkout and ~40 min per slice. --build (or a slice
#    that cannot be fetched) builds from source as below.
PREBUILT_URL=${PREBUILT_URL:-https://github.com/Srile/webxr-to-native/releases/download}
prebuilt_sha() {
  case "$1" in
    v8-apple-15.6.75.19-include.tar.gz)      echo effabb52bb929dce880253a4f94385310f6932d402571e06dd664fe061177835;;
    v8-apple-15.6.75.19-ios-arm64.tar.gz)    echo b4fc915420a74d1488d9cb83c77f206be8301159f0535d6bcd9778a906e263d8;;
    v8-apple-15.6.75.19-iossim-arm64.tar.gz) echo b8f8f6511309cecbc623d47207427d84d711b31ca32c43d04d84567b02d088a2;;
    v8-apple-15.6.75.19-xros-arm64.tar.gz)   echo ec66eed07cd171667a2ec6cca4f915a3ad788e404c4f063704476c272c240fa7;;
    v8-apple-15.6.75.19-xrsim-arm64.tar.gz)  echo 94cd79da73d9ebc7250f4e3e4466e7133ad1e88b9bacbfad61291cd057fcda2d;;
  esac
}
fetch_prebuilt() {  # fetch_prebuilt <archive>: download, verify, unpack into $DEST
  local f=$1 sha tmp="$TP/$1.part"; sha=$(prebuilt_sha "$f"); [ -n "$sha" ] || return 1
  curl -fsSL --retry 3 -o "$tmp" "$PREBUILT_URL/v8-apple-$V8_TAG/$f" || { rm -f "$tmp"; return 1; }
  echo "$sha  $tmp" | shasum -a 256 -c - >/dev/null 2>&1 || { rm -f "$tmp"; log "checksum mismatch: $f"; return 1; }
  mkdir -p "$DEST" && tar -xzf "$tmp" -C "$DEST" && rm -f "$tmp"
}
BUILD=0; REST=(); for a in "$@"; do if [ "$a" = "--build" ]; then BUILD=1; else REST+=("$a"); fi; done
set -- ${REST[@]+"${REST[@]}"}
if [ "$BUILD" = 0 ]; then
  WANT=("$@"); [ ${#WANT[@]} -gt 0 ] || WANT=(iossim-arm64 xrsim-arm64 ios-arm64 xros-arm64)
  missing=()
  for slice in "${WANT[@]}"; do
    if [ -f "$DEST/lib/$slice/libv8_monolith.a" ] && [ "$(cat "$DEST/lib/$slice/TAG" 2>/dev/null)" = "$V8_TAG" ]; then continue; fi
    log "$slice: prebuilt"; if fetch_prebuilt "v8-apple-$V8_TAG-$slice.tar.gz"; then ok "$slice: prebuilt"; else missing+=("$slice"); fi
  done
  if [ ${#missing[@]} -eq 0 ] && { [ ! -f "$DEST/include/v8.h" ] || [ "$(head -1 "$DEST/VERSION" 2>/dev/null)" != "v8-apple $V8_TAG" ]; }; then
    fetch_prebuilt "v8-apple-$V8_TAG-include.tar.gz" || missing=(include)
  fi
  if [ ${#missing[@]} -eq 0 ]; then ok "v8-apple $V8_TAG (prebuilt) → $DEST"; exit 0; fi
  log "no prebuilt for ${missing[*]}: building from source"
fi

xcrun --sdk xros --show-sdk-path >/dev/null 2>&1 || fail "Xcode with the visionOS SDK is needed"
ok "$(xcodebuild -version | head -1), iOS SDK $(xcrun --sdk iphoneos --show-sdk-version), xrOS SDK $(xcrun --sdk xros --show-sdk-version)"

# 1. depot_tools (not on PATH globally: only this script's)
if [ ! -d "$TP/depot_tools/.git" ]; then
  log "clone depot_tools"; git clone -q https://chromium.googlesource.com/chromium/tools/depot_tools.git "$TP/depot_tools"
fi
if [ -n "$DEPOT_TOOLS_REV" ]; then git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV" 2>/dev/null || { git -C "$TP/depot_tools" fetch -q origin; git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV"; }; fi
export PATH="$TP/depot_tools:$PATH"
[ -f "$TP/depot_tools/python3_bin_reldir.txt" ] || { log "bootstrap depot_tools (its own python + cipd)"; "$TP/depot_tools/ensure_bootstrap"; }
export DEPOT_TOOLS_UPDATE=0 VPYTHON_BYPASS="manually managed python not supported by chrome operations"
export PATH="$TP/depot_tools/$(cat "$TP/depot_tools/python3_bin_reldir.txt"):$PATH"   # its python 3.11, not Xcode's 3.9
ok "depot_tools $(git -C "$TP/depot_tools" rev-parse --short HEAD)"

# 2. the checkout: fetch v8 (no history), target_os ios, the tag
mkdir -p "$SRC"
if [ ! -d "$SRC/v8/.git" ]; then
  log "fetch v8 (no history) into $SRC"
  (cd "$SRC" && fetch --no-history v8)
fi
grep -q "target_os" "$SRC/.gclient" || printf "target_os = ['ios']\n" >> "$SRC/.gclient"
if [ ! -f "$SRC/.synced-$V8_TAG" ]; then
  log "checkout V8 $V8_TAG and sync its DEPS (ios)"
  if [ "$(git -C "$SRC/v8" describe --tags --exact-match 2>/dev/null)" != "$V8_TAG" ]; then
    git -C "$SRC/v8" fetch -q --depth 1 origin "refs/tags/$V8_TAG:refs/tags/$V8_TAG"
    git -C "$SRC/v8" checkout -q "refs/tags/$V8_TAG"
  fi
  (cd "$SRC" && gclient sync -D --no-history --nohooks)
  (cd "$SRC" && gclient runhooks)
  touch "$SRC/.synced-$V8_TAG"
fi
ok "V8 $(git -C "$SRC/v8" describe --tags --exact-match) ($(grep -E 'define V8_(MAJOR|MINOR|BUILD|PATCH)' "$SRC/v8/include/v8-version.h" | awk '{print $3}' | paste -sd. -))"

# 3. the xros patches (tools/patches/v8-apple/*.patch, paths relative to v8/): applied once, checked by reverse dry-run
for p in "$PATCHES"/*.patch; do
  [ -f "$p" ] || continue
  if patch -p1 -d "$SRC/v8" -R --dry-run -s -f < "$p" >/dev/null 2>&1; then ok "patched: $(basename "$p")"
  else patch -p1 -d "$SRC/v8" -N -s < "$p" || fail "patch failed: $p"; ok "patch applied: $(basename "$p")"; fi
done

# 4. the slices
# GN args shared by every slice. Verified against this tag's gni files (gni/v8.gni, BUILD.gn, build/config/ios/*):
#  - jitless: v8_jitless compiles the JIT tiers out (Sparkplug, Maglev and TurboFan must then be off explicitly:
#    TurboFan defaults to !v8_enable_lite_mode); the host passes --jitless at runtime as well. v8_enable_lite_mode stays false (iphoneos would default it on; lite mode
#    also changes heap/feedback defaults, and the mac measurements were taken without it).
#  - no WebAssembly (WAMR has it): required with v8_jitless unless DrumBrake is on.
#  - no Temporal: it is the one Rust dependency (temporal_capi + ICU4X crates, Rust std built per target), and is
#    unreachable at runtime without --harmony-temporal anyway. Without it no Rust target for xros is needed.
#  - pointer compression on; the SANDBOX is OFF: its default here would be on (shared cage + external code space),
#    but BUILD.gn asserts v8_enable_sandbox needs use_safe_libcxx, which is use_custom_libcxx && ..., and the host
#    links the system libc++ (use_custom_libcxx=false is what keeps V8's and the host's std:: ABI the same).
#  - i18n on: third_party/icu's icu_use_data_file (default true) puts the data in icudtl.dat, bundled by tools/ios.mjs.
#  - no external startup data: the snapshot is linked in.
#  - v8_use_metagen_instance_types=false: V8 15.6's metagen harvests instance types with libclang and, on this
#    toolchain, runs clang in cl driver mode (-isysroot dropped, "'limits' file not found"); Torque's emission is the
#    documented alternative and needs no libclang.
#  - symbol_level=0 (the archive is 10x smaller; the host's own code is what gets debugged).
COMMON_ARGS='target_os="ios" target_cpu="arm64" is_debug=false is_component_build=false is_official_build=false
  v8_monolithic=true v8_use_external_startup_data=false v8_enable_i18n_support=true v8_enable_inspector=true
  v8_enable_webassembly=false v8_jitless=true v8_enable_lite_mode=false v8_use_metagen_instance_types=false
  v8_enable_turbofan=false v8_enable_maglev=false v8_enable_sparkplug=false v8_enable_temporal_support=false
  v8_enable_pointer_compression=true v8_enable_sandbox=false
  use_custom_libcxx=false treat_warnings_as_errors=false symbol_level=0 dcheck_always_on=false
  use_remoteexec=false use_siso=false ios_enable_code_signing=false'
slice_args() {
  case "$1" in
    ios-arm64)    echo 'target_platform="iphoneos" target_environment="device"    ios_deployment_target="15.0"';;
    iossim-arm64) echo 'target_platform="iphoneos" target_environment="simulator" ios_deployment_target="15.0"';;
    xros-arm64)   echo 'target_platform="xros"     target_environment="device"    ios_deployment_target="2.0"';;
    xrsim-arm64)  echo 'target_platform="xros"     target_environment="simulator" ios_deployment_target="2.0"';;
    *) fail "unknown slice $1 (ios-arm64 iossim-arm64 xros-arm64 xrsim-arm64)";;
  esac
}
SLICES=("$@"); [ ${#SLICES[@]} -gt 0 ] || SLICES=(iossim-arm64 xrsim-arm64 ios-arm64 xros-arm64)
GN="$SRC/v8/buildtools/mac/gn"; [ -x "$GN" ] || fail "no gn at $GN (gclient runhooks)"
mkdir -p "$DEST/lib"
for slice in "${SLICES[@]}"; do
  LIB="$DEST/lib/$slice/libv8_monolith.a"
  if [ -f "$LIB" ] && [ "$(cat "$DEST/lib/$slice/TAG" 2>/dev/null)" = "$V8_TAG" ]; then ok "$slice built ($(du -h "$LIB" | cut -f1))"; continue; fi
  OUT="$SRC/v8/out/$slice"
  ARGS="$COMMON_ARGS $(slice_args "$slice")"
  log "$slice: gn gen"
  (cd "$SRC/v8" && "$GN" gen "$OUT" --args="$ARGS") || fail "$slice: gn gen failed"
  log "$slice: ninja -j $JOBS v8_monolith"
  ninja -C "$OUT" -j "$JOBS" v8_monolith || fail "$slice: build failed"
  mkdir -p "$DEST/lib/$slice"
  cp "$OUT/obj/libv8_monolith.a" "$LIB"
  cp "$OUT/args.gn" "$DEST/lib/$slice/args.gn"
  # The defines the embedder must compile with (V8's own config("v8_header_features")), without the warning switches.
  # Only the macros: gn prints its argument warnings on stdout too, and CMake feeds every line to the compiler.
  (cd "$SRC/v8" && "$GN" desc "$OUT" //:v8_header_features defines) | grep '^V8_' | grep -v "DEPRECATION_WARNINGS" > "$DEST/lib/$slice/defines.txt"
  [ -f "$OUT/icudtl.dat" ] && cp "$OUT/icudtl.dat" "$DEST/icudtl.dat"
  echo "$V8_TAG" > "$DEST/lib/$slice/TAG"
  ok "$slice: $(du -h "$LIB" | cut -f1), $(xcrun vtool -show-build "$LIB" 2>/dev/null | grep -m1 -E '^\s*platform' | xargs)"
  [ "${V8_APPLE_KEEP_OUT:-0}" = 1 ] || rm -rf "$OUT"
done

# 5. headers and the pin
rm -rf "$DEST/include"; cp -R "$SRC/v8/include" "$DEST/include"
{
  echo "v8-apple $V8_TAG"
  echo "v8 tag $V8_TAG ($(git -C "$SRC/v8" rev-parse HEAD))"
  echo "depot_tools $(git -C "$TP/depot_tools" rev-parse HEAD)"
  echo "$(xcodebuild -version | tr '\n' ' ')($(xcodebuild -version | tail -1 | awk '{print $3}')), iOS SDK $(xcrun --sdk iphoneos --show-sdk-version), xrOS SDK $(xcrun --sdk xros --show-sdk-version)"
  echo "slices: $(ls "$DEST/lib" | tr '\n' ' ')"
  echo "icu data: $([ -f "$DEST/icudtl.dat" ] && echo "icudtl.dat ($(du -h "$DEST/icudtl.dat" | cut -f1))" || echo "built in")"
  echo "patches: $(ls "$PATCHES" | tr '\n' ' ')"
} > "$DEST/VERSION"
ok "$(head -1 "$DEST/VERSION") → $DEST"
