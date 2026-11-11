cmake_minimum_required(VERSION 3.22)
project(webxrhost CXX C)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(TP ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)
option(HOST_TESTS "Build host-side unit tests (no Android)" OFF)
option(HOST_WEBRTC "WebSocket + WebRTC data channels (host.json network.webrtc, WP-21)" OFF)
option(HOST_V8_INTL "Android: V8 with ICU (third_party/v8-intl) for Intl (host.json js.intl, WP-24)" OFF)
include(${CMAKE_CURRENT_SOURCE_DIR}/webrtc.cmake)
option(HOST_MICROPHONE "Microphone capture: getUserMedia, MediaStreamAudioSourceNode (host.json media.microphone, WP-25)" OFF)
include(${CMAKE_CURRENT_SOURCE_DIR}/microphone.cmake)
option(HOST_STORAGE "IndexedDB + Cache API over SQLite (host.json storage.indexedDB / storage.cache, WP-26)" OFF)
include(${CMAKE_CURRENT_SOURCE_DIR}/storage.cmake)

# Canvas 2D text (stb_truetype, img/text.cpp) and SVG images (nanosvg, img/decode.cpp): host.json web.canvasText and
# web.svg. An APK carries them only when its game asks (tools/pack.mjs passes the switches to Gradle); the desktop
# hosts are one binary for every game, so they build both in and the game's host.json decides at run time
# (host/img/image_bind.cpp registers the text binding and accepts SVG only when the switch is on).
if(ANDROID)
  set(HOST_WEB_FEATURE_DEFAULT OFF)
else()
  set(HOST_WEB_FEATURE_DEFAULT ON)
endif()
option(HOST_CANVAS_TEXT "Canvas 2D text through stb_truetype (host.json web.canvasText)" ${HOST_WEB_FEATURE_DEFAULT})
option(HOST_SVG "SVG images through nanosvg (host.json web.svg)" ${HOST_WEB_FEATURE_DEFAULT})
add_library(host_web_features INTERFACE)
if(HOST_CANVAS_TEXT)
  target_compile_definitions(host_web_features INTERFACE HOST_HAS_CANVAS_TEXT)
endif()
if(HOST_SVG)
  if(NOT EXISTS ${TP}/nanosvg/nanosvg.h)
    message(FATAL_ERROR "HOST_SVG: third_party/nanosvg is missing; run tools/setup.sh")
  endif()
  target_compile_definitions(host_web_features INTERFACE HOST_HAS_SVG)
  target_include_directories(host_web_features INTERFACE ${TP}/nanosvg)
endif()

# WebP decoding (the game's logos are .webp): libwebp from source, decoder target only.
if(EXISTS ${TP}/libwebp/CMakeLists.txt)
  foreach(opt WEBP_BUILD_ANIM_UTILS WEBP_BUILD_CWEBP WEBP_BUILD_DWEBP WEBP_BUILD_GIF2WEBP WEBP_BUILD_IMG2WEBP WEBP_BUILD_VWEBP WEBP_BUILD_WEBPINFO WEBP_BUILD_WEBPMUX WEBP_BUILD_EXTRAS WEBP_BUILD_LIBWEBPMUX WEBP_USE_THREAD)
    set(${opt} OFF CACHE BOOL "" FORCE)
  endforeach()
  set(WEBP_LINK_STATIC ON CACHE BOOL "" FORCE)
  set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
  add_subdirectory(${TP}/libwebp libwebp EXCLUDE_FROM_ALL)
  set(HOST_WEBP webpdecoder)
  add_library(host_webp INTERFACE)
  target_link_libraries(host_webp INTERFACE webpdecoder)
  target_include_directories(host_webp INTERFACE ${TP}/libwebp/src)
  target_compile_definitions(host_webp INTERFACE HOST_HAS_WEBP)
else()
  add_library(host_webp INTERFACE)
endif()

# Opus (decodeAudioData of Opus in WebM and Ogg, host/audio/decode.cpp): libopus from source, its decoder used.
if(EXISTS ${TP}/opus/CMakeLists.txt)
  foreach(opt OPUS_BUILD_SHARED_LIBRARY OPUS_BUILD_TESTING OPUS_BUILD_PROGRAMS OPUS_INSTALL_PKG_CONFIG_MODULE OPUS_INSTALL_CMAKE_CONFIG_MODULE OPUS_DRED OPUS_OSCE)
    set(${opt} OFF CACHE BOOL "" FORCE)
  endforeach()
  # Apple silicon always has NEON; opus presumes it for "aarch64" and iOS, not for macOS's "arm64" (its iOS setting:
  # presumed, no runtime detection, which it has only for Linux, Android and Windows).
  if(APPLE AND CMAKE_SYSTEM_PROCESSOR MATCHES "arm64")
    set(OPUS_PRESUME_NEON ON CACHE BOOL "" FORCE)
  endif()
  add_subdirectory(${TP}/opus opus EXCLUDE_FROM_ALL)
  add_library(host_opus INTERFACE)
  target_link_libraries(host_opus INTERFACE opus)
  target_compile_definitions(host_opus INTERFACE HOST_HAS_OPUS)
else()
  add_library(host_opus INTERFACE)
endif()

if(ANDROID)
  set(CMAKE_CXX_STANDARD 20)  # V8 13+ headers need C++20 (V8 14.9 since WP-20's 16 KB build), as on the desktop hosts
  add_library(native_app_glue STATIC ${ANDROID_NDK}/sources/android/native_app_glue/android_native_app_glue.c)
  target_include_directories(native_app_glue PUBLIC ${ANDROID_NDK}/sources/android/native_app_glue)

  add_library(openxr_loader SHARED IMPORTED)
  set_target_properties(openxr_loader PROPERTIES IMPORTED_LOCATION ${TP}/openxr/lib/${ANDROID_ABI}/libopenxr_loader.so
    INTERFACE_INCLUDE_DIRECTORIES ${TP}/openxr/include)

  # V8 14.9 as a static monolith (tools/setup.sh: NativeScript/v8-buildscripts), linked into libwebxrhost.so so the
  # one native library is 16 KB aligned. The defines must match its build (pointer compression, 31-bit smis, no
  # sandbox); V8::Initialize checks them. Its symbols stay out of our export table (--exclude-libs).
  # HOST_V8_INTL (host.json js.intl, WP-24): the same V8 built with ICU and its data compiled in
  # (tools/setup-v8-android-intl.sh → third_party/v8-intl: the stock build's gn args and patches, i18n on), and
  # js/intl.cpp, which sets ICU's default locale and zone. Without it nothing of ICU is linked.
  add_library(v8 STATIC IMPORTED)
  if(HOST_V8_INTL)
    if(NOT EXISTS ${TP}/v8-intl/lib/libv8_monolith.a)
      message(FATAL_ERROR "HOST_V8_INTL: no ${TP}/v8-intl/lib/libv8_monolith.a; run tools/setup-v8-android-intl.sh (the published build) or tools/setup-v8-android-intl.sh --build")
    endif()
    set_target_properties(v8 PROPERTIES IMPORTED_LOCATION ${TP}/v8-intl/lib/libv8_monolith.a
      INTERFACE_INCLUDE_DIRECTORIES ${TP}/v8-intl/include)
    # ICU's public macros as the archive's ICU was compiled with (U_USING_ICU_NAMESPACE=0 and the like), from the build.
    file(STRINGS ${TP}/v8-intl/icu-defines.txt V8_INTL_ICU_DEFINES)
    target_compile_definitions(v8 INTERFACE HOST_V8_INTL ${V8_INTL_ICU_DEFINES})
    message(STATUS "V8: third_party/v8-intl (ICU) for Intl")
  else()
    set_target_properties(v8 PROPERTIES IMPORTED_LOCATION ${TP}/v8/lib/${ANDROID_ABI}/libv8_monolith.a
      INTERFACE_INCLUDE_DIRECTORIES ${TP}/v8/include)
  endif()
  target_compile_definitions(v8 INTERFACE V8_COMPRESS_POINTERS V8_31BIT_SMIS_ON_64BIT_ARCH)

  # Relative paths, so the filter sees only the source tree (a checkout under some ".../mac/..." must not match).
  file(GLOB_RECURSE HOST_SOURCES RELATIVE ${CMAKE_CURRENT_SOURCE_DIR} CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp)
  list(FILTER HOST_SOURCES EXCLUDE REGEX "^(tests|emu|mac|win|ios|linux|media|storage)/|^net/http_curl\\.cpp$")  # the experimental hosts' own sources; media/: HOST_MICROPHONE; storage/: HOST_STORAGE
  if(NOT HOST_CANVAS_TEXT)
    list(FILTER HOST_SOURCES EXCLUDE REGEX "^img/text\\.cpp$")
  endif()
  add_library(webxrhost SHARED ${HOST_SOURCES})
  target_include_directories(webxrhost PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs)
  target_compile_definitions(webxrhost PRIVATE XR_USE_PLATFORM_ANDROID XR_USE_GRAPHICS_API_OPENGL_ES)
  target_compile_options(webxrhost PRIVATE -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers -Wno-unused-private-field -fno-exceptions -fno-rtti)
  target_link_options(webxrhost PRIVATE -Wl,-z,max-page-size=16384 -u ANativeActivity_onCreate -Wl,--exclude-libs,libv8_monolith.a -Wl,--exclude-libs,libopus.a -Wl,--gc-sections)
  option(HOST_PHONE "the phone build (WP-20): no Meta Platform SDK" OFF)
  if(EXISTS ${TP}/ovr_platform_sdk/Include/OVR_Platform.h AND NOT HOST_PHONE)
    message(STATUS "Meta Platform SDK found: navigator.horizon enabled")
    add_library(ovrplatform SHARED IMPORTED)
    set_target_properties(ovrplatform PROPERTIES IMPORTED_LOCATION ${TP}/ovr_platform_sdk/Android/libs/${ANDROID_ABI}/libovrplatformloader.so INTERFACE_INCLUDE_DIRECTORIES ${TP}/ovr_platform_sdk/Include)
    target_compile_definitions(webxrhost PRIVATE HOST_HAS_OVR_PLATFORM)
    target_link_libraries(webxrhost ovrplatform)
  endif()
  # WP-08: Oboe (AAudio) for the WebAudio device stream. Its cmake_minimum_required(3.4.1) predates CMake 4's floor.
  set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
  add_subdirectory(${TP}/oboe oboe)
  target_link_libraries(webxrhost native_app_glue openxr_loader v8 android log EGL GLESv3 mediandk oboe host_webp host_opus host_web_features)
  if(HOST_WEBRTC)
    host_enable_webrtc(webxrhost)
  endif()
  if(HOST_MICROPHONE)
    host_enable_microphone(webxrhost)
  endif()
  if(HOST_STORAGE)
    host_enable_storage(webxrhost)
  endif()
endif()

# The experimental hosts without a headset: mac/, win/, ios/ and linux/. Each runs the same runtime and bindings
# with emu/ (the windowed Host and an emulated headset in place of OpenXR) and brings its own entry point and
# window, Http transport, V8 and GLES (3.0 through ANGLE on mac and win, Apple's OpenGL ES on ios, the system's
# GLES 3.2 on linux).
if(NOT ANDROID AND NOT HOST_TESTS)
  set(CMAKE_CXX_STANDARD 20)  # V8 13+ headers need C++20
  file(GLOB EMU_SOURCES CONFIGURE_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/core/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/js/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/gl/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/img/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/audio/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/store/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/platform/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/app/native_clear.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/net/assets.cpp ${CMAKE_CURRENT_SOURCE_DIR}/net/http_common.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/emu/host_emu.cpp ${CMAKE_CURRENT_SOURCE_DIR}/emu/emu_xr.cpp ${CMAKE_CURRENT_SOURCE_DIR}/emu/splash.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/rtc/rtc_bind.cpp)
  if(NOT HOST_CANVAS_TEXT)
    list(FILTER EMU_SOURCES EXCLUDE REGEX "/img/text\\.cpp$")
  endif()
  # Khronos EGL/GLES headers: the NDK's, only those directories of its sysroot (the rest is Android's libc).
  if(CMAKE_HOST_WIN32)
    set(NDK_HOST_TAG windows-x86_64)
  elseif(CMAKE_HOST_APPLE)
    set(NDK_HOST_TAG darwin-x86_64)
  else()
    set(NDK_HOST_TAG linux-x86_64)
  endif()
  set(KHR_SYSROOT ${CMAKE_CURRENT_SOURCE_DIR}/../tools/sdk/android/ndk/27.2.12479018/toolchains/llvm/prebuilt/${NDK_HOST_TAG}/sysroot/usr/include CACHE PATH "Khronos EGL/GLES headers (the NDK's)")
  set(KHR_INC ${CMAKE_CURRENT_BINARY_DIR}/khr)
  # WebAssembly where V8 has none (ios), or to test that path (mac, host.json wasm.interpreter): js/wasm_interp.cpp.
  if(EXISTS ${TP}/wamr/VERSION AND NOT WIN32)
    add_subdirectory(wamr)
    set(HOST_WAMR wamr)
  endif()
  # Linux has the Khronos headers in the system (libegl-dev, libgles-dev), matching its libEGL and libGLESv2.
  foreach(d EGL GLES2 GLES3 KHR)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
      break()
    endif()
    if(NOT EXISTS ${KHR_INC}/${d})
      file(MAKE_DIRECTORY ${KHR_INC})
      if(CMAKE_HOST_WIN32)
        file(COPY ${KHR_SYSROOT}/${d} DESTINATION ${KHR_INC})
      else()
        file(CREATE_LINK ${KHR_SYSROOT}/${d} ${KHR_INC}/${d} SYMBOLIC)
      endif()
    endif()
  endforeach()
endif()

if(APPLE AND NOT IOS AND NOT CMAKE_SYSTEM_NAME STREQUAL "visionOS" AND NOT HOST_TESTS)
  # host/mac/: a GLFW window, GLES 3.0 through ANGLE on Metal (the libEGL/libGLESv2 pair Electron ships;
  # tools/setup-mac.sh stages it), Homebrew's V8, CoreAudio, libcurl.
  enable_language(OBJCXX)
  set(V8_PREFIX /opt/homebrew/opt/v8 CACHE PATH "Homebrew V8")
  set(ANGLE_DIR ${TP}/angle-mac CACHE PATH "libEGL.dylib + libGLESv2.dylib")
  find_package(glfw3 REQUIRED)

  add_library(v8 SHARED IMPORTED)
  set_target_properties(v8 PROPERTIES IMPORTED_LOCATION ${V8_PREFIX}/lib/libv8.dylib INTERFACE_INCLUDE_DIRECTORIES ${V8_PREFIX}/include)
  add_library(v8_platform SHARED IMPORTED)
  set_target_properties(v8_platform PROPERTIES IMPORTED_LOCATION ${V8_PREFIX}/lib/libv8_libplatform.dylib)
  # Must match the bottle: pointer compression (arm64 default), no sandbox; V8 15.4+ headers want the cppgc define.
  target_compile_definitions(v8 INTERFACE V8_COMPRESS_POINTERS V8_31BIT_SMIS_ON_64BIT_ARCH V8_CPPGC_MICROTASK_QUEUE)
  add_library(angle_egl SHARED IMPORTED)
  set_target_properties(angle_egl PROPERTIES IMPORTED_LOCATION ${ANGLE_DIR}/libEGL.dylib)
  add_library(angle_gles SHARED IMPORTED)
  set_target_properties(angle_gles PROPERTIES IMPORTED_LOCATION ${ANGLE_DIR}/libGLESv2.dylib)

  file(GLOB MAC_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/mac/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/mac/*.mm)
  list(APPEND MAC_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/net/http_curl.cpp)
  add_executable(webxrhost-mac ${EMU_SOURCES} ${MAC_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/emu/glfw_input.cpp)
  target_include_directories(webxrhost-mac PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs ${TP}/openxr/include ${KHR_INC})
  target_compile_definitions(webxrhost-mac PRIVATE HOST_XR_EMULATED HOST_PLATFORM_NAME="mac" GL_GLEXT_PROTOTYPES EGL_EGLEXT_PROTOTYPES HOST_V8_ICU_DATA="${V8_PREFIX}/libexec/icudtl.dat")
  target_compile_options(webxrhost-mac PRIVATE -Wall -Wno-unused-parameter -Wno-missing-field-initializers -Wno-unused-private-field -fno-exceptions -fno-rtti)  # V8 is built without RTTI
  set_source_files_properties(${CMAKE_CURRENT_SOURCE_DIR}/mac/main.mm PROPERTIES COMPILE_OPTIONS -fobjc-arc)
  find_library(CURL curl REQUIRED)
  target_link_libraries(webxrhost-mac v8 v8_platform angle_egl angle_gles glfw host_webp host_opus host_web_features ${CURL} ${HOST_WAMR}
    "-framework Cocoa" "-framework QuartzCore" "-framework AudioToolbox" "-framework CoreAudio")
  if(HOST_WEBRTC)
    host_enable_webrtc(webxrhost-mac)
  endif()
  if(HOST_MICROPHONE)
    host_enable_microphone(webxrhost-mac)
  endif()
  if(HOST_STORAGE)
    host_enable_storage(webxrhost-mac)
  endif()
  # ANGLE is loaded from next to the executable (tools/setup-mac.sh rewrites its install names to @rpath).
  set_target_properties(webxrhost-mac PROPERTIES BUILD_RPATH "${ANGLE_DIR};${V8_PREFIX}/lib;${V8_PREFIX}/libexec")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT ANDROID AND NOT HOST_TESTS)
  # host/linux/ (WP-18): a GLFW window (X11; XWayland on a Wayland session), the system's EGL and GLES 3.2 through
  # libglvnd (Mesa or NVIDIA: the Quest's direct-GLES path, no ANGLE), Homebrew's V8 bottle (Linuxbrew: the same
  # formula as mac), the PulseAudio client API (PipeWire serves it too), libcurl. tools/setup-linux.sh checks the
  # pieces, tools/linux.mjs builds and runs.
  find_package(PkgConfig REQUIRED)
  find_package(Threads REQUIRED)
  pkg_check_modules(LINUX_SYS REQUIRED IMPORTED_TARGET glfw3 libcurl libpulse)
  # GL: the system's libEGL/libGLESv2 (libglvnd), or with HOST_LINUX_ANGLE ANGLE on Vulkan out of the pinned
  # Electron (tools/setup-linux.sh --angle): the GL stack the mac and win hosts run, for parity checks. The
  # Khronos headers are the system's either way.
  option(HOST_LINUX_ANGLE "ANGLE (Vulkan) instead of the system's GLES" OFF)
  set(ANGLE_LINUX ${TP}/angle-linux CACHE PATH "tools/setup-linux.sh --angle")
  if(HOST_LINUX_ANGLE)
    if(NOT EXISTS ${ANGLE_LINUX}/libGLESv2.so)
      message(FATAL_ERROR "no ANGLE at ${ANGLE_LINUX}: run tools/setup-linux.sh --angle")
    endif()
    pkg_check_modules(LINUX_GL_HEADERS REQUIRED egl glesv2)
    add_library(linux_gl INTERFACE)
    target_include_directories(linux_gl INTERFACE ${LINUX_GL_HEADERS_INCLUDE_DIRS})
    target_link_libraries(linux_gl INTERFACE ${ANGLE_LINUX}/libEGL.so ${ANGLE_LINUX}/libGLESv2.so)
    target_compile_definitions(linux_gl INTERFACE HOST_LINUX_ANGLE)
  else()
    pkg_check_modules(LINUX_GL REQUIRED IMPORTED_TARGET egl glesv2)
    add_library(linux_gl INTERFACE)
    target_link_libraries(linux_gl INTERFACE PkgConfig::LINUX_GL)
  endif()
  message(STATUS "linux host GL: ${HOST_LINUX_ANGLE}")
  set(V8_PREFIX /home/linuxbrew/.linuxbrew/opt/v8 CACHE PATH "Homebrew V8 (brew --prefix v8)")
  if(NOT EXISTS ${V8_PREFIX}/lib/libv8.so)
    message(FATAL_ERROR "no V8 at ${V8_PREFIX}: run tools/setup-linux.sh (brew install v8), or pass -DV8_PREFIX=")
  endif()
  add_library(v8 SHARED IMPORTED)
  set_target_properties(v8 PROPERTIES IMPORTED_LOCATION ${V8_PREFIX}/lib/libv8.so INTERFACE_INCLUDE_DIRECTORIES ${V8_PREFIX}/include)
  add_library(v8_platform SHARED IMPORTED)
  set_target_properties(v8_platform PROPERTIES IMPORTED_LOCATION ${V8_PREFIX}/lib/libv8_libplatform.so)
  # Must match the bottle, as on mac: pointer compression, no sandbox, the cppgc microtask define (V8 15.4+).
  target_compile_definitions(v8 INTERFACE V8_COMPRESS_POINTERS V8_31BIT_SMIS_ON_64BIT_ARCH V8_CPPGC_MICROTASK_QUEUE)

  add_executable(webxrhost-linux ${EMU_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/linux/main.cpp ${CMAKE_CURRENT_SOURCE_DIR}/emu/glfw_input.cpp ${CMAKE_CURRENT_SOURCE_DIR}/net/http_curl.cpp)
  target_include_directories(webxrhost-linux PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs ${TP}/openxr/include)
  # EGL_NO_X11: eglplatform.h's native types as integers and void*, without Xlib.h (its None/Bool/Status macros
  # collide with V8's enums); the X11 handles cross as those (linux/main.cpp).
  target_compile_definitions(webxrhost-linux PRIVATE HOST_XR_EMULATED HOST_PLATFORM_NAME="linux" EGL_NO_X11 MESA_EGL_NO_X11_HEADERS
    HOST_V8_ICU_DATA="${V8_PREFIX}/libexec/icudtl.dat")
  # GCC's -Wall adds warnings clang (every other host's compiler) does not: one-line ifs, V8's [[nodiscard]] Maybe.
  target_compile_options(webxrhost-linux PRIVATE -Wall -Wno-unused-parameter -Wno-missing-field-initializers -fno-exceptions -fno-rtti
    $<$<CXX_COMPILER_ID:GNU>:-Wno-misleading-indentation -Wno-unused-result -Wno-maybe-uninitialized> $<$<CXX_COMPILER_ID:Clang>:-Wno-unused-private-field>)
  target_link_libraries(webxrhost-linux v8 v8_platform linux_gl PkgConfig::LINUX_SYS host_webp host_opus host_web_features ${HOST_WAMR} Threads::Threads ${CMAKE_DL_LIBS})
  if(HOST_WEBRTC)
    host_enable_webrtc(webxrhost-linux)
  endif()
  if(HOST_MICROPHONE)
    host_enable_microphone(webxrhost-linux)
  endif()
  if(HOST_STORAGE)
    host_enable_storage(webxrhost-linux)
  endif()
  # The bottle is a component build: libv8 needs libv8_libbase, absl, icu, zlib and partition_alloc, which live in
  # libexec/ (lib/ links only the three public ones) and carry no RUNPATH of their own. An old-style DT_RPATH
  # applies to the whole load chain, a RUNPATH would reach only the executable's direct dependencies; GNU ld also
  # needs the directory to check them at link time. Only libexec/: Homebrew's shared lib/ on the path would hand
  # the system's libcurl Homebrew's zlib, zstd and nghttp2. linux.mjs --app gives the packaged copies $ORIGIN.
  target_link_options(webxrhost-linux PRIVATE -Wl,--disable-new-dtags -Wl,-rpath-link,${V8_PREFIX}/libexec)
  set_target_properties(webxrhost-linux PROPERTIES BUILD_RPATH "${V8_PREFIX}/libexec;$<$<BOOL:${HOST_LINUX_ANGLE}>:${ANGLE_LINUX}>")

  # webxrhost-linux-xr (WP-18b, -DHOST_LINUX_XR=ON): the same host on the system's OpenXR runtime (Monado, WiVRn)
  # instead of the emulated headset: the Quest's xr/ sources with the EGL context bound through XR_MNDX_egl_enable.
  # A second binary, not a runtime switch: OpenXrDevice is one class with two implementations.
  option(HOST_LINUX_XR "Also build webxrhost-linux-xr (OpenXR runtime: the distribution's openxr loader)" OFF)
  if(HOST_LINUX_XR)
    pkg_check_modules(OPENXR REQUIRED IMPORTED_TARGET openxr)
    set(LINUX_XR_SOURCES ${EMU_SOURCES})
    list(FILTER LINUX_XR_SOURCES EXCLUDE REGEX "/emu/emu_xr\\.cpp$")
    add_executable(webxrhost-linux-xr ${LINUX_XR_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/linux/main.cpp ${CMAKE_CURRENT_SOURCE_DIR}/linux/xr_glue.cpp
      ${CMAKE_CURRENT_SOURCE_DIR}/emu/glfw_input.cpp ${CMAKE_CURRENT_SOURCE_DIR}/net/http_curl.cpp
      ${CMAKE_CURRENT_SOURCE_DIR}/xr/openxr_device.cpp ${CMAKE_CURRENT_SOURCE_DIR}/xr/xr_input.cpp ${CMAKE_CURRENT_SOURCE_DIR}/xr/xr_scene.cpp ${CMAKE_CURRENT_SOURCE_DIR}/xr/xr_render_models.cpp)
    # The pinned OpenXR headers (third_party/openxr, 1.1.49) ahead of the distribution's; the loader is the system's.
    target_include_directories(webxrhost-linux-xr BEFORE PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs ${TP}/openxr/include)
    get_target_property(_defs webxrhost-linux COMPILE_DEFINITIONS)
    list(REMOVE_ITEM _defs HOST_XR_EMULATED)
    target_compile_definitions(webxrhost-linux-xr PRIVATE ${_defs} HOST_XR_OPENXR XR_USE_PLATFORM_EGL XR_USE_GRAPHICS_API_OPENGL_ES)
    get_target_property(_opts webxrhost-linux COMPILE_OPTIONS)
    target_compile_options(webxrhost-linux-xr PRIVATE ${_opts})
    get_target_property(_lopts webxrhost-linux LINK_OPTIONS)
    target_link_options(webxrhost-linux-xr PRIVATE ${_lopts})
    target_link_libraries(webxrhost-linux-xr v8 v8_platform linux_gl PkgConfig::LINUX_SYS PkgConfig::OPENXR host_webp host_opus host_web_features ${HOST_WAMR} Threads::Threads ${CMAKE_DL_LIBS})
    if(HOST_WEBRTC)
      host_enable_webrtc(webxrhost-linux-xr)
    endif()
    if(HOST_MICROPHONE)
      host_enable_microphone(webxrhost-linux-xr)
    endif()
    if(HOST_STORAGE)
      host_enable_storage(webxrhost-linux-xr)
    endif()
    get_target_property(_rpath webxrhost-linux BUILD_RPATH)
    set_target_properties(webxrhost-linux-xr PROPERTIES BUILD_RPATH "${_rpath}")
  endif()
endif()

if(WIN32 AND NOT HOST_TESTS)
  # host/win/: a GLFW window, GLES 3.0 through ANGLE on Direct3D 11 (Electron's libEGL/libGLESv2), V8 13.0 from
  # NuGet, WASAPI, WinHTTP (tools/setup-win.mjs fetches the prebuilts). Builds with MSVC or clang-cl; tools/win.mjs
  # drives it (on a Mac: --cross, tools/win-cross.cmake). HOST_WIN_CONSOLE=OFF: the GUI-subsystem build to hand out.
  option(HOST_WIN_CONSOLE "Console subsystem (a terminal for the log)" ON)
  set(V8_WIN ${TP}/v8-win CACHE PATH "tools/setup-win.mjs")
  set(ANGLE_WIN ${TP}/angle-win CACHE PATH "tools/setup-win.mjs")
  set(GLFW_WIN ${TP}/glfw-win CACHE PATH "tools/setup-win.mjs")
  add_library(v8 INTERFACE)
  target_include_directories(v8 INTERFACE ${V8_WIN}/include)
  target_link_libraries(v8 INTERFACE ${V8_WIN}/lib/v8.dll.lib ${V8_WIN}/lib/v8_libbase.dll.lib ${V8_WIN}/lib/v8_libplatform.dll.lib)
  # Must match the prebuilt (its v8_build_config.json): pointer compression, 31-bit smis, the sandbox.
  target_compile_definitions(v8 INTERFACE V8_COMPRESS_POINTERS V8_31BIT_SMIS_ON_64BIT_ARCH V8_ENABLE_SANDBOX)

  file(GLOB WIN_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/win/*.cpp)
  add_executable(webxrhost-win ${EMU_SOURCES} ${WIN_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/emu/glfw_input.cpp)
  target_include_directories(webxrhost-win PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/win/khr ${TP}/stb ${TP}/dr_libs ${TP}/openxr/include ${KHR_INC} ${GLFW_WIN}/include)  # win/khr: a 64-bit GLintptr
  target_compile_definitions(webxrhost-win PRIVATE HOST_XR_EMULATED HOST_PLATFORM_NAME="win" GL_GLEXT_PROTOTYPES EGL_EGLEXT_PROTOTYPES
    NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS _HAS_EXCEPTIONS=0 UNICODE _UNICODE)
  # No exceptions, no RTTI (V8 is built without), as on the other hosts; clang-cl takes the GCC-style warning flags too.
  string(REPLACE "/EHsc" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
  string(REPLACE "/GR" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
  target_compile_options(webxrhost-win PRIVATE /GR- /utf-8 $<$<CXX_COMPILER_ID:Clang>:-Wno-unused-parameter -Wno-missing-field-initializers -Wno-unused-private-field -Wno-microsoft-cast>)
  target_link_libraries(webxrhost-win v8 host_webp host_opus host_web_features ${ANGLE_WIN}/lib/libEGL.lib ${ANGLE_WIN}/lib/libGLESv2.lib ${GLFW_WIN}/lib/glfw3.lib
    ws2_32 winhttp ole32 winmm shell32 user32 gdi32 dbghelp shlwapi)
  if(NOT HOST_WIN_CONSOLE)
    target_link_options(webxrhost-win PRIVATE /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup)
  endif()
  set(HOST_WIN_ICON "" CACHE FILEPATH "An .ico for the executable")
  if(HOST_WIN_ICON)
    enable_language(RC)
    configure_file(${CMAKE_CURRENT_SOURCE_DIR}/win/icon.rc.in ${CMAKE_CURRENT_BINARY_DIR}/icon.rc @ONLY)
    target_sources(webxrhost-win PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/icon.rc)
  endif()
  # The DLLs (and V8's ICU data, win/main.cpp) next to the executable, where Windows looks first.
  file(GLOB WIN_DLLS ${V8_WIN}/bin/*.dll ${V8_WIN}/bin/icudtl.dat ${ANGLE_WIN}/bin/*.dll)
  add_custom_command(TARGET webxrhost-win POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different ${WIN_DLLS} $<TARGET_FILE_DIR:webxrhost-win>)
endif()

if((IOS OR CMAKE_SYSTEM_NAME STREQUAL "visionOS") AND NOT HOST_TESTS)
  # host/ios/: a UIKit view, V8 built from source for Apple platforms (tools/setup-v8-apple.sh: a static monolith per
  # slice, jitless, no WebAssembly of its own: WAMR gives it, ICU data as a file next to the assets), CoreAudio's
  # remote I/O, NSURLSession. GLES 3.0 is ANGLE on Metal (third_party/angle-ios: the GPU, in the simulator too)
  # through gl/egl.cpp as on mac; without it, Apple's OpenGL ES (ios/egl_eagl.mm; ios/gl_ios.h maps framebuffer 0),
  # which the simulator renders in software. tools/ios.mjs configures this with CMAKE_SYSTEM_NAME=iOS and finishes
  # the bundle (assets, frameworks, signing).
  # visionOS (CMAKE_SYSTEM_NAME=visionOS, tools/ios.mjs --vision): the same sources as a flat UIKit window app
  # (WP-17's 17a spike, not the immersive host) on the xros V8 slice and Apple's OpenGLES.framework, which the xros
  # SDK ships; ios/egl_eagl.mm presents by readback there (no CAEAGLLayer on visionOS).
  enable_language(OBJCXX)
  set(V8_APPLE ${TP}/v8-apple CACHE PATH "tools/setup-v8-apple.sh")
  set(V8_IOS ${TP}/v8-ios CACHE PATH "tools/setup-ios.sh (the npm v8-ios framework: the fallback when v8-apple is not built)")
  set(ANGLE_IOS ${TP}/angle-ios CACHE PATH "tools/setup-ios.sh")
  if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
    set(APPLE_SIM ON)
  else()
    set(APPLE_SIM OFF)
  endif()
  if(CMAKE_SYSTEM_NAME STREQUAL "visionOS")
    set(HOST_APPLE vision)
    if(APPLE_SIM)
      set(V8_SLICE xrsim-arm64)
    else()
      set(V8_SLICE xros-arm64)
    endif()
  else()
    set(HOST_APPLE ios)
    if(APPLE_SIM)
      set(V8_SLICE iossim-arm64)
      set(IOS_SLICE ios-arm64_x86_64-simulator)
    else()
      set(V8_SLICE ios-arm64)
      set(IOS_SLICE ios-arm64)
    endif()
  endif()
  set(HOST_APPLE_TARGET webxrhost-${HOST_APPLE})
  if(EXISTS ${V8_APPLE}/lib/${V8_SLICE}/libv8_monolith.a)
    add_library(v8 STATIC IMPORTED)
    set_target_properties(v8 PROPERTIES IMPORTED_LOCATION ${V8_APPLE}/lib/${V8_SLICE}/libv8_monolith.a INTERFACE_INCLUDE_DIRECTORIES ${V8_APPLE}/include)
    # The embedder defines that must match the build (pointer compression, sandbox, ...): written by the build script.
    file(STRINGS ${V8_APPLE}/lib/${V8_SLICE}/defines.txt V8_APPLE_DEFINES)
    target_compile_definitions(v8 INTERFACE ${V8_APPLE_DEFINES})
    set(HOST_V8_DESC "v8-apple ${V8_SLICE} (${V8_APPLE_DEFINES})")
  elseif(HOST_APPLE STREQUAL "ios" AND EXISTS ${V8_IOS}/VERSION)
    add_library(v8 INTERFACE)
    target_include_directories(v8 INTERFACE ${V8_IOS}/include)
    target_link_options(v8 INTERFACE -F${V8_IOS}/v8.xcframework/${IOS_SLICE} "SHELL:-framework v8")
    # The prebuilt is built without pointer compression (V8 checks: "Embedder-vs-V8 build configuration mismatch").
    set(HOST_V8_DESC "v8-ios framework ${IOS_SLICE}")
  else()
    message(FATAL_ERROR "no V8 for ${HOST_APPLE} ${V8_SLICE}: run tools/setup-v8-apple.sh ${V8_SLICE}")
  endif()
  message(STATUS "${HOST_APPLE} host V8: ${HOST_V8_DESC}")

  file(GLOB IOS_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/ios/*.mm)
  option(HOST_IOS_EAGL "Apple's OpenGL ES instead of ANGLE" OFF)
  # Where libEGL.framework and libGLESv2.framework are: the raylib-iOS xcframework slice on iOS, the slice
  # tools/setup-angle-apple.sh built on visionOS (third_party/angle-apple/<slice>).
  if(HOST_APPLE STREQUAL "vision")
    set(ANGLE_FW_DIRS ${TP}/angle-apple/${V8_SLICE})
    set(ANGLE_PRESENT EXISTS ${TP}/angle-apple/${V8_SLICE}/libGLESv2.framework)
  else()
    set(ANGLE_FW_DIRS ${ANGLE_IOS}/libEGL.xcframework/${IOS_SLICE} ${ANGLE_IOS}/libGLESv2.xcframework/${IOS_SLICE})
    set(ANGLE_PRESENT EXISTS ${ANGLE_IOS}/VERSION)
  endif()
  if(${ANGLE_PRESENT} AND NOT HOST_IOS_EAGL)
    set(HOST_IOS_GL angle)
    list(FILTER IOS_SOURCES EXCLUDE REGEX "/egl_eagl\\.mm$")
  else()
    set(HOST_IOS_GL eagl)
    list(FILTER EMU_SOURCES EXCLUDE REGEX "/gl/egl\\.cpp$")
  endif()
  message(STATUS "${HOST_APPLE} host GL: ${HOST_IOS_GL}")
  # The immersive Vision Pro host (WP-17 17b): the SwiftUI shell (vision/App.swift: a window for the flat page
  # and touch input, an immersive space with a CompositorLayer) and vision/vision_xr.mm, OpenXrDevice over
  # Compositor Services + ARKit, in place of the emulated headset. Needs ANGLE (its Metal textures are the
  # compositor's); on Apple's GLES the vision build stays the flat window of the 17a spike.
  if(HOST_APPLE STREQUAL "vision" AND HOST_IOS_GL STREQUAL "angle")
    set(HOST_VISION_IMMERSIVE ON)
    enable_language(Swift)
    list(FILTER EMU_SOURCES EXCLUDE REGEX "/emu/emu_xr\\.cpp$")
    list(APPEND IOS_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/vision/vision_xr.mm)
    add_library(webxrhost-vision-shell STATIC ${CMAKE_CURRENT_SOURCE_DIR}/vision/App.swift)
    set_target_properties(webxrhost-vision-shell PROPERTIES Swift_MODULE_NAME WebXRHostShell)
    target_compile_options(webxrhost-vision-shell PRIVATE "$<$<COMPILE_LANGUAGE:Swift>:SHELL:-import-objc-header ${CMAKE_CURRENT_SOURCE_DIR}/vision/vision_bridge.h>")
  else()
    set(HOST_VISION_IMMERSIVE OFF)
  endif()
  message(STATUS "${HOST_APPLE} host immersive: ${HOST_VISION_IMMERSIVE}")
  add_executable(${HOST_APPLE_TARGET} MACOSX_BUNDLE ${EMU_SOURCES} ${IOS_SOURCES})
  if(HOST_VISION_IMMERSIVE)
    target_compile_definitions(${HOST_APPLE_TARGET} PRIVATE HOST_VISION_IMMERSIVE)
    # Linked by clang++, not swiftc (CMake would otherwise hand swiftc the C flags): the Swift runtime comes
    # from the toolchain's per-platform directory and the SDK's; the Swift objects autolink the rest.
    if(APPLE_SIM)
      set(SWIFT_RT_PLATFORM xrsimulator)
    else()
      set(SWIFT_RT_PLATFORM xros)
    endif()
    execute_process(COMMAND xcrun --find swift OUTPUT_VARIABLE SWIFT_BIN OUTPUT_STRIP_TRAILING_WHITESPACE)
    get_filename_component(SWIFT_TOOLCHAIN_USR ${SWIFT_BIN}/../.. ABSOLUTE)
    set_target_properties(${HOST_APPLE_TARGET} PROPERTIES LINKER_LANGUAGE CXX)
    target_link_options(${HOST_APPLE_TARGET} PRIVATE -L${SWIFT_TOOLCHAIN_USR}/lib/swift/${SWIFT_RT_PLATFORM} -L${CMAKE_OSX_SYSROOT}/usr/lib/swift -Wl,-rpath,/usr/lib/swift)
    target_link_libraries(${HOST_APPLE_TARGET} webxrhost-vision-shell swiftCore "-framework CompositorServices" "-framework ARKit" "-framework SwiftUI" "-framework Metal")
  endif()
  set(IOS_BUNDLE_ID "gg.dmnshd.webxrhost" CACHE STRING "CFBundleIdentifier")
  set(IOS_BUNDLE_NAME "webxr-host" CACHE STRING "CFBundleName")
  set(IOS_VERSION "0.1.0" CACHE STRING "CFBundleShortVersionString")
  if(HOST_APPLE STREQUAL "vision")
    set(IOS_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/ios/Info-vision.plist.in)
  else()
    set(IOS_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/ios/Info.plist.in)
  endif()
  set_target_properties(${HOST_APPLE_TARGET} PROPERTIES MACOSX_BUNDLE_INFO_PLIST ${IOS_PLIST}
    MACOSX_BUNDLE_GUI_IDENTIFIER ${IOS_BUNDLE_ID} MACOSX_BUNDLE_BUNDLE_NAME ${IOS_BUNDLE_NAME}
    MACOSX_BUNDLE_SHORT_VERSION_STRING ${IOS_VERSION} MACOSX_BUNDLE_BUNDLE_VERSION ${IOS_VERSION}
    OUTPUT_NAME webxrhost BUILD_RPATH "@executable_path/Frameworks" INSTALL_RPATH "@executable_path/Frameworks")
  target_include_directories(${HOST_APPLE_TARGET} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs ${TP}/openxr/include ${KHR_INC})
  target_compile_definitions(${HOST_APPLE_TARGET} PRIVATE HOST_XR_EMULATED HOST_PLATFORM_NAME="${HOST_APPLE}" HOST_V8_FLAGS="--jitless --no-freeze-flags-after-init")
  target_compile_options(${HOST_APPLE_TARGET} PRIVATE -Wall -Wno-unused-parameter -Wno-missing-field-initializers -Wno-unused-private-field -fno-exceptions -fno-rtti)
  set_source_files_properties(${IOS_SOURCES} PROPERTIES COMPILE_OPTIONS -fobjc-arc)
  if(NOT HOST_WAMR)
    message(FATAL_ERROR "the ${HOST_APPLE} host needs WAMR for WebAssembly: run tools/setup-ios.sh")
  endif()
  target_link_libraries(${HOST_APPLE_TARGET} v8 host_webp host_opus host_web_features ${HOST_WAMR} "-framework UIKit" "-framework QuartzCore" "-framework CoreGraphics"
    "-framework AudioToolbox" "-framework AVFoundation" "-framework GameController" "-framework Foundation")
  if(HOST_IOS_GL STREQUAL "angle")
    target_compile_definitions(${HOST_APPLE_TARGET} PRIVATE HOST_IOS_ANGLE GL_GLEXT_PROTOTYPES EGL_EGLEXT_PROTOTYPES)
    foreach(d ${ANGLE_FW_DIRS})
      target_link_options(${HOST_APPLE_TARGET} PRIVATE -F${d})
    endforeach()
    target_link_options(${HOST_APPLE_TARGET} PRIVATE "SHELL:-framework libEGL" "SHELL:-framework libGLESv2" "SHELL:-framework Metal")
  else()
    target_compile_definitions(${HOST_APPLE_TARGET} PRIVATE GLES_SILENCE_DEPRECATION)
    target_compile_options(${HOST_APPLE_TARGET} PRIVATE "SHELL:-include ${CMAKE_CURRENT_SOURCE_DIR}/ios/gl_ios.h")
    target_link_libraries(${HOST_APPLE_TARGET} "-framework OpenGLES")
  endif()
endif()

if(HOST_TESTS)
  add_executable(json_test tests/json_test.cpp core/json.cpp)
  target_include_directories(json_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  add_executable(loop_test tests/loop_test.cpp core/loop.cpp)
  target_include_directories(loop_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  # WP-08: the audio graph's DSP, rendered offline on the Mac.
  add_executable(audio_test tests/audio_test.cpp audio/graph.cpp audio/analyser.cpp audio/context.cpp audio/offline.cpp audio/decode.cpp audio/webm.cpp audio/mp3.cpp audio/aac.cpp)
  target_include_directories(audio_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb ${TP}/dr_libs)
  find_package(Threads REQUIRED)
  target_link_libraries(audio_test Threads::Threads host_opus)
  # WP-23: the GL thread's ring, two threads, no GL.
  add_executable(gl_queue_test tests/gl_queue_test.cpp gl/gl_queue.cpp)
  target_include_directories(gl_queue_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  target_compile_definitions(gl_queue_test PRIVATE GLQ_NO_EGL)
  set_target_properties(gl_queue_test PROPERTIES CXX_STANDARD 20)  # std::atomic::wait, std::bit_cast, as in the hosts
  target_link_libraries(gl_queue_test Threads::Threads)
  add_executable(image_test tests/image_test.cpp img/decode.cpp)
  target_include_directories(image_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${TP}/stb)
  target_link_libraries(image_test host_webp host_web_features)
  # WP-26: the SQLite store under IndexedDB and the Cache API (no V8), when tools/setup-storage.sh has fetched SQLite.
  if(EXISTS ${TP}/sqlite/sqlite3.c)
    host_sqlite_library()
    add_executable(storage_test tests/storage_test.cpp storage/kv.cpp)
    target_include_directories(storage_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(storage_test host_sqlite Threads::Threads ${CMAKE_DL_LIBS})
  endif()
endif()
