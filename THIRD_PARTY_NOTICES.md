# Third-party software

webxr-to-native is MIT-licensed (see [LICENSE](LICENSE)). It depends on a fair amount of other people's work. Most
of it is downloaded by the setup scripts, or by npm, and is not stored in this repository. This file says what
each piece is, under which licence, and what ends up inside an app you build. The full licence texts are in
[`licenses/`](licenses), copied verbatim from the pinned sources.

## What a built app carries

Every build gets a `THIRD_PARTY_NOTICES.txt` from `tools/pack.mjs`. It lists the third-party software in that
host's binary, libraries and runtime script, followed by each licence in full (`tools/notices.mjs` puts it
together from `licenses/`).

| Build | Where the notices end up |
|---|---|
| Quest / Android APK | `assets/THIRD_PARTY_NOTICES.txt` |
| macOS `.app` | `Contents/Resources/assets/THIRD_PARTY_NOTICES.txt`, plus `Contents/Resources/LICENSES.chromium.html` for ANGLE |
| Windows zip, Linux tarball | `assets/THIRD_PARTY_NOTICES.txt`, plus `LICENSES.chromium.html` beside the executable (ANGLE, SwiftShader, Vulkan loader) |
| iOS / visionOS app | `assets/THIRD_PARTY_NOTICES.txt` in the app bundle |

If you ship an app built with this toolkit, keep those files in it. Several of the licences (BSD, MIT, Apache-2.0,
Zlib) require their notices to travel with binary distributions. Showing them in an About screen as well is up
to you.

Builds with `network.webrtc` contain libdatachannel and libjuice, which are MPL-2.0. MPL-2.0 asks you to tell the
people you distribute to where the source code of those files is. The notices file does that: it names the
upstream release and the one patch this toolkit applies (`tools/patches/libdatachannel-0.24.6-mbedtls-verify.patch`).

The prebuilt libraries attached to this repository's releases (`v8-apple-*`, `angle-apple-*`, and `v8-android-intl-*`, the
Android V8 with ICU that `js.intl` links) are binary distributions of V8, ICU and ANGLE too. Each archive carries
the matching texts from `licenses/` in a `LICENSES/` folder.

## Inside built apps

| Component | Version | Licence (SPDX) | Comes from | In |
|---|---|---|---|---|
| [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (the WebXR implementation, host mode) | 2.8.0 | MIT | npm `iwer`, bundled into `host-runtime.js` | all |
| [gl-matrix](https://github.com/toji/gl-matrix) | 3.4.4 | MIT | npm, via IWER | all |
| [V8](https://v8.dev) | Android 14.9.207.39 (NativeScript's build); macOS/Linux Homebrew 15.6; Windows NuGet 13.0.245.25; iOS/visionOS 15.6.75.19 from source, or npm `v8-ios` 11.110.1 | BSD-3-Clause, with fdlibm and Strongtalk notices | `tools/setup*.sh` | all |
| Code built into V8: Abseil, Dragonbox, fast_float, FP16, Highway, inspector_protocol, LLVM libc, PartitionAlloc, rapidhash, simdutf, SipHash, UTF-8 decoder, zlib | as pinned by V8 | Apache-2.0, BSL-1.0, MIT, BSD-3-Clause, BSD-2-Clause, CC0-1.0, Zlib | inside V8 | all |
| [ICU](https://icu.unicode.org) | as built with V8 (Android: 77.1) | Unicode-3.0 | inside V8 / `icudtl.dat` | macOS, Windows, Linux, iOS, visionOS; Android games with `js.intl` |
| [stb](https://github.com/nothings/stb) (image, image_write, vorbis, truetype) | commit `f0569113` | MIT OR Unlicense | `tools/setup.sh` | all |
| [nanosvg](https://github.com/memononen/nanosvg) | commit `239e102e` | Zlib | `tools/setup.sh` | games with `web.svg` |
| [SQLite](https://sqlite.org) | 3.54.1 | blessing (public domain) | `tools/setup-storage.sh`, on first need | games with `storage.indexedDB` or `storage.cache` |
| [dr_mp3](https://github.com/mackron/dr_libs) | 0.7.4 | Unlicense OR MIT-0 | `tools/setup.sh` | all |
| [Opus](https://opus-codec.org) (decoder) | 1.5.2 | BSD-3-Clause | `tools/setup.sh` | all |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) (decoder) | 1.5.0 | BSD-3-Clause, with a patent grant | `tools/setup.sh` | all |
| [Khronos OpenXR loader](https://github.com/KhronosGroup/OpenXR-SDK) | 1.1.49 | Apache-2.0 | Maven Central AAR | Quest |
| [Oboe](https://github.com/google/oboe) | 1.9.3 | Apache-2.0 | `tools/setup.sh` | Android |
| Android NDK `native_app_glue` | NDK r27 | Apache-2.0 | the NDK | Android |
| LLVM libc++ (`libc++_shared.so`) | NDK r27 | Apache-2.0 WITH LLVM-exception | the NDK | Android |
| [ANGLE](https://chromium.googlesource.com/angle/angle) | Electron 37.2.0's build (macOS, Windows, Linux); 2.1.28853 (iOS: raylib-iOS 6.0.7's build; visionOS: built from source) | BSD-3-Clause. The Apple builds also contain Dawn and Tint (BSD-3-Clause), Abseil and astc-encoder (Apache-2.0), xxHash (BSD-2-Clause), zlib, PartitionAlloc and LLVM libc++, all in `licenses/angle.txt`; the Electron builds ship Chromium's credits (`LICENSES.chromium.html`) | `tools/setup-*.sh` | macOS, Windows, Linux (`--angle`), iOS, visionOS |
| `d3dcompiler_47.dll` | from Electron 37.2.0 | Microsoft, redistributable with the Windows SDK | `tools/setup-win.mjs` | Windows |
| [GLFW](https://www.glfw.org) | 3.4 | Zlib | Windows: official binary; macOS: Homebrew | macOS, Windows |
| [WAMR](https://github.com/bytecodealliance/wasm-micro-runtime) | 2.4.5 | Apache-2.0 WITH LLVM-exception | `tools/setup-ios.sh` | iOS, visionOS (macOS, Linux when present) |
| [SIMDe](https://github.com/simd-everywhere/simde) | 0.8.2 | MIT | `tools/setup-ios.sh` | with WAMR |
| [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | 0.24.6, patched | MPL-2.0 | `tools/setup-webrtc.sh` | games with `network.webrtc` |
| [libjuice](https://github.com/paullouisageneau/libjuice) | `b89c792e` | MPL-2.0 | with libdatachannel | `network.webrtc` |
| [usrsctp](https://github.com/sctplab/usrsctp) | `fec583d5` | BSD-3-Clause | with libdatachannel | `network.webrtc` |
| [plog](https://github.com/SergiusTheBest/plog) | `94899e0b` | MIT | with libdatachannel | `network.webrtc` |
| [Mbed TLS](https://github.com/Mbed-TLS/mbedtls) | 3.6.7 | Apache-2.0 (or GPL-2.0-or-later) | `tools/setup-webrtc.sh` | `network.webrtc` |
| [libsrtp](https://github.com/cisco/libsrtp) | 2.7.0 | BSD-3-Clause | `tools/setup-webrtc.sh` | `network.webrtc` with `media.microphone` |

The Linux host also loads the distribution's GLFW, libcurl, PulseAudio, EGL/GLES and X11 libraries, and macOS's
host loads the system libcurl. Those belong to the system and are not copied into the app.

The **Meta Platform SDK** (leaderboards, achievements, entitlement) is optional and not downloaded by any script.
If you put it in `third_party/ovr_platform_sdk/` yourself, the Quest build links its loader. That loader is
under the [Oculus SDK License Agreement](https://developer.oculus.com/licenses/oculussdk/), and the notices file
says so.

## Inside this repository

Everything here is MIT (LICENSE) except:

- `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar`: the Gradle 8.9 wrapper, Apache-2.0.
- `host/win/khr/KHR/khrplatform.h`: derived from the Khronos Group's `khrplatform.h`. Its MIT-style notice is in
  the file.
- `tools/patches/`: changes to the projects they patch, under those projects' licences.
  - `libdatachannel-0.24.6-mbedtls-verify.patch`: MPL-2.0.
  - `v8-apple/0001-xros-target-platform.patch` and `angle-apple/0002-xros-codesign-bundle-kind.patch`: they patch
    Chromium's build files, BSD-3-Clause.
- `licenses/`: the upstream licence texts, each under its own terms.
- `apps/bench` installs three.js (`super-three`, MIT) and `@iwsdk/core` (MIT) from npm when you build it. Nothing
  from them is stored here.

## Used to build, not shipped

Each of these comes under its own licence, which you accept by running its setup script.
- **Android build tools:**
  - `tools/setup.sh` downloads the Android SDK command-line tools, platform tools, build tools, platform 34 and NDK
    r27, and accepts the Android SDK licence on your behalf (`sdkmanager --licenses`). Read it at
    https://developer.android.com/studio/terms before you run the script.
  - It also downloads Eclipse Temurin JDK 17 (GPL-2.0 WITH Classpath-exception-2.0) and Gradle 8.9 (Apache-2.0).
- **JavaScript tooling:** esbuild (MIT; npm devDependency) bundles the runtime.
- **V8 and ANGLE source builds for iOS/visionOS:** depot_tools (BSD-3-Clause) and Chromium's build tree.
- **Desktop prebuilts:**
  - The Electron 37.2.0 release archives (MIT) are downloaded only to take ANGLE's libraries and its licence file
    out of them.
  - Homebrew's `v8` and `glfw` formulae provide V8 and GLFW on macOS and Linux.
- **Windows cross build (optional):** it uses xwin, which downloads Microsoft's CRT and Windows SDK under
  Microsoft's licence; you accept it when you run xwin.
- **Your own toolchain:** Xcode, CMake and Ninja, under their own licences.
