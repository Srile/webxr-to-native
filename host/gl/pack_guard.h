#pragma once
// A host readback into its own memory (screenshots) whatever pack state the page left: no PIXEL_PACK_BUFFER bound
// (with one, glReadPixels writes into that buffer and the "pointer" is an offset: Wonderland keeps one bound), tight
// rows from the origin. Everything is put back when the guard goes. Include after the GLES 3 headers.
namespace host {
struct PackGuard {
  GLint buf = 0, align = 4, rowLength = 0, skipRows = 0, skipPixels = 0;
  PackGuard() {
    glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &buf); glGetIntegerv(GL_PACK_ALIGNMENT, &align);
    glGetIntegerv(GL_PACK_ROW_LENGTH, &rowLength); glGetIntegerv(GL_PACK_SKIP_ROWS, &skipRows); glGetIntegerv(GL_PACK_SKIP_PIXELS, &skipPixels);
    if (buf) glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    glPixelStorei(GL_PACK_ALIGNMENT, 4); glPixelStorei(GL_PACK_ROW_LENGTH, 0); glPixelStorei(GL_PACK_SKIP_ROWS, 0); glPixelStorei(GL_PACK_SKIP_PIXELS, 0);
  }
  ~PackGuard() {
    glPixelStorei(GL_PACK_ALIGNMENT, align); glPixelStorei(GL_PACK_ROW_LENGTH, rowLength); glPixelStorei(GL_PACK_SKIP_ROWS, skipRows); glPixelStorei(GL_PACK_SKIP_PIXELS, skipPixels);
    if (buf) glBindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)buf);
  }
  PackGuard(const PackGuard&) = delete; PackGuard& operator=(const PackGuard&) = delete;
};
}  // namespace host
