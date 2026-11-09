# WebSocket and WebRTC data channels (WP-21), only in a build for a game whose host.json says network.webrtc
# (HOST_WEBRTC: tools/pack.mjs and tools/mac.mjs set it). libdatachannel 0.24.6 without media, over Mbed TLS 3.6.7,
# both from source (tools/setup-webrtc.sh), static, into the host's one library. A game without it builds none of it.
function(host_enable_webrtc target)
  if(NOT EXISTS ${TP}/libdatachannel/CMakeLists.txt OR NOT EXISTS ${TP}/mbedtls/CMakeLists.txt)
    message(FATAL_ERROR "HOST_WEBRTC: the sources are missing; run tools/setup-webrtc.sh")
  endif()
  if(NOT TARGET datachannel-static)
    set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
    set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
    set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
    set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
    set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "" FORCE)
    add_subdirectory(${TP}/mbedtls ${CMAKE_BINARY_DIR}/mbedtls EXCLUDE_FROM_ALL)
    # libdatachannel's DTLS refers to the DTLS-SRTP extension even without media; one setting for both sides.
    foreach(t mbedtls mbedx509 mbedcrypto)
      target_compile_definitions(${t} PUBLIC MBEDTLS_SSL_DTLS_SRTP)
    endforeach()
    # libdatachannel links MbedTLS::MbedTLS (what find_package would give): the three libraries just added.
    add_library(MbedTLS::MbedTLS INTERFACE IMPORTED GLOBAL)
    set_target_properties(MbedTLS::MbedTLS PROPERTIES INTERFACE_LINK_LIBRARIES "mbedtls;mbedx509;mbedcrypto")
    foreach(opt USE_MBEDTLS NO_MEDIA NO_EXAMPLES NO_TESTS)
      set(${opt} ON CACHE BOOL "" FORCE)
    endforeach()
    set(USE_GNUTLS OFF CACHE BOOL "" FORCE)
    set(NO_WEBSOCKET OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    add_subdirectory(${TP}/libdatachannel ${CMAKE_BINARY_DIR}/libdatachannel EXCLUDE_FROM_ALL)
  endif()
  target_link_libraries(${target} datachannel-static)  # the plain signature, as the host targets use
  target_compile_definitions(${target} PRIVATE HOST_HAS_WEBRTC)
  # libdatachannel reports failures as exceptions; the binding catches them (the rest of the host builds without).
  set_source_files_properties(${CMAKE_CURRENT_SOURCE_DIR}/rtc/rtc_bind.cpp TARGET_DIRECTORY ${target} PROPERTIES COMPILE_OPTIONS "-fexceptions;-frtti")
  message(STATUS "${target}: WebSocket + WebRTC data channels (libdatachannel, Mbed TLS)")
endfunction()
