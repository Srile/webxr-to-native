#pragma once
// Included LAST by webgl_bind.cpp (after every GL header): each GL entry point the hand-written natives call
// becomes a synchronous call on the GL thread when the queue is on (gl_queue.h), in order with the recorded
// commands, and the plain call otherwise (or on the GL thread itself). Hot natives record a command instead
// (glq::put / reserve + commit) and never reach these. Regenerate the list when webgl_bind.cpp calls a new one:
//   grep -oE '\bgl[A-Z][a-zA-Z0-9_]+\(' host/gl/webgl_bind.cpp | sort -u
// (with the underscore: the indexed getters glGetIntegeri_v & co. were missed without it, ran on the host thread
// with no context current and answered 0, so getIndexedParameter(UNIFORM_BUFFER_BINDING) was null with the thread on)
#include "gl/gl_queue.h"

#ifndef glBindBuffer
#define glBindBuffer(...) ::host::glq::sync("glBindBuffer", [&]() { return ::glBindBuffer(__VA_ARGS__); })
#endif
#ifndef glBindFramebuffer
#define glBindFramebuffer(...) ::host::glq::sync("glBindFramebuffer", [&]() { return ::glBindFramebuffer(__VA_ARGS__); })
#endif
#ifndef glBufferData
#define glBufferData(...) ::host::glq::sync("glBufferData", [&]() { return ::glBufferData(__VA_ARGS__); })
#endif
#ifndef glBufferSubData
#define glBufferSubData(...) ::host::glq::sync("glBufferSubData", [&]() { return ::glBufferSubData(__VA_ARGS__); })
#endif
#ifndef glClear
#define glClear(...) ::host::glq::sync("glClear", [&]() { return ::glClear(__VA_ARGS__); })
#endif
#ifndef glClearColor
#define glClearColor(...) ::host::glq::sync("glClearColor", [&]() { return ::glClearColor(__VA_ARGS__); })
#endif
#ifndef glClearDepthf
#define glClearDepthf(...) ::host::glq::sync("glClearDepthf", [&]() { return ::glClearDepthf(__VA_ARGS__); })
#endif
#ifndef glClearStencil
#define glClearStencil(...) ::host::glq::sync("glClearStencil", [&]() { return ::glClearStencil(__VA_ARGS__); })
#endif
#ifndef glClientWaitSync
#define glClientWaitSync(...) ::host::glq::sync("glClientWaitSync", [&]() { return ::glClientWaitSync(__VA_ARGS__); })
#endif
#ifndef glColorMask
#define glColorMask(...) ::host::glq::sync("glColorMask", [&]() { return ::glColorMask(__VA_ARGS__); })
#endif
#ifndef glCompressedTexImage2D
#define glCompressedTexImage2D(...) ::host::glq::sync("glCompressedTexImage2D", [&]() { return ::glCompressedTexImage2D(__VA_ARGS__); })
#endif
#ifndef glCompressedTexImage3D
#define glCompressedTexImage3D(...) ::host::glq::sync("glCompressedTexImage3D", [&]() { return ::glCompressedTexImage3D(__VA_ARGS__); })
#endif
#ifndef glCompressedTexSubImage2D
#define glCompressedTexSubImage2D(...) ::host::glq::sync("glCompressedTexSubImage2D", [&]() { return ::glCompressedTexSubImage2D(__VA_ARGS__); })
#endif
#ifndef glCompressedTexSubImage3D
#define glCompressedTexSubImage3D(...) ::host::glq::sync("glCompressedTexSubImage3D", [&]() { return ::glCompressedTexSubImage3D(__VA_ARGS__); })
#endif
#ifndef glDeleteBuffers
#define glDeleteBuffers(...) ::host::glq::sync("glDeleteBuffers", [&]() { return ::glDeleteBuffers(__VA_ARGS__); })
#endif
#ifndef glDeleteSync
#define glDeleteSync(...) ::host::glq::sync("glDeleteSync", [&]() { return ::glDeleteSync(__VA_ARGS__); })
#endif
#ifndef glDepthMask
#define glDepthMask(...) ::host::glq::sync("glDepthMask", [&]() { return ::glDepthMask(__VA_ARGS__); })
#endif
#ifndef glDisable
#define glDisable(...) ::host::glq::sync("glDisable", [&]() { return ::glDisable(__VA_ARGS__); })
#endif
#ifndef glDisableVertexAttribArray
#define glDisableVertexAttribArray(...) ::host::glq::sync("glDisableVertexAttribArray", [&]() { return ::glDisableVertexAttribArray(__VA_ARGS__); })
#endif
#ifndef glDrawArrays
#define glDrawArrays(...) ::host::glq::sync("glDrawArrays", [&]() { return ::glDrawArrays(__VA_ARGS__); })
#endif
#ifndef glDrawArraysInstanced
#define glDrawArraysInstanced(...) ::host::glq::sync("glDrawArraysInstanced", [&]() { return ::glDrawArraysInstanced(__VA_ARGS__); })
#endif
#ifndef glDrawBuffers
#define glDrawBuffers(...) ::host::glq::sync("glDrawBuffers", [&]() { return ::glDrawBuffers(__VA_ARGS__); })
#endif
#ifndef glDrawElements
#define glDrawElements(...) ::host::glq::sync("glDrawElements", [&]() { return ::glDrawElements(__VA_ARGS__); })
#endif
#ifndef glDrawElementsInstanced
#define glDrawElementsInstanced(...) ::host::glq::sync("glDrawElementsInstanced", [&]() { return ::glDrawElementsInstanced(__VA_ARGS__); })
#endif
#ifndef glEnable
#define glEnable(...) ::host::glq::sync("glEnable", [&]() { return ::glEnable(__VA_ARGS__); })
#endif
#ifndef glEnableVertexAttribArray
#define glEnableVertexAttribArray(...) ::host::glq::sync("glEnableVertexAttribArray", [&]() { return ::glEnableVertexAttribArray(__VA_ARGS__); })
#endif
#ifndef glFenceSync
#define glFenceSync(...) ::host::glq::sync("glFenceSync", [&]() { return ::glFenceSync(__VA_ARGS__); })
#endif
#ifndef glFramebufferTexture2D
#define glFramebufferTexture2D(...) ::host::glq::sync("glFramebufferTexture2D", [&]() { return ::glFramebufferTexture2D(__VA_ARGS__); })
#endif
#ifndef glFramebufferTextureLayer
#define glFramebufferTextureLayer(...) ::host::glq::sync("glFramebufferTextureLayer", [&]() { return ::glFramebufferTextureLayer(__VA_ARGS__); })
#endif
#ifndef glGenBuffers
#define glGenBuffers(...) ::host::glq::sync("glGenBuffers", [&]() { return ::glGenBuffers(__VA_ARGS__); })
#endif
#ifndef glGetActiveAttrib
#define glGetActiveAttrib(...) ::host::glq::sync("glGetActiveAttrib", [&]() { return ::glGetActiveAttrib(__VA_ARGS__); })
#endif
#ifndef glGetActiveUniform
#define glGetActiveUniform(...) ::host::glq::sync("glGetActiveUniform", [&]() { return ::glGetActiveUniform(__VA_ARGS__); })
#endif
#ifndef glGetActiveUniformBlockName
#define glGetActiveUniformBlockName(...) ::host::glq::sync("glGetActiveUniformBlockName", [&]() { return ::glGetActiveUniformBlockName(__VA_ARGS__); })
#endif
#ifndef glGetActiveUniformBlockiv
#define glGetActiveUniformBlockiv(...) ::host::glq::sync("glGetActiveUniformBlockiv", [&]() { return ::glGetActiveUniformBlockiv(__VA_ARGS__); })
#endif
#ifndef glGetActiveUniformsiv
#define glGetActiveUniformsiv(...) ::host::glq::sync("glGetActiveUniformsiv", [&]() { return ::glGetActiveUniformsiv(__VA_ARGS__); })
#endif
#ifndef glGetAttachedShaders
#define glGetAttachedShaders(...) ::host::glq::sync("glGetAttachedShaders", [&]() { return ::glGetAttachedShaders(__VA_ARGS__); })
#endif
#ifndef glGetBooleani_v
#define glGetBooleani_v(...) ::host::glq::sync("glGetBooleani_v", [&]() { return ::glGetBooleani_v(__VA_ARGS__); })
#endif
#ifndef glGetBooleanv
#define glGetBooleanv(...) ::host::glq::sync("glGetBooleanv", [&]() { return ::glGetBooleanv(__VA_ARGS__); })
#endif
#ifndef glGetError
#define glGetError(...) ::host::glq::sync("glGetError", [&]() { return ::glGetError(__VA_ARGS__); })
#endif
#ifndef glGetFloatv
#define glGetFloatv(...) ::host::glq::sync("glGetFloatv", [&]() { return ::glGetFloatv(__VA_ARGS__); })
#endif
#ifndef glGetInteger64i_v
#define glGetInteger64i_v(...) ::host::glq::sync("glGetInteger64i_v", [&]() { return ::glGetInteger64i_v(__VA_ARGS__); })
#endif
#ifndef glGetInteger64v
#define glGetInteger64v(...) ::host::glq::sync("glGetInteger64v", [&]() { return ::glGetInteger64v(__VA_ARGS__); })
#endif
#ifndef glGetIntegeri_v
#define glGetIntegeri_v(...) ::host::glq::sync("glGetIntegeri_v", [&]() { return ::glGetIntegeri_v(__VA_ARGS__); })
#endif
#ifndef glGetIntegerv
#define glGetIntegerv(...) ::host::glq::sync("glGetIntegerv", [&]() { return ::glGetIntegerv(__VA_ARGS__); })
#endif
#ifndef glGetInternalformativ
#define glGetInternalformativ(...) ::host::glq::sync("glGetInternalformativ", [&]() { return ::glGetInternalformativ(__VA_ARGS__); })
#endif
#ifndef glGetProgramInfoLog
#define glGetProgramInfoLog(...) ::host::glq::sync("glGetProgramInfoLog", [&]() { return ::glGetProgramInfoLog(__VA_ARGS__); })
#endif
#ifndef glGetProgramiv
#define glGetProgramiv(...) ::host::glq::sync("glGetProgramiv", [&]() { return ::glGetProgramiv(__VA_ARGS__); })
#endif
#ifndef glGetQueryObjectuiv
#define glGetQueryObjectuiv(...) ::host::glq::sync("glGetQueryObjectuiv", [&]() { return ::glGetQueryObjectuiv(__VA_ARGS__); })
#endif
#ifndef glGetSamplerParameterfv
#define glGetSamplerParameterfv(...) ::host::glq::sync("glGetSamplerParameterfv", [&]() { return ::glGetSamplerParameterfv(__VA_ARGS__); })
#endif
#ifndef glGetSamplerParameteriv
#define glGetSamplerParameteriv(...) ::host::glq::sync("glGetSamplerParameteriv", [&]() { return ::glGetSamplerParameteriv(__VA_ARGS__); })
#endif
#ifndef glGetShaderInfoLog
#define glGetShaderInfoLog(...) ::host::glq::sync("glGetShaderInfoLog", [&]() { return ::glGetShaderInfoLog(__VA_ARGS__); })
#endif
#ifndef glGetShaderPrecisionFormat
#define glGetShaderPrecisionFormat(...) ::host::glq::sync("glGetShaderPrecisionFormat", [&]() { return ::glGetShaderPrecisionFormat(__VA_ARGS__); })
#endif
#ifndef glGetShaderiv
#define glGetShaderiv(...) ::host::glq::sync("glGetShaderiv", [&]() { return ::glGetShaderiv(__VA_ARGS__); })
#endif
#ifndef glGetString
#define glGetString(...) ::host::glq::sync("glGetString", [&]() { return ::glGetString(__VA_ARGS__); })
#endif
#ifndef glGetSynciv
#define glGetSynciv(...) ::host::glq::sync("glGetSynciv", [&]() { return ::glGetSynciv(__VA_ARGS__); })
#endif
#ifndef glGetTexParameterfv
#define glGetTexParameterfv(...) ::host::glq::sync("glGetTexParameterfv", [&]() { return ::glGetTexParameterfv(__VA_ARGS__); })
#endif
#ifndef glGetTexParameteriv
#define glGetTexParameteriv(...) ::host::glq::sync("glGetTexParameteriv", [&]() { return ::glGetTexParameteriv(__VA_ARGS__); })
#endif
#ifndef glGetTransformFeedbackVarying
#define glGetTransformFeedbackVarying(...) ::host::glq::sync("glGetTransformFeedbackVarying", [&]() { return ::glGetTransformFeedbackVarying(__VA_ARGS__); })
#endif
#ifndef glGetUniformIndices
#define glGetUniformIndices(...) ::host::glq::sync("glGetUniformIndices", [&]() { return ::glGetUniformIndices(__VA_ARGS__); })
#endif
#ifndef glGetUniformLocation
#define glGetUniformLocation(...) ::host::glq::sync("glGetUniformLocation", [&]() { return ::glGetUniformLocation(__VA_ARGS__); })
#endif
#ifndef glGetUniformfv
#define glGetUniformfv(...) ::host::glq::sync("glGetUniformfv", [&]() { return ::glGetUniformfv(__VA_ARGS__); })
#endif
#ifndef glGetUniformiv
#define glGetUniformiv(...) ::host::glq::sync("glGetUniformiv", [&]() { return ::glGetUniformiv(__VA_ARGS__); })
#endif
#ifndef glGetUniformuiv
#define glGetUniformuiv(...) ::host::glq::sync("glGetUniformuiv", [&]() { return ::glGetUniformuiv(__VA_ARGS__); })
#endif
#ifndef glGetVertexAttribIiv
#define glGetVertexAttribIiv(...) ::host::glq::sync("glGetVertexAttribIiv", [&]() { return ::glGetVertexAttribIiv(__VA_ARGS__); })
#endif
#ifndef glGetVertexAttribPointerv
#define glGetVertexAttribPointerv(...) ::host::glq::sync("glGetVertexAttribPointerv", [&]() { return ::glGetVertexAttribPointerv(__VA_ARGS__); })
#endif
#ifndef glGetVertexAttribfv
#define glGetVertexAttribfv(...) ::host::glq::sync("glGetVertexAttribfv", [&]() { return ::glGetVertexAttribfv(__VA_ARGS__); })
#endif
#ifndef glGetVertexAttribiv
#define glGetVertexAttribiv(...) ::host::glq::sync("glGetVertexAttribiv", [&]() { return ::glGetVertexAttribiv(__VA_ARGS__); })
#endif
#ifndef glInvalidateFramebuffer
#define glInvalidateFramebuffer(...) ::host::glq::sync("glInvalidateFramebuffer", [&]() { return ::glInvalidateFramebuffer(__VA_ARGS__); })
#endif
#ifndef glInvalidateSubFramebuffer
#define glInvalidateSubFramebuffer(...) ::host::glq::sync("glInvalidateSubFramebuffer", [&]() { return ::glInvalidateSubFramebuffer(__VA_ARGS__); })
#endif
#ifndef glIsEnabled
#define glIsEnabled(...) ::host::glq::sync("glIsEnabled", [&]() { return ::glIsEnabled(__VA_ARGS__); })
#endif
#ifndef glIsEnabledi
#define glIsEnabledi(...) ::host::glq::sync("glIsEnabledi", [&]() { return ::glIsEnabledi(__VA_ARGS__); })
#endif
#ifndef glIsFramebuffer
#define glIsFramebuffer(...) ::host::glq::sync("glIsFramebuffer", [&]() { return ::glIsFramebuffer(__VA_ARGS__); })
#endif
#ifndef glIsSync
#define glIsSync(...) ::host::glq::sync("glIsSync", [&]() { return ::glIsSync(__VA_ARGS__); })
#endif
#ifndef glMapBufferRange
#define glMapBufferRange(...) ::host::glq::sync("glMapBufferRange", [&]() { return ::glMapBufferRange(__VA_ARGS__); })
#endif
#ifndef glReadPixels
#define glReadPixels(...) ::host::glq::sync("glReadPixels", [&]() { return ::glReadPixels(__VA_ARGS__); })
#endif
#ifndef glShaderSource
#define glShaderSource(...) ::host::glq::sync("glShaderSource", [&]() { return ::glShaderSource(__VA_ARGS__); })
#endif
#ifndef glStencilMaskSeparate
#define glStencilMaskSeparate(...) ::host::glq::sync("glStencilMaskSeparate", [&]() { return ::glStencilMaskSeparate(__VA_ARGS__); })
#endif
#ifndef glTexImage2D
#define glTexImage2D(...) ::host::glq::sync("glTexImage2D", [&]() { return ::glTexImage2D(__VA_ARGS__); })
#endif
#ifndef glTexImage3D
#define glTexImage3D(...) ::host::glq::sync("glTexImage3D", [&]() { return ::glTexImage3D(__VA_ARGS__); })
#endif
#ifndef glTexSubImage2D
#define glTexSubImage2D(...) ::host::glq::sync("glTexSubImage2D", [&]() { return ::glTexSubImage2D(__VA_ARGS__); })
#endif
#ifndef glTexSubImage3D
#define glTexSubImage3D(...) ::host::glq::sync("glTexSubImage3D", [&]() { return ::glTexSubImage3D(__VA_ARGS__); })
#endif
#ifndef glTransformFeedbackVaryings
#define glTransformFeedbackVaryings(...) ::host::glq::sync("glTransformFeedbackVaryings", [&]() { return ::glTransformFeedbackVaryings(__VA_ARGS__); })
#endif
#ifndef glUniform1i
#define glUniform1i(...) ::host::glq::sync("glUniform1i", [&]() { return ::glUniform1i(__VA_ARGS__); })
#endif
#ifndef glUnmapBuffer
#define glUnmapBuffer(...) ::host::glq::sync("glUnmapBuffer", [&]() { return ::glUnmapBuffer(__VA_ARGS__); })
#endif
#ifndef glVertexAttribDivisor
#define glVertexAttribDivisor(...) ::host::glq::sync("glVertexAttribDivisor", [&]() { return ::glVertexAttribDivisor(__VA_ARGS__); })
#endif
#ifndef glVertexAttribI4i
#define glVertexAttribI4i(...) ::host::glq::sync("glVertexAttribI4i", [&]() { return ::glVertexAttribI4i(__VA_ARGS__); })
#endif
#ifndef glVertexAttribIPointer
#define glVertexAttribIPointer(...) ::host::glq::sync("glVertexAttribIPointer", [&]() { return ::glVertexAttribIPointer(__VA_ARGS__); })
#endif
#ifndef glWaitSync
#define glWaitSync(...) ::host::glq::sync("glWaitSync", [&]() { return ::glWaitSync(__VA_ARGS__); })
#endif
