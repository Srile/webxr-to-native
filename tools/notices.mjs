// notices.mjs — THIRD_PARTY_NOTICES.txt for a built app: the licences of the third-party code inside that host's
// binary, libraries and runtime script, concatenated from licenses/<id>.txt (the upstream texts, verbatim).
// tools/pack.mjs writes it into the staged assets of every build: the APK's assets/, and the asset folder the
// macOS, Windows, Linux, iOS and visionOS packagers put into their app. An app built from this toolkit must carry
// these notices; where it shows them (an About screen, the store listing) is the game's choice, as long as they
// travel with the app. THIRD_PARTY_NOTICES.md at the repository root explains what is where.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// In every host: the runtime script (IWER, gl-matrix), V8 and what it links, the image and audio decoders.
const COMMON = ['iwer', 'gl-matrix', 'v8', 'v8-third-party', 'stb', 'dr_mp3', 'libopus', 'libwebp']
const HOSTS = {
  quest: [...COMMON, 'openxr-loader', 'oboe', 'android-native-app-glue', 'libcxx'],
  phone: [...COMMON, 'oboe', 'android-native-app-glue', 'libcxx'],
  // ANGLE on macOS, Windows and Linux comes out of an Electron release; its licences are Chromium's credits,
  // LICENSES.chromium.html, which mac.mjs, win.mjs and linux.mjs copy beside the app.
  mac: [...COMMON, 'icu', 'glfw', 'wamr', 'simde'],
  win: [...COMMON, 'icu', 'glfw'],
  linux: [...COMMON, 'icu', 'wamr', 'simde'],
  ios: [...COMMON, 'icu', 'angle', 'wamr', 'simde'],
  vision: [...COMMON, 'icu', 'angle', 'wamr', 'simde'],
}
const WEBRTC = ['libdatachannel', 'libjuice', 'usrsctp', 'plog', 'mbedtls']
const EXTRA = {
  mac: 'ANGLE (libEGL, libGLESv2) from Electron 37.2.0: see LICENSES.chromium.html beside this file in the app.',
  win: 'ANGLE (libEGL.dll, libGLESv2.dll) and d3dcompiler_47.dll from Electron 37.2.0: see LICENSES.chromium.html\n' +
    'beside the executable. d3dcompiler_47.dll is Microsoft\'s, redistributed under the terms of the Windows SDK.',
  linux: 'With ANGLE (linux.mjs --angle): ANGLE, SwiftShader and the Vulkan loader from Electron 37.2.0, see\n' +
    'LICENSES.chromium.html beside the executable. The system libraries the host loads (GLFW, libcurl, PulseAudio,\n' +
    'EGL/GLES, X11) are not part of the app.',
}

// A stage made without naming its host: everything any desktop or Apple host may carry.
HOSTS.desktop = [...new Set([...HOSTS.mac, ...HOSTS.win, ...HOSTS.linux, ...HOSTS.ios, ...HOSTS.vision])]
EXTRA.desktop = [EXTRA.mac, EXTRA.win, EXTRA.linux].join('\n')

export const NOTICE_HOSTS = Object.keys(HOSTS)

// The notices text for `host` (quest | phone | mac | win | linux | ios | vision | desktop); `webrtc` adds the WebRTC stack
// (host.json network.webrtc); `platformSdk` notes the Meta Platform SDK loader when the game bundles it.
export function notices(root, host, { webrtc = false, platformSdk = false } = {}) {
  const ids = HOSTS[host]
  if (!ids) throw new Error(`notices: unknown host "${host}" (${NOTICE_HOSTS.join(', ')})`)
  const list = webrtc ? [...ids, ...WEBRTC] : ids
  const rule = '='.repeat(79)
  let out = 'THIRD-PARTY SOFTWARE NOTICES\n\n' +
    'This application runs on webxr-to-native (https://github.com/Srile/webxr-to-native, MIT licence), which\n' +
    'contains the third-party software listed below, each under its own licence. The full texts follow.\n\n'
  for (const id of list) out += '  - ' + readFileSync(join(root, 'licenses', id + '.txt'), 'utf8').split('\n')[0] + '\n'
  if (EXTRA[host]) out += '\n' + EXTRA[host] + '\n'
  if (platformSdk) out += '\nThe Meta Platform SDK loader (libovrplatformloader.so) is used under the Oculus SDK License Agreement:\nhttps://developer.oculus.com/licenses/oculussdk/\n'
  for (const id of list) out += '\n' + rule + '\n' + readFileSync(join(root, 'licenses', id + '.txt'), 'utf8').replace(/\s+$/, '') + '\n'
  return out
}
