# IndexedDB and the Cache API (WP-26), only in a build for a game whose host.json asks for either (storage.indexedDB,
# storage.cache; HOST_STORAGE: tools/pack.mjs, tools/mac.mjs and tools/linux.mjs set it). The SQLite amalgamation from
# tools/setup-storage.sh, a static library linked into the host's one library, and host/storage/ on top of it
# (__native.storage), added to the target only here: a game without either compiles none of it.
function(host_sqlite_library)
  if(NOT EXISTS ${TP}/sqlite/sqlite3.c)
    message(FATAL_ERROR "HOST_STORAGE: the SQLite sources are missing; run tools/setup-storage.sh")
  endif()
  if(NOT TARGET host_sqlite)
    add_library(host_sqlite STATIC ${TP}/sqlite/sqlite3.c)
    target_include_directories(host_sqlite PUBLIC ${TP}/sqlite)
    # One connection per isolate (each on its own thread): no per-connection mutex. WAL with synchronous=NORMAL (a
    # commit does not fsync; a crash loses at most the last commits, never consistency). Nothing the host does not use:
    # no extension loading, no deprecated or shared-cache API, no JSON functions; temporary tables in memory (Android
    # apps have no writable /tmp).
    target_compile_definitions(host_sqlite PRIVATE SQLITE_THREADSAFE=2 SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 SQLITE_DQS=0
      SQLITE_OMIT_LOAD_EXTENSION SQLITE_OMIT_DEPRECATED SQLITE_OMIT_SHARED_CACHE SQLITE_OMIT_JSON SQLITE_OMIT_PROGRESS_CALLBACK
      SQLITE_DEFAULT_MEMSTATUS=0 SQLITE_LIKE_DOESNT_MATCH_BLOBS SQLITE_MAX_EXPR_DEPTH=0 SQLITE_TEMP_STORE=3 SQLITE_USE_ALLOCA)
    set_target_properties(host_sqlite PROPERTIES C_VISIBILITY_PRESET hidden POSITION_INDEPENDENT_CODE ON)
    if(MSVC AND NOT CMAKE_C_COMPILER_ID STREQUAL "Clang")
      target_compile_options(host_sqlite PRIVATE /w)
    else()
      target_compile_options(host_sqlite PRIVATE -w)
    endif()
  endif()
endfunction()
function(host_enable_storage target)
  host_sqlite_library()
  target_sources(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/storage/kv.cpp ${CMAKE_CURRENT_SOURCE_DIR}/storage/storage_bind.cpp)
  target_link_libraries(${target} host_sqlite)  # the plain signature, as the host targets use
  target_compile_definitions(${target} PRIVATE HOST_HAS_STORAGE)
  if(ANDROID)
    target_link_options(${target} PRIVATE -Wl,--exclude-libs,libhost_sqlite.a)  # SQLite's symbols stay out of the export table
  endif()
  message(STATUS "${target}: IndexedDB + Cache API (SQLite ${HOST_SQLITE_VERSION})")
endfunction()
set(HOST_SQLITE_VERSION 3.54.1)
