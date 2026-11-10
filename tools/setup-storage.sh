#!/usr/bin/env bash
# IndexedDB and the Cache API for games that ask for them (host.json storage.indexedDB / storage.cache, WP-26): the
# SQLite amalgamation (public domain), sources only, compiled into the host by host/storage.cmake when a game enables
# either. tools/game.mjs runs this on demand (pack.mjs, mac.mjs, linux.mjs). Pinned here; sqlite.org
# publishes the archive's SHA3-256 (92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30), checked once
# when pinning; the sha256 below is of the same file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; TP="$ROOT/third_party"
log(){ printf '\033[1;34m[storage]\033[0m %s\n' "$*"; }
sha256_ok() {
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null; then echo "$1  $2" | shasum -a 256 -c - >/dev/null
  else echo "no sha256sum or shasum to check $2" >&2; exit 1; fi
}
DEST="$TP/sqlite"
if [ ! -f "$DEST/.stamp-3540100" ]; then
  URL=https://sqlite.org/2026/sqlite-amalgamation-3540100.zip
  SHA=0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  log "download $(basename "$URL")"
  curl -fsSL --retry 3 -o "$tmp/a.zip" "$URL"
  sha256_ok "$SHA" "$tmp/a.zip" || { echo "checksum mismatch: $URL" >&2; exit 1; }
  mkdir -p "$tmp/x"
  if command -v unzip >/dev/null; then unzip -q "$tmp/a.zip" -d "$tmp/x"
  else python3 -I -m zipfile -e "$tmp/a.zip" "$tmp/x"; fi
  rm -rf "$DEST"; mkdir -p "$DEST"
  # The library only: shell.c (the sqlite3 command line tool) is not built.
  for f in sqlite3.c sqlite3.h sqlite3ext.h; do cp "$tmp/x/sqlite-amalgamation-3540100/$f" "$DEST/"; done
  touch "$DEST/.stamp-3540100"
fi
log "SQLite 3.54.1 (amalgamation)"
