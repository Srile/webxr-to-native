#!/usr/bin/env bash
# Experimental desktop host (host/mac/): its third-party pieces. Idempotent.
#  - V8 and GLFW from Homebrew (checked, not installed: `brew install v8 glfw`)
#  - ANGLE (libEGL + libGLESv2, GLES 3.0 on Metal) out of a pinned Electron release,
#    into third_party/angle-mac with @rpath install names, ad-hoc re-signed after the rename.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"; mkdir -p "$TP"
log(){ printf '\033[1;34m[setup-mac]\033[0m %s\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

for f in v8 glfw; do
  brew list --versions "$f" >/dev/null 2>&1 || fail "$f missing: brew install v8 glfw"
  ok "$f $(brew list --versions "$f" | cut -d' ' -f2)"
done

ELECTRON=37.2.0
ZIP="$TP/electron-v$ELECTRON-darwin-arm64.zip"
SHA=4e43432b53a118635048408851130a7065b3cfb193382c0cd755c9f56b2dbf06
ANGLE="$TP/angle-mac"
if [ ! -f "$ANGLE/libGLESv2.dylib" ] || [ ! -f "$ANGLE/LICENSES.chromium.html" ] || [ "$(cat "$ANGLE/VERSION" 2>/dev/null)" != "electron $ELECTRON" ]; then
  [ -f "$ZIP" ] || { log "download electron $ELECTRON (ANGLE)"; curl -fL# --retry 3 -o "$ZIP.part" "https://github.com/electron/electron/releases/download/v$ELECTRON/electron-v$ELECTRON-darwin-arm64.zip" && mv "$ZIP.part" "$ZIP"; }
  echo "$SHA  $ZIP" | shasum -a 256 -c - >/dev/null || fail "checksum mismatch: $ZIP"
  rm -rf "$ANGLE" "$ANGLE.tmp"; mkdir -p "$ANGLE.tmp"
  unzip -q -j "$ZIP" 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib' \
                     'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib' -d "$ANGLE.tmp"
  # the licences of ANGLE and everything Chromium builds into it, which a .app carrying these libraries must ship
  unzip -q -j "$ZIP" LICENSES.chromium.html -d "$ANGLE.tmp"
  for l in libEGL libGLESv2; do
    install_name_tool -id "@rpath/$l.dylib" "$ANGLE.tmp/$l.dylib" 2>/dev/null
    codesign -f -s - "$ANGLE.tmp/$l.dylib" 2>/dev/null
  done
  echo "electron $ELECTRON" > "$ANGLE.tmp/VERSION"; mv "$ANGLE.tmp" "$ANGLE"
fi
ok "angle $(cat "$ANGLE/VERSION") ($ANGLE)"
