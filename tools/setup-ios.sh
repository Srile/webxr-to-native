#!/usr/bin/env bash
# Experimental iOS host (host/ios/): its third-party pieces. Idempotent.
#  - V8 11.0 for iOS (npm v8-ios, Kudo/v8-android-buildscripts): a dynamic v8.framework per slice (device arm64,
#    simulator arm64 + x86_64) in an xcframework, with libplatform, the inspector and ICU data linked in. It is
#    built without WebAssembly and runs --jitless (iOS gives apps no executable memory).
#  - WAMR (wasm-micro-runtime) 2.4.5 + SIMDe 0.8.2, sources: its fast interpreter (SIMD through SIMDe) gives the
#    host a WebAssembly where V8 has none (host/js/wasm_interp.cpp). The mac host builds it too, to test with
#    host.json wasm.interpreter.
#  - GLES: ANGLE on Metal (libEGL + libGLESv2 xcframeworks, device + simulator, out of a pinned raylib-iOS release
#    that packages upstream ANGLE) → third_party/angle-ios. Metal runs on the Mac's GPU in the simulator; Apple's
#    own OpenGL ES there is a software renderer. Without it the host falls back to Apple's GLES (host/ios/egl_eagl.mm).
#  Xcode itself is checked.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
log(){ printf '\033[1;34m[setup-ios]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1 || fail "Xcode with the iOS SDK is needed (xcode-select -s /Applications/Xcode.app)"
ok "$(xcodebuild -version | head -1), iOS SDK $(xcrun --sdk iphoneos --show-sdk-version)"

V8=11.110.1
TGZ="$TP/v8-ios-$V8.tgz"
SHA=5f91e4e1d659e98363db6b4af70e3f317d24d84055b5cbee579c280a4cbc43db
DIR="$TP/v8-ios"
if [ "$(cat "$DIR/VERSION" 2>/dev/null)" != "v8-ios $V8" ]; then
  [ -f "$TGZ" ] || { log "download v8-ios $V8"; curl -fL# --retry 3 -o "$TGZ.part" "https://registry.npmjs.org/v8-ios/-/v8-ios-$V8.tgz" && mv "$TGZ.part" "$TGZ"; }
  echo "$SHA  $TGZ" | shasum -a 256 -c - >/dev/null || fail "checksum mismatch: $TGZ"
  rm -rf "$DIR" "$DIR.tmp"; mkdir -p "$DIR.tmp"
  tar -xzf "$TGZ" -C "$DIR.tmp" --strip-components 1 package/include package/v8.xcframework
  echo "v8-ios $V8" > "$DIR.tmp/VERSION"; mv "$DIR.tmp" "$DIR"
fi
ok "$(cat "$DIR/VERSION") ($(grep -E 'define V8_(MAJOR|MINOR|BUILD|PATCH)' "$DIR/include/v8-version.h" | awk '{print $3}' | paste -sd. -))"

# WAMR + SIMDe (sources; host/wamr/CMakeLists.txt builds them)
fetch_src() {  # name version url sha dir
  local tgz="$TP/$1-$2.tar.gz" dir="$TP/$5"
  if [ "$(cat "$dir/VERSION" 2>/dev/null)" != "$1 $2" ]; then
    [ -f "$tgz" ] || { log "download $1 $2"; curl -fL# --retry 3 -o "$tgz.part" "$3" && mv "$tgz.part" "$tgz"; }
    echo "$4  $tgz" | shasum -a 256 -c - >/dev/null || fail "checksum mismatch: $tgz"
    rm -rf "$dir" "$dir.tmp"; mkdir -p "$dir.tmp"; tar -xzf "$tgz" -C "$dir.tmp" --strip-components 1
    echo "$1 $2" > "$dir.tmp/VERSION"; mv "$dir.tmp" "$dir"
  fi
  ok "$(cat "$dir/VERSION") ($dir)"
}
fetch_src wamr 2.4.5 https://github.com/bytecodealliance/wasm-micro-runtime/archive/refs/tags/WAMR-2.4.5.tar.gz 1ab09d51099f276ca4a1d6629f6b589aab2bd0caa01445e05031a4bed22c199b wamr
fetch_src simde 0.8.2 https://github.com/simd-everywhere/simde/archive/refs/tags/v0.8.2.tar.gz ed2a3268658f2f2a9b5367628a85ccd4cf9516460ed8604eed369653d49b25fb simde

# ANGLE for iOS (libEGL/libGLESv2 xcframeworks; ANGLE 2.1.28853 on Metal)
RAYLIB=6.0.7-iOS
ZIP="$TP/raylib-ios-xcframeworks-$RAYLIB.zip"
ASHA=1b1fce1bb42bf665240bd83084a556b1944308d748c5a2ba60e55119020392ed
ADIR="$TP/angle-ios"
if [ "$(cat "$ADIR/VERSION" 2>/dev/null)" != "raylib-ios $RAYLIB" ]; then
  [ -f "$ZIP" ] || { log "download ANGLE for iOS (raylib-iOS $RAYLIB)"; curl -fL# --retry 3 -o "$ZIP.part" "https://github.com/ghera/raylib-iOS/releases/download/$RAYLIB/raylib-ios-xcframeworks-$RAYLIB.zip" && mv "$ZIP.part" "$ZIP"; }
  echo "$ASHA  $ZIP" | shasum -a 256 -c - >/dev/null || fail "checksum mismatch: $ZIP"
  rm -rf "$ADIR" "$ADIR.tmp"; mkdir -p "$ADIR.tmp"
  unzip -q "$ZIP" 'raylib-ios-xcframeworks/libEGL.xcframework/*' 'raylib-ios-xcframeworks/libGLESv2.xcframework/*' -d "$ADIR.tmp"
  mv "$ADIR.tmp/raylib-ios-xcframeworks/"*.xcframework "$ADIR.tmp/" && rmdir "$ADIR.tmp/raylib-ios-xcframeworks"
  echo "raylib-ios $RAYLIB" > "$ADIR.tmp/VERSION"; mv "$ADIR.tmp" "$ADIR"
fi
ok "angle $(cat "$ADIR/VERSION") ($ADIR)"
