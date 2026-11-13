#!/usr/bin/env python3
"""The WebGL2 binding's table (WP-04). THIS FILE IS THE SPEC.

It emits:
  host/gl/webgl_bind.gen.cpp          one C++ entry point per generated row + the getParameter kind table
  runtime/src/webgl/constants.gen.js  every WebGL2 constant (and the extension objects' constants)
  runtime/src/webgl/methods.gen.js    the JS pass-through methods (object unwrapping, create/delete bookkeeping)

Run `python3 host/gl/webgl_table.py` from anywhere; `--check <ndk-sysroot-include>`
also verifies every constant's value against GLES3/gl32.h + GLES2/gl2ext.h.
Python 3 stdlib only. The hand-written entry points (texImage2D, getParameter,
uniform arrays with awkward overloads, …) live in webgl_bind.cpp and context.js;
HAND_NATIVES below lists them so the README and the counts stay honest.

Row format for FUNCS: (jsName, glCall, args, ret[, flags])
  glCall      "glBindBuffer"                  plain call
              "gen:glGenBuffers"              create*: glGen*(1, &n), returns the name
              "del:glDeleteBuffers"           delete*: glDelete*(1, &n)
              "geti:glGetBufferParameteriv"   one GLint out-parameter appended, returned
              "uv:glUniform1fv:f:1"           (loc, data, srcOffset, srcLength) element type f/i/u, N per element
              "um:glUniformMatrix4fv:16"      (loc, transpose, data, srcOffset, srcLength)
              "av:glVertexAttrib4fv:f:4"      (index, values) needs N elements
              "cb:glClearBufferfv:f"          (buffer, drawbuffer, values, srcOffset)
              "ext:member"                    wgl::ext.member(...), installed only when resolved
  args        space-separated kinds:
              e enum  u GLuint  i GLint/GLsizei  f GLfloat  b GLboolean  p GLintptr/GLsizeiptr  ptr a byte offset GL takes as const void*  str DOMString
              o:<kind> a WebGL object's name (uint32 in C++; the JS side unwraps <kind>: buffer texture program
                shader framebuffer renderbuffer vao sampler query tf) — o:loc is a WebGLUniformLocation (GLint,
                null = silently return, as WebGL does)
  ret         v void, i int, u uint, e enum, b bool, f float, o:<kind> object (create* and getQuery)
  flags       "nojs"   no JS pass-through is generated (an extension object's method, written by hand in extensions.js)
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GEN_CPP = os.path.join(HERE, 'webgl_bind.gen.cpp')
GEN_CONST_JS = os.path.join(ROOT, 'runtime', 'src', 'webgl', 'constants.gen.js')
GEN_METHODS_JS = os.path.join(ROOT, 'runtime', 'src', 'webgl', 'methods.gen.js')
GEN_QUEUE_JS = os.path.join(ROOT, 'runtime', 'src', 'webgl', 'queue.gen.js')

# ---------------------------------------------------------------------------
# WebGL2RenderingContext constants, in the IDL's order (WebGL 1 block, then WebGL 2).
# ---------------------------------------------------------------------------
CONSTANTS = [
    # ClearBufferMask
    ('DEPTH_BUFFER_BIT', 0x00000100), ('STENCIL_BUFFER_BIT', 0x00000400), ('COLOR_BUFFER_BIT', 0x00004000),
    # BeginMode
    ('POINTS', 0x0000), ('LINES', 0x0001), ('LINE_LOOP', 0x0002), ('LINE_STRIP', 0x0003), ('TRIANGLES', 0x0004),
    ('TRIANGLE_STRIP', 0x0005), ('TRIANGLE_FAN', 0x0006),
    # BlendingFactorDest / Src
    ('ZERO', 0), ('ONE', 1), ('SRC_COLOR', 0x0300), ('ONE_MINUS_SRC_COLOR', 0x0301), ('SRC_ALPHA', 0x0302),
    ('ONE_MINUS_SRC_ALPHA', 0x0303), ('DST_ALPHA', 0x0304), ('ONE_MINUS_DST_ALPHA', 0x0305), ('DST_COLOR', 0x0306),
    ('ONE_MINUS_DST_COLOR', 0x0307), ('SRC_ALPHA_SATURATE', 0x0308),
    # BlendEquationSeparate / BlendSubtract
    ('FUNC_ADD', 0x8006), ('BLEND_EQUATION', 0x8009), ('BLEND_EQUATION_RGB', 0x8009), ('BLEND_EQUATION_ALPHA', 0x883D),
    ('FUNC_SUBTRACT', 0x800A), ('FUNC_REVERSE_SUBTRACT', 0x800B),
    # Separate Blend Functions
    ('BLEND_DST_RGB', 0x80C8), ('BLEND_SRC_RGB', 0x80C9), ('BLEND_DST_ALPHA', 0x80CA), ('BLEND_SRC_ALPHA', 0x80CB),
    ('CONSTANT_COLOR', 0x8001), ('ONE_MINUS_CONSTANT_COLOR', 0x8002), ('CONSTANT_ALPHA', 0x8003),
    ('ONE_MINUS_CONSTANT_ALPHA', 0x8004), ('BLEND_COLOR', 0x8005),
    # Buffer Objects
    ('ARRAY_BUFFER', 0x8892), ('ELEMENT_ARRAY_BUFFER', 0x8893), ('ARRAY_BUFFER_BINDING', 0x8894),
    ('ELEMENT_ARRAY_BUFFER_BINDING', 0x8895), ('STREAM_DRAW', 0x88E0), ('STATIC_DRAW', 0x88E4), ('DYNAMIC_DRAW', 0x88E8),
    ('BUFFER_SIZE', 0x8764), ('BUFFER_USAGE', 0x8765), ('CURRENT_VERTEX_ATTRIB', 0x8626),
    # CullFaceMode
    ('FRONT', 0x0404), ('BACK', 0x0405), ('FRONT_AND_BACK', 0x0408),
    # EnableCap
    ('CULL_FACE', 0x0B44), ('BLEND', 0x0BE2), ('DITHER', 0x0BD0), ('STENCIL_TEST', 0x0B90), ('DEPTH_TEST', 0x0B71),
    ('SCISSOR_TEST', 0x0C11), ('POLYGON_OFFSET_FILL', 0x8037), ('SAMPLE_ALPHA_TO_COVERAGE', 0x809E), ('SAMPLE_COVERAGE', 0x80A0),
    # ErrorCode
    ('NO_ERROR', 0), ('INVALID_ENUM', 0x0500), ('INVALID_VALUE', 0x0501), ('INVALID_OPERATION', 0x0502), ('OUT_OF_MEMORY', 0x0505),
    # FrontFaceDirection
    ('CW', 0x0900), ('CCW', 0x0901),
    # GetPName
    ('LINE_WIDTH', 0x0B21), ('ALIASED_POINT_SIZE_RANGE', 0x846D), ('ALIASED_LINE_WIDTH_RANGE', 0x846E), ('CULL_FACE_MODE', 0x0B45),
    ('FRONT_FACE', 0x0B46), ('DEPTH_RANGE', 0x0B70), ('DEPTH_WRITEMASK', 0x0B72), ('DEPTH_CLEAR_VALUE', 0x0B73), ('DEPTH_FUNC', 0x0B74),
    ('STENCIL_CLEAR_VALUE', 0x0B91), ('STENCIL_FUNC', 0x0B92), ('STENCIL_FAIL', 0x0B94), ('STENCIL_PASS_DEPTH_FAIL', 0x0B95),
    ('STENCIL_PASS_DEPTH_PASS', 0x0B96), ('STENCIL_REF', 0x0B97), ('STENCIL_VALUE_MASK', 0x0B93), ('STENCIL_WRITEMASK', 0x0B98),
    ('STENCIL_BACK_FUNC', 0x8800), ('STENCIL_BACK_FAIL', 0x8801), ('STENCIL_BACK_PASS_DEPTH_FAIL', 0x8802),
    ('STENCIL_BACK_PASS_DEPTH_PASS', 0x8803), ('STENCIL_BACK_REF', 0x8CA3), ('STENCIL_BACK_VALUE_MASK', 0x8CA4),
    ('STENCIL_BACK_WRITEMASK', 0x8CA5), ('VIEWPORT', 0x0BA2), ('SCISSOR_BOX', 0x0C10), ('COLOR_CLEAR_VALUE', 0x0C22),
    ('COLOR_WRITEMASK', 0x0C23), ('UNPACK_ALIGNMENT', 0x0CF5), ('PACK_ALIGNMENT', 0x0D05), ('MAX_TEXTURE_SIZE', 0x0D33),
    ('MAX_VIEWPORT_DIMS', 0x0D3A), ('SUBPIXEL_BITS', 0x0D50), ('RED_BITS', 0x0D52), ('GREEN_BITS', 0x0D53), ('BLUE_BITS', 0x0D54),
    ('ALPHA_BITS', 0x0D55), ('DEPTH_BITS', 0x0D56), ('STENCIL_BITS', 0x0D57), ('POLYGON_OFFSET_UNITS', 0x2A00),
    ('POLYGON_OFFSET_FACTOR', 0x8038), ('TEXTURE_BINDING_2D', 0x8069), ('SAMPLE_BUFFERS', 0x80A8), ('SAMPLES', 0x80A9),
    ('SAMPLE_COVERAGE_VALUE', 0x80AA), ('SAMPLE_COVERAGE_INVERT', 0x80AB),
    # GetTextureParameter
    ('COMPRESSED_TEXTURE_FORMATS', 0x86A3),
    # HintMode / HintTarget
    ('DONT_CARE', 0x1100), ('FASTEST', 0x1101), ('NICEST', 0x1102), ('GENERATE_MIPMAP_HINT', 0x8192),
    # DataType
    ('BYTE', 0x1400), ('UNSIGNED_BYTE', 0x1401), ('SHORT', 0x1402), ('UNSIGNED_SHORT', 0x1403), ('INT', 0x1404),
    ('UNSIGNED_INT', 0x1405), ('FLOAT', 0x1406),
    # PixelFormat / PixelType
    ('DEPTH_COMPONENT', 0x1902), ('ALPHA', 0x1906), ('RGB', 0x1907), ('RGBA', 0x1908), ('LUMINANCE', 0x1909), ('LUMINANCE_ALPHA', 0x190A),
    ('UNSIGNED_SHORT_4_4_4_4', 0x8033), ('UNSIGNED_SHORT_5_5_5_1', 0x8034), ('UNSIGNED_SHORT_5_6_5', 0x8363),
    # Shaders
    ('FRAGMENT_SHADER', 0x8B30), ('VERTEX_SHADER', 0x8B31), ('MAX_VERTEX_ATTRIBS', 0x8869), ('MAX_VERTEX_UNIFORM_VECTORS', 0x8DFB),
    ('MAX_VARYING_VECTORS', 0x8DFC), ('MAX_COMBINED_TEXTURE_IMAGE_UNITS', 0x8B4D), ('MAX_VERTEX_TEXTURE_IMAGE_UNITS', 0x8B4C),
    ('MAX_TEXTURE_IMAGE_UNITS', 0x8872), ('MAX_FRAGMENT_UNIFORM_VECTORS', 0x8DFD), ('SHADER_TYPE', 0x8B4F), ('DELETE_STATUS', 0x8B80),
    ('LINK_STATUS', 0x8B82), ('VALIDATE_STATUS', 0x8B83), ('ATTACHED_SHADERS', 0x8B85), ('ACTIVE_UNIFORMS', 0x8B86),
    ('ACTIVE_ATTRIBUTES', 0x8B89), ('SHADING_LANGUAGE_VERSION', 0x8B8C), ('CURRENT_PROGRAM', 0x8B8D),
    # StencilFunction
    ('NEVER', 0x0200), ('LESS', 0x0201), ('EQUAL', 0x0202), ('LEQUAL', 0x0203), ('GREATER', 0x0204), ('NOTEQUAL', 0x0205),
    ('GEQUAL', 0x0206), ('ALWAYS', 0x0207),
    # StencilOp
    ('KEEP', 0x1E00), ('REPLACE', 0x1E01), ('INCR', 0x1E02), ('DECR', 0x1E03), ('INVERT', 0x150A), ('INCR_WRAP', 0x8507), ('DECR_WRAP', 0x8508),
    # StringName
    ('VENDOR', 0x1F00), ('RENDERER', 0x1F01), ('VERSION', 0x1F02),
    # TextureMagFilter / MinFilter
    ('NEAREST', 0x2600), ('LINEAR', 0x2601), ('NEAREST_MIPMAP_NEAREST', 0x2700), ('LINEAR_MIPMAP_NEAREST', 0x2701),
    ('NEAREST_MIPMAP_LINEAR', 0x2702), ('LINEAR_MIPMAP_LINEAR', 0x2703),
    # TextureParameterName
    ('TEXTURE_MAG_FILTER', 0x2800), ('TEXTURE_MIN_FILTER', 0x2801), ('TEXTURE_WRAP_S', 0x2802), ('TEXTURE_WRAP_T', 0x2803),
    # TextureTarget
    ('TEXTURE_2D', 0x0DE1), ('TEXTURE', 0x1702), ('TEXTURE_CUBE_MAP', 0x8513), ('TEXTURE_BINDING_CUBE_MAP', 0x8514),
    ('TEXTURE_CUBE_MAP_POSITIVE_X', 0x8515), ('TEXTURE_CUBE_MAP_NEGATIVE_X', 0x8516), ('TEXTURE_CUBE_MAP_POSITIVE_Y', 0x8517),
    ('TEXTURE_CUBE_MAP_NEGATIVE_Y', 0x8518), ('TEXTURE_CUBE_MAP_POSITIVE_Z', 0x8519), ('TEXTURE_CUBE_MAP_NEGATIVE_Z', 0x851A),
    ('MAX_CUBE_MAP_TEXTURE_SIZE', 0x851C),
] + [('TEXTURE%d' % i, 0x84C0 + i) for i in range(32)] + [
    ('ACTIVE_TEXTURE', 0x84E0),
    # TextureWrapMode
    ('REPEAT', 0x2901), ('CLAMP_TO_EDGE', 0x812F), ('MIRRORED_REPEAT', 0x8370),
    # Uniform Types
    ('FLOAT_VEC2', 0x8B50), ('FLOAT_VEC3', 0x8B51), ('FLOAT_VEC4', 0x8B52), ('INT_VEC2', 0x8B53), ('INT_VEC3', 0x8B54),
    ('INT_VEC4', 0x8B55), ('BOOL', 0x8B56), ('BOOL_VEC2', 0x8B57), ('BOOL_VEC3', 0x8B58), ('BOOL_VEC4', 0x8B59),
    ('FLOAT_MAT2', 0x8B5A), ('FLOAT_MAT3', 0x8B5B), ('FLOAT_MAT4', 0x8B5C), ('SAMPLER_2D', 0x8B5E), ('SAMPLER_CUBE', 0x8B60),
    # Vertex Arrays
    ('VERTEX_ATTRIB_ARRAY_ENABLED', 0x8622), ('VERTEX_ATTRIB_ARRAY_SIZE', 0x8623), ('VERTEX_ATTRIB_ARRAY_STRIDE', 0x8624),
    ('VERTEX_ATTRIB_ARRAY_TYPE', 0x8625), ('VERTEX_ATTRIB_ARRAY_NORMALIZED', 0x886A), ('VERTEX_ATTRIB_ARRAY_POINTER', 0x8645),
    ('VERTEX_ATTRIB_ARRAY_BUFFER_BINDING', 0x889F),
    # Read Format
    ('IMPLEMENTATION_COLOR_READ_TYPE', 0x8B9A), ('IMPLEMENTATION_COLOR_READ_FORMAT', 0x8B9B),
    # Shader Source
    ('COMPILE_STATUS', 0x8B81),
    # Shader Precision-Specified Types
    ('LOW_FLOAT', 0x8DF0), ('MEDIUM_FLOAT', 0x8DF1), ('HIGH_FLOAT', 0x8DF2), ('LOW_INT', 0x8DF3), ('MEDIUM_INT', 0x8DF4), ('HIGH_INT', 0x8DF5),
    # Framebuffer Object
    ('FRAMEBUFFER', 0x8D40), ('RENDERBUFFER', 0x8D41), ('RGBA4', 0x8056), ('RGB5_A1', 0x8057), ('RGBA8', 0x8058), ('RGB565', 0x8D62),
    ('DEPTH_COMPONENT16', 0x81A5), ('STENCIL_INDEX8', 0x8D48), ('DEPTH_STENCIL', 0x84F9),
    ('RENDERBUFFER_WIDTH', 0x8D42), ('RENDERBUFFER_HEIGHT', 0x8D43), ('RENDERBUFFER_INTERNAL_FORMAT', 0x8D44),
    ('RENDERBUFFER_RED_SIZE', 0x8D50), ('RENDERBUFFER_GREEN_SIZE', 0x8D51), ('RENDERBUFFER_BLUE_SIZE', 0x8D52),
    ('RENDERBUFFER_ALPHA_SIZE', 0x8D53), ('RENDERBUFFER_DEPTH_SIZE', 0x8D54), ('RENDERBUFFER_STENCIL_SIZE', 0x8D55),
    ('FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE', 0x8CD0), ('FRAMEBUFFER_ATTACHMENT_OBJECT_NAME', 0x8CD1),
    ('FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL', 0x8CD2), ('FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE', 0x8CD3),
    ('COLOR_ATTACHMENT0', 0x8CE0), ('DEPTH_ATTACHMENT', 0x8D00), ('STENCIL_ATTACHMENT', 0x8D20), ('DEPTH_STENCIL_ATTACHMENT', 0x821A),
    ('NONE', 0), ('FRAMEBUFFER_COMPLETE', 0x8CD5), ('FRAMEBUFFER_INCOMPLETE_ATTACHMENT', 0x8CD6),
    ('FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT', 0x8CD7), ('FRAMEBUFFER_INCOMPLETE_DIMENSIONS', 0x8CD9), ('FRAMEBUFFER_UNSUPPORTED', 0x8CDD),
    ('FRAMEBUFFER_BINDING', 0x8CA6), ('RENDERBUFFER_BINDING', 0x8CA7), ('MAX_RENDERBUFFER_SIZE', 0x84E8),
    ('INVALID_FRAMEBUFFER_OPERATION', 0x0506),
    # WebGL-specific enums
    ('UNPACK_FLIP_Y_WEBGL', 0x9240), ('UNPACK_PREMULTIPLY_ALPHA_WEBGL', 0x9241), ('CONTEXT_LOST_WEBGL', 0x9242),
    ('UNPACK_COLORSPACE_CONVERSION_WEBGL', 0x9243), ('BROWSER_DEFAULT_WEBGL', 0x9244),
    # ---- WebGL 2 ----
    ('READ_BUFFER', 0x0C02), ('UNPACK_ROW_LENGTH', 0x0CF2), ('UNPACK_SKIP_ROWS', 0x0CF3), ('UNPACK_SKIP_PIXELS', 0x0CF4),
    ('PACK_ROW_LENGTH', 0x0D02), ('PACK_SKIP_ROWS', 0x0D03), ('PACK_SKIP_PIXELS', 0x0D04), ('COLOR', 0x1800), ('DEPTH', 0x1801),
    ('STENCIL', 0x1802), ('RED', 0x1903), ('RGB8', 0x8051), ('RGB10_A2', 0x8059), ('TEXTURE_BINDING_3D', 0x806A),
    ('UNPACK_SKIP_IMAGES', 0x806D), ('UNPACK_IMAGE_HEIGHT', 0x806E), ('TEXTURE_3D', 0x806F), ('TEXTURE_WRAP_R', 0x8072),
    ('MAX_3D_TEXTURE_SIZE', 0x8073), ('UNSIGNED_INT_2_10_10_10_REV', 0x8368), ('MAX_ELEMENTS_VERTICES', 0x80E8),
    ('MAX_ELEMENTS_INDICES', 0x80E9), ('TEXTURE_MIN_LOD', 0x813A), ('TEXTURE_MAX_LOD', 0x813B), ('TEXTURE_BASE_LEVEL', 0x813C),
    ('TEXTURE_MAX_LEVEL', 0x813D), ('MIN', 0x8007), ('MAX', 0x8008), ('DEPTH_COMPONENT24', 0x81A6), ('MAX_TEXTURE_LOD_BIAS', 0x84FD),
    ('TEXTURE_COMPARE_MODE', 0x884C), ('TEXTURE_COMPARE_FUNC', 0x884D), ('CURRENT_QUERY', 0x8865), ('QUERY_RESULT', 0x8866),
    ('QUERY_RESULT_AVAILABLE', 0x8867), ('STREAM_READ', 0x88E1), ('STREAM_COPY', 0x88E2), ('STATIC_READ', 0x88E5),
    ('STATIC_COPY', 0x88E6), ('DYNAMIC_READ', 0x88E9), ('DYNAMIC_COPY', 0x88EA), ('MAX_DRAW_BUFFERS', 0x8824),
] + [('DRAW_BUFFER%d' % i, 0x8825 + i) for i in range(16)] + [
    ('MAX_FRAGMENT_UNIFORM_COMPONENTS', 0x8B49), ('MAX_VERTEX_UNIFORM_COMPONENTS', 0x8B4A), ('SAMPLER_3D', 0x8B5F),
    ('SAMPLER_2D_SHADOW', 0x8B62), ('FRAGMENT_SHADER_DERIVATIVE_HINT', 0x8B8B), ('PIXEL_PACK_BUFFER', 0x88EB),
    ('PIXEL_UNPACK_BUFFER', 0x88EC), ('PIXEL_PACK_BUFFER_BINDING', 0x88ED), ('PIXEL_UNPACK_BUFFER_BINDING', 0x88EF),
    ('FLOAT_MAT2x3', 0x8B65), ('FLOAT_MAT2x4', 0x8B66), ('FLOAT_MAT3x2', 0x8B67), ('FLOAT_MAT3x4', 0x8B68), ('FLOAT_MAT4x2', 0x8B69),
    ('FLOAT_MAT4x3', 0x8B6A), ('SRGB', 0x8C40), ('SRGB8', 0x8C41), ('SRGB8_ALPHA8', 0x8C43), ('COMPARE_REF_TO_TEXTURE', 0x884E),
    ('RGBA32F', 0x8814), ('RGB32F', 0x8815), ('RGBA16F', 0x881A), ('RGB16F', 0x881B), ('VERTEX_ATTRIB_ARRAY_INTEGER', 0x88FD),
    ('MAX_ARRAY_TEXTURE_LAYERS', 0x88FF), ('MIN_PROGRAM_TEXEL_OFFSET', 0x8904), ('MAX_PROGRAM_TEXEL_OFFSET', 0x8905),
    ('MAX_VARYING_COMPONENTS', 0x8B4B), ('TEXTURE_2D_ARRAY', 0x8C1A), ('TEXTURE_BINDING_2D_ARRAY', 0x8C1D), ('R11F_G11F_B10F', 0x8C3A),
    ('UNSIGNED_INT_10F_11F_11F_REV', 0x8C3B), ('RGB9_E5', 0x8C3D), ('UNSIGNED_INT_5_9_9_9_REV', 0x8C3E),
    ('TRANSFORM_FEEDBACK_BUFFER_MODE', 0x8C7F), ('MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS', 0x8C80),
    ('TRANSFORM_FEEDBACK_VARYINGS', 0x8C83), ('TRANSFORM_FEEDBACK_BUFFER_START', 0x8C84), ('TRANSFORM_FEEDBACK_BUFFER_SIZE', 0x8C85),
    ('TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN', 0x8C88), ('RASTERIZER_DISCARD', 0x8C89),
    ('MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS', 0x8C8A), ('MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS', 0x8C8B),
    ('INTERLEAVED_ATTRIBS', 0x8C8C), ('SEPARATE_ATTRIBS', 0x8C8D), ('TRANSFORM_FEEDBACK_BUFFER', 0x8C8E),
    ('TRANSFORM_FEEDBACK_BUFFER_BINDING', 0x8C8F), ('RGBA32UI', 0x8D70), ('RGB32UI', 0x8D71), ('RGBA16UI', 0x8D76), ('RGB16UI', 0x8D77),
    ('RGBA8UI', 0x8D7C), ('RGB8UI', 0x8D7D), ('RGBA32I', 0x8D82), ('RGB32I', 0x8D83), ('RGBA16I', 0x8D88), ('RGB16I', 0x8D89),
    ('RGBA8I', 0x8D8E), ('RGB8I', 0x8D8F), ('RED_INTEGER', 0x8D94), ('RGB_INTEGER', 0x8D98), ('RGBA_INTEGER', 0x8D99),
    ('SAMPLER_2D_ARRAY', 0x8DC1), ('SAMPLER_2D_ARRAY_SHADOW', 0x8DC4), ('SAMPLER_CUBE_SHADOW', 0x8DC5), ('UNSIGNED_INT_VEC2', 0x8DC6),
    ('UNSIGNED_INT_VEC3', 0x8DC7), ('UNSIGNED_INT_VEC4', 0x8DC8), ('INT_SAMPLER_2D', 0x8DCA), ('INT_SAMPLER_3D', 0x8DCB),
    ('INT_SAMPLER_CUBE', 0x8DCC), ('INT_SAMPLER_2D_ARRAY', 0x8DCF), ('UNSIGNED_INT_SAMPLER_2D', 0x8DD2), ('UNSIGNED_INT_SAMPLER_3D', 0x8DD3),
    ('UNSIGNED_INT_SAMPLER_CUBE', 0x8DD4), ('UNSIGNED_INT_SAMPLER_2D_ARRAY', 0x8DD7), ('DEPTH_COMPONENT32F', 0x8CAC),
    ('DEPTH32F_STENCIL8', 0x8CAD), ('FLOAT_32_UNSIGNED_INT_24_8_REV', 0x8DAD), ('FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING', 0x8210),
    ('FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE', 0x8211), ('FRAMEBUFFER_ATTACHMENT_RED_SIZE', 0x8212),
    ('FRAMEBUFFER_ATTACHMENT_GREEN_SIZE', 0x8213), ('FRAMEBUFFER_ATTACHMENT_BLUE_SIZE', 0x8214),
    ('FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE', 0x8215), ('FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE', 0x8216),
    ('FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE', 0x8217), ('FRAMEBUFFER_DEFAULT', 0x8218), ('UNSIGNED_INT_24_8', 0x84FA),
    ('DEPTH24_STENCIL8', 0x88F0), ('UNSIGNED_NORMALIZED', 0x8C17), ('DRAW_FRAMEBUFFER_BINDING', 0x8CA6), ('READ_FRAMEBUFFER', 0x8CA8),
    ('DRAW_FRAMEBUFFER', 0x8CA9), ('READ_FRAMEBUFFER_BINDING', 0x8CAA), ('RENDERBUFFER_SAMPLES', 0x8CAB),
    ('FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER', 0x8CD4), ('MAX_COLOR_ATTACHMENTS', 0x8CDF),
] + [('COLOR_ATTACHMENT%d' % i, 0x8CE0 + i) for i in range(1, 16)] + [
    ('FRAMEBUFFER_INCOMPLETE_MULTISAMPLE', 0x8D56), ('MAX_SAMPLES', 0x8D57), ('HALF_FLOAT', 0x140B), ('RG', 0x8227), ('RG_INTEGER', 0x8228),
    ('R8', 0x8229), ('RG8', 0x822B), ('R16F', 0x822D), ('R32F', 0x822E), ('RG16F', 0x822F), ('RG32F', 0x8230), ('R8I', 0x8231),
    ('R8UI', 0x8232), ('R16I', 0x8233), ('R16UI', 0x8234), ('R32I', 0x8235), ('R32UI', 0x8236), ('RG8I', 0x8237), ('RG8UI', 0x8238),
    ('RG16I', 0x8239), ('RG16UI', 0x823A), ('RG32I', 0x823B), ('RG32UI', 0x823C), ('VERTEX_ARRAY_BINDING', 0x85B5), ('R8_SNORM', 0x8F94),
    ('RG8_SNORM', 0x8F95), ('RGB8_SNORM', 0x8F96), ('RGBA8_SNORM', 0x8F97), ('SIGNED_NORMALIZED', 0x8F9C), ('COPY_READ_BUFFER', 0x8F36),
    ('COPY_WRITE_BUFFER', 0x8F37), ('COPY_READ_BUFFER_BINDING', 0x8F36), ('COPY_WRITE_BUFFER_BINDING', 0x8F37), ('UNIFORM_BUFFER', 0x8A11),
    ('UNIFORM_BUFFER_BINDING', 0x8A28), ('UNIFORM_BUFFER_START', 0x8A29), ('UNIFORM_BUFFER_SIZE', 0x8A2A),
    ('MAX_VERTEX_UNIFORM_BLOCKS', 0x8A2B), ('MAX_FRAGMENT_UNIFORM_BLOCKS', 0x8A2D), ('MAX_COMBINED_UNIFORM_BLOCKS', 0x8A2E),
    ('MAX_UNIFORM_BUFFER_BINDINGS', 0x8A2F), ('MAX_UNIFORM_BLOCK_SIZE', 0x8A30), ('MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS', 0x8A31),
    ('MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS', 0x8A33), ('UNIFORM_BUFFER_OFFSET_ALIGNMENT', 0x8A34), ('ACTIVE_UNIFORM_BLOCKS', 0x8A36),
    ('UNIFORM_TYPE', 0x8A37), ('UNIFORM_SIZE', 0x8A38), ('UNIFORM_BLOCK_INDEX', 0x8A3A), ('UNIFORM_OFFSET', 0x8A3B),
    ('UNIFORM_ARRAY_STRIDE', 0x8A3C), ('UNIFORM_MATRIX_STRIDE', 0x8A3D), ('UNIFORM_IS_ROW_MAJOR', 0x8A3E), ('UNIFORM_BLOCK_BINDING', 0x8A3F),
    ('UNIFORM_BLOCK_DATA_SIZE', 0x8A40), ('UNIFORM_BLOCK_ACTIVE_UNIFORMS', 0x8A42), ('UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES', 0x8A43),
    ('UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER', 0x8A44), ('UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER', 0x8A46),
    ('INVALID_INDEX', 0xFFFFFFFF), ('MAX_VERTEX_OUTPUT_COMPONENTS', 0x9122), ('MAX_FRAGMENT_INPUT_COMPONENTS', 0x9125),
    ('MAX_SERVER_WAIT_TIMEOUT', 0x9111), ('OBJECT_TYPE', 0x9112), ('SYNC_CONDITION', 0x9113), ('SYNC_STATUS', 0x9114), ('SYNC_FLAGS', 0x9115),
    ('SYNC_FENCE', 0x9116), ('SYNC_GPU_COMMANDS_COMPLETE', 0x9117), ('UNSIGNALED', 0x9118), ('SIGNALED', 0x9119), ('ALREADY_SIGNALED', 0x911A),
    ('TIMEOUT_EXPIRED', 0x911B), ('CONDITION_SATISFIED', 0x911C), ('WAIT_FAILED', 0x911D), ('SYNC_FLUSH_COMMANDS_BIT', 0x00000001),
    ('VERTEX_ATTRIB_ARRAY_DIVISOR', 0x88FE), ('ANY_SAMPLES_PASSED', 0x8C2F), ('ANY_SAMPLES_PASSED_CONSERVATIVE', 0x8D6A),
    ('SAMPLER_BINDING', 0x8919), ('RGB10_A2UI', 0x906F), ('INT_2_10_10_10_REV', 0x8D9F), ('TRANSFORM_FEEDBACK', 0x8E22),
    ('TRANSFORM_FEEDBACK_PAUSED', 0x8E23), ('TRANSFORM_FEEDBACK_ACTIVE', 0x8E24), ('TRANSFORM_FEEDBACK_BINDING', 0x8E25),
    ('TEXTURE_IMMUTABLE_FORMAT', 0x912F), ('MAX_ELEMENT_INDEX', 0x8D6B), ('TEXTURE_IMMUTABLE_LEVELS', 0x82DF),
    ('TIMEOUT_IGNORED', -1), ('MAX_CLIENT_WAIT_TIMEOUT_WEBGL', 0x9247),
]

# Constants that live on extension OBJECTS (gl.getExtension(name).X), per WebGL extension name.
EXT_CONSTANTS = {
    'EXT_texture_filter_anisotropic': [('TEXTURE_MAX_ANISOTROPY_EXT', 0x84FE), ('MAX_TEXTURE_MAX_ANISOTROPY_EXT', 0x84FF)],
    'KHR_parallel_shader_compile': [('COMPLETION_STATUS_KHR', 0x91B1)],
    'WEBGL_debug_renderer_info': [('UNMASKED_VENDOR_WEBGL', 0x9245), ('UNMASKED_RENDERER_WEBGL', 0x9246)],
    'EXT_color_buffer_half_float': [('RGBA16F_EXT', 0x881A), ('RGB16F_EXT', 0x881B), ('FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT', 0x8211),
                                    ('UNSIGNED_NORMALIZED_EXT', 0x8C17)],
    'EXT_disjoint_timer_query_webgl2': [('QUERY_COUNTER_BITS_EXT', 0x8864), ('CURRENT_QUERY_EXT', 0x8865), ('QUERY_RESULT_EXT', 0x8866),
                                        ('QUERY_RESULT_AVAILABLE_EXT', 0x8867), ('TIMESTAMP_EXT', 0x8E28), ('TIME_ELAPSED_EXT', 0x88BF),
                                        ('GPU_DISJOINT_EXT', 0x8FBB)],
    'OVR_multiview2': [('FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR', 0x9630), ('MAX_VIEWS_OVR', 0x9631),
                       ('FRAMEBUFFER_ATTACHMENT_TEXTURE_BASE_VIEW_INDEX_OVR', 0x9632), ('FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR', 0x9633)],
    'WEBGL_multisampled_render_to_texture': [('RENDERBUFFER_SAMPLES_EXT', 0x8CAB), ('FRAMEBUFFER_INCOMPLETE_MULTISAMPLE_EXT', 0x8D56),
                                             ('MAX_SAMPLES_EXT', 0x8D57), ('FRAMEBUFFER_ATTACHMENT_TEXTURE_SAMPLES_EXT', 0x8D6C)],
    'WEBGL_render_shared_exponent': [('RGB9_E5', 0x8C3D)],
    'EXT_clip_control': [('LOWER_LEFT_EXT', 0x8CA1), ('UPPER_LEFT_EXT', 0x8CA2), ('NEGATIVE_ONE_TO_ONE_EXT', 0x935E), ('ZERO_TO_ONE_EXT', 0x935F),
                         ('CLIP_ORIGIN_EXT', 0x935C), ('CLIP_DEPTH_MODE_EXT', 0x935D)],
    'WEBGL_clip_cull_distance': [('MAX_CLIP_DISTANCES_WEBGL', 0x0D32), ('MAX_CULL_DISTANCES_WEBGL', 0x82F9),
                                 ('MAX_COMBINED_CLIP_AND_CULL_DISTANCES_WEBGL', 0x82FA)] + [('CLIP_DISTANCE%d_WEBGL' % i, 0x3000 + i) for i in range(8)],
    'EXT_texture_norm16': [('R16_EXT', 0x822A), ('RG16_EXT', 0x822C), ('RGB16_EXT', 0x8054), ('RGBA16_EXT', 0x805B), ('R16_SNORM_EXT', 0x8F98),
                           ('RG16_SNORM_EXT', 0x8F99), ('RGB16_SNORM_EXT', 0x8F9A), ('RGBA16_SNORM_EXT', 0x8F9B)],
    'WEBGL_compressed_texture_etc': [('COMPRESSED_R11_EAC', 0x9270), ('COMPRESSED_SIGNED_R11_EAC', 0x9271), ('COMPRESSED_RG11_EAC', 0x9272),
                                     ('COMPRESSED_SIGNED_RG11_EAC', 0x9273), ('COMPRESSED_RGB8_ETC2', 0x9274), ('COMPRESSED_SRGB8_ETC2', 0x9275),
                                     ('COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2', 0x9276), ('COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2', 0x9277),
                                     ('COMPRESSED_RGBA8_ETC2_EAC', 0x9278), ('COMPRESSED_SRGB8_ALPHA8_ETC2_EAC', 0x9279)],
    'WEBGL_compressed_texture_astc': (
        [('COMPRESSED_RGBA_ASTC_%s_KHR' % b, 0x93B0 + i) for i, b in enumerate(['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'])] +
        [('COMPRESSED_SRGB8_ALPHA8_ASTC_%s_KHR' % b, 0x93D0 + i) for i, b in enumerate(['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'])]),
    'WEBGL_compressed_texture_s3tc': [('COMPRESSED_RGB_S3TC_DXT1_EXT', 0x83F0), ('COMPRESSED_RGBA_S3TC_DXT1_EXT', 0x83F1),
                                      ('COMPRESSED_RGBA_S3TC_DXT3_EXT', 0x83F2), ('COMPRESSED_RGBA_S3TC_DXT5_EXT', 0x83F3)],
    'WEBGL_compressed_texture_s3tc_srgb': [('COMPRESSED_SRGB_S3TC_DXT1_EXT', 0x8C4C), ('COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT', 0x8C4D),
                                           ('COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT', 0x8C4E), ('COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT', 0x8C4F)],
    'WEBGL_compressed_texture_pvrtc': [('COMPRESSED_RGB_PVRTC_4BPPV1_IMG', 0x8C00), ('COMPRESSED_RGB_PVRTC_2BPPV1_IMG', 0x8C01),
                                       ('COMPRESSED_RGBA_PVRTC_4BPPV1_IMG', 0x8C02), ('COMPRESSED_RGBA_PVRTC_2BPPV1_IMG', 0x8C03)],
    'EXT_texture_compression_bptc': [('COMPRESSED_RGBA_BPTC_UNORM_EXT', 0x8E8C), ('COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT', 0x8E8D),
                                     ('COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT', 0x8E8E), ('COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT', 0x8E8F)],
    'EXT_texture_compression_rgtc': [('COMPRESSED_RED_RGTC1_EXT', 0x8DBB), ('COMPRESSED_SIGNED_RED_RGTC1_EXT', 0x8DBC),
                                     ('COMPRESSED_RED_GREEN_RGTC2_EXT', 0x8DBD), ('COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT', 0x8DBE)],
}

# ---------------------------------------------------------------------------
# getParameter(pname) → what the NATIVE side returns. Object bindings are 'i'
# (the GL name; the JS side wraps it). WebGL-only enums are answered in JS and
# never reach here. Extension pnames are included: harmless when absent.
# ---------------------------------------------------------------------------
_P = {}
def _p(kind, *names):
    for n in names: _P[n] = kind
_p('b', 'BLEND', 'CULL_FACE', 'DEPTH_TEST', 'DEPTH_WRITEMASK', 'DITHER', 'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'SAMPLE_COVERAGE',
   'SAMPLE_COVERAGE_INVERT', 'SCISSOR_TEST', 'STENCIL_TEST', 'RASTERIZER_DISCARD', 'TRANSFORM_FEEDBACK_ACTIVE', 'TRANSFORM_FEEDBACK_PAUSED',
   'GPU_DISJOINT_EXT', *['CLIP_DISTANCE%d_WEBGL' % i for i in range(8)])
_p('f', 'DEPTH_CLEAR_VALUE', 'LINE_WIDTH', 'POLYGON_OFFSET_FACTOR', 'POLYGON_OFFSET_UNITS', 'SAMPLE_COVERAGE_VALUE', 'MAX_TEXTURE_LOD_BIAS',
   'MAX_TEXTURE_MAX_ANISOTROPY_EXT')
_p('f2', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE', 'DEPTH_RANGE')
_p('f4', 'BLEND_COLOR', 'COLOR_CLEAR_VALUE')
_p('i2', 'MAX_VIEWPORT_DIMS')
_p('i4', 'SCISSOR_BOX', 'VIEWPORT')
_p('b4', 'COLOR_WRITEMASK')
_p('s', 'VENDOR', 'RENDERER', 'VERSION', 'SHADING_LANGUAGE_VERSION')
_p('u', 'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK', 'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_WRITEMASK')
_p('i64', 'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS', 'MAX_ELEMENT_INDEX', 'MAX_SERVER_WAIT_TIMEOUT',
   'MAX_UNIFORM_BLOCK_SIZE', 'TIMESTAMP_EXT')
_p('cf', 'COMPRESSED_TEXTURE_FORMATS')
_p('i', 'ACTIVE_TEXTURE', 'ALPHA_BITS', 'ARRAY_BUFFER_BINDING', 'BLEND_DST_ALPHA', 'BLEND_DST_RGB', 'BLEND_EQUATION', 'BLEND_EQUATION_ALPHA',
   'BLEND_SRC_ALPHA', 'BLEND_SRC_RGB', 'BLUE_BITS', 'CULL_FACE_MODE', 'CURRENT_PROGRAM', 'DEPTH_BITS', 'DEPTH_FUNC', 'ELEMENT_ARRAY_BUFFER_BINDING',
   'FRAMEBUFFER_BINDING', 'FRONT_FACE', 'GENERATE_MIPMAP_HINT', 'GREEN_BITS', 'IMPLEMENTATION_COLOR_READ_FORMAT', 'IMPLEMENTATION_COLOR_READ_TYPE',
   'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_RENDERBUFFER_SIZE',
   'MAX_TEXTURE_IMAGE_UNITS', 'MAX_TEXTURE_SIZE', 'MAX_VARYING_VECTORS', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
   'MAX_VERTEX_UNIFORM_VECTORS', 'PACK_ALIGNMENT', 'RED_BITS', 'RENDERBUFFER_BINDING', 'SAMPLE_BUFFERS', 'SAMPLES', 'STENCIL_BACK_FAIL',
   'STENCIL_BACK_FUNC', 'STENCIL_BACK_PASS_DEPTH_FAIL', 'STENCIL_BACK_PASS_DEPTH_PASS', 'STENCIL_BACK_REF', 'STENCIL_BITS', 'STENCIL_CLEAR_VALUE',
   'STENCIL_FAIL', 'STENCIL_FUNC', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS', 'STENCIL_REF', 'SUBPIXEL_BITS', 'TEXTURE_BINDING_2D',
   'TEXTURE_BINDING_CUBE_MAP', 'UNPACK_ALIGNMENT',
   # WebGL 2
   'COPY_READ_BUFFER_BINDING', 'COPY_WRITE_BUFFER_BINDING', *['DRAW_BUFFER%d' % i for i in range(16)], 'FRAGMENT_SHADER_DERIVATIVE_HINT',
   'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_COMBINED_UNIFORM_BLOCKS', 'MAX_DRAW_BUFFERS',
   'MAX_ELEMENTS_INDICES', 'MAX_ELEMENTS_VERTICES', 'MAX_FRAGMENT_INPUT_COMPONENTS', 'MAX_FRAGMENT_UNIFORM_BLOCKS',
   'MAX_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_PROGRAM_TEXEL_OFFSET', 'MAX_SAMPLES', 'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS',
   'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS', 'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS', 'MAX_UNIFORM_BUFFER_BINDINGS',
   'MAX_VARYING_COMPONENTS', 'MAX_VERTEX_OUTPUT_COMPONENTS', 'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_VERTEX_UNIFORM_COMPONENTS',
   'MIN_PROGRAM_TEXEL_OFFSET', 'PACK_ROW_LENGTH', 'PACK_SKIP_PIXELS', 'PACK_SKIP_ROWS', 'PIXEL_PACK_BUFFER_BINDING', 'PIXEL_UNPACK_BUFFER_BINDING',
   'READ_BUFFER', 'READ_FRAMEBUFFER_BINDING', 'SAMPLER_BINDING', 'TEXTURE_BINDING_2D_ARRAY', 'TEXTURE_BINDING_3D', 'TRANSFORM_FEEDBACK_BINDING',
   'TRANSFORM_FEEDBACK_BUFFER_BINDING', 'UNIFORM_BUFFER_BINDING', 'UNIFORM_BUFFER_OFFSET_ALIGNMENT', 'UNPACK_IMAGE_HEIGHT', 'UNPACK_ROW_LENGTH',
   'UNPACK_SKIP_IMAGES', 'UNPACK_SKIP_PIXELS', 'UNPACK_SKIP_ROWS', 'VERTEX_ARRAY_BINDING',
   # extensions
   'MAX_VIEWS_OVR', 'MAX_CLIP_DISTANCES_WEBGL', 'MAX_CULL_DISTANCES_WEBGL', 'MAX_COMBINED_CLIP_AND_CULL_DISTANCES_WEBGL', 'CLIP_ORIGIN_EXT',
   'CLIP_DEPTH_MODE_EXT', 'MAX_SAMPLES_EXT')
PARAMS = _P

# getParameter pnames whose GL name the JS side wraps into an object, per object kind.
PARAM_OBJECTS = {
    'buffer': ['ARRAY_BUFFER_BINDING', 'ELEMENT_ARRAY_BUFFER_BINDING', 'COPY_READ_BUFFER_BINDING', 'COPY_WRITE_BUFFER_BINDING',
               'PIXEL_PACK_BUFFER_BINDING', 'PIXEL_UNPACK_BUFFER_BINDING', 'TRANSFORM_FEEDBACK_BUFFER_BINDING', 'UNIFORM_BUFFER_BINDING'],
    'program': ['CURRENT_PROGRAM'],
    'framebuffer': ['FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING'],
    'renderbuffer': ['RENDERBUFFER_BINDING'],
    'texture': ['TEXTURE_BINDING_2D', 'TEXTURE_BINDING_CUBE_MAP', 'TEXTURE_BINDING_3D', 'TEXTURE_BINDING_2D_ARRAY'],
    'vao': ['VERTEX_ARRAY_BINDING'],
    'sampler': ['SAMPLER_BINDING'],
    'tf': ['TRANSFORM_FEEDBACK_BINDING'],
}

# ---------------------------------------------------------------------------
# Generated entry points.
# ---------------------------------------------------------------------------
FUNCS = [
    # --- WebGL 1 core ---
    ('activeTexture', 'glActiveTexture', 'e', 'v'),
    ('attachShader', 'glAttachShader', 'o:program o:shader', 'v'),
    ('bindAttribLocation', 'glBindAttribLocation', 'o:program u str', 'v'),
    ('bindBuffer', 'glBindBuffer', 'e o:buffer', 'v'),
    ('bindFramebuffer', 'glBindFramebuffer', 'e o:framebuffer', 'v'),
    ('bindRenderbuffer', 'glBindRenderbuffer', 'e o:renderbuffer', 'v'),
    ('bindTexture', 'glBindTexture', 'e o:texture', 'v'),
    ('blendColor', 'glBlendColor', 'f f f f', 'v'),
    ('blendEquation', 'glBlendEquation', 'e', 'v'),
    ('blendEquationSeparate', 'glBlendEquationSeparate', 'e e', 'v'),
    ('blendFunc', 'glBlendFunc', 'e e', 'v'),
    ('blendFuncSeparate', 'glBlendFuncSeparate', 'e e e e', 'v'),
    ('checkFramebufferStatus', 'glCheckFramebufferStatus', 'e', 'e'),
    ('clear', 'glClear', 'u', 'v'),
    ('clearColor', 'glClearColor', 'f f f f', 'v'),
    ('clearDepth', 'glClearDepthf', 'f', 'v'),
    ('clearStencil', 'glClearStencil', 'i', 'v'),
    ('colorMask', 'glColorMask', 'b b b b', 'v'),
    ('compileShader', 'glCompileShader', 'o:shader', 'v'),
    ('copyTexImage2D', 'glCopyTexImage2D', 'e i e i i i i i', 'v'),
    ('copyTexSubImage2D', 'glCopyTexSubImage2D', 'e i i i i i i i', 'v'),
    ('createBuffer', 'gen:glGenBuffers', '', 'o:buffer'),
    ('createFramebuffer', 'gen:glGenFramebuffers', '', 'o:framebuffer'),
    ('createProgram', 'glCreateProgram', '', 'o:program'),
    ('createRenderbuffer', 'gen:glGenRenderbuffers', '', 'o:renderbuffer'),
    ('createShader', 'glCreateShader', 'e', 'o:shader'),
    ('createTexture', 'gen:glGenTextures', '', 'o:texture'),
    ('cullFace', 'glCullFace', 'e', 'v'),
    ('deleteBuffer', 'del:glDeleteBuffers', 'o:buffer', 'v'),
    ('deleteFramebuffer', 'del:glDeleteFramebuffers', 'o:framebuffer', 'v'),
    ('deleteProgram', 'glDeleteProgram', 'o:program', 'v'),
    ('deleteRenderbuffer', 'del:glDeleteRenderbuffers', 'o:renderbuffer', 'v'),
    ('deleteShader', 'glDeleteShader', 'o:shader', 'v'),
    ('deleteTexture', 'del:glDeleteTextures', 'o:texture', 'v'),
    ('depthFunc', 'glDepthFunc', 'e', 'v'),
    ('depthMask', 'glDepthMask', 'b', 'v'),
    ('depthRange', 'glDepthRangef', 'f f', 'v'),
    ('detachShader', 'glDetachShader', 'o:program o:shader', 'v'),
    ('disable', 'glDisable', 'e', 'v'),
    ('disableVertexAttribArray', 'glDisableVertexAttribArray', 'u', 'v'),
    ('drawArrays', 'glDrawArrays', 'e i i', 'v'),
    ('drawElements', 'glDrawElements', 'e i e ptr', 'v'),
    ('enable', 'glEnable', 'e', 'v'),
    ('enableVertexAttribArray', 'glEnableVertexAttribArray', 'u', 'v'),
    ('finish', 'glFinish', '', 'v'),
    ('flush', 'glFlush', '', 'v'),
    ('framebufferRenderbuffer', 'glFramebufferRenderbuffer', 'e e e o:renderbuffer', 'v'),
    ('framebufferTexture2D', 'glFramebufferTexture2D', 'e e e o:texture i', 'v'),
    ('frontFace', 'glFrontFace', 'e', 'v'),
    ('generateMipmap', 'glGenerateMipmap', 'e', 'v'),
    ('getAttribLocation', 'glGetAttribLocation', 'o:program str', 'i'),
    ('getBufferParameter', 'geti:glGetBufferParameteriv', 'e e', 'i'),
    ('getError', 'glGetError', '', 'e'),
    ('getFramebufferAttachmentParameter', 'geti:glGetFramebufferAttachmentParameteriv', 'e e e', 'i'),
    ('getRenderbufferParameter', 'geti:glGetRenderbufferParameteriv', 'e e', 'i'),
    ('getProgramParameter', 'geti:glGetProgramiv', 'o:program e', 'i'),
    ('getShaderParameter', 'geti:glGetShaderiv', 'o:shader e', 'i'),
    ('hint', 'glHint', 'e e', 'v'),
    ('isBuffer', 'glIsBuffer', 'o:buffer', 'b'),
    ('isEnabled', 'glIsEnabled', 'e', 'b'),
    ('isFramebuffer', 'glIsFramebuffer', 'o:framebuffer', 'b'),
    ('isProgram', 'glIsProgram', 'o:program', 'b'),
    ('isRenderbuffer', 'glIsRenderbuffer', 'o:renderbuffer', 'b'),
    ('isShader', 'glIsShader', 'o:shader', 'b'),
    ('isTexture', 'glIsTexture', 'o:texture', 'b'),
    ('lineWidth', 'glLineWidth', 'f', 'v'),
    ('linkProgram', 'glLinkProgram', 'o:program', 'v'),
    ('pixelStorei', 'glPixelStorei', 'e i', 'v'),
    ('polygonOffset', 'glPolygonOffset', 'f f', 'v'),
    ('renderbufferStorage', 'glRenderbufferStorage', 'e e i i', 'v'),
    ('sampleCoverage', 'glSampleCoverage', 'f b', 'v'),
    ('scissor', 'glScissor', 'i i i i', 'v'),
    ('stencilFunc', 'glStencilFunc', 'e i u', 'v'),
    ('stencilFuncSeparate', 'glStencilFuncSeparate', 'e e i u', 'v'),
    ('stencilMask', 'glStencilMask', 'u', 'v'),
    ('stencilMaskSeparate', 'glStencilMaskSeparate', 'e u', 'v'),
    ('stencilOp', 'glStencilOp', 'e e e', 'v'),
    ('stencilOpSeparate', 'glStencilOpSeparate', 'e e e e', 'v'),
    ('texParameterf', 'glTexParameterf', 'e e f', 'v'),
    ('texParameteri', 'glTexParameteri', 'e e i', 'v'),
    ('uniform1f', 'glUniform1f', 'o:loc f', 'v'),
    ('uniform2f', 'glUniform2f', 'o:loc f f', 'v'),
    ('uniform3f', 'glUniform3f', 'o:loc f f f', 'v'),
    ('uniform4f', 'glUniform4f', 'o:loc f f f f', 'v'),
    ('uniform1i', 'glUniform1i', 'o:loc i', 'v'),
    ('uniform2i', 'glUniform2i', 'o:loc i i', 'v'),
    ('uniform3i', 'glUniform3i', 'o:loc i i i', 'v'),
    ('uniform4i', 'glUniform4i', 'o:loc i i i i', 'v'),
    ('uniform1fv', 'uv:glUniform1fv:f:1', 'o:loc', 'v'),
    ('uniform2fv', 'uv:glUniform2fv:f:2', 'o:loc', 'v'),
    ('uniform3fv', 'uv:glUniform3fv:f:3', 'o:loc', 'v'),
    ('uniform4fv', 'uv:glUniform4fv:f:4', 'o:loc', 'v'),
    ('uniform1iv', 'uv:glUniform1iv:i:1', 'o:loc', 'v'),
    ('uniform2iv', 'uv:glUniform2iv:i:2', 'o:loc', 'v'),
    ('uniform3iv', 'uv:glUniform3iv:i:3', 'o:loc', 'v'),
    ('uniform4iv', 'uv:glUniform4iv:i:4', 'o:loc', 'v'),
    ('uniformMatrix2fv', 'um:glUniformMatrix2fv:4', 'o:loc', 'v'),
    ('uniformMatrix3fv', 'um:glUniformMatrix3fv:9', 'o:loc', 'v'),
    ('uniformMatrix4fv', 'um:glUniformMatrix4fv:16', 'o:loc', 'v'),
    ('useProgram', 'glUseProgram', 'o:program', 'v'),
    ('validateProgram', 'glValidateProgram', 'o:program', 'v'),
    ('vertexAttrib1f', 'glVertexAttrib1f', 'u f', 'v'),
    ('vertexAttrib2f', 'glVertexAttrib2f', 'u f f', 'v'),
    ('vertexAttrib3f', 'glVertexAttrib3f', 'u f f f', 'v'),
    ('vertexAttrib4f', 'glVertexAttrib4f', 'u f f f f', 'v'),
    ('vertexAttrib1fv', 'av:glVertexAttrib1fv:f:1', 'u', 'v'),
    ('vertexAttrib2fv', 'av:glVertexAttrib2fv:f:2', 'u', 'v'),
    ('vertexAttrib3fv', 'av:glVertexAttrib3fv:f:3', 'u', 'v'),
    ('vertexAttrib4fv', 'av:glVertexAttrib4fv:f:4', 'u', 'v'),
    ('vertexAttribPointer', 'glVertexAttribPointer', 'u i e b i ptr', 'v'),
    ('viewport', 'glViewport', 'i i i i', 'v'),
    # --- WebGL 2 ---
    ('copyBufferSubData', 'glCopyBufferSubData', 'e e p p p', 'v'),
    ('blitFramebuffer', 'glBlitFramebuffer', 'i i i i i i i i u e', 'v'),
    ('framebufferTextureLayer', 'glFramebufferTextureLayer', 'e e o:texture i i', 'v'),
    ('readBuffer', 'glReadBuffer', 'e', 'v'),
    ('renderbufferStorageMultisample', 'glRenderbufferStorageMultisample', 'e i e i i', 'v'),
    ('texStorage2D', 'glTexStorage2D', 'e i e i i', 'v'),
    ('texStorage3D', 'glTexStorage3D', 'e i e i i i', 'v'),
    ('copyTexSubImage3D', 'glCopyTexSubImage3D', 'e i i i i i i i i', 'v'),
    ('getFragDataLocation', 'glGetFragDataLocation', 'o:program str', 'i'),
    ('uniform1ui', 'glUniform1ui', 'o:loc u', 'v'),
    ('uniform2ui', 'glUniform2ui', 'o:loc u u', 'v'),
    ('uniform3ui', 'glUniform3ui', 'o:loc u u u', 'v'),
    ('uniform4ui', 'glUniform4ui', 'o:loc u u u u', 'v'),
    ('uniform1uiv', 'uv:glUniform1uiv:u:1', 'o:loc', 'v'),
    ('uniform2uiv', 'uv:glUniform2uiv:u:2', 'o:loc', 'v'),
    ('uniform3uiv', 'uv:glUniform3uiv:u:3', 'o:loc', 'v'),
    ('uniform4uiv', 'uv:glUniform4uiv:u:4', 'o:loc', 'v'),
    ('uniformMatrix3x2fv', 'um:glUniformMatrix3x2fv:6', 'o:loc', 'v'),
    ('uniformMatrix4x2fv', 'um:glUniformMatrix4x2fv:8', 'o:loc', 'v'),
    ('uniformMatrix2x3fv', 'um:glUniformMatrix2x3fv:6', 'o:loc', 'v'),
    ('uniformMatrix4x3fv', 'um:glUniformMatrix4x3fv:12', 'o:loc', 'v'),
    ('uniformMatrix2x4fv', 'um:glUniformMatrix2x4fv:8', 'o:loc', 'v'),
    ('uniformMatrix3x4fv', 'um:glUniformMatrix3x4fv:12', 'o:loc', 'v'),
    ('vertexAttribI4i', 'glVertexAttribI4i', 'u i i i i', 'v'),
    ('vertexAttribI4iv', 'av:glVertexAttribI4iv:i:4', 'u', 'v'),
    ('vertexAttribI4ui', 'glVertexAttribI4ui', 'u u u u u', 'v'),
    ('vertexAttribI4uiv', 'av:glVertexAttribI4uiv:u:4', 'u', 'v'),
    ('vertexAttribIPointer', 'glVertexAttribIPointer', 'u i e i ptr', 'v'),
    ('vertexAttribDivisor', 'glVertexAttribDivisor', 'u u', 'v'),
    ('drawArraysInstanced', 'glDrawArraysInstanced', 'e i i i', 'v'),
    ('drawElementsInstanced', 'glDrawElementsInstanced', 'e i e ptr i', 'v'),
    ('drawRangeElements', 'glDrawRangeElements', 'e u u i e ptr', 'v'),
    ('clearBufferfv', 'cb:glClearBufferfv:f', 'e i', 'v'),
    ('clearBufferiv', 'cb:glClearBufferiv:i', 'e i', 'v'),
    ('clearBufferuiv', 'cb:glClearBufferuiv:u', 'e i', 'v'),
    ('clearBufferfi', 'glClearBufferfi', 'e i f i', 'v'),
    ('createQuery', 'gen:glGenQueries', '', 'o:query'),
    ('deleteQuery', 'del:glDeleteQueries', 'o:query', 'v'),
    ('isQuery', 'glIsQuery', 'o:query', 'b'),
    ('beginQuery', 'glBeginQuery', 'e o:query', 'v'),
    ('endQuery', 'glEndQuery', 'e', 'v'),
    ('getQuery', 'geti:glGetQueryiv', 'e e', 'o:query'),
    ('createSampler', 'gen:glGenSamplers', '', 'o:sampler'),
    ('deleteSampler', 'del:glDeleteSamplers', 'o:sampler', 'v'),
    ('isSampler', 'glIsSampler', 'o:sampler', 'b'),
    ('bindSampler', 'glBindSampler', 'u o:sampler', 'v'),
    ('samplerParameteri', 'glSamplerParameteri', 'o:sampler e i', 'v'),
    ('samplerParameterf', 'glSamplerParameterf', 'o:sampler e f', 'v'),
    ('createTransformFeedback', 'gen:glGenTransformFeedbacks', '', 'o:tf'),
    ('deleteTransformFeedback', 'del:glDeleteTransformFeedbacks', 'o:tf', 'v'),
    ('isTransformFeedback', 'glIsTransformFeedback', 'o:tf', 'b'),
    ('bindTransformFeedback', 'glBindTransformFeedback', 'e o:tf', 'v'),
    ('beginTransformFeedback', 'glBeginTransformFeedback', 'e', 'v'),
    ('endTransformFeedback', 'glEndTransformFeedback', '', 'v'),
    ('pauseTransformFeedback', 'glPauseTransformFeedback', '', 'v'),
    ('resumeTransformFeedback', 'glResumeTransformFeedback', '', 'v'),
    ('bindBufferBase', 'glBindBufferBase', 'e u o:buffer', 'v'),
    ('bindBufferRange', 'glBindBufferRange', 'e u o:buffer p p', 'v'),
    ('getUniformBlockIndex', 'glGetUniformBlockIndex', 'o:program str', 'u'),
    ('uniformBlockBinding', 'glUniformBlockBinding', 'o:program u u', 'v'),
    ('createVertexArray', 'gen:glGenVertexArrays', '', 'o:vao'),
    ('deleteVertexArray', 'del:glDeleteVertexArrays', 'o:vao', 'v'),
    ('isVertexArray', 'glIsVertexArray', 'o:vao', 'b'),
    ('bindVertexArray', 'glBindVertexArray', 'o:vao', 'v'),
    # --- extension entry points (resolved through eglGetProcAddress; present only when the driver has them) ---
    ('framebufferTextureMultiviewOVR', 'ext:framebufferTextureMultiviewOVR', 'e e o:texture i i i', 'v', 'nojs'),
    ('framebufferTextureMultisampleMultiviewOVR', 'ext:framebufferTextureMultisampleMultiviewOVR', 'e e o:texture i i i i', 'v', 'nojs'),
    ('renderbufferStorageMultisampleEXT', 'ext:renderbufferStorageMultisampleEXT', 'e i e i i', 'v', 'nojs'),
    ('framebufferTexture2DMultisampleEXT', 'ext:framebufferTexture2DMultisampleEXT', 'e e e o:texture i i', 'v', 'nojs'),
    ('queryCounterEXT', 'ext:queryCounterEXT', 'o:query e', 'v', 'nojs'),
    ('clipControlEXT', 'ext:clipControlEXT', 'e e', 'v', 'nojs'),
    ('enableiOES', 'ext:enableiOES', 'e u', 'v', 'nojs'),
    ('disableiOES', 'ext:disableiOES', 'e u', 'v', 'nojs'),
    ('blendEquationiOES', 'ext:blendEquationiOES', 'u e', 'v', 'nojs'),
    ('blendEquationSeparateiOES', 'ext:blendEquationSeparateiOES', 'u e e', 'v', 'nojs'),
    ('blendFunciOES', 'ext:blendFunciOES', 'u e e', 'v', 'nojs'),
    ('blendFuncSeparateiOES', 'ext:blendFuncSeparateiOES', 'u e e e e', 'v', 'nojs'),
    ('colorMaskiOES', 'ext:colorMaskiOES', 'u b b b b', 'v', 'nojs'),
]

# Hand-written natives in webgl_bind.cpp (name, JS-visible signature on __native.gl). Listed for the count and the README.
HAND_NATIVES = [
    ('extensions', '(): string — the GL_EXTENSIONS string'),
    ('getString', '(name): string|null — glGetString'),
    ('getParameter', '(pname): number|boolean|string|Int32Array|Float32Array|Uint32Array|boolean[]|null — kind per webgl_table.PARAMS; unknown pnames are read as one GLint and null on INVALID_ENUM'),
    ('getIndexedParameter', '(target, index): number'),
    ('getInternalformatParameter', '(target, internalformat, pname): Int32Array|null'),
    ('bufferData', '(target, sizeOrData, usage, srcOffset=0, length=0)'),
    ('bufferSubData', '(target, dstByteOffset, data, srcOffset=0, length=0)'),
    ('getBufferSubData', '(target, srcByteOffset, dst, dstOffset=0, length=0)'),
    ('texImage2D', '(target, level, internalformat, width, height, border, format, type, pixels|pboOffset|null, srcOffset=0)'),
    ('texSubImage2D', '(target, level, xoffset, yoffset, width, height, format, type, pixels|pboOffset|null, srcOffset=0)'),
    ('texImage3D', '(target, level, internalformat, width, height, depth, border, format, type, pixels|pboOffset|null, srcOffset=0)'),
    ('texSubImage3D', '(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels|pboOffset|null, srcOffset=0)'),
    ('compressedTexImage2D', '(target, level, internalformat, width, height, border, data|imageSize, srcOffset|pboOffset=0, srcLengthOverride=0)'),
    ('compressedTexSubImage2D', '(target, level, xoffset, yoffset, width, height, format, data|imageSize, srcOffset|pboOffset=0, srcLengthOverride=0)'),
    ('compressedTexImage3D', '(target, level, internalformat, width, height, depth, border, data|imageSize, srcOffset|pboOffset=0, srcLengthOverride=0)'),
    ('compressedTexSubImage3D', '(target, level, xoffset, yoffset, zoffset, width, height, depth, format, data|imageSize, srcOffset|pboOffset=0, srcLengthOverride=0)'),
    ('readPixels', '(x, y, width, height, format, type, dst|pboOffset, dstOffset=0)'),
    ('shaderSource', '(shader, source: string)'),
    ('getShaderInfoLog', '(shader): string'),
    ('getProgramInfoLog', '(program): string'),
    ('getShaderPrecisionFormat', '(shadertype, precisiontype): {rangeMin, rangeMax, precision}'),
    ('getActiveUniform', '(program, index): {size, type, name}|null'),
    ('getActiveAttrib', '(program, index): {size, type, name}|null'),
    ('getAttachedShaders', '(program): number[] (shader names)'),
    ('getUniformLocation', '(program, name): number (-1 = none)'),
    ('getUniformLocations', '(program): [name, location, ...] (every active uniform in one GL-thread round trip; arrays bare and by element)'),
    ('getUniform', '(program, location): number|boolean|Float32Array|Int32Array|Uint32Array|boolean[]|null'),
    ('getUniformIndices', '(program, names: string[]): number[]'),
    ('getActiveUniforms', '(program, indices: number[], pname): number[]|boolean[]'),
    ('getActiveUniformBlockParameter', '(program, blockIndex, pname): number|boolean|Uint32Array'),
    ('getActiveUniformBlockName', '(program, blockIndex): string|null'),
    ('getTransformFeedbackVarying', '(program, index): {size, type, name}|null'),
    ('transformFeedbackVaryings', '(program, varyings: string[], bufferMode)'),
    ('getTexParameter', '(target, pname): number'),
    ('getSamplerParameter', '(sampler, pname): number'),
    ('getVertexAttrib', '(index, pname): number|boolean|Float32Array|Int32Array|Uint32Array'),
    ('getVertexAttribOffset', '(index, pname): number'),
    ('getQueryParameter', '(query, pname): number (QUERY_RESULT reads 64-bit when EXT_disjoint_timer_query is present)'),
    ('drawBuffers', '(buffers: number[]|Uint32Array)'),
    ('invalidateFramebuffer', '(target, attachments: number[]|Uint32Array)'),
    ('invalidateSubFramebuffer', '(target, attachments: number[]|Uint32Array, x, y, width, height)'),
    ('fenceSync', '(condition, flags): number (sync handle, 0 = failed)'),
    ('isSync', '(handle): boolean'),
    ('deleteSync', '(handle)'),
    ('clientWaitSync', '(handle, flags, timeout): enum'),
    ('waitSync', '(handle, flags, timeout)'),
    ('getSyncParameter', '(handle, pname): number'),
    ('multiDrawArraysWEBGL', '(mode, firsts, firstsOffset, counts, countsOffset, drawcount, drawIdLoc)'),
    ('multiDrawElementsWEBGL', '(mode, counts, countsOffset, type, offsets, offsetsOffset, drawcount, drawIdLoc)'),
    ('multiDrawArraysInstancedWEBGL', '(mode, firsts, firstsOffset, counts, countsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)'),
    ('multiDrawElementsInstancedWEBGL', '(mode, counts, countsOffset, type, offsets, offsetsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)'),
    ('multiDrawElementsIndirect', '(mode, type, commands: Uint32Array (5 words per draw), drawcount, flags)'),
    ('multiDrawArraysIndirect', '(mode, commands: Uint32Array (4 words per draw), drawcount, flags)'),
    ('multiDrawInfo', '(): number (the reserved draw-id attribute location, -1 = no indirect path)'),
]

CTYPE = {'e': 'GLenum', 'u': 'GLuint', 'i': 'GLint', 'f': 'GLfloat', 'b': 'GLboolean', 'p': 'int64_t', 'ptr': 'int64_t'}
READER = {'e': 'argU32', 'u': 'argU32', 'i': 'argI32', 'f': 'argF', 'b': 'argBool', 'p': 'argI64', 'ptr': 'argI64'}
ELEM = {'f': ('GLfloat', 'Float32Array'), 'i': ('GLint', 'Int32Array'), 'u': ('GLuint', 'Uint32Array')}
SCR_T = {'f': 0, 'i': 1, 'u': 2}  # scratch array index in methods.gen.js
OBJ_KINDS = ('buffer', 'texture', 'program', 'shader', 'framebuffer', 'renderbuffer', 'vao', 'sampler', 'query', 'tf', 'loc')


def parse_args(args):
    out = []
    for k in args.split():
        if k.startswith('o:'):
            kind = k[2:]
            assert kind in OBJ_KINDS, k
            out.append(('o', kind))
        else:
            assert k in CTYPE or k == 'str', k
            out.append((k, None))
    return out


def ctype(kind, obj):
    if kind == 'o': return 'GLint' if obj == 'loc' else 'GLuint'
    if kind == 'str': return 'const char*'
    return CTYPE[kind]


def read_arg(kind, obj, i):
    """C++ statements reading argument i into p<i>; returns on error."""
    if kind == 'str':
        return ('  if (%d >= a.Length()) { wgl::typeError(iso, "WebGL: missing string argument"); return; }\n'
                '  v8::String::Utf8Value s%d(iso, a[%d]); const char* p%d = *s%d ? *s%d : "";\n' % (i, i, i, i, i, i))
    reader = 'argI32' if (kind == 'o' and obj == 'loc') else ('argU32' if kind == 'o' else READER[kind])
    return '  %s p%d; if (!wgl::%s(a, %d, p%d)) return;\n' % (ctype(kind, obj), i, reader, i, i)


# ---------------------------------------------------------------------------
# V8 fast API calls (v8-fast-api-calls.h, V8 10.0; on with --turbo-fast-api-calls,
# see host/js/engine.cpp). A row gets a CFunction beside its slow callback when
# every argument is a scalar or the one typed array of a uv/um/av/cb row. TurboFan
# then calls the C function straight from optimized JS: no FunctionCallbackInfo,
# no HandleScope, no V8 exit frame. The JS pass-through (methods.gen.js) passes
# the FULL arity with WebIDL-converted values (x>>>0, x|0, +x, !!x), because V8
# matches an overload by argument count and deopts the call site on a value that
# is not a number — the JS conversions make both impossible. Anything the fast
# function cannot handle (wrong typed-array kind, shared/detached buffer, a
# range that must raise INVALID_VALUE) falls back to the slow callback, which
# does the full checks; the fast function touches no GL state before deciding.
# ---------------------------------------------------------------------------
FAST_SCALAR = {'e': 'uint32_t', 'u': 'uint32_t', 'i': 'int32_t', 'f': 'float', 'b': 'bool', 'p': 'double', 'ptr': 'double'}
FAST_RET = {'v': 'void', 'b': 'bool', 'i': 'int32_t', 'u': 'uint32_t', 'e': 'uint32_t'}
FAST_TA = {'f': 'float', 'i': 'int32_t', 'u': 'uint32_t'}
JS_TA = {'f': 'Float32Array', 'i': 'Int32Array', 'u': 'Uint32Array'}


def fast_ok(row):
    js, gl, args, ret = row[:4]
    if gl.split(':')[0] in ('gen', 'del', 'geti'): return False
    if ret not in FAST_RET: return False
    return all(k != 'str' for k, _ in parse_args(args))


def fast_ctype(k, o):
    if k == 'o': return 'int32_t' if o == 'loc' else 'uint32_t'
    return FAST_SCALAR[k]


def fast_val(k, i):
    if k == 'b': return '(GLboolean)(p%d ? GL_TRUE : GL_FALSE)' % i
    if k in ('p',): return 'wgl::toI64(p%d)' % i
    if k == 'ptr': return '(const void*)(intptr_t)wgl::toI64(p%d)' % i
    return 'p%d' % i


# Entry points that draw into a framebuffer: each bumps wgl::drawCalls (the implicit clear follows a drawn frame).
DRAWS = {'clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements',
         'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer'}


def emit_fast(row):
    """The CFunction body for a row (fast_ok)."""
    js, gl, args, ret = row[:4]
    argl = parse_args(args)
    params = ['v8::Local<v8::Object>'] + ['%s p%d' % (fast_ctype(k, o), i) for i, (k, o) in enumerate(argl)]
    vals = [fast_val(k, i) for i, (k, _) in enumerate(argl)]
    out = []
    w = out.append
    w('#if HOST_FAST_API')
    kind = gl.split(':')[0] if ':' in gl and gl.split(':')[0] in ('uv', 'um', 'av', 'cb', 'ext') else ''
    if kind == 'uv':
        _, fn, et, cnt = gl.split(':'); ct = FAST_TA[et]
        params += ['const v8::FastApiTypedArray<%s>& d' % ct, 'uint32_t off', 'uint32_t len', 'v8::FastApiCallbackOptions& o']
        w('static void ff_%s(%s) {' % (js, ', '.join(params)))
        w('  if (glq::active() && !glq::onGLThread()) { o.fallback = true; return; }')
        w('  %s* e; size_t n; if (!wgl::fastSpan(d, off, len, %s, e, n)) { o.fallback = true; return; }' % (ct, cnt))
        w('  %s(p0, (GLsizei)(n / %s), (const GL%s*)e);' % (fn, cnt, {'f': 'float', 'i': 'int', 'u': 'uint'}[et]))
    elif kind == 'um':
        _, fn, cnt = gl.split(':')
        params += ['bool t', 'const v8::FastApiTypedArray<float>& d', 'uint32_t off', 'uint32_t len', 'v8::FastApiCallbackOptions& o']
        w('static void ff_%s(%s) {' % (js, ', '.join(params)))
        w('  if (glq::active() && !glq::onGLThread()) { o.fallback = true; return; }')
        w('  float* e; size_t n; if (!wgl::fastSpan(d, off, len, %s, e, n)) { o.fallback = true; return; }' % cnt)
        w('  %s(p0, (GLsizei)(n / %s), t ? GL_TRUE : GL_FALSE, e);' % (fn, cnt))
    elif kind == 'av':
        _, fn, et, cnt = gl.split(':'); ct = FAST_TA[et]
        params += ['const v8::FastApiTypedArray<%s>& d' % ct, 'v8::FastApiCallbackOptions& o']
        w('static void ff_%s(%s) {' % (js, ', '.join(params)))
        w('  if (glq::active() && !glq::onGLThread()) { o.fallback = true; return; }')
        w('  %s* e; if (d.length() < %s || !d.getStorageIfAligned(&e)) { o.fallback = true; return; }' % (ct, cnt))
        w('  %s(p0, (const GL%s*)e);' % (fn, {'f': 'float', 'i': 'int', 'u': 'uint'}[et]))
    elif kind == 'cb':
        _, fn, et = gl.split(':'); ct = FAST_TA[et]
        params += ['const v8::FastApiTypedArray<%s>& d' % ct, 'uint32_t off', 'v8::FastApiCallbackOptions& o']
        w('static void ff_%s(%s) {' % (js, ', '.join(params)))
        w('  if (glq::active() && !glq::onGLThread()) { o.fallback = true; return; }')
        w('  %s* e; size_t need = p0 == GL_COLOR ? 4 : 1;' % ct)
        w('  if (off > d.length() || d.length() - off < need || !d.getStorageIfAligned(&e)) { o.fallback = true; return; }')
        w('  %s(p0, p1, (const GL%s*)(e + off));' % (fn, {'f': 'float', 'i': 'int', 'u': 'uint'}[et]))
    else:
        w('static %s ff_%s(%s) {' % (FAST_RET[ret], js, ', '.join(params)))
        q = queue_kind(row)
        if js == 'pixelStorei': w('  wgl::pixelStore(p0, p1);')
        if q in ('plain', 'ext'):
            guard = '  if (glq::active() && !glq::onGLThread()' + ''.join(' && wgl::toI64(p%d) >= 0 && wgl::toI64(p%d) <= 0x7fffffff' % (i, i) for i, (k, _) in enumerate(argl) if k in ('p', 'ptr')) + ') {'
            words = [('(uint32_t)wgl::toI64(p%d)' % i) if k in ('p', 'ptr') else word_expr(k, o, 'p%d' % i) for i, (k, o) in enumerate(argl)]
            w(guard + ' glq::put(%s); return; }' % ', '.join(['%du' % queue_ops()[js]] + words))
        call = ('wgl::ext.%s(%s)' % (gl[4:], ', '.join(vals))) if kind == 'ext' else \
               ('wgl::takeError()' if js == 'getError' else '%s(%s)' % (gl, ', '.join(vals)))
        if not q and js != 'getError': call = 'GLQ_SYNC(%s)' % call
        if ret == 'v': w('  %s;' % call)
        elif ret == 'b': w('  return %s != GL_FALSE;' % call)
        elif ret == 'i': w('  return (int32_t)%s;' % call)
        else: w('  return (uint32_t)%s;' % call)
    if js in DRAWS: out.insert(len(out) - 1, '  ++wgl::drawCalls;')  # the direct path only: the decoder counts queued draws
    w('}')
    w('static const v8::CFunction cf_%s = v8::CFunction::Make(ff_%s);' % (js, js))
    w('#endif')
    return out


def js_arity(row):
    """Number of JS arguments the native takes (= the length of the pass-through's call)."""
    js, gl, args, ret = row[:4]
    n = len(parse_args(args))
    k = gl.split(':')[0]
    return n + {'uv': 3, 'um': 4, 'av': 1, 'cb': 2}.get(k, 0)


# ---------------------------------------------------------------------------
# The GL queue (host/gl/gl_queue.h, host.json gl.thread): every void row without a string argument is a command
# the host thread records and the GL thread executes. Each gets an opcode (from glq::kFirstGenerated, in table
# order), a case in wgl::execQueued (the GL thread's decoder, webgl_bind.gen.cpp), a queued branch in its C++
# native (taken when the queue is on and the caller is not the GL thread) and a JS encoder (queue.gen.js) that
# writes the command into the ring without a native call. Rows that answer something, take a string or wait
# (finish) stay synchronous: their GL call runs on the GL thread through GLQ_SYNC, in order with the queue.
# Every command word is 32 bits: enums/names/ints as is, floats by bit pattern, GLboolean 0/1, and GLintptr /
# byte offsets only in [0, 2^31) — anything else takes the synchronous path, which raises GL's own error.
# pixelStorei is queued from C++ only: the native keeps the UNPACK_/PACK_ shadow the hand-written upload calls
# size their client data with (wgl::pixelStore), instead of asking GL for it.
# ---------------------------------------------------------------------------
QUEUE_FIRST_OP = 64          # glq::kFirstGenerated
QUEUE_NO_JS = {'pixelStorei'}
GLQ_ELEM_N = {'uv': None, 'um': None}


def queue_kind(row):
    js, gl, args, ret = row[:4]
    if ret != 'v' or js == 'finish': return None
    if any(k == 'str' for k, _ in parse_args(args)): return None
    k = gl.split(':')[0] if ':' in gl else ''
    if k in ('gen', 'geti'): return None
    return k or 'plain'


def queue_ops():
    ops = {}
    n = QUEUE_FIRST_OP
    for row in FUNCS:
        if queue_kind(row): ops[row[0]] = n; n += 1
    return ops


def word_expr(k, o, name):
    """C++ expression: argument -> one uint32 ring word."""
    if k == 'f': return name                                   # glq::put stores a float by bit pattern
    if k == 'b': return '(uint32_t)(%s ? 1u : 0u)' % name
    return '(uint32_t)%s' % name


def dec_expr(k, o, idx):
    """C++ expression: ring word c[idx] -> the GL argument."""
    if k == 'f': return 'f[%d]' % idx
    if k == 'b': return '(GLboolean)c[%d]' % idx
    if k == 'i' or (k == 'o' and o == 'loc'): return '(GLint)c[%d]' % idx
    if k == 'p': return '(GLintptr)c[%d]' % idx
    if k == 'ptr': return '(const void*)(uintptr_t)c[%d]' % idx
    return 'c[%d]' % idx


GLES_ET = {'f': 'GLfloat', 'i': 'GLint', 'u': 'GLuint'}


# Calls that attach a texture to a framebuffer: the texture argument goes through wgl::xrTex (the pipelined
# swapchain image, webgl_bind.h). js -> (texture arg index, kind, extra args as C++ expressions over the args).
XR_ATTACH = {
    'framebufferTexture2D': (3, 0, lambda v: [v[2], v[4]]),
    'framebufferTextureLayer': (2, 1, lambda v: [v[3], v[4]]),
    'framebufferTextureMultiviewOVR': (2, 2, lambda v: [v[3], v[4], v[5]]),
    'framebufferTextureMultisampleMultiviewOVR': (2, 3, lambda v: [v[3], v[4], v[5], v[6]]),
    'framebufferTexture2DMultisampleEXT': (3, 4, lambda v: [v[2], v[4], v[5]]),
}


def xr_wrap(js, vals):
    """vals with the texture argument of an attaching call wrapped in wgl::xrTex."""
    if js not in XR_ATTACH: return vals
    ti, kind, extra = XR_ATTACH[js]
    vals = list(vals)
    vals[ti] = 'wgl::xrTex(%s, %s, %s, %d, %s)' % (vals[ti], vals[0], vals[1], kind, ', '.join('(GLint)(%s)' % e for e in extra(vals)))
    return vals


def emit_queue_decoder():
    """wgl::execQueued: one case per queued row; returns the command's length in words."""
    ops = queue_ops()
    out = ['uint32_t execQueued(const uint32_t* c) {', '  const float* f = (const float*)c; (void)f;', '  switch (c[0]) {']
    w = out.append
    for row in FUNCS:
        js, gl, args, ret = row[:4]
        q = queue_kind(row)
        if not q: continue
        argl = parse_args(args)
        vals = xr_wrap(js, [dec_expr(k, o, i + 1) for i, (k, o) in enumerate(argl)])
        n = len(argl)
        pre = '++wgl::drawCalls; ' if js in DRAWS else ''
        if q == 'plain':
            w('    case %d: %s%s(%s); return %d;  // %s' % (ops[js], pre, gl, ', '.join(vals), 1 + n, js))
        elif q == 'ext':
            w('    case %d: %swgl::ext.%s(%s); return %d;  // %s' % (ops[js], pre, gl[4:], ', '.join(vals), 1 + n, js))
        elif q == 'del':
            w('    case %d: { GLuint name = c[1]; %s(1, &name); return 2; }  // %s' % (ops[js], gl[4:], js))
        elif q == 'uv':
            _, fn, et, cnt = gl.split(':')
            w('    case %d: %s((GLint)c[1], (GLsizei)c[2], (const %s*)(c + 3)); return 3 + c[2] * %s;  // %s' % (ops[js], fn, GLES_ET[et], cnt, js))
        elif q == 'um':
            _, fn, cnt = gl.split(':')
            w('    case %d: %s((GLint)c[1], (GLsizei)c[3], (GLboolean)c[2], (const GLfloat*)(c + 4)); return 4 + c[3] * %s;  // %s' % (ops[js], fn, cnt, js))
        elif q == 'av':
            _, fn, et, cnt = gl.split(':')
            w('    case %d: %s(c[1], (const %s*)(c + 2)); return %d;  // %s' % (ops[js], fn, GLES_ET[et], 2 + int(cnt), js))
        elif q == 'cb':
            _, fn, et = gl.split(':')
            w('    case %d: %s%s(c[1], (GLint)c[2], (const %s*)(c + 3)); return 7;  // %s' % (ops[js], pre, fn, GLES_ET[et], js))
        else:
            raise ValueError(q)
    w('  }')
    w('  HOST_LOGE("gl queue: no generated op %u", c[0]); return 1;')
    w('}')
    return out


def emit_queue_branch(row, argl):
    """The queued branch of a C++ native (after its arguments are read): records the command and returns."""
    js, gl, args, ret = row[:4]
    q = queue_kind(row)
    op = queue_ops()[js]
    out = []
    w = out.append
    guard = '  if (glq::active() && !glq::onGLThread()'
    for i, (k, o) in enumerate(argl):
        if k in ('p', 'ptr'): guard += ' && p%d >= 0 && p%d <= 0x7fffffff' % (i, i)
    guard += ') {'
    if q in ('plain', 'ext', 'del'):
        words = [word_expr(k, o, 'p%d' % i) for i, (k, o) in enumerate(argl)]
        w(guard + ' glq::put(%s); return; }' % ', '.join(['%du' % op] + words))
    elif q == 'uv':
        _, fn, et, cnt = gl.split(':')
        w(guard)
        w('    const uint32_t n = (uint32_t)(v.len / 4), sz = 3 + n; const uint32_t pos = glq::reserve(sz); uint32_t* d = glq::data() + pos;')
        w('    d[0] = %du; d[1] = (uint32_t)p0; d[2] = n / %s; memcpy(d + 3, v.data, v.len); glq::commit(pos + sz); return;' % (op, cnt))
        w('  }')
    elif q == 'um':
        _, fn, cnt = gl.split(':')
        w(guard)
        w('    const uint32_t n = (uint32_t)(v.len / 4), sz = 4 + n; const uint32_t pos = glq::reserve(sz); uint32_t* d = glq::data() + pos;')
        w('    d[0] = %du; d[1] = (uint32_t)p0; d[2] = t ? 1u : 0u; d[3] = n / %s; memcpy(d + 4, v.data, v.len); glq::commit(pos + sz); return;' % (op, cnt))
        w('  }')
    elif q == 'av':
        _, fn, et, cnt = gl.split(':')
        w(guard)
        w('    const uint32_t pos = glq::reserve(%d); uint32_t* d = glq::data() + pos; d[0] = %du; d[1] = p0; memcpy(d + 2, v.data, %s * 4); glq::commit(pos + %d); return;' % (2 + int(cnt), op, cnt, 2 + int(cnt)))
        w('  }')
    elif q == 'cb':
        w(guard)
        w('    const uint32_t pos = glq::reserve(7); uint32_t* d = glq::data() + pos; d[0] = %du; d[1] = p0; d[2] = (uint32_t)p1; memset(d + 3, 0, 16); memcpy(d + 3, v.data, need); glq::commit(pos + 7); return;' % op)
        w('  }')
    return out


def emit_cpp():
    lines = []
    w = lines.append
    w('// GENERATED by host/gl/webgl_table.py — do not edit. The table is the spec.')
    w('#include "gl/webgl_bind.h"')
    w('#include "gl/gl_queue.h"')
    w('#include "core/log.h"')
    w('#include "js/bind.h"')
    w('#include <cstring>')
    w('')
    w('namespace host {')
    w('namespace {')
    w('using wgl::Args; using wgl::View;')
    w('')
    for row in FUNCS:
        js, gl, args, ret = row[:4]
        argl = parse_args(args)
        body = []
        b = body.append
        b('static void f_%s(const Args& a) {' % js)
        q = queue_kind(row)
        S = (lambda e: e) if q else (lambda e: 'GLQ_SYNC(%s)' % e)   # a queued row's direct call runs where it is
        needs_iso = any(k == 'str' for k, _ in argl) or any(x in gl for x in ('uv:', 'um:', 'av:', 'cb:'))
        if needs_iso: b('  v8::Isolate* iso = a.GetIsolate(); (void)iso;')
        for i, (k, o) in enumerate(argl):
            b(read_arg(k, o, i).rstrip('\n'))
        n = len(argl)
        plist = ', '.join(('(const void*)(intptr_t)p%d' % i) if k == 'ptr' else 'p%d' % i for i, (k, _) in enumerate(argl))
        if js == 'pixelStorei': b('  wgl::pixelStore(p0, p1);')
        if q in ('plain', 'ext', 'del'): body.extend(emit_queue_branch(row, argl))
        if js in DRAWS and q in ('plain', 'ext'): b('  ++wgl::drawCalls;')
        if js == 'getError':
            b('  wgl::retU(a, wgl::takeError());')
        elif gl.startswith('gen:'):
            b('  GLuint name = 0; %s; wgl::retU(a, name);' % S('%s(1, &name)' % gl[4:]))
        elif gl.startswith('del:'):
            b('  %s(1, &p0);' % gl[4:])
        elif gl.startswith('geti:'):
            b('  GLint out = 0; %s;' % S('%s(%s, &out)' % (gl[5:], plist)))
            b('  wgl::retI(a, out);')
        elif gl.startswith('uv:'):
            _, fn, et, cnt = gl.split(':')
            ct = ELEM[et][0]
            b('  View v; if (!wgl::argTyped(a, %d, v, wgl::TA::%s)) return; if (!wgl::window(a, v, %d, %d)) return;' % (n, JS_TA[et], n + 1, n + 2))
            b('  if (!wgl::wholeElements(v, sizeof(%s) * %s)) return;' % (ct, cnt))
            body.extend(emit_queue_branch(row, argl))
            b('  %s(p0, (GLsizei)(v.len / (sizeof(%s) * %s)), (const %s*)v.data);' % (fn, ct, cnt, ct))
        elif gl.startswith('um:'):
            _, fn, cnt = gl.split(':')
            b('  GLboolean t; if (!wgl::argBool(a, %d, t)) return;' % n)
            b('  View v; if (!wgl::argTyped(a, %d, v, wgl::TA::Float32Array)) return; if (!wgl::window(a, v, %d, %d)) return;' % (n + 1, n + 2, n + 3))
            b('  if (!wgl::wholeElements(v, sizeof(GLfloat) * %s)) return;' % cnt)
            body.extend(emit_queue_branch(row, argl))
            b('  %s(p0, (GLsizei)(v.len / (sizeof(GLfloat) * %s)), t, (const GLfloat*)v.data);' % (fn, cnt))
        elif gl.startswith('av:'):
            _, fn, et, cnt = gl.split(':')
            ct = ELEM[et][0]
            b('  View v; if (!wgl::argTyped(a, %d, v, wgl::TA::%s)) return;' % (n, JS_TA[et]))
            b('  if (v.len < sizeof(%s) * %s) { wgl::synthError(GL_INVALID_VALUE); return; }' % (ct, cnt))
            body.extend(emit_queue_branch(row, argl))
            b('  %s(p0, (const %s*)v.data);' % (fn, ct))
        elif gl.startswith('cb:'):
            _, fn, et = gl.split(':')
            ct = ELEM[et][0]
            b('  View v; if (!wgl::argTyped(a, %d, v, wgl::TA::%s)) return; if (!wgl::window(a, v, %d, -1)) return;' % (n, JS_TA[et], n + 1))
            b('  size_t need = (p0 == GL_COLOR ? 4 : 1) * sizeof(%s);' % ct)
            b('  if (v.len < need) { wgl::synthError(GL_INVALID_VALUE); return; }')
            body.extend(emit_queue_branch(row, argl))
            b('  ++wgl::drawCalls;')
            b('  %s(p0, p1, (const %s*)v.data);' % (fn, ct))
        elif gl.startswith('ext:'):
            b('  wgl::ext.%s(%s);' % (gl[4:], plist))
        else:
            call = S('%s(%s)' % (gl, plist))
            if ret == 'v': b('  %s;' % call)
            elif ret == 'b': b('  wgl::retB(a, %s != GL_FALSE);' % call)
            elif ret in ('e', 'u') or ret.startswith('o:'): b('  wgl::retU(a, (uint32_t)%s);' % call)
            elif ret == 'i': b('  wgl::retI(a, (int32_t)%s);' % call)
            elif ret == 'f': b('  wgl::ret(a, (double)%s);' % call)
            else: raise ValueError(ret)
        b('}')
        lines.extend(body)
        if fast_ok(row): lines.extend(emit_fast(row))
        w('')
    w('}  // namespace')
    w('')
    w('namespace wgl {')
    w('')
    w('ParamKind paramKind(GLenum pname) {')
    w('  switch (pname) {')
    kinds = {'b': 'Bool', 'i': 'Int', 'u': 'Uint', 'f': 'Float', 'i2': 'Int2', 'i4': 'Int4', 'f2': 'Float2', 'f4': 'Float4', 'b4': 'Bool4',
             's': 'String', 'i64': 'Int64', 'cf': 'CompressedFormats'}
    values = dict(CONSTANTS)
    for ext in EXT_CONSTANTS.values():
        for n, v in ext: values.setdefault(n, v)
    seen = set()
    for name, kind in PARAMS.items():
        v = values[name]
        if v in seen: continue  # aliases (FRAMEBUFFER_BINDING == DRAW_FRAMEBUFFER_BINDING)
        seen.add(v)
        w('    case 0x%04X: return ParamKind::%s;  // %s' % (v, kinds[kind], name))
    w('    default: return ParamKind::Unknown;')
    w('  }')
    w('}')
    w('')
    lines.extend(emit_queue_decoder())
    w('')
    w('int generatedFunctionCount() { return %d; }' % len(FUNCS))
    w('int generatedFastCount() { return %d; }' % sum(1 for r in FUNCS if fast_ok(r)))
    w('')
    w('void installGeneratedGL(v8::Local<v8::Context> ctx, v8::Local<v8::Object> gl, bool (*has)(const char*)) {')
    w('  (void)has;')
    for row in FUNCS:
        js, gl = row[0], row[1]
        cf = ('HOST_FAST(cf_%s)' % js) if fast_ok(row) else 'nullptr'
        stmt = 'wgl::installFn(ctx, gl, "%s", f_%s, %s, %d);' % (js, js, cf, js_arity(row))
        if gl.startswith('ext:'):
            w('  if (ext.%s) %s' % (gl[4:], stmt))
        else:
            w('  %s' % stmt)
    w('}')
    w('')
    w('}  // namespace wgl')
    w('}  // namespace host')
    return '\n'.join(lines) + '\n'


def js_unwrap(kind, name):
    if kind == 'loc': return '%s._loc' % name
    return '(%s ? %s._name : 0)' % (name, name)


JS_CONV = {'e': '%s >>> 0', 'u': '%s >>> 0', 'i': '%s | 0', 'f': '+%s', 'b': '!!%s', 'p': '+%s', 'ptr': '+%s'}


def emit_methods_js():
    lines = []
    w = lines.append
    w('// GENERATED by host/gl/webgl_table.py — do not edit. Pass-through methods of WebGL2RenderingContext:')
    w('// WebGL objects are unwrapped to their GL names here, create*/delete* keep the wrapper tables in context.js')
    w('// (_create / _release / _lookup), and a null WebGLUniformLocation is the no-op the spec asks for.')
    w('//')
    w('// Call-path rules (measured with apps/gl-bench):')
    w('// - N is a CONST whose prototype is the native object: `N.x` then folds to a constant in TurboFan (a stable')
    w('//   prototype holder), which is what lets V8 inline the native call — and use its fast-API C function')
    w('//   (webgl_bind.gen.cpp, cf_*). Calling through the native object itself would not fold: V8 keeps an object')
    w('//   with 238 API-defined properties in dictionary mode, and a mutable `let N` is never a constant.')
    w('// - Scalars go down WebIDL-converted (x>>>0 GLenum/GLuint, x|0 GLint, +x GLfloat/GLintptr, !!x GLboolean) and')
    w('//   with the FULL arity: V8 picks the fast function by argument count and would deopt on a non-number.')
    w('// - this._ensureCurrent() is a no-op (inlined away) until a second context exists; switch.js then makes it')
    w('//   one identity compare.')
    w("import { QUEUED, QUEUED_EXT, setQueue, FB, fbReset } from './queue.gen.js'")
    w('export { FB, fbReset }')
    w('export const N = {}')
    w('// With the GL thread on (host.json gl.thread: __native.gl.queue is its ring) the JS encoders sit between N and')
    w('// the native object: every N.x they define records a command, everything else reaches the native as before.')
    w('export let queued = false')
    w('export function setNative(n) {')
    w('  if (n.queue instanceof ArrayBuffer && typeof n.glqReserve === "function") {')
    w('    setQueue(n.queue, n); queued = true')
    w('    for (const k of QUEUED_EXT) if (typeof n[k] !== "function") QUEUED[k] = undefined')
    w('    Object.setPrototypeOf(QUEUED, n); Object.setPrototypeOf(N, QUEUED)')
    w('  } else Object.setPrototypeOf(N, n)')
    w('}')
    w('// A non-typed-array list (an Array, another typed array kind, an iterable) is copied into a scratch typed array')
    w('// (grown, never shrunk) instead of a new one per call; the copy covers [srcOffset, srcOffset + srcLength) and')
    w('// goes down as (scratch, 0, count). Typed arrays of the right kind always go down as they are: no copy.')
    w('const SCR = [new Float32Array(64), new Int32Array(64), new Uint32Array(64)]; const EMPTY = [new Float32Array(0), new Int32Array(0), new Uint32Array(0)]')
    w('const SCR_CTOR = [Float32Array, Int32Array, Uint32Array]; let SCR_N = 0')
    w('function scratch(t, d, off, len) { off = off >>> 0; const n = len ? len >>> 0 : Math.max(0, d.length - off); SCR_N = n; if (n === 0) return EMPTY[t]; let s = SCR[t]; if (s.length < n) s = SCR[t] = new SCR_CTOR[t](Math.max(n, s.length * 2)); for (let i = 0; i < n; i++) s[i] = d[off + i]; return s }')
    w('function list(t, d, off, len) {')
    w('  if (Array.isArray(d) || (ArrayBuffer.isView(d) && !(d instanceof DataView))) return scratch(t, d, off, len)')
    w("  if (d !== null && typeof d === 'object' && typeof d[Symbol.iterator] === 'function') return scratch(t, Array.from(d), off, len)")
    w("  throw new TypeError('WebGL: expected a ' + SCR_CTOR[t].name + ' or a sequence of numbers')")
    w('}')
    w('export const GENERATED_METHOD_NAMES = [%s]' % ', '.join("'%s'" % r[0] for r in FUNCS if 'nojs' not in r[4:]))
    w('export const generatedMethods = {')
    for row in FUNCS:
        js, gl, args, ret = row[:4]
        if 'nojs' in row[4:]: continue
        argl = parse_args(args)
        fast = fast_ok(row)
        names = []
        for i, (k, o) in enumerate(argl):
            names.append(o if k == 'o' else 'a%d' % i)
        pre = 'this._ensureCurrent(); '
        call_args = []
        for (k, o), nm in zip(argl, names):
            if k == 'o':
                if o == 'loc': pre += 'if (loc === null || loc === undefined) return; '
                call_args.append(js_unwrap(o, nm))
            elif fast and k in JS_CONV:
                call_args.append(JS_CONV[k] % nm)
            else:
                call_args.append(nm)
        extra = []
        if gl.startswith('uv:'):
            _, fn, et, cnt = gl.split(':')
            params_x = ['data', 'srcOffset', 'srcLength']
            extra = ['data', 'srcOffset >>> 0', 'srcLength >>> 0']
            pre += 'if (!(data instanceof %s)) { data = list(%d, data, srcOffset, srcLength); srcOffset = 0; srcLength = SCR_N } ' % (ELEM[et][1], SCR_T[et])
        elif gl.startswith('um:'):
            params_x = ['transpose', 'data', 'srcOffset', 'srcLength']
            extra = ['!!transpose', 'data', 'srcOffset >>> 0', 'srcLength >>> 0']
            pre += 'if (!(data instanceof Float32Array)) { data = list(0, data, srcOffset, srcLength); srcOffset = 0; srcLength = SCR_N } '
        elif gl.startswith('av:'):
            _, fn, et, cnt = gl.split(':')
            params_x = ['values']
            extra = ['values']
            # too short: a fresh short array, so the native's length check sees it (INVALID_VALUE)
            pre += 'if (!(values instanceof %s)) { values = list(%d, values, 0, 0); if (SCR_N < %s) values = EMPTY[%d] } ' % (ELEM[et][1], SCR_T[et], cnt, SCR_T[et])
        elif gl.startswith('cb:'):
            _, fn, et = gl.split(':')
            params_x = ['values', 'srcOffset']
            extra = ['values', 'srcOffset >>> 0']
            pre += 'if (!(values instanceof %s)) { values = list(%d, values, srcOffset, 0); srcOffset = 0; if (SCR_N < (a0 === 0x1800 ? 4 : 1)) values = EMPTY[%d] } ' % (ELEM[et][1], SCR_T[et], SCR_T[et])
        else:
            params_x = []
        params = names + params_x
        call = 'N.%s(%s)' % (js, ', '.join(call_args + extra))
        if gl.startswith('gen:') or (ret.startswith('o:') and not gl.startswith('geti:')):
            kind = ret[2:]
            body = "return this._create('%s', %s)" % (kind, call)
        elif gl.startswith('del:') or js in ('deleteProgram', 'deleteShader'):
            kind = argl[0][1]
            body = "if (!%s || %s._name === 0) return; %s; this._release('%s', %s)" % (names[0], names[0], call, kind, names[0])
        elif ret.startswith('o:'):
            body = "return this._lookup('%s', %s)" % (ret[2:], call)
        elif ret == 'v':
            body = call
        else:
            body = 'return ' + call
        w('  %s(%s) { %s%s },' % (js, ', '.join(params), pre, body))
    w('}')
    return '\n'.join(lines) + '\n'


def pub(end, js):
    """JS that records the producer position `end` and publishes it at a draw (or a clear / blit) or once 1024
    words are pending; between those the GL thread is not told, so a command costs plain stores only."""
    if js in DRAWS: return 'I[2] = %s; Atomics.store(I, 0, %s); if (Atomics.load(I, 32) !== 0) WK()' % (end, end)
    return 'const e = %s; I[2] = e; if (e - I[0] > 1024 || e < I[0]) { Atomics.store(I, 0, e); if (Atomics.load(I, 32) !== 0) WK() }' % end


def emit_queue_js():
    """queue.gen.js: the JS encoders. An object literal (fast properties) whose methods shadow the natives of the
    same name: methods.gen.js puts it between N and __native.gl when the GL thread is on, so every caller of N.x
    (the pass-throughs, context.js, switch.js, extensions.js) records into the ring instead of calling native."""
    ops = queue_ops()
    lines = []
    w = lines.append
    w('// GENERATED by host/gl/webgl_table.py — do not edit. GL commands recorded straight into the GL thread\'s ring')
    w('// (host/gl/gl_queue.h): I/F view the ring\'s ArrayBuffer (ctrl words, then data from word 64). A command is')
    w('// written at the producer position W = I[0], published with Atomics.store, and the GL thread is woken (WK, a')
    w('// futex wake) only when it is parked (I[32]). LIMIT = I[1] is the end of the free run known to fit; past it,')
    w('// RS(n) (native) finds room, waiting or wrapping. Anything off the fast path (an error the native must raise,')
    w('// a range or kind the encoder does not handle) goes to the native NP.x, which runs synchronously in order.')
    w('let I = null, F = null, RS = null, WK = null, NP = null')
    w('// The draw / read framebuffer bindings as recorded (every JS bind goes through bindFramebuffer below), so the')
    w('// runtime can know them without a getParameter round trip (context.js _boundFb). The host binds 0 at the end')
    w('// of every XR frame: the runtime calls fbReset() when the next one starts.')
    w('export const FB = new Int32Array(2)')
    w('export function fbReset() { FB[0] = 0; FB[1] = 0 }')
    w('export function setQueue(buf, native) { I = new Int32Array(buf); F = new Float32Array(buf); NP = native; RS = (n) => native.glqReserve(n); WK = () => native.glqWake() }')
    w('export const QUEUED = {')
    for row in FUNCS:
        js, gl, args, ret = row[:4]
        q = queue_kind(row)
        if not q or js in QUEUE_NO_JS: continue
        op = ops[js]
        argl = parse_args(args)
        names = ['a%d' % i for i in range(len(argl))]
        checks = []
        stores = []
        for i, (k, o) in enumerate(argl):
            nm = names[i]
            if k == 'f': stores.append('F[o + %d] = %s' % (i + 1, nm))
            elif k == 'b': stores.append('I[o + %d] = %s ? 1 : 0' % (i + 1, nm))
            else:
                if k in ('p', 'ptr'): checks.append('!(%s >= 0 && %s <= 2147483647)' % (nm, nm))
                stores.append('I[o + %d] = %s' % (i + 1, nm))
        if q in ('plain', 'ext', 'del'):
            params = names
            size = 1 + len(argl)
            pre = ('if (%s) return NP.%s(%s); ' % (' || '.join(checks), js, ', '.join(params))) if checks else ''
            if js == 'bindFramebuffer': pre += 'if (a0 === 0x8CA8) FB[1] = a1; else if (a0 === 0x8CA9) FB[0] = a1; else if (a0 === 0x8D40) { FB[0] = a1; FB[1] = a1 } '
            body = '%slet w = I[2]; if (w + %d > I[1]) w = RS(%d); const o = w + 64; I[o] = %d; %s; %s' % (
                pre, size, size, op, '; '.join(stores) if stores else 'void 0', pub('w + %d' % size, js))
        elif q in ('uv', 'um'):
            if q == 'uv':
                _, fn, et, cnt = gl.split(':'); hdr = 3
                params = names + ['d', 'off', 'len']
                ta = JS_TA[et]; dst = 'F' if et == 'f' else 'I'
                hstore = 'I[o + 1] = a0; I[o + 2] = n / %s' % cnt
            else:
                _, fn, cnt = gl.split(':'); hdr = 4; et = 'f'
                params = names + ['t', 'd', 'off', 'len']
                ta = 'Float32Array'; dst = 'F'
                hstore = 'I[o + 1] = a0; I[o + 2] = t ? 1 : 0; I[o + 3] = n / %s' % cnt
            call = 'NP.%s(%s)' % (js, ', '.join(params))
            body = ('if (!(d instanceof %s)) return %s; off = off >>> 0; len = len >>> 0; const tot = d.length, n = len === 0 ? tot - off : len; '
                    'if (off > tot || n <= 0 || off + n > tot || n %% %s !== 0 || n > 65536) return %s; '
                    'const sz = %d + n; let w = I[2]; if (w + sz > I[1]) w = RS(sz); const o = w + 64; I[o] = %d; %s; '
                    'if (n <= 16) { for (let i = 0; i < n; i++) %s[o + %d + i] = d[off + i] } else %s.set(off === 0 && n === tot ? d : d.subarray(off, off + n), o + %d); '
                    + pub('w + sz', js)) % (
                        ta, call, cnt, call, hdr, op, hstore, dst, hdr, dst, hdr)
        elif q == 'av':
            _, fn, et, cnt = gl.split(':'); cnt = int(cnt)
            params = names + ['d']
            dst = 'F' if et == 'f' else 'I'
            call = 'NP.%s(%s)' % (js, ', '.join(params))
            body = ('if (!(d instanceof %s) || d.length < %d) return %s; let w = I[2]; if (w + %d > I[1]) w = RS(%d); const o = w + 64; I[o] = %d; I[o + 1] = a0; '
                    'for (let i = 0; i < %d; i++) %s[o + 2 + i] = d[i]; ' + pub('w + %d' % (2 + cnt), js)) % (
                        JS_TA[et], cnt, call, 2 + cnt, 2 + cnt, op, cnt, dst)
        elif q == 'cb':
            _, fn, et = gl.split(':')
            params = names + ['d', 'off']
            dst = 'F' if et == 'f' else 'I'
            call = 'NP.%s(%s)' % (js, ', '.join(params))
            body = ('if (!(d instanceof %s)) return %s; off = off >>> 0; const need = a0 === 0x1800 ? 4 : 1; if (off > d.length || d.length - off < need) return %s; '
                    'let w = I[2]; if (w + 7 > I[1]) w = RS(7); const o = w + 64; I[o] = %d; I[o + 1] = a0; I[o + 2] = a1; '
                    'for (let i = 0; i < 4; i++) %s[o + 3 + i] = i < need ? d[off + i] : 0; ' + pub('w + 7', js)) % (
                        JS_TA[et], call, call, op, dst)
        else:
            raise ValueError(q)
        w('  %s(%s) { %s },' % (js, ', '.join(params), body))
    w('}')
    w('// Opcode per queued call (the decoder is wgl::execQueued in webgl_bind.gen.cpp), for tests and tools.')
    w('export const OPS = { %s }' % ', '.join('%s: %d' % (r[0], ops[r[0]]) for r in FUNCS if r[0] in ops))
    w('// Encoders for extension entry points the driver may not have: dropped when the native is absent.')
    w('export const QUEUED_EXT = [%s]' % ', '.join("'%s'" % r[0] for r in FUNCS if queue_kind(r) == 'ext' and r[0] not in QUEUE_NO_JS))
    return '\n'.join(lines) + '\n'


def emit_constants_js():
    lines = []
    w = lines.append
    w('// GENERATED by host/gl/webgl_table.py — do not edit.')
    w('export const GL = {')
    for n, v in CONSTANTS:
        w('  %s: %s,' % (n, ('0x%04X' % v) if v >= 0 else str(v)))
    w('}')
    w('// Constants that live on the extension objects, per WebGL extension name.')
    w('export const EXT = {')
    for ext, consts in EXT_CONSTANTS.items():
        w('  %s: { %s },' % (ext, ', '.join('%s: 0x%04X' % (n, v) for n, v in consts)))
    w('}')
    w('// getParameter pnames the JS side wraps into objects, per object kind.')
    w('export const PARAM_OBJECTS = {')
    values = dict(CONSTANTS)
    for kind, names in PARAM_OBJECTS.items():
        w('  %s: [%s],' % (kind, ', '.join('0x%04X' % values[n] for n in names)))
    w('}')
    return '\n'.join(lines) + '\n'


def check(include_dir):
    """Verifies every constant's value against the Khronos headers."""
    text = ''
    for rel in ('GLES3/gl32.h', 'GLES2/gl2ext.h'):
        with open(os.path.join(include_dir, rel)) as f: text += f.read()
    defs = {}
    for m in re.finditer(r'#define\s+GL_(\w+)\s+(0x[0-9A-Fa-f]+|\d+|0xFFFFFFFFull)', text):
        defs.setdefault(m.group(1), int(m.group(2).rstrip('ul'), 0))
    bad = 0; missing = []
    allc = list(CONSTANTS)
    for consts in EXT_CONSTANTS.values(): allc += consts
    webgl_only = {'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'CONTEXT_LOST_WEBGL', 'UNPACK_COLORSPACE_CONVERSION_WEBGL',
                  'BROWSER_DEFAULT_WEBGL', 'MAX_CLIENT_WAIT_TIMEOUT_WEBGL', 'UNMASKED_VENDOR_WEBGL', 'UNMASKED_RENDERER_WEBGL'}
    for n, v in allc:
        if n in webgl_only: continue  # no GL counterpart
        key = n
        if key.endswith('_WEBGL'):
            key = key[:-6]  # e.g. MAX_CLIP_DISTANCES_WEBGL -> GL_MAX_CLIP_DISTANCES_EXT / CLIP_DISTANCE0_EXT
            cands = [key + '_EXT', key]
        else:
            cands = [key]
        hv = None
        for c in cands:
            if c in defs: hv = defs[c]; break
        if hv is None: missing.append(n); continue
        if v < 0: v &= 0xFFFFFFFFFFFFFFFF
        if hv != v:
            print('MISMATCH %s: table 0x%X header 0x%X' % (n, v, hv)); bad += 1
    print('checked %d constants (%d WebGL-only skipped), %d mismatches, %d not in headers: %s' % (len(allc) - len(webgl_only), len(webgl_only), bad, len(missing), ' '.join(missing)))
    return bad == 0


def main():
    if len(sys.argv) > 2 and sys.argv[1] == '--check':
        sys.exit(0 if check(sys.argv[2]) else 1)
    names = [r[0] for r in FUNCS] + [h[0] for h in HAND_NATIVES]
    assert len(names) == len(set(names)), 'duplicate entry point'
    with open(GEN_CPP, 'w') as f: f.write(emit_cpp())
    with open(GEN_CONST_JS, 'w') as f: f.write(emit_constants_js())
    with open(GEN_METHODS_JS, 'w') as f: f.write(emit_methods_js())
    with open(GEN_QUEUE_JS, 'w') as f: f.write(emit_queue_js())
    print('wrote %s (%d generated + %d hand-written natives), %s (%d constants), %s' % (
        os.path.relpath(GEN_CPP, ROOT), len(FUNCS), len(HAND_NATIVES), os.path.relpath(GEN_CONST_JS, ROOT), len(CONSTANTS),
        os.path.relpath(GEN_METHODS_JS, ROOT)))


if __name__ == '__main__':
    main()
