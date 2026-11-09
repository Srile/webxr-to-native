#pragma once
#include <TargetConditionals.h>
#if TARGET_OS_VISION
// The xros SDK ships OpenGLES.framework for arm64-xros yet marks every one of its declarations
// API_UNAVAILABLE(visionos) through OpenGLESAvailability.h (both branches of its GLES_SILENCE_DEPRECATION test).
// WP-17's 17a spike asks the runtime, not the SDK: that header is pre-empted by its own include guard and the
// macro defined away, so the vision target compiles against the same EAGL and gl* declarations as iOS.
#define _OpenGLESAvailability_H
#define OPENGLES_DEPRECATED(...)
#endif
// Force-included into every iOS translation unit (host/CMakeLists.txt). Apple's OpenGL ES has no default
// framebuffer: the window (and the "pbuffer") is a framebuffer object of ours (ios/egl_eagl.mm). Everything
// above GL names the window as framebuffer 0, the way EGL and WebGL do, so the calls that take or report a
// framebuffer binding or a default-framebuffer buffer go through these, which put the window's object in for
// 0 and report 0 for it. The shared code stays as it is on Android, mac and win.
#ifdef __cplusplus
#include <GLES3/gl32.h>
extern "C" {
void hostIosBindFramebuffer(GLenum target, GLuint framebuffer);
void hostIosGetIntegerv(GLenum pname, GLint* data);
void hostIosReadBuffer(GLenum src);
void hostIosDrawBuffers(GLsizei n, const GLenum* bufs);
void hostIosInvalidateFramebuffer(GLenum target, GLsizei n, const GLenum* attachments);
}
#define glBindFramebuffer hostIosBindFramebuffer
#define glGetIntegerv hostIosGetIntegerv
#define glReadBuffer hostIosReadBuffer
#define glDrawBuffers hostIosDrawBuffers
#define glInvalidateFramebuffer hostIosInvalidateFramebuffer
#endif
