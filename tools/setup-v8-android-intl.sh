#!/usr/bin/env bash
# V8 14.9.207.39 for Android arm64-v8a WITH i18n (ICU): the V8 a game gets with host.json js.intl (WP-24).
# The stock Android V8 (third_party/v8, tools/setup.sh) is NativeScript/v8-buildscripts' release v8-14.9.207.39-9,
# built with v8_enable_i18n_support=false, and NativeScript publishes no i18n build. This is that build again with
# i18n on and nothing else changed: the same V8 tag, the same three patches, the same gn args (so the headers and the
# embedder ABI are the stock lib's: the host compiles unchanged against either), against the same NDK r29 (fetched
# into third_party/android-ndk-r29; V8 14.9 needs its libc++ headers), with ICU's data compiled in
# (icu_use_data_file=false: nothing to stage next to the APK's assets). Like the stock archive it then links against
# the host's NDK r27c libc++_shared: every libc++ symbol it needs from that library is checked to be there.
# Output: third_party/v8-intl/{include, lib/libv8_monolith.a, args.gn, defines.txt, icu-defines.txt, libcxx-check.txt,
# VERSION, LICENSES/}.
#   tools/setup-v8-android-intl.sh            stage 0: the published prebuilt (V8_INTL_URL, pinned SHA-256)
#   tools/setup-v8-android-intl.sh --build    the source build: depot_tools → checkout (third_party/v8-src-android)
#                                             → patches → gn gen + ninja v8_monolith → third_party/v8-intl
#   tools/setup-v8-android-intl.sh --package <dir>   v8-intl-<tag>-android-arm64-v8a.tar.gz + SHA256SUMS in <dir>
#   V8_ANDROID_JOBS=6 (ninja -j), V8_ANDROID_KEEP_OUT=1 keeps the out/ dir after the archive is copied (~3 GB)
# NativeScript's scripts (BSD-2-Clause, Kudo Chien; LICENSES/v8-buildscripts.LICENSE) are read from their pinned
# commit: scripts/matrix/fetch.sh (the sync and the patches) and build-android.sh (GN_ARGS) are what this follows.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
DEST="$TP/v8-intl"
SRC="$TP/v8-src-android"                  # never third_party/v8-src (the Apple 15.6 checkout)
V8_TAG=14.9.207.39
NS_COMMIT=c43d232e600adcadc95404bf7efe41a65a92401c   # NativeScript/v8-buildscripts, the commit release v8-14.9.207.39-9 was built from
DEPOT_TOOLS_REV=${DEPOT_TOOLS_REV:-3a8af1e64be01a524f7d1c46daf8c2dcac63ff85}  # the pin tools/setup-v8-apple.sh uses
JOBS=${V8_ANDROID_JOBS:-6}
MIN_FREE_GB=12
# Stage 0: the published archive, a release asset of github.com/Srile/webxr-to-native (--package makes it).
# V8_INTL_URL in the environment points elsewhere (the SHA-256 still has to match).
V8_INTL_URL=${V8_INTL_URL:-https://github.com/Srile/webxr-to-native/releases/download/v8-android-intl-14.9.207.39/v8-intl-14.9.207.39-android-arm64-v8a.tar.gz}
V8_INTL_SHA256=ed15504e132941facceafa204be47ca85201d8efc2da4665ccc44cf9368681a4
log(){ printf '\033[1;34m[setup-v8-android-intl]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
sha256(){ shasum -a 256 "$1" | awk '{print $1}'; }
free_gb(){ df -Pk "$TP" | awk 'NR==2 { printf "%d", $4 / 1048576 }'; }
need_disk(){ local f; f=$(free_gb); [ "$f" -ge "$MIN_FREE_GB" ] || fail "$1: only $f GB free on $(df -P "$TP" | awk 'NR==2{print $6}') (needs $MIN_FREE_GB)"; ok "$1: $f GB free"; }

MODE=prebuilt
case "${1:-}" in
  --build) MODE=build;;
  --package) MODE=package; PKG_DIR="${2:?--package <dir>}";;
  "") ;;
  *) fail "usage: $0 [--build | --package <dir>]";;
esac

TARBALL="v8-intl-$V8_TAG-android-arm64-v8a.tar.gz"
if [ "$MODE" = package ]; then
  [ -f "$DEST/lib/libv8_monolith.a" ] || fail "no $DEST to package (run --build)"
  mkdir -p "$PKG_DIR"; PKG_DIR="$(cd "$PKG_DIR" && pwd)"
  COPYFILE_DISABLE=1 tar -czf "$PKG_DIR/$TARBALL" -C "$TP" v8-intl   # COPYFILE_DISABLE: no AppleDouble ._ files
  (cd "$PKG_DIR" && shasum -a 256 "$TARBALL" > SHA256SUMS)
  ok "$PKG_DIR/$TARBALL ($(du -h "$PKG_DIR/$TARBALL" | cut -f1)), sha256 $(sha256 "$PKG_DIR/$TARBALL")"
  exit 0
fi

if [ "$MODE" = prebuilt ]; then
  if [ -f "$DEST/lib/libv8_monolith.a" ] && grep -q "^v8-intl $V8_TAG" "$DEST/VERSION" 2>/dev/null; then ok "$(head -1 "$DEST/VERSION") in $DEST"; exit 0; fi
  [ -n "$V8_INTL_URL" ] || fail "no published v8-intl archive is pinned yet: build it with $0 --build (1 to 3 h on 8 cores, ~10 GB of disk)"
  log "download $V8_INTL_URL"
  rm -rf "$TP/v8-intl.tmp"; mkdir -p "$TP/v8-intl.tmp"
  curl -fL --retry 3 -o "$TP/v8-intl.tmp/$TARBALL" "$V8_INTL_URL"
  [ "$(sha256 "$TP/v8-intl.tmp/$TARBALL")" = "$V8_INTL_SHA256" ] || fail "checksum mismatch: $TARBALL"
  tar -xzf "$TP/v8-intl.tmp/$TARBALL" -C "$TP/v8-intl.tmp"
  rm -rf "$DEST"; mv "$TP/v8-intl.tmp/v8-intl" "$DEST"; rm -rf "$TP/v8-intl.tmp"
  ok "$(head -1 "$DEST/VERSION") → $DEST"
  exit 0
fi

# --build
source "$ROOT/tools/env.sh"   # ANDROID_NDK_HOME: r27c, the host's NDK (its libc++_shared.so is the one the APK ships)
[ -f "$ANDROID_NDK_HOME/source.properties" ] || fail "no NDK at $ANDROID_NDK_HOME (tools/setup.sh)"
# 0. The NDK V8 is compiled against: r29, as NativeScript builds it (their config.env ANDROID_NDK_RELEASE=r29). V8 14.9
#    uses C++20's std::atomic_ref (src/base/memcopy.h), which r27c's libc++ (LLVM 18) lacks; it is header-only, and
#    what the archive does take from the shared libc++ is checked against r27c's in step 6.
NDK_BUILD_REL=r29; NDK_BUILD_REV=29.0.14206865
NDK_BUILD_ZIP=android-ndk-r29-darwin.zip   # Google's repository2-3.xml: ndk;29.0.14206865, macosx, sha1 03d29fbb57e3c05a7d53597dd011d856c1456a4f
NDK_BUILD_SHA256=ce5e4b100ec5fe5be4eb3edcb2c02528824ff9cda3860f5304619be6c3da34d3
NDK_BUILD="$TP/android-ndk-$NDK_BUILD_REL"
if [ ! -f "$NDK_BUILD/source.properties" ]; then
  need_disk "before the NDK download"
  log "NDK $NDK_BUILD_REL (1.0 GB download) → $NDK_BUILD"
  curl -fL --retry 3 -o "$TP/$NDK_BUILD_ZIP.part" "https://dl.google.com/android/repository/$NDK_BUILD_ZIP"
  [ "$(sha256 "$TP/$NDK_BUILD_ZIP.part")" = "$NDK_BUILD_SHA256" ] || { rm -f "$TP/$NDK_BUILD_ZIP.part"; fail "checksum mismatch: $NDK_BUILD_ZIP"; }
  rm -rf "$NDK_BUILD.tmp"; mkdir -p "$NDK_BUILD.tmp"
  unzip -q "$TP/$NDK_BUILD_ZIP.part" -d "$NDK_BUILD.tmp"; rm -f "$TP/$NDK_BUILD_ZIP.part"
  mv "$NDK_BUILD.tmp/android-ndk-$NDK_BUILD_REL" "$NDK_BUILD"; rm -rf "$NDK_BUILD.tmp"
fi
[ "$(awk -F' = ' '/Pkg.Revision/{print $2}' "$NDK_BUILD/source.properties")" = "$NDK_BUILD_REV" ] || fail "$NDK_BUILD is not NDK $NDK_BUILD_REV"
NDK_HOST_REL=$(awk -F' = ' '/Pkg.ReleaseName/{print $2}' "$ANDROID_NDK_HOME/source.properties")
ok "NDK $NDK_BUILD_REL for V8 ($NDK_BUILD); NDK $NDK_HOST_REL's libc++_shared for the check"

# 1. depot_tools (the shared checkout; only this script's PATH)
if [ ! -d "$TP/depot_tools/.git" ]; then
  log "clone depot_tools"; git clone -q https://chromium.googlesource.com/chromium/tools/depot_tools.git "$TP/depot_tools"
fi
if [ "$(git -C "$TP/depot_tools" rev-parse HEAD)" != "$DEPOT_TOOLS_REV" ]; then
  git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV" 2>/dev/null || { git -C "$TP/depot_tools" fetch -q origin; git -C "$TP/depot_tools" checkout -q "$DEPOT_TOOLS_REV"; }
fi
export PATH="$TP/depot_tools:$PATH"
[ -f "$TP/depot_tools/python3_bin_reldir.txt" ] || { log "bootstrap depot_tools"; "$TP/depot_tools/ensure_bootstrap"; }
export DEPOT_TOOLS_UPDATE=0 VPYTHON_BYPASS="manually managed python not supported by chrome operations"
export PATH="$TP/depot_tools/$(cat "$TP/depot_tools/python3_bin_reldir.txt"):$PATH"
ok "depot_tools $(git -C "$TP/depot_tools" rev-parse --short HEAD)"

# 2. NativeScript's patches at the pinned commit, checked by SHA-256
NS="$SRC/ns-v8-buildscripts"; mkdir -p "$NS/patches"
ns_get() {  # <path in the repo> <sha256>
  local f="$NS/$1"
  if [ ! -f "$f" ] || [ "$(sha256 "$f")" != "$2" ]; then
    curl -fsSL --retry 3 -o "$f.part" "https://raw.githubusercontent.com/NativeScript/v8-buildscripts/$NS_COMMIT/$1"
    [ "$(sha256 "$f.part")" = "$2" ] || fail "checksum mismatch: v8-buildscripts/$1"
    mv "$f.part" "$f"
  fi
}
ns_get LICENSE bafa9370eea675815d9afe29fc052c58b32bbe43f48dbe66824777734e511a0e
ns_get patches/v8_resurrecting_finalizers.patch 7341d2b0fa0fdacab815f13cb157c89bc5707d05f3ad36c6821734552c93f12c
ns_get patches/v8_js_dispatch_table_reservation.patch 4fbe45961f43b2199acae3c6a80c0ea000be7d5820e9e22c9febbf54e77e8ad1
ns_get patches/android_build.patch fa5ac6e7b615aabd214462fc4fc4246164989669371275a4cd5c1bbf05de0bbb
ok "v8-buildscripts ${NS_COMMIT:0:7}: LICENSE + 3 patches"

# 3. the checkout: v8 at the tag (no history), its DEPS for target_os android. As fetch.sh, less two CIPD packages
#    the build never reads: Chromium's own NDK (android_ndk_root points at ours) and the Android SDK (Java tooling;
#    v8_monolith is native only). Together ~3 GB; DEPS is restored after the sync.
if [ ! -f "$SRC/.synced-$V8_TAG" ]; then
  need_disk "before the fetch"
  cd "$SRC"
  [ -f .gclient ] || gclient config --name v8 --unmanaged https://chromium.googlesource.com/v8/v8.git
  grep -q "target_os" .gclient || echo "target_os = ['android']" >> .gclient
  if [ "$(git -C v8 describe --tags --exact-match 2>/dev/null)" != "$V8_TAG" ]; then
    log "v8 $V8_TAG (depth 1)"
    [ -d v8/.git ] || { git init -q v8; git -C v8 remote add origin https://chromium.googlesource.com/v8/v8.git; }
    git -C v8 fetch -q --depth 1 origin "refs/tags/$V8_TAG:refs/tags/$V8_TAG"
    git -C v8 checkout -q "refs/tags/$V8_TAG"
  fi
  python3 - "$SRC/v8/DEPS" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
for name in ('third_party/android_toolchain/ndk', 'third_party/android_sdk/public'):
    head = "  '%s': {" % name
    if head not in s: continue
    i = s.index(head); j = s.index("\n  },\n", i) + len("\n  },\n")
    s = s[:i] + s[j:]
open(p, 'w').write(s)
PY
  log "gclient sync (no history; ~6 GB)"
  gclient sync --nohooks --no-history -D || { git -C v8 checkout -q -- DEPS; fail "gclient sync failed"; }
  gclient runhooks || { git -C v8 checkout -q -- DEPS; fail "gclient runhooks failed"; }
  git -C v8 checkout -q -- DEPS
  touch "$SRC/.synced-$V8_TAG"
fi
ok "V8 $(git -C "$SRC/v8" describe --tags --exact-match) in $SRC ($(du -sh "$SRC" 2>/dev/null | cut -f1))"

# 4. the patches, as fetch.sh applies them (once: a reverse check says whether it is in)
apply_once() {  # <repo dir> <patch>
  if git -C "$1" apply --reverse --check "$2" 2>/dev/null; then ok "patched: $(basename "$2")"
  else git -C "$1" apply "$2" || fail "patch failed: $2"; ok "patch applied: $(basename "$2")"; fi
}
apply_once "$SRC/v8" "$NS/patches/v8_resurrecting_finalizers.patch"
apply_once "$SRC/v8" "$NS/patches/v8_js_dispatch_table_reservation.patch"
apply_once "$SRC/v8/build" "$NS/patches/android_build.patch"

# 5. the build: build-android.sh's GN_ARGS (pinned commit; their reasons there), with v8_enable_i18n_support=true
#    the one change. use_remoteexec/use_siso only pick the build driver. Temporal stays off (Rust).
#    v8_use_host_cpu_arm_features=false: V8's default (true) adds the BUILD machine's __ARM_FEATURE_* to what mksnapshot
#    assumes the target has. NativeScript builds on Linux x64, where there are none; on an Apple-silicon Mac there are
#    JSCVT, LSE, SHA3, DOTPROD..., so the embedded builtins used FJCVTZS (ARMv8.3), which the Quest 3's cores lack:
#    SIGILL (ILL_ILLOPC, *pc=0x1e7e0003) in the first run on a Quest 3, while the emulator, on the Mac's CPU, passed.
#    With it off the snapshot assumes only what every arm64 Android device has; the JIT still probes the real CPU.
GN_ARGS='target_os="android" target_cpu="arm64" v8_target_cpu="arm64"
  is_component_build=false is_debug=false is_official_build=true chrome_pgo_phase=0 treat_warnings_as_errors=false
  symbol_level=0 use_thin_lto=false default_min_sdk_version=21
  use_custom_libcxx=false icu_use_data_file=false
  use_allocator_shim=false use_partition_alloc_as_malloc=false
  v8_array_buffer_internal_field_count=2 v8_array_buffer_view_internal_field_count=2
  v8_monolithic=true v8_static_library=true v8_use_external_startup_data=false
  v8_enable_i18n_support=true v8_enable_webassembly=true v8_enable_sandbox=false v8_enable_temporal_support=false
  v8_enable_v8_checks=false v8_enable_debugging_features=false v8_control_flow_integrity=false
  v8_use_host_cpu_arm_features=false
  use_remoteexec=false use_siso=false'
OUT="$SRC/v8/out.gn/android-arm64-release-intl"
GN="$SRC/v8/buildtools/mac/gn"; [ -x "$GN" ] || fail "no gn at $GN (gclient runhooks)"
# Chromium's clang for a Mac host ships no Android compiler-rt (lib/clang/<v>/lib/linux), and every target links
# //build/config/clang:compiler_builtins: the monolith's archive step lists libclang_rt.builtins-aarch64-android.a
# as an input (only that: ar never puts it in the archive; the host's own link takes the NDK's). Our NDK's copy
# stands in (the build NDK's), as NativeScript's notes on android_build.patch say a macOS host needs.
CLANG_LIB=$(ls -d "$SRC/v8/third_party/llvm-build/Release+Asserts/lib/clang/"*/lib | head -1)
BUILTINS=$(ls "$NDK_BUILD"/toolchains/llvm/prebuilt/darwin-x86_64/lib/clang/*/lib/linux/libclang_rt.builtins-aarch64-android.a | head -1)
[ -n "$CLANG_LIB" ] && [ -f "$BUILTINS" ] || fail "no clang lib dir in the checkout or no Android builtins in the NDK"
mkdir -p "$CLANG_LIB/linux"; ln -sf "$BUILTINS" "$CLANG_LIB/linux/libclang_rt.builtins-aarch64-android.a"
need_disk "before the build"
log "gn gen $OUT"
(cd "$SRC/v8" && "$GN" gen "$OUT" --args="$GN_ARGS android_ndk_root=\"$NDK_BUILD\"") || fail "gn gen failed"
log "ninja -j $JOBS v8_monolith ($(date '+%H:%M'))"
ninja -C "$OUT" -j "$JOBS" v8_monolith || fail "build failed"
ok "built ($(date '+%H:%M')): $(du -h "$OUT/obj/libv8_monolith.a" | cut -f1)"

# 6. The archive was compiled against r29's libc++ headers and links against the host's r27c libc++_shared.so (as the
#    stock archive does): every libc++ symbol (std::__ndk1) it leaves undefined must be exported there. The stock
#    archive's set is listed beside it for comparison; any symbol r27c lacks stops the build.
NM="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-nm"
LIBCXX="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
cxx_needed() {  # <archive>: libc++ names undefined in it and defined by none of its members
  "$NM" -u "$1" 2>/dev/null | awk 'NF { print $NF }' | grep '__ndk1' | sort -u > "$OUT/u.txt"
  "$NM" --defined-only "$1" 2>/dev/null | awk 'NF >= 3 { print $3 }' | sort -u > "$OUT/d.txt"
  comm -23 "$OUT/u.txt" "$OUT/d.txt"; rm -f "$OUT/u.txt" "$OUT/d.txt"
}
"$NM" -D --defined-only "$LIBCXX" | awk 'NF >= 3 { print $3 }' | sort -u > "$OUT/libcxx-r27.txt"
cxx_needed "$OUT/obj/libv8_monolith.a" > "$OUT/libcxx-intl.txt"
[ -f "$TP/v8/lib/arm64-v8a/libv8_monolith.a" ] && cxx_needed "$TP/v8/lib/arm64-v8a/libv8_monolith.a" > "$OUT/libcxx-stock.txt" || : > "$OUT/libcxx-stock.txt"
MISSING=$(comm -23 "$OUT/libcxx-intl.txt" "$OUT/libcxx-r27.txt")
{
  echo "libc++ symbols libv8_monolith.a needs from libc++_shared.so: $(wc -l < "$OUT/libcxx-intl.txt" | tr -d ' ') (the stock archive: $(wc -l < "$OUT/libcxx-stock.txt" | tr -d ' '))"
  echo "not in NDK $NDK_HOST_REL's libc++_shared.so: $(printf '%s' "$MISSING" | grep -c . || true)"
  echo "not needed by the stock archive:"; comm -23 "$OUT/libcxx-intl.txt" "$OUT/libcxx-stock.txt" | sed 's/^/  /'
} > "$OUT/libcxx-check.txt"
cat "$OUT/libcxx-check.txt"
[ -z "$MISSING" ] || { printf '%s\n' "$MISSING" | sed 's/^/  missing: /'; fail "the archive needs libc++ symbols NDK $NDK_HOST_REL's libc++_shared.so lacks"; }
ok "every libc++ symbol the archive needs is in NDK $NDK_HOST_REL's libc++_shared.so"

# 6b. The builtins (obj/v8_snapshot/embedded.o, code mksnapshot wrote) must not use an instruction an arm64 Android
#     device may lack. FJCVTZS (ARMv8.3 JSCVT) is the one a Mac-built snapshot picked up when the build machine's CPU
#     features leaked in (v8_use_host_cpu_arm_features, above): SIGILL on a Quest 3. The stock archive has none.
JSCVT=$(python3 -I -c '
import struct, sys
d = open(sys.argv[1], "rb").read()
print(sum(1 for i in range(0, len(d) - 3, 4) if struct.unpack_from("<I", d, i)[0] & 0xfffffc00 == 0x1e7e0000))
' "$OUT/obj/v8_snapshot/embedded.o") || fail "could not scan the builtins"
[ "$JSCVT" = 0 ] || fail "the builtins use FJCVTZS $JSCVT times (ARMv8.3: a Quest 3 dies with SIGILL); is v8_use_host_cpu_arm_features=false set?"
ok "the builtins use no FJCVTZS (ARMv8.3), as the stock archive"

# 7. third_party/v8-intl: the archive, the headers (+ the generated inspector protocol headers and ICU's public
#    headers, which host/js/intl.cpp uses to set the default locale and zone), the args, the embedder defines.
rm -rf "$DEST.tmp"; mkdir -p "$DEST.tmp/lib" "$DEST.tmp/LICENSES"
cp "$OUT/obj/libv8_monolith.a" "$DEST.tmp/lib/"
cp -R "$SRC/v8/include" "$DEST.tmp/include"
mkdir -p "$DEST.tmp/include/inspector"; cp "$OUT/gen/include/inspector/"*.h "$DEST.tmp/include/inspector/"
mkdir -p "$DEST.tmp/include/unicode"; cp "$SRC/v8/third_party/icu/source/common/unicode/"*.h "$SRC/v8/third_party/icu/source/i18n/unicode/"*.h "$DEST.tmp/include/unicode/"
cp "$OUT/args.gn" "$DEST.tmp/args.gn"; cp "$OUT/libcxx-check.txt" "$DEST.tmp/libcxx-check.txt"
# The macros the embedder must compile with (config("v8_header_features")) and ICU's (config("icu_config")).
(cd "$SRC/v8" && "$GN" desc "$OUT" //:v8_header_features defines) | grep '^V8_' | grep -v DEPRECATION_WARNINGS > "$DEST.tmp/defines.txt"
# ICU's public macros as a consumer of it sees them (v8_base depends on ICU: icu_config, not ICU's private ones).
(cd "$SRC/v8" && "$GN" desc "$OUT" //:v8_base_without_compiler defines) | grep -E '^(U_|UCONFIG_|USE_CHROMIUM_ICU|ICU_UTIL_DATA_IMPL)' > "$DEST.tmp/icu-defines.txt"
# Licences of what the archive carries (V8 and the third_party code linked into the monolith) and of the scripts.
cp "$NS/LICENSE" "$DEST.tmp/LICENSES/v8-buildscripts.LICENSE"
for f in "$SRC/v8"/LICENSE*; do cp "$f" "$DEST.tmp/LICENSES/v8.$(basename "$f")"; done
for d in icu abseil-cpp zlib simdutf highway fp16 dragonbox fast_float; do
  for f in "$SRC/v8/third_party/$d"/LICENSE* "$SRC/v8/third_party/$d/src"/LICENSE*; do
    [ -f "$f" ] && cp "$f" "$DEST.tmp/LICENSES/$d.$(basename "$f")"
  done
done
ICU_VER=$(awk '/#define U_ICU_VERSION /{gsub(/"/,"",$3); print $3}' "$SRC/v8/third_party/icu/source/common/unicode/uvernum.h")
{
  echo "v8-intl $V8_TAG android-arm64-v8a"
  echo "v8 tag $V8_TAG ($(git -C "$SRC/v8" rev-parse HEAD)), i18n on, ICU $ICU_VER (data compiled in)"
  echo "patches: NativeScript/v8-buildscripts $NS_COMMIT (v8_resurrecting_finalizers, v8_js_dispatch_table_reservation, android_build)"
  echo "NDK $NDK_BUILD_REL ($NDK_BUILD_REV) for the build, libc++ checked against NDK $NDK_HOST_REL's libc++_shared.so; depot_tools $(git -C "$TP/depot_tools" rev-parse HEAD)"
  echo "built $(date -u '+%Y-%m-%d') on $(uname -sm)"
} > "$DEST.tmp/VERSION"
rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
ok "$(head -1 "$DEST/VERSION") → $DEST ($(du -sh "$DEST" | cut -f1))"
[ "${V8_ANDROID_KEEP_OUT:-0}" = 1 ] || { rm -rf "$OUT"; ok "removed $OUT (V8_ANDROID_KEEP_OUT=1 keeps it)"; }
