// macOS's microphone permission (TCC) for the mac host's capture (WP-25, media/media_bind.cpp). Unbundled
// (tools/mac.mjs runs the binary from a terminal) macOS attributes the access to the terminal app and asks for
// it; a bundle (mac.mjs --app) asks in its own name, with its Info.plist's NSMicrophoneUsageDescription.
#import <AVFoundation/AVFoundation.h>
#include <functional>

namespace host {
namespace media {

// AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
int macMicAuthorization() { return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]; }

// done(granted) on an arbitrary queue, once the person has answered (at once when they already had).
void macMicRequest(std::function<void(bool)> done) {
  auto* cb = new std::function<void(bool)>(std::move(done));
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) { (*cb)(granted == YES); delete cb; }];
}

}  // namespace media
}  // namespace host
