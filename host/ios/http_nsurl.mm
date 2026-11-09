// iOS host: net/http.h's transport over NSURLSession (the system's TLS and trust store; iOS has no public curl),
// on the same small worker pool as the other hosts; results are posted back to the host loop. The allow-list
// and the queue are shared (net/http_common.cpp).
#include "net/http.h"
#include "core/log.h"
#import <Foundation/Foundation.h>
#include <algorithm>

// Redirects come back as responses (the session follows none): each hop is checked against network.allow below.
@interface HostNoRedirect : NSObject <NSURLSessionTaskDelegate>
@end
@implementation HostNoRedirect
- (void)URLSession:(NSURLSession*)s task:(NSURLSessionTask*)t willPerformHTTPRedirection:(NSHTTPURLResponse*)r newRequest:(NSURLRequest*)req completionHandler:(void (^)(NSURLRequest*))done { done(nil); }
@end

namespace host {
namespace {
NSURLSession* session() {
  static NSURLSession* s = [] {
    NSURLSessionConfiguration* c = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    // Android's timeouts: 30 s without a byte; a slow but moving download has no total cap.
    c.timeoutIntervalForRequest = 30; c.timeoutIntervalForResource = 24 * 3600;
    c.HTTPCookieStorage = nil; c.URLCache = nil;
    return [NSURLSession sessionWithConfiguration:c delegate:[HostNoRedirect new] delegateQueue:nil];
  }();
  return s;
}
}  // namespace

void Http::init(JavaVM*, Loop* loop, std::vector<std::string> allow) {
  loop_ = loop; allow_ = std::move(allow);
  for (int i = 0; i < 4; ++i) threads_.emplace_back([this] { worker(); });
}

void Http::cancelInflight() {
  std::lock_guard<std::mutex> g(mu_);
  for (void* t : inflight_) [(__bridge NSURLSessionTask*)t cancel];  // the completion handler fires with the cancel, the worker goes on
  inflight_.clear();
}

void Http::worker() {
  for (;;) {
    std::pair<HttpRequest, std::function<void(HttpResponse)>> job;
    { std::unique_lock<std::mutex> lk(mu_); cv_.wait(lk, [&] { return stop_ || !q_.empty(); }); if (stop_ && q_.empty()) break; job = std::move(q_.front()); q_.pop(); }
    HttpResponse r; @autoreleasepool { r = perform(nullptr, job.first); }
    auto cb = job.second; loop_->post([cb, r] { cb(r); });
  }
}

// One hop at a time, as mac/http_curl.cpp: every redirect target must pass network.allow (and stay on http/https).
// A 303, or a 301/302 answering a POST, goes on as a GET without the body; 307/308 keep the method and body.
HttpResponse Http::perform(JNIEnv*, const HttpRequest& r) {
  HttpResponse out;
  std::string url = r.url, method = r.method; bool sendBody = !r.body.empty();
  for (int hop = 0; ; ++hop) {
    out = HttpResponse{};
    NSURL* u = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    if (!u || !([u.scheme isEqualToString:@"https"] || [u.scheme isEqualToString:@"http"])) { out.error = "unsupported URL: " + url; return out; }
    NSMutableURLRequest* req = [NSMutableURLRequest requestWithURL:u];
    req.HTTPMethod = [NSString stringWithUTF8String:method.c_str()];
    for (auto& h : r.headers) [req setValue:[NSString stringWithUTF8String:h.second.c_str()] forHTTPHeaderField:[NSString stringWithUTF8String:h.first.c_str()]];
    if (sendBody) req.HTTPBody = [NSData dataWithBytes:r.body.data() length:r.body.size()];
    __block NSData* data = nil; __block NSURLResponse* resp = nil; __block NSError* err = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSURLSessionDataTask* task = [session() dataTaskWithRequest:req completionHandler:^(NSData* d, NSURLResponse* rs, NSError* e) { data = d; resp = rs; err = e; dispatch_semaphore_signal(done); }];
    { std::lock_guard<std::mutex> g(mu_); if (stop_) { out.error = "cancelled"; return out; } inflight_.push_back((__bridge void*)task); }  // shutdown cancels it
    [task resume];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    { std::lock_guard<std::mutex> g(mu_); inflight_.erase(std::remove(inflight_.begin(), inflight_.end(), (__bridge void*)task), inflight_.end()); }
    if (err) { out.error = err.localizedDescription.UTF8String; return out; }
    NSHTTPURLResponse* hr = (NSHTTPURLResponse*)resp;
    out.status = (int)hr.statusCode;
    out.statusText = [NSHTTPURLResponse localizedStringForStatusCode:hr.statusCode].UTF8String;
    for (id k in hr.allHeaderFields) out.headers.push_back({[k description].UTF8String, [hr.allHeaderFields[k] description].UTF8String});
    if (data.length) out.body.assign((const char*)data.bytes, data.length);
    NSString* loc = out.status >= 300 && out.status < 400 ? [hr valueForHTTPHeaderField:@"Location"] : nil;
    if (!loc) return out;
    NSURL* nextUrl = [NSURL URLWithString:loc relativeToURL:u];
    if (!nextUrl) return out;
    std::string next = nextUrl.absoluteURL.absoluteString.UTF8String;
    if (hop >= 10) { out.error = "too many redirects"; return out; }
    if (!allowed(next)) { out = HttpResponse{}; out.error = "redirect blocked by network.allow: " + next; return out; }
    if (out.status == 303 || ((out.status == 301 || out.status == 302) && method == "POST")) { method = "GET"; sendBody = false; }
    url = next;
  }
}

}  // namespace host
