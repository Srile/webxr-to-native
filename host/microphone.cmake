# Microphone capture (WP-25), only in a build for a game whose host.json says media.microphone (HOST_MICROPHONE:
# tools/pack.mjs through Gradle's host.microphone, tools/mac.mjs and tools/linux.mjs through tools/game.mjs). Adds
# host/media/ (the capture device, its tracks, __native.media) to the target: a build without it compiles none of
# it, and the APK's manifest has no RECORD_AUDIO (android/app/src/microphone/AndroidManifest.xml, merged only then).
# Android (Oboe input), mac (CoreAudio HAL input + AVFoundation's permission) and Linux (PulseAudio record);
# the Windows and iOS hosts have no capture and do not call this.
function(host_enable_microphone target)
  set(src ${CMAKE_CURRENT_SOURCE_DIR}/media/mic.cpp ${CMAKE_CURRENT_SOURCE_DIR}/media/media_bind.cpp)
  if(APPLE)
    list(APPEND src ${CMAKE_CURRENT_SOURCE_DIR}/media/mic_permission_mac.mm)
    target_link_libraries(${target} "-framework AVFoundation")
  endif()
  target_sources(${target} PRIVATE ${src})
  target_compile_definitions(${target} PRIVATE HOST_HAS_MICROPHONE)
  message(STATUS "${target}: microphone capture (getUserMedia, MediaStreamAudioSourceNode)")
endfunction()
