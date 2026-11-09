#!/usr/bin/env bash
# WebRTC data channels and WebSocket for games that ask for them (host.json network.webrtc, WP-21): libdatachannel
# with its ICE (libjuice), SCTP (usrsctp) and log (plog) sources at the commits its release pins, and Mbed TLS for
# DTLS and wss. Sources only, built by CMake into the host when a game enables them (tools/pack.mjs, tools/mac.mjs
# run this on demand). Versions and licences: THIRD_PARTY_NOTICES.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; TP="$ROOT/third_party"
log(){ printf '\033[1;34m[webrtc]\033[0m %s\n' "$*"; }
# sha256sum on Linux (coreutils), shasum on macOS (Perl's); either missing is a missing tool, not a mismatch.
sha256_ok() {
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null; then echo "$1  $2" | shasum -a 256 -c - >/dev/null
  else echo "no sha256sum or shasum to check $2" >&2; exit 1; fi
}
fetch() {  # fetch <url> <sha256> <dest dir> [strip]
  local url="$1" sha="$2" dest="$3" tmp; tmp="$(mktemp -d)"
  log "download $(basename "$url")"
  curl -fsSL --retry 3 -o "$tmp/a" "$url"
  sha256_ok "$sha" "$tmp/a" || { echo "checksum mismatch: $url" >&2; exit 1; }
  rm -rf "$dest"; mkdir -p "$dest"; tar -xf "$tmp/a" -C "$dest" --strip-components 1; rm -rf "$tmp"
}

LDC="$TP/libdatachannel"
if [ ! -f "$LDC/.stamp-v0.24.6" ]; then
  fetch https://github.com/paullouisageneau/libdatachannel/archive/refs/tags/v0.24.6.tar.gz \
    22a66aebebd8dae561d8e5181da96f2fcc203e067c5b2186c07b39af913464c0 "$LDC"
  fetch https://github.com/paullouisageneau/libjuice/archive/b89c792e3612faf2f12cf35bcc56857313a06be3.tar.gz \
    713b22174e8cb2e06538fa9bac2650bda21b83c86f5128813ab4dcf8f5bea9ed "$LDC/deps/libjuice"
  fetch https://github.com/sctplab/usrsctp/archive/fec583d54493f879d2ae44a743423bf8a04371ab.tar.gz \
    e5c114afe73c9a0ec419fab5f5b3f63f3ce57b09b90d06ea85e63dca8aed3e7c "$LDC/deps/usrsctp"
  fetch https://github.com/SergiusTheBest/plog/archive/94899e0b926ac1b0f4750bfbd495167b4a6ae9ef.tar.gz \
    92a08bce559b5f28aa88d3fd9071567414b9f43a83fe2a05a6dd14f1da536072 "$LDC/deps/plog"
  rm -rf "$LDC/examples" "$LDC/test" "$LDC/pages"  # not built; most of the archive's size
  # With Mbed TLS, upstream never verifies a TLS server (wss signalling could be intercepted): verify against the
  # system's CAs, which the host names in RTC_CA_PATH (host/rtc/rtc_bind.cpp).
  (cd "$LDC" && patch -s -p1 < "$ROOT/tools/patches/libdatachannel-0.24.6-mbedtls-verify.patch")
  touch "$LDC/.stamp-v0.24.6"
fi
if [ ! -f "$TP/mbedtls/.stamp-3.6.7" ]; then
  fetch https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2 \
    a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6 "$TP/mbedtls"
  rm -rf "$TP/mbedtls/tests" "$TP/mbedtls/programs"
  touch "$TP/mbedtls/.stamp-3.6.7"
fi
log "libdatachannel 0.24.6, Mbed TLS 3.6.7"
