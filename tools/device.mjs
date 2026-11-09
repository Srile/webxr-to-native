#!/usr/bin/env node
// Quest device helper: status | install <apk> | run <pkg> | stop <pkg> | log [pkg] | shot <out.png> | crash | forward <port>
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const local = join(root, 'tools/sdk/android/platform-tools/adb')
const ADB = existsSync(local) ? local : 'adb'
const adb = (args, opts = {}) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const sh = (cmd) => adb(['shell', cmd]).trim()
const [cmd, ...rest] = process.argv.slice(2)

function status() {
  const devs = adb(['devices', '-l']).split('\n').slice(1).filter(l => l.trim())
  if (!devs.length) { console.log('no device'); process.exit(2) }
  console.log(devs.join('\n'))
  const worn = /mProximityPositive=true/.test(sh('dumpsys power')) || /mWakefulness=Awake/.test(sh('dumpsys power'))
  console.log(`model: ${sh('getprop ro.product.model')}  os: ${sh('getprop ro.build.version.release')} (sdk ${sh('getprop ro.build.version.sdk')})  build: ${sh('getprop ro.build.id')}`)
  console.log(`worn: ${worn ? 'yes' : 'no'}  battery: ${(sh('dumpsys battery').match(/level: (\d+)/) || [])[1] ?? '?'}%`)
}
switch (cmd) {
  case 'status': status(); break
  case 'install': console.log(adb(['install', '-r', '-g', rest[0]])); break
  case 'run': console.log(adb(['shell', 'am', 'start', '-S', '-n', `${rest[0]}/android.app.NativeActivity`])); break
  case 'stop': console.log(adb(['shell', 'am', 'force-stop', rest[0]])); break
  case 'log': {
    adb(['logcat', '-G', '32M']); adb(['logcat', '-c'])
    const p = spawn(ADB, ['logcat', '-v', 'time', '-s', 'webxr-host:V', 'OpenXR:V', 'AndroidRuntime:E', 'DEBUG:V', 'libc:F', 'js:V'], { stdio: 'inherit' })
    p.on('exit', c => process.exit(c ?? 0)); break
  }
  case 'tail': { // tail <n> — last n lines of our tags, no clear
    console.log(adb(['logcat', '-d', '-v', 'time', '-s', 'webxr-host:V', 'OpenXR:V', 'AndroidRuntime:E', 'DEBUG:V', 'js:V']).split('\n').slice(-(+rest[0] || 200)).join('\n')); break
  }
  case 'shot': {
    const png = adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20 })
    writeFileSync(rest[0], png); console.log(`${rest[0]} ${png.length} bytes`); break
  }
  case 'crash': {
    const t = sh('ls -t /data/tombstones 2>/dev/null | head -1')
    if (!t) { console.log(adb(['logcat', '-d', '-s', 'DEBUG:V']).split('\n').slice(-80).join('\n')); break }
    console.log(sh(`cat /data/tombstones/${t}`)); break
  }
  case 'forward': console.log(adb(['forward', `tcp:${rest[0]}`, `tcp:${rest[1] || rest[0]}`])); break
  default: console.log('usage: device.mjs status|install <apk>|run <pkg>|stop <pkg>|log|tail [n]|shot <out.png>|crash|forward <port> [devport]')
}
