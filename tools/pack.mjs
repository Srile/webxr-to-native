#!/usr/bin/env node
// pack.mjs <host.json | game repo> [--phone] [--install] [--run] [--release] [--keystore <path>] [--out <apk>] [--no-native] [--stage <dir> [--host mac|win|linux|ios|vision]]
// Stages assets/host.json (+ the web dist into assets/www), renders the per-game
// Gradle properties, builds the APK, optionally installs and runs it. --stage <dir> stages
// the assets there instead and stops (the experimental desktop host, tools/mac.mjs).
import { execSync, execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gameArg, ensureWebrtcSources, ensureV8Intl, ensureStorageSources, wantsStorage } from './game.mjs'
import { rewriteFile } from './unicode-regex.mjs'
import { appVersion } from './app-version.mjs'
import { notices } from './notices.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const cfgPath = gameArg(args)
if (!cfgPath) { console.error('usage: pack.mjs <host.json | game repo> [--install] [--run] [--release] [--keystore k] [--out apk]'); process.exit(2) }
const cfgDir = dirname(resolve(cfgPath))
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const app = cfg.app ?? {}
const pkg = app.package
if (!pkg && !opt('--stage')) { console.error(`${cfgPath}: app.package is not set (the APK's application id, e.g. com.example.mygame)`); process.exit(2) }
const name = app.name ?? basename(cfgDir)
const release = flag('--release')
// The phone build (WP-20): host.json android.formFactor "phone", or --phone; the APK's host.json says so to native.
const phone = flag('--phone') || cfg.android?.formFactor === 'phone'
// WebSocket + WebRTC data channels (WP-21): only built into a game that asks for them; the sources come on demand.
const webrtc = cfg.network?.webrtc === true
if (webrtc && !opt('--stage')) ensureWebrtcSources(cfg)
// Canvas 2D text (stb_truetype) and SVG images (nanosvg): native code only the games that ask carry (host/CMakeLists.txt
// HOST_CANVAS_TEXT / HOST_SVG); the runtime estimates text and refuses SVG without them, as it did before.
const canvasText = cfg.web?.canvasText === true, svg = cfg.web?.svg === true
// Microphone capture (WP-25): host.json media.microphone; the capture code and RECORD_AUDIO only then.
const microphone = cfg.media?.microphone === true
// Intl (WP-24): js.intl links V8 with ICU (third_party/v8-intl) in place of the stock Android V8, which has none.
const intl = opt('--stage') ? cfg.js?.intl === true : ensureV8Intl(cfg)
// IndexedDB + Cache API over SQLite (WP-26): only built into a game whose host.json storage asks for either.
const storage = wantsStorage(cfg)
if (storage && !opt('--stage')) ensureStorageSources(cfg)
// app.orientation: landscape, portrait, or any (follows the phone, respecting its rotation lock).
const orientation = { landscape: 'userLandscape', portrait: 'userPortrait', any: 'fullUser' }[app.orientation ?? 'landscape'] ?? 'userLandscape'

// env from tools/env.sh (the Android toolchain): not for --stage, which also runs where there is no bash (Windows)
const stageOnly = opt('--stage')
const env = { ...process.env }
if (!stageOnly) for (const kv of execFileSync('bash', ['-c', 'source "$1" && env -0', '_', join(root, 'tools/env.sh')], { encoding: 'utf8' }).split('\0')) {
  const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
}
// Git bash reports toolchain paths as /c/Users/... . Gradle and the JDK on Windows need drive paths,
// and the Windows PATH must stay semicolon-separated.
if (process.platform === 'win32') {
  const msysToWin = (p) => { const m = /^\/([A-Za-z])\/(.*)$/.exec(p); return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p }
  for (const k of Object.keys(env)) {
    if (k === 'PATH' || k === 'Path') continue
    if (typeof env[k] === 'string' && /^\/[A-Za-z]\//.test(env[k])) env[k] = msysToWin(env[k])
  }
  const prepend = [env.JAVA_HOME && join(env.JAVA_HOME, 'bin'), env.ANDROID_HOME && join(env.ANDROID_HOME, 'platform-tools')].filter(Boolean)
  env.PATH = env.Path = [...prepend, process.env.PATH || process.env.Path || ''].filter(Boolean).join(';')
}

// 1. stage assets
const assets = stageOnly ? resolve(stageOnly) : join(root, 'android/app/src/main/assets')
// The staging directory is wiped first, so a --stage target must be one pack.mjs staged before (it holds
// host.json and host-runtime.js) or not exist / be empty; and host.json must not live inside it.
if (stageOnly) {
  const ours = existsSync(join(assets, 'host.json')) && existsSync(join(assets, 'host-runtime.js'))
  if (existsSync(assets) && !ours && readdirSync(assets).length) { console.error(`--stage ${stageOnly}: not empty and not a previous pack.mjs stage; refusing to wipe it`); process.exit(2) }
  if ((resolve(cfgPath) + sep).startsWith(assets + sep)) { console.error(`--stage ${stageOnly}: host.json is inside the staging directory`); process.exit(2) }
}
rmSync(assets, { recursive: true, force: true }); mkdirSync(join(assets, 'www'), { recursive: true })
// `build` tells the game which APK it is in (`__native.config.build`): a sideloaded debug build fails the store's
// entitlement check until it is mapped to a release channel, so the game only enforces that check on a release.
const manifest = { ...cfg, build: release ? 'release' : 'debug', ...(phone ? { android: { ...cfg.android, formFactor: 'phone' } } : {}) }
// A release carries no debugger: the inspector's /host bridge evaluates any JS it is sent, and the headset binds it
// on every interface (host/js/inspector.cpp), so a store build must not open it (mac.mjs and win.mjs --app: the same).
if (release && manifest.debug?.inspector !== false) { manifest.debug = { ...cfg.debug, inspector: false }; console.log('release: debug.inspector off') }
const webDist = cfg.web?.dist ? resolve(cfgDir, cfg.web.dist) : existsSync(join(cfgDir, 'www')) ? join(cfgDir, 'www') : null
if (webDist) {
  const dist = webDist
  if (!existsSync(join(dist, 'index.html'))) { console.error(`no index.html in ${dist}`); process.exit(2) }
  // web.exclude: paths relative to web.dist, as .gitignore spells them: `*` and `?` match within a name, a pattern
  // without a '/' matches a name at any depth (`*.map`, `.DS_Store`), a trailing '/' only a directory; an excluded
  // directory goes with everything under it.
  const exclude = (cfg.web.exclude ?? []).map(e => {
    const dir = e.endsWith('/'), pat = e.replace(/^\.?\//, '').replace(/\/$/, '')
    const re = new RegExp('^' + pat.split('').map(c => c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$')
    return { re, dir, anyDepth: !pat.includes('/') }
  })
  const excluded = (rel, isDir) => exclude.some(({ re, dir, anyDepth }) => (!dir || isDir) && (re.test(rel) || (anyDepth && re.test(rel.slice(rel.lastIndexOf('/') + 1)))))
  cpSync(dist, join(assets, 'www'), { recursive: true, filter: (src) => { const rel = src.slice(dist.length + 1).split(sep).join('/'); return rel === '' || !excluded(rel, statSync(src).isDirectory()) } })
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const entry = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1] ?? html.match(/__bootLoad\(["']([^"']+)["']\)/)?.[1]
  if (!entry) { console.error('index.html has no module entry'); process.exit(2) }
  const elements = pageElements(html)
  // web.inlineScripts: true runs index.html's classic inline scripts before the entry (runtime/src/boot.js); the
  // manifest carries their text. Off, a page's inline startup code is skipped, as it always was.
  const inlineScripts = cfg.web.inlineScripts === true ? classicInlineScripts(html) : undefined
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? name
  // web.inject: the game's own boot scripts, paths relative to host.json (its native/ folder), imported as modules
  // before the entry (runtime/src/boot.js): where a page needs a choice made that its HTML UI, which no host draws,
  // would have made. Staged under www/webxr-host-inject/ so they resolve against the page's origin (not a name
  // starting with "_": aapt drops such directories from the APK).
  const inject = (cfg.web.inject ?? []).map((p, i) => {
    const src = resolve(cfgDir, p)
    if (!existsSync(src)) { console.error(`web.inject: ${src} not found`); process.exit(2) }
    const rel = `webxr-host-inject/${i}-${basename(src).replace(/\.[cm]?js$/, '')}.js`
    mkdirSync(join(assets, 'www', 'webxr-host-inject'), { recursive: true }); cpSync(src, join(assets, 'www', rel))
    return rel
  })
  manifest.web = { ...cfg.web, entry: entry.replace(/^\.?\//, ''), preload: [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)].map(m => m[1].replace(/^\.?\//, '')), elements, inlineScripts, title, inject }
  if (inject.length) console.log(`web.inject: ${inject.join(', ')}`)
  if (inlineScripts) console.log(`web.inlineScripts: ${inlineScripts.length} classic inline script(s) from index.html`)
  console.log(`web: ${dist} entry=${manifest.web.entry}`)
  // The APK's stock V8 (14.9, no ICU) rejects Unicode property escapes: spell them out (tools/unicode-regex.mjs). With
  // js.intl it has ICU, as the desktop and Apple hosts' V8s do, and gets the page as it is.
  if (!stageOnly && !intl) {
    let files = 0, escapes = 0
    const walkJs = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkJs(p); else if (/\.m?js$/.test(e.name)) { const n = rewriteFile(p); if (n) { files++; escapes += n } } } }
    walkJs(join(assets, 'www'))
    if (escapes) console.log(`unicode: ${escapes} property escape(s) in ${files} file(s) spelled out (the APK's V8 has no ICU)`)
  }
}
// The prelude is rebuilt here so an edit under runtime/src can never ship stale (it did once: the APK carried a
// bundle from before the AR work and reported no immersive-ar while native had it). A release ships it minified
// without its source map (runtime/build.mjs --min: 0.4 MB instead of 2.6 MB); a debug build keeps the readable
// bundle and the inline map, which the inspector shows as runtime/src.
execSync(`node runtime/build.mjs${release ? ' --min' : ''}`, { cwd: root, stdio: 'inherit' })
const runtime = join(root, 'runtime/dist/host-runtime.js')
if (existsSync(runtime)) cpSync(runtime, join(assets, 'host-runtime.js'))
const workerRt = join(root, 'runtime/dist/host-worker.js'); if (existsSync(workerRt)) cpSync(workerRt, join(assets, 'host-worker.js'))
console.log(`runtime: ${(statSync(join(assets, 'host-runtime.js')).size / 1e6).toFixed(2)} MB${release ? ' (minified)' : ''}`)
// The service-worker prelude (WP-27) only for a game that turns service workers on (host.json web.serviceWorker).
if (cfg.web?.serviceWorker === true) cpSync(join(root, 'runtime/dist/host-sw.js'), join(assets, 'host-sw.js'))
const snapshot = join(root, 'third_party/v8/snapshot_blob.bin')
// The APK's V8 10.0 snapshot; the desktop host's V8 has its own built in (as the js.intl monolith does: never another's).
if (existsSync(snapshot) && !stageOnly && !intl) cpSync(snapshot, join(assets, 'snapshot_blob.bin'))
writeFileSync(join(assets, 'host.json'), JSON.stringify(manifest, null, 2))
// 2a. the licences of the third-party code this build contains (tools/notices.mjs, licenses/): every app built
// from the toolkit carries them. --host names the desktop or Apple host a stage is for (the builders pass it).
const noticeHost = stageOnly ? (opt('--host') ?? 'desktop') : (phone ? 'phone' : 'quest')
const platformSdk = !stageOnly && !phone && existsSync(join(root, 'third_party/ovr_platform_sdk/Include/OVR_Platform.h'))
writeFileSync(join(assets, 'THIRD_PARTY_NOTICES.txt'), notices(root, noticeHost, { webrtc, webrtcMedia: microphone, svg, storage, intl, platformSdk }))
let bytes = 0; const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : bytes += statSync(join(d, e.name)).size }; walk(assets)
console.log(`assets: ${(bytes / 1e6).toFixed(1)} MB`)
// 2b. OS splash: Quest shows assets/vr_splash.png (with com.oculus.ossplash in the manifest) from launch until
// the app's first frame, in place of its generic loading void; the emulated hosts (mac/win/ios, --stage) show it in
// their window while the page loads (host/emu/splash.h). Staged as an sRGB PNG, at most 2048 px wide.
let osSplash = false
if (app.splash) {
  const splash = resolve(cfgDir, app.splash)
  if (!existsSync(splash)) { console.error(`app.splash not found: ${splash}`); process.exit(2) }
  try { execFileSync('magick', [splash, '-colorspace', 'sRGB', '-resize', '2048x2048>', '-strip', `PNG32:${join(assets, 'vr_splash.png')}`]) }
  catch (e) { if (!stageOnly || !/\.png$/i.test(splash)) throw e; cpSync(splash, join(assets, 'vr_splash.png')) }  // no ImageMagick (a Windows stage): the PNG as it is
  osSplash = true
  console.log(`os splash: ${splash}`)
}

if (stageOnly) process.exit(0)

// 2. icon
if (app.icon) {
  const icon = resolve(cfgDir, app.icon)
  for (const [dir, px] of [['mipmap-mdpi', 48], ['mipmap-hdpi', 72], ['mipmap-xhdpi', 96], ['mipmap-xxhdpi', 144], ['mipmap-xxxhdpi', 192]]) {
    mkdirSync(join(root, 'android/app/src/main/res', dir), { recursive: true })
    execFileSync('magick', [icon, '-resize', `${px}x${px}`, join(root, 'android/app/src/main/res', dir, 'ic_launcher.png')])
  }
}

// 3. gradle
const task = release ? 'assembleRelease' : 'assembleDebug'
const versionCode = app.versionCode ?? Math.floor(Date.now() / 60000) % 2000000000
const gradleArgs = [task, `-Phost.package=${pkg}`, `-Phost.appName=${name}`, `-Phost.versionCode=${versionCode}`, `-Phost.versionName=${appVersion(cfg, cfgPath)}`, `-Phost.osSplash=${osSplash}`, `-Phost.formFactor=${phone ? 'phone' : 'quest'}`, `-Phost.orientation=${orientation}`, `-Phost.webrtc=${webrtc}`, `-Phost.canvasText=${canvasText}`, `-Phost.svg=${svg}`, `-Phost.microphone=${microphone}`, `-Phost.intl=${intl}`, `-Phost.storage=${storage}`, '--console=plain', '-q']
const gradleBat = join(root, 'android/gradlew.bat')
const gradle = process.platform === 'win32' && existsSync(gradleBat) ? gradleBat : existsSync(join(root, 'android/gradlew')) ? join(root, 'android/gradlew') : join(env.ANDROID_HOME ? dirname(dirname(env.ANDROID_HOME)) : root, 'sdk/gradle-8.9/bin/gradle')
if (!existsSync(join(root, 'android/local.properties'))) writeFileSync(join(root, 'android/local.properties'), `sdk.dir=${(env.ANDROID_HOME ?? '').replace(/\\/g, '/')}\n`)
console.log(`gradle ${task} package=${pkg}${phone ? ' (phone)' : ''}${webrtc ? ' +webrtc' : ''}${canvasText ? ' +canvasText' : ''}${svg ? ' +svg' : ''}${microphone ? ' +microphone' : ''}${intl ? ' +intl' : ''}${storage ? ' +storage' : ''}`)
// gradlew.bat is the Windows entry. cmd splits on spaces, so quote those args (the app name).
const gradleCmd = process.platform === 'win32' ? gradleArgs.map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a) : gradleArgs
const r = spawnSync(gradle, gradleCmd, { cwd: join(root, 'android'), env, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status !== 0) process.exit(r.status ?? 1)
let apk = join(root, 'android/app/build/outputs/apk', release ? 'release' : 'debug', release ? 'app-release.apk' : 'app-debug.apk')
if (release && !existsSync(apk)) apk = apk.replace('app-release.apk', 'app-release-unsigned.apk')

// 4. sign (release)
if (release) {
  const ks = opt('--keystore') ?? env.KEYSTORE_PATH
  if (ks) {
    const bt = join(env.ANDROID_HOME, 'build-tools/34.0.0')
    const aligned = apk.replace(/\.apk$/, '-aligned.apk'); const signed = apk.replace(/(-unsigned)?\.apk$/, '-signed.apk')
    execFileSync(join(bt, 'zipalign'), ['-f', '-p', '4', apk, aligned], { env })
    // apksigner is a script that needs java on PATH (the sourced env), and the passwords go to it as env: references,
    // never as arguments: an argument shows in `ps` and in the error execFileSync throws when signing fails.
    const pass = env.KEYSTORE_PASS ?? env.KEYSTORE_PASSWORD ?? env.BUBBLEWRAP_KEYSTORE_PASSWORD; const alias = env.KEYSTORE_ALIAS ?? 'android'
    const signEnv = { ...env, WXH_KS_PASS: pass ?? '', WXH_KEY_PASS: env.KEY_PASS ?? env.BUBBLEWRAP_KEY_PASSWORD ?? pass ?? '' }
    execFileSync(join(bt, 'apksigner'), ['sign', '--ks', ks, '--ks-key-alias', alias, ...(pass ? ['--ks-pass', 'env:WXH_KS_PASS', '--key-pass', 'env:WXH_KEY_PASS'] : []), '--out', signed, aligned], { stdio: 'inherit', env: signEnv })
    apk = signed
  }
}
const out = opt('--out'); if (out) { cpSync(apk, out); apk = out }
console.log(`apk: ${apk} (${(statSync(apk).size / 1e6).toFixed(1)} MB)`)

// 5. device
const dev = join(root, 'tools/device.mjs')
if (flag('--install')) execFileSync('node', [dev, 'install', apk], { stdio: 'inherit', env })
if (flag('--run')) execFileSync('node', [dev, 'run', pkg], { stdio: 'inherit', env })

// The page's own elements that carry an id, in document order, each with its tag, classes and the nearest ancestor
// that also has one (null: the body): the runtime builds them before the entry runs, so a page that queries its
// containers, canvases and overlays finds them (runtime/src/dom-lite). Script and style bodies are skipped.
// The body's element tree, for dom-lite to build as stubs (no layout, no paint: the page's HTML UI stays invisible, but
// every element a script looks up exists, by id, class, tag or a descendant selector). Each: tag, id, class, the
// index of its parent element (-1: the body) and its other attributes (style left out). Text and scripts are not kept
// as elements. Classic inline scripts (no src, not a module, an import map or a nomodule script, which a browser
// that runs modules never executes) are kept and run before the entry when host.json web.inlineScripts is true:
// the host never parses the document, so a page's own startup — the VR button click the host cannot draw — would
// otherwise never run.
function classicInlineScripts(html) {
  const out = []
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || ''
    if (/\ssrc\s*=/i.test(attrs)) continue
    if (/\snomodule(\s|=|$)/i.test(attrs)) continue

    const type = attrs.match(/\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const t = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').toLowerCase()
    if (t && t !== 'text/javascript' && t !== 'application/javascript' && t !== 'text/ecmascript') continue
    if (m[2].trim()) out.push(m[2])
  }
  return out
}
function pageElements(html) {
  const body = html.slice(Math.max(0, html.search(/<body[\s>]/i)))
  const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])
  const SKIP = new Set(['script', 'style', 'template', 'noscript'])
  const out = [], stack = []  // stack: { name, index }
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->/g
  for (let m; (m = tag.exec(body));) {
    if (!m[2]) continue  // a comment
    const name = m[2].toLowerCase()
    if (m[1]) { const i = stack.map(e => e.name).lastIndexOf(name); if (i >= 0) stack.length = i; continue }
    if (name === 'body') continue
    if (SKIP.has(name)) { const end = body.indexOf(`</${name}`, tag.lastIndex); if (end < 0) break; tag.lastIndex = end; continue }
    const attrs = {}
    for (const a of m[3].matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? ''
    const { id, class: cls, style, ...rest } = attrs
    const e = { tag: name, parent: stack.length ? stack[stack.length - 1].index : -1 }
    if (id) e.id = id; if (cls) e.class = cls; if (Object.keys(rest).length) e.attrs = rest
    out.push(e)
    if (!VOID.has(name) && !m[4]) stack.push({ name, index: out.length - 1 })
  }
  return out
}
