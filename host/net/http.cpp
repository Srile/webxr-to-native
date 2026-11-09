#include "net/http.h"
#include "core/log.h"
namespace host {

void Http::init(JavaVM* vm, Loop* loop, std::vector<std::string> allow) {
  vm_ = vm; loop_ = loop; allow_ = std::move(allow);
  for (int i = 0; i < 4; ++i) threads_.emplace_back([this] { worker(); });
}

void Http::cancelInflight() {}  // HttpURLConnection has no cross-thread abort; the Android host never reaches a quit through here

void Http::worker() {
  JNIEnv* env = nullptr; JavaVMAttachArgs args{JNI_VERSION_1_6, "host-http", nullptr}; vm_->AttachCurrentThread(&env, &args);
  for (;;) {
    std::pair<HttpRequest, std::function<void(HttpResponse)>> job;
    { std::unique_lock<std::mutex> lk(mu_); cv_.wait(lk, [&] { return stop_ || !q_.empty(); }); if (stop_ && q_.empty()) break; job = std::move(q_.front()); q_.pop(); }
    HttpResponse r = perform(env, job.first);
    auto cb = job.second; loop_->post([cb, r] { cb(r); });
  }
  vm_->DetachCurrentThread();
}

#define JCHECK(expr) do { expr; if (env->ExceptionCheck()) { env->ExceptionDescribe(); env->ExceptionClear(); out.error = "jni exception in " #expr; goto done; } } while (0)

HttpResponse Http::perform(JNIEnv* env, const HttpRequest& r) {
  HttpResponse out; env->PushLocalFrame(64);
  {
    jclass URL = env->FindClass("java/net/URL"); jmethodID urlCtor = env->GetMethodID(URL, "<init>", "(Ljava/lang/String;)V");
    jobject url = env->NewObject(URL, urlCtor, env->NewStringUTF(r.url.c_str()));
    if (env->ExceptionCheck()) { env->ExceptionClear(); out.error = "bad url"; goto done; }
    jmethodID open = env->GetMethodID(URL, "openConnection", "()Ljava/net/URLConnection;");
    jobject conn = env->CallObjectMethod(url, open);
    if (env->ExceptionCheck() || !conn) { env->ExceptionClear(); out.error = "openConnection failed"; goto done; }
    jclass HUC = env->FindClass("java/net/HttpURLConnection");
    env->CallVoidMethod(conn, env->GetMethodID(HUC, "setRequestMethod", "(Ljava/lang/String;)V"), env->NewStringUTF(r.method.c_str()));
    env->CallVoidMethod(conn, env->GetMethodID(HUC, "setConnectTimeout", "(I)V"), 15000);
    env->CallVoidMethod(conn, env->GetMethodID(HUC, "setReadTimeout", "(I)V"), 30000);
    env->CallVoidMethod(conn, env->GetMethodID(HUC, "setInstanceFollowRedirects", "(Z)V"), JNI_TRUE);
    jmethodID setHeader = env->GetMethodID(HUC, "setRequestProperty", "(Ljava/lang/String;Ljava/lang/String;)V");
    for (auto& h : r.headers) env->CallVoidMethod(conn, setHeader, env->NewStringUTF(h.first.c_str()), env->NewStringUTF(h.second.c_str()));
    if (!r.body.empty()) {
      env->CallVoidMethod(conn, env->GetMethodID(HUC, "setDoOutput", "(Z)V"), JNI_TRUE);
      jobject os = env->CallObjectMethod(conn, env->GetMethodID(HUC, "getOutputStream", "()Ljava/io/OutputStream;"));
      if (env->ExceptionCheck() || !os) { env->ExceptionClear(); out.error = "getOutputStream failed"; goto done; }
      jclass OS = env->FindClass("java/io/OutputStream"); jbyteArray arr = env->NewByteArray((jsize)r.body.size()); env->SetByteArrayRegion(arr, 0, (jsize)r.body.size(), (const jbyte*)r.body.data());
      env->CallVoidMethod(os, env->GetMethodID(OS, "write", "([B)V"), arr); env->CallVoidMethod(os, env->GetMethodID(OS, "close", "()V"));
      if (env->ExceptionCheck()) { env->ExceptionClear(); out.error = "write failed"; goto done; }
    }
    out.status = env->CallIntMethod(conn, env->GetMethodID(HUC, "getResponseCode", "()I"));
    if (env->ExceptionCheck()) { env->ExceptionClear(); out.error = "connection failed"; goto done; }
    jstring msg = (jstring)env->CallObjectMethod(conn, env->GetMethodID(HUC, "getResponseMessage", "()Ljava/lang/String;"));
    if (msg) { const char* c = env->GetStringUTFChars(msg, nullptr); out.statusText = c; env->ReleaseStringUTFChars(msg, c); }
    jmethodID hk = env->GetMethodID(HUC, "getHeaderFieldKey", "(I)Ljava/lang/String;"), hv = env->GetMethodID(HUC, "getHeaderField", "(I)Ljava/lang/String;");
    for (int i = 0; i < 100; ++i) { jstring k = (jstring)env->CallObjectMethod(conn, hk, i), v = (jstring)env->CallObjectMethod(conn, hv, i); if (!v) break; if (!k) continue;
      const char* kc = env->GetStringUTFChars(k, nullptr); const char* vc = env->GetStringUTFChars(v, nullptr); out.headers.push_back({kc, vc}); env->ReleaseStringUTFChars(k, kc); env->ReleaseStringUTFChars(v, vc); }
    jobject is = env->CallObjectMethod(conn, env->GetMethodID(HUC, out.status >= 400 ? "getErrorStream" : "getInputStream", "()Ljava/io/InputStream;"));
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (is) {
      jclass IS = env->FindClass("java/io/InputStream"); jmethodID rd = env->GetMethodID(IS, "read", "([B)I"); jbyteArray buf = env->NewByteArray(65536);
      for (;;) { jint n = env->CallIntMethod(is, rd, buf); if (env->ExceptionCheck()) { env->ExceptionClear(); break; } if (n <= 0) break; size_t at = out.body.size(); out.body.resize(at + n); env->GetByteArrayRegion(buf, 0, n, (jbyte*)out.body.data() + at); }
      env->CallVoidMethod(is, env->GetMethodID(IS, "close", "()V"));
    }
    env->CallVoidMethod(conn, env->GetMethodID(HUC, "disconnect", "()V"));
  }
done:
  env->PopLocalFrame(nullptr);
  return out;
}
}
