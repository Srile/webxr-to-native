#pragma once
#include <cstdio>
#ifdef __ANDROID__
#include <android/log.h>
#define HOST_LOGI(...) __android_log_print(ANDROID_LOG_INFO, "webxr-host", __VA_ARGS__)
#define HOST_LOGW(...) __android_log_print(ANDROID_LOG_WARN, "webxr-host", __VA_ARGS__)
#define HOST_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "webxr-host", __VA_ARGS__)
#define HOST_LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, "webxr-host", __VA_ARGS__)
#define JS_LOG(level, ...) __android_log_print(level, "js", __VA_ARGS__)
#else
// Logcat priorities, so callers pass the same levels everywhere (console.* → JS_LOG).
enum { ANDROID_LOG_DEBUG = 3, ANDROID_LOG_INFO = 4, ANDROID_LOG_WARN = 5, ANDROID_LOG_ERROR = 6 };
#define HOST_LOGI(...) (fprintf(stderr, "[I] " __VA_ARGS__), fputc('\n', stderr))
#define HOST_LOGW(...) (fprintf(stderr, "[W] " __VA_ARGS__), fputc('\n', stderr))
#define HOST_LOGE(...) (fprintf(stderr, "[E] " __VA_ARGS__), fputc('\n', stderr))
#define HOST_LOGD(...) (fprintf(stderr, "[D] " __VA_ARGS__), fputc('\n', stderr))
#define JS_LOG(level, ...) (fprintf(stderr, "%s", (level) >= ANDROID_LOG_ERROR ? "[js:E] " : (level) == ANDROID_LOG_WARN ? "[js:W] " : "[js] "), fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#endif
