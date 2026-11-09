# `__native.gl` — the WebGL2 binding's native surface (WP-04)

`__native.gl` is a flat object of GL entry points installed by
`host/gl/webgl_bind.cpp` (`installWebGL`, after the EGL context is current on
the host thread). `runtime/src/webgl/` wraps it as `WebGL2RenderingContext`;
nothing else should call it. 188 of its functions are generated from the table
in `host/gl/webgl_table.py` (`webgl_bind.gen.cpp`, committed; re-run
`python3 host/gl/webgl_table.py` after editing the table, `--check <ndk
sysroot include dir>` verifies every constant against the Khronos headers) and
50 are hand-written in `webgl_bind.cpp`; 238 in all, 13 of them extension
entry points that exist only when the driver has the GL extension.

## Conventions

- GL names (buffers, textures, …) and enums are plain numbers. `0` is "no
  object". The context's methods convert scalars the WebIDL way before the
  native sees them (`x>>>0`, `x|0`, `+x`, `!!x`). Called raw, the native reads
  `null`/`undefined` as 0 for any numeric argument and a boolean as 0/1;
  anything else (an object, a string) is a **TypeError**.
- Byte data is any `ArrayBufferView`, `ArrayBuffer` or `SharedArrayBuffer`,
  read by backing-store pointer + `byteOffset`, never copied (subarrays and
  DataViews included). WebGL2's `srcOffset` / `srcLength` / `srcLengthOverride`
  / `dstOffset` are counted in **elements** of the typed array (bytes for a
  DataView / ArrayBuffer); `0` / absent length = the rest. Out of range is a
  synthesized **INVALID_VALUE** (WebGL2), not an exception; so is a
  `uniform*v` list that is empty or not a whole number of elements, and a
  `vertexAttrib*v` / `clearBuffer*v` list that is too short. A pixel view too
  small for the image under the current PACK_/UNPACK_ state (`readPixels`,
  `tex[Sub]Image2D/3D`) is **INVALID_OPERATION** and GL is not called. A
  detached buffer reads as zero bytes (never dereferenced).
- A GL error never throws; `getError()` returns it, as in a browser. The
  binding's own (synthesized) error is reported first, one per getError.
- Call path (see `methods.gen.js` header): the JS pass-throughs call the native
  through a constant holder `N` (prototype = `__native.gl`) with WebIDL-converted
  scalars at full arity; 160 generated entry points also carry a V8 fast-API C
  function (`cf_*` in `webgl_bind.gen.cpp`, `--turbo-fast-api-calls`) that
  optimized JS calls directly. `this._ensureCurrent()` opens every method: free
  until a second context exists, one compare after.
- Strings go in as JS strings and come back as JS strings.
- Nothing allocates per call beyond V8 handles, except the `get*` queries that
  return containers (typed arrays, objects) and the string-list calls
  (`getUniformIndices`, `transformFeedbackVaryings`), none of which is on a
  frame path.

## Generated entry points (same name and argument order as WebGL)

Every row of `FUNCS` in `webgl_table.py`. GL objects are passed as names; a
`WebGLUniformLocation` as its `GLint`. Typed-array forms:

| group | signature |
|---|---|
| `uniform{1..4}{f,i,ui}v` | `(loc, data, srcOffset = 0, srcLength = 0)` — count = elements / N |
| `uniformMatrix{2,3,4,2x3,3x2,2x4,4x2,3x4,4x3}fv` | `(loc, transpose, data, srcOffset = 0, srcLength = 0)` |
| `vertexAttrib{1..4}fv`, `vertexAttribI4iv`, `vertexAttribI4uiv` | `(index, values)` — needs N elements |
| `clearBuffer{fv,iv,uiv}` | `(buffer, drawbuffer, values, srcOffset = 0)` — 4 values for COLOR, 1 otherwise |
| `create*` | `()` → name (`createShader(type)`) |
| `delete*`, `is*` | `(name)` |
| `getBufferParameter`, `getRenderbufferParameter`, `getFramebufferAttachmentParameter`, `getProgramParameter`, `getShaderParameter`, `getQuery` | one `GLint` out-parameter, returned as a number |
| `drawElements`, `drawElementsInstanced`, `drawRangeElements`, `vertexAttribPointer`, `vertexAttribIPointer` | the byte offset is a number |

Extension entry points (present only when resolved through `eglGetProcAddress`
AND the GL extension is in the extension string):
`framebufferTextureMultiviewOVR(target, attachment, texture, level, baseViewIndex, numViews)`,
`framebufferTextureMultisampleMultiviewOVR(target, attachment, texture, level, samples, baseViewIndex, numViews)`,
`renderbufferStorageMultisampleEXT(target, samples, internalformat, width, height)`,
`framebufferTexture2DMultisampleEXT(target, attachment, textarget, texture, level, samples)`,
`queryCounterEXT(query, target)`, `clipControlEXT(origin, depth)`,
`enableiOES(target, index)`, `disableiOES`, `blendEquationiOES(buf, mode)`,
`blendEquationSeparateiOES(buf, rgb, alpha)`, `blendFunciOES(buf, src, dst)`,
`blendFuncSeparateiOES(buf, srcRGB, dstRGB, srcAlpha, dstAlpha)`,
`colorMaskiOES(buf, r, g, b, a)` (the `iOES` seven also appear on a GLES 3.2
context through the core entry points).

## The GL thread (WP-23, host.json `gl.thread`)

When the host runs GL on a thread of its own, `__native.gl.queue` is an `ArrayBuffer` over the command ring
(`host/gl/gl_queue.h`) and `glqReserve(n)` / `glqWake()` are its two natives. `setNative` (methods.gen.js) then
puts `QUEUED` (queue.gen.js, generated) between `N` and the native object: every void call without a string
argument is written into the ring by JS — opcode, then one 32-bit word per argument, floats by bit pattern, the
`*v` forms' elements copied — with plain stores at the unpublished position `I[2]`; a draw (or clear / blit), or
1024 pending words, publishes it with one `Atomics.store` and wakes the GL thread only when it is parked. With
pipelined frames (`gl.pipeline`) the frame's colour texture is the constant name `0x7FFF0001`, resolved by the GL
thread to the image it acquired.
An encoder hands anything off its fast path (a range the native must reject, a negative or 64-bit offset, a
typed array of another kind) to the native, which raises the same error as before, in order. Everything that
answers something (`get*`, `is*`, `create*`, `checkFramebufferStatus`, `getError`, `readPixels`) is a native that
runs on the GL thread synchronously, behind whatever was recorded: correct, but a page that calls one per frame
makes its thread wait for the GL thread to catch up. The runtime itself avoids that: the swapchain texture's
per-frame re-attach saves and restores bindings on the GL thread (`glqSaveFb` / `glqRestoreFb`), and the
framebuffer bindings JS records are tracked in `FB` (`_boundFb`) rather than read back. `glqSaveFb` /
`glqRestoreFb` exist only with the thread on.

## Hand-written entry points

```
extensions(): string                       the GL_EXTENSIONS string (parse once)
getString(name): string | null             glGetString
getParameter(pname)                        number | boolean | string | Int32Array | Float32Array | Uint32Array | boolean[] | null
                                           kind per webgl_table.PARAMS (VIEWPORT → Int32Array(4), COLOR_WRITEMASK → boolean[4],
                                           COMPRESSED_TEXTURE_FORMATS → Uint32Array, 64-bit limits → number, bindings → the NAME);
                                           a pname not in the table is read as one GLint and answers null on INVALID_ENUM
getIndexedParameter(target, index): number | boolean | boolean[]
getInternalformatParameter(target, internalformat, pname): Int32Array | null   (SAMPLES only)
bufferData(target, size | data | null, usage, srcOffset = 0, length = 0)
bufferSubData(target, dstByteOffset, data, srcOffset = 0, length = 0)
getBufferSubData(target, srcByteOffset, dst, dstOffset = 0, length = 0)       (glMapBufferRange + copy; GLES has no glGetBufferSubData)
texImage2D(target, level, internalformat, width, height, border, format, type, pixels | pboOffset | null, srcOffset = 0)
texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels | pboOffset | null, srcOffset = 0)
texImage3D(target, level, internalformat, width, height, depth, border, format, type, pixels | pboOffset | null, srcOffset = 0)
texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels | pboOffset | null, srcOffset = 0)
compressedTexImage2D(target, level, internalformat, width, height, border, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
compressedTexImage3D(target, level, internalformat, width, height, depth, border, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
compressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, data | imageSize, srcOffset | pboOffset = 0, srcLengthOverride = 0)
readPixels(x, y, width, height, format, type, dst | pboOffset, dstOffset = 0)
shaderSource(shader, source: string)
getShaderInfoLog(shader): string
getProgramInfoLog(program): string
getShaderPrecisionFormat(shadertype, precisiontype): { rangeMin, rangeMax, precision }
getActiveUniform(program, index): { size, type, name } | null
getActiveAttrib(program, index): { size, type, name } | null
getAttachedShaders(program): number[]
getUniformLocation(program, name): number           (-1 = none)
getUniform(program, location): number | boolean | Float32Array | Int32Array | Uint32Array | boolean[] | null
getUniformIndices(program, names: string[]): number[]
getActiveUniforms(program, indices: number[], pname): number[] | boolean[]
getActiveUniformBlockParameter(program, blockIndex, pname): number | boolean | Uint32Array
getActiveUniformBlockName(program, blockIndex): string | null
getTransformFeedbackVarying(program, index): { size, type, name } | null
transformFeedbackVaryings(program, varyings: string[], bufferMode)
getTexParameter(target, pname): number              (float for the LOD / anisotropy pnames)
getSamplerParameter(sampler, pname): number
getVertexAttrib(index, pname): number | Float32Array | Int32Array
getVertexAttribOffset(index, pname): number
getQueryParameter(query, pname): number             (QUERY_RESULT is 64-bit when GL_EXT_disjoint_timer_query is present)
drawBuffers(buffers: number[] | Uint32Array)        (≤ 16)
invalidateFramebuffer(target, attachments: number[] | Uint32Array)
invalidateSubFramebuffer(target, attachments, x, y, width, height)
fenceSync(condition, flags): number                 (a handle into the native GLsync table; 0 = failed)
isSync(handle): boolean
deleteSync(handle)
clientWaitSync(handle, flags, timeout): enum        (timeout < 0 = GL_TIMEOUT_IGNORED)
waitSync(handle, flags, timeout)
getSyncParameter(handle, pname): number
multiDrawArraysWEBGL(mode, firsts, firstsOffset, counts, countsOffset, drawcount, drawIdLoc)
multiDrawElementsWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, drawcount, drawIdLoc)
multiDrawArraysInstancedWEBGL(mode, firsts, firstsOffset, counts, countsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)
multiDrawElementsInstancedWEBGL(mode, counts, countsOffset, type, offsets, offsetsOffset, instanceCounts, instOffset, drawcount, drawIdLoc)
multiDrawElementsIndirect(mode, type, commands: Uint32Array (5 words per draw), drawcount, flags)
multiDrawArraysIndirect(mode, commands: Uint32Array (4 words per draw), drawcount, flags)
multiDrawInfo(): number                             (reserved draw-id attribute location; -1 = no indirect path)
```

Multi-draw has two paths. **Indirect** (GL_EXT_multi_draw_indirect +
GL_EXT_base_instance, ES 3.1; host.json `gl.multiDrawIndirect`, default on):
`multidraw.js` builds the DrawElements/DrawArraysIndirectCommand records from
the game's lists (read in place) into a grow-only Uint32Array, and
`multiDraw*Indirect` copies them into a host ring on
GL_DRAW_INDIRECT_BUFFER (persistent coherent map with GL_EXT_buffer_storage,
4 fenced segments; `gl.indirectUpload: "subdata"` = glBufferSubData with
orphan-on-wrap) and issues one `glMultiDraw*IndirectEXT`. gl_DrawID is then
the integer attribute `webgl_DrawID` at location MAX_VERTEX_ATTRIBS - 1
(`multiDrawInfo()`), bound before link and hidden from the game
(MAX_VERTEX_ATTRIBS, ACTIVE_ATTRIBUTES, getActiveAttrib, getAttribLocation,
getVertexAttrib): divisor 1 over a host buffer of 0..N-1, so baseInstance = i
reads i. Flags: 1 = enable that array for the call (it is disabled otherwise,
so plain draws read its constant 0), 2 = point the bound VAO's attribute at
the id buffer first (once per VAO). **Loop** (everything else: no extensions,
default VAO, game divisors with gl_DrawID, instanced variants with gl_DrawID,
ESSL 1.00 vertex shaders, misaligned/negative values): the lists are
`Int32Array`s (offsets in elements); the loop skips zero counts / instance
counts, sets the draw id before each draw — `glUniform1i(drawIdLoc, i)` when
`drawIdLoc >= 0`, `glVertexAttribI4i(attrib, i, 0, 0, 0)` when `drawIdLoc == -2`
(reset to 0 after) — and issues one `glDrawArrays` /
`glDrawElements[Instanced]` per entry (ANGLE's baseline).

## What the JS side owns (`runtime/src/webgl/`)

- `context.js` — `WebGL2RenderingContext`: one wrapper per GL name per kind
  (`_create` / `_lookup` / `_release`), the constants (`constants.gen.js`,
  559 of them, on the prototype and the class), `canvas`,
  `drawingBufferWidth/Height` (the canvas size), `getContextAttributes()`,
  `isContextLost()`, `makeXRCompatible()`, `getError()` (CONTEXT_LOST_WEBGL
  once after `WEBGL_lose_context.loseContext()`), the WebGL-only
  `getParameter` answers (`VERSION` → `"WebGL 2.0 (webxr-host)"`,
  `SHADING_LANGUAGE_VERSION` → `"WebGL GLSL ES 3.00 (webxr-host)"`,
  `UNPACK_*_WEBGL`, `MAX_CLIENT_WAIT_TIMEOUT_WEBGL` → 0, `UNMASKED_*` →
  `GL_VENDOR` / `GL_RENDERER`), object wrapping for the binding pnames
  (`PARAM_OBJECTS` in the table), the boolean conversions of
  `getProgramParameter` / `getShaderParameter` / `getTexParameter` /
  `getVertexAttrib` / `getQueryParameter`, and the overload dispatch of
  `texImage2D` / `texSubImage2D` (6- / 7- / 9- / 10-argument forms).
- `methods.gen.js` — the generated pass-throughs (unwrapping, null uniform
  location = no-op, plain arrays → typed arrays for the `*v` forms).
- `pixels.js` — the pixelStorei emulation. `UNPACK_FLIP_Y_WEBGL` flips rows
  on the CPU into one scratch buffer grown to the largest upload;
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` premultiplies RGBA/UNSIGNED_BYTE (all
  three ever asks for); `UNPACK_COLORSPACE_CONVERSION_WEBGL` is a no-op;
  `UNPACK_ALIGNMENT` / `ROW_LENGTH` / `SKIP_*` pass through and are read to
  lay rows out as GL will. Not applied to 3D uploads or when `SKIP_*` is
  non-zero (the source is passed as is). **Image sources**: any object with
  numeric `width`, `height` and `__rgba` (a `Uint8Array` or `ArrayBuffer` of
  `width * height * 4` bytes, top-down RGBA8 — bottom-up when
  `__rgbaBottomUp` is true — straight alpha unless `__premultiplied` is true)
  — what WP-05's `ImageBitmap`, `ImageData`, `HTMLImageElement` and canvas
  carry; an ImageData-shaped `data` is the fallback. A secondary WebGL
  canvas's `__rgba` is a readback (GL's bottom-up rows, in a buffer its
  context reuses), so flipY=true uploads it without any flip; `__rgba` is
  read once per upload. texImage2D / texSubImage2D of a secondary WebGL
  canvas into a TEXTURE_2D skip the readback altogether: `_copyFromCanvas`
  copies out of its FBO on the GPU (copyTex(Sub)Image2D for flipY=true, a
  Y-swapped blitFramebuffer for flipY=false), unless premultiply, an unpack
  skip, a size mismatch, feedback or a format other than RGBA8/RGB8 with
  UNSIGNED_BYTE (sRGB included) means the copy could differ. Converted to RGBA / RGB / RG / RED / LUMINANCE / LUMINANCE_ALPHA /
  ALPHA at UNSIGNED_BYTE; any other type is uploaded as RGBA8 with the
  caller's internalformat (warned once). A premultiplied bitmap is not
  un-premultiplied when the flag is off.
- `shader-rewrite.js` — `gl_DrawID` → `in highp int webgl_DrawID;` (ESSL 3.00
  vertex shaders when the indirect path is on) or `uniform highp int
  webgl_gl_DrawID;` (otherwise), declared after the last `#version` /
  `#extension` line; in a fragment shader it is left for the compiler to
  reject (as ANGLE does) when the indirect path is on; the `#extension
  GL_ANGLE_multi_draw` line becomes `#define webgl_ANGLE_multi_draw 1` and
  the shader's own tests of `GL_ANGLE_multi_draw` (three's batching chunk) are
  renamed to it: GLSL ES reserves `GL_` macro names and Adreno refuses to
  define one. Per-shader `_source` (original, for
  `getShaderSource`) and `_translated` (sent to GL, for
  `WEBGL_debug_shaders.getTranslatedShaderSource`). `linkProgram` binds the
  attribute (or caches the uniform's location, `_drawIdLoc`; -2 = attribute)
  when any attached shader uses it;
  `useProgram` tracks the current program so the multi-draw calls carry it.
- `extensions.js` — the `getExtension` table, gated on the driver's GL
  extension string (`__native.gl.extensions()`): always on — `EXT_color_buffer_float`,
  `EXT_color_buffer_half_float`, `WEBGL_compressed_texture_etc`,
  `WEBGL_debug_renderer_info`, `WEBGL_debug_shaders`, `WEBGL_lose_context`,
  `WEBGL_multi_draw`; gated — `OES_texture_float_linear`, `EXT_float_blend`,
  `EXT_texture_filter_anisotropic`, `EXT_texture_norm16`,
  `KHR_parallel_shader_compile`, `WEBGL_clip_cull_distance`
  (`GL_EXT_clip_cull_distance`), `WEBGL_render_shared_exponent`
  (`GL_QCOM_render_shared_exponent`), `EXT_clip_control`,
  `WEBGL_compressed_texture_astc` (`getSupportedProfiles()` → `['ldr']`, plus
  `'hdr'` when present), `WEBGL_compressed_texture_s3tc[_srgb]`,
  `WEBGL_compressed_texture_pvrtc`, `EXT_texture_compression_bptc`,
  `EXT_texture_compression_rgtc`, `WEBGL_multisampled_render_to_texture`
  (`GL_EXT_multisampled_render_to_texture`),
  `EXT_disjoint_timer_query_webgl2` (`GL_EXT_disjoint_timer_query`),
  `OVR_multiview2` and `OCULUS_multiview` (one object; `GL_OVR_multiview2`,
  `framebufferTextureMultisampleMultiviewOVR` only with
  `GL_OVR_multiview_multisampled_render_to_texture`), `OES_draw_buffers_indexed`
  (`GL_OES_draw_buffers_indexed` or GLES 3.2). WebGL1-only names answer null.
- `index.js` — `install(g)`: defines `WebGL2RenderingContext`,
  `WebGLRenderingContext` (the same class), the object classes, and the hooks
  `g.__hostCreateWebGLContext(canvas, attrs, type)` (the singleton; called by
  `canvas.getContext('webgl2' | 'webgl')` in images/canvas2d.js),
  `g.__hostGL()` and `g.__hostWrapTexture(name)` (used by webxr/ for the
  swapchain images).

## Deliberately not done

- No index-range validation on `drawElements` (the browser's
  INVALID_OPERATION for out-of-range indices); a speed win, as WP-04 says.
- No "object belongs to this context" / deleted-object checks: a deleted
  wrapper's name is 0, which GL reads as "none".
- `getContextAttributes()` reports what was asked (`antialias` always false);
  the EGL config in `host/gl/egl.cpp` carries no depth or stencil for the
  default framebuffer, so on the flat panel a renderer that depth-tests
  against the default framebuffer needs an FBO (or `egl.cpp` needs
  `EGL_DEPTH_SIZE 24` for panel mode) — out of this package's files.
- `getVertexAttrib(CURRENT_VERTEX_ATTRIB)` returns `Int32Array` for integer
  attribute arrays and `Float32Array` otherwise (browsers track the last
  `vertexAttribI4*` call instead).
