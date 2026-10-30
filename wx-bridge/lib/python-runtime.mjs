/**
 * Python 解释器解析 —— **统一入口**（取代散落各处的 'D:\\Python311\\python.exe' 硬编码）。
 *
 * 为什么要抽出来（2026-10-28 崩溃事故的教训）：
 *   出错的那台机器 D:\\Python311 被删了，而代码里至少有 11 处写死这个路径。
 *   ttsSpawn() 直接 spawn 它 → ENOENT 以 **error 事件**异步抛出 → 没人监听 →
 *   unhandled 'error' → 整个 Electron 宿主当场崩给你看。
 *   所以这里把「去哪找 Python」收敛成一个可配置、可自动探测、结果可缓存的地方，
 *   调用点只拿到**一个确定存在的路径**或者 **null**（自己去降级）。
 *
 * 解析优先级（严格按此顺序，**第一个真实存在的胜出**）：
 *   ① process.env.PYTHON_EXE   —— 用户/运维显式指定，最高优先级
 *   ② 配置文件里用户指定的路径  —— <DSH_HOME>/wechat-bot/config.json 的
 *                                 pythonPath（pythonExe 作为别名也认）
 *   ③ 调用方传入的 candidates   —— 某些脚本知道自己配了专用解释器
 *   ④ 自动探测                  —— 常见安装路径 → uv 管理的解释器 →
 *                                 PATH 上的 python/python3 → py -3
 *   ⑤ 全部失败                  —— 返回 **null**（绝不抛异常）
 *
 * 缓存：探测结果缓存在模块级变量里（避免每次 spawn 都扫盘 + 起子进程跑 where）。
 * 失效条件（任一变化就重算）：环境变量值 / 配置文件的内容指纹 / 传入的候选列表。
 * 需要立刻失效时调用 invalidatePythonCache()。
 *
 * ⚠️ 本文件在本仓库里有**两份**（wechat-group-agent/lib 与 wx-bridge/lib 各一份）：
 *    两个包是独立部署的（微信插件只安装 wechat-group-agent，桥单独跑），
 *    它们之间没有依赖，没法 import 同一个文件。两份必须保持**逐字节一致**，
 *    改的时候请同步改另一个副本。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Windows 判定（路径分隔符/where/py launcher 都是 Windows 专有） */
const IS_WIN = process.platform === 'win32'

/**
 * 自动探测时**不想选中**的路径片段（只作用于第 ④ 步的自动探测，
 * 用户在环境变量/配置文件里显式指定的路径永远不会被这里过滤掉）。
 *   - WindowsApps：微软商店的别名 stub，双击会让系统去装商店版 Python；
 *     Node 里 execFileSync 它会直接返回「此应用无法在你的电脑上运行」。
 *   - .workbuddy：WorkBuddy 自带的便携解释器，只给它自己用，
 *     拿去当插件运行时会被它自己的升级/清理动作带崩。
 */
export const AUTO_DENY_PATTERNS = ['\\WindowsApps\\', '\\.workbuddy\\']

/** 配置文件里认的字段名（按顺序取第一个非空的） */
const CONFIG_KEYS = ['pythonPath', 'pythonExe']

/**
 * 单次探测命令的超时（毫秒）。
 * ⚠️ 这里用的是 execFileSync（同步子进程）—— 本项目规范 R18 禁止在插件进程里跑阻塞式外部命令。
 *    为什么仍然可以接受：① 只在**首次**解析时跑一次，之后全走缓存；
 *    ② 调用点都在启动 8 秒之后的定时器 / 面板请求里，不在 apply() 阶段；
 *    ③ 超时收到 3 秒，最坏情况也只是卡 3 秒一次，且命令行工具（where/py）实测几十毫秒。
 */
const PROBE_TIMEOUT_MS = 3000

/** 模块级缓存：{ key: string, value: {exe, source} | null } */
let cache = null

/** 上一次解析的「失败线索」（给人看的，面板/日志用） */
let lastMisses = []

/** 版本号缓存：exe 路径 → 'Python 3.12.14' */
const versionCache = new Map()

const NOOP = () => {}

/** DSH 的家目录（配置文件就放在这里） */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 路径是否真是「一个可执行的文件」。
 * 为什么不只 existsSync：目录、坏掉的符号链接、没有执行位的 POSIX 文件，
 * 都会被 existsSync 判成 true，然后 spawn 照样失败。
 */
function isRunnableFile(p) {
  try {
    if (!p || typeof p !== 'string') return false
    const st = statSync(p)
    if (!st.isFile()) return false
    if (!IS_WIN && !(st.mode & 0o111)) return false
    return true
  } catch {
    return false
  }
}

/** 跑一条命令拿 stdout，任何异常都吞掉（探测失败不该打断业务） */
function runQuiet(file, args) {
  try {
    const out = execFileSync(file, args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(out || '')
  } catch {
    return ''
  }
}

/**
 * 从配置文件里读用户指定的解释器路径。
 * @param {string} [configFile] 调用方指定的额外配置文件（优先于默认那一份）
 * @returns {{value:string, label:string, fingerprint:string}|null}
 */
function readConfiguredPython(configFile) {
  const candidates = []
  if (configFile) candidates.push(configFile)
  candidates.push(join(dshHome(), 'wechat-bot', 'config.json'))

  for (const file of candidates) {
    let fingerprint = 'missing'
    try {
      const st = statSync(file)
      fingerprint = `${st.size}:${Math.trunc(st.mtimeMs)}`
    } catch {
      continue
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) || {}
      for (const key of CONFIG_KEYS) {
        const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
        if (value) return { value, label: `${key}@${file}`, fingerprint }
      }
      // 文件在，但没配这两个字段 —— 指纹要参与缓存 key（用户以后填了要能生效）
      return { value: '', label: '', fingerprint }
    } catch {
      // 配置文件坏了（半截 JSON）：当作没配，但指纹仍算进去
      return { value: '', label: '', fingerprint }
    }
  }
  return null
}

/** 常见安装路径（本机实测：C:\\Python312\\python.exe） */
function knownInstallCandidates() {
  const out = []
  if (IS_WIN) {
    // 官方安装器的默认根（3.8 之前带点号，之后不带；两个都列上）
    for (const v of ['314', '313', '312', '311', '310', '39', '38']) out.push(`C:\\Python${v}\\python.exe`)
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    for (const v of ['314', '313', '312', '311', '310']) out.push(join(local, 'Programs', 'Python', `Python${v}`, 'python.exe'))
    // uv 管理的解释器（uv python install 出来的都在这里，目录名带完整版本号）
    const uvRoot = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'uv', 'python')
    try {
      const dirs = readdirSync(uvRoot)
        .filter((d) => /^cpython-3\./.test(d))
        .sort((a, b) => b.localeCompare(a))          // 版本号降序 → 新的优先
      for (const d of dirs) out.push(join(uvRoot, d, 'python.exe'))
    } catch {
      // 没装 uv，正常
    }
  } else {
    out.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')
  }
  return out
}

/** PATH 上的 python / python3（Windows 用 where，POSIX 用 which） */
function pathLookupCandidates() {
  const out = []
  const names = IS_WIN ? ['python'] : ['python3', 'python']
  for (const name of names) {
    const raw = IS_WIN ? runQuiet('where', [name]) : runQuiet('which', [name])
    for (const line of raw.split(/\r?\n/)) {
      const p = line.trim()
      if (p) out.push(p)
    }
  }
  return out
}

/** Windows 的 py launcher：py -3 解析出的那个解释器 */
function pyLauncherCandidate() {
  if (!IS_WIN) return ''
  const out = runQuiet('py', ['-3', '-c', 'import sys;print(sys.executable)'])
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines[lines.length - 1] || ''
}

/** 去重 + 剔除自动探测黑名单，保持原顺序 */
function cleanCandidates(list) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const p = String(raw || '').trim()
    if (!p) continue
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * 组出完整的候选列表（按优先级排好）。
 * @param {boolean} allowProbe 是否允许跑子进程探测（false = 只查静态路径，最快）
 */
function collectAutoCandidates(allowProbe) {
  const list = knownInstallCandidates()
  if (allowProbe) {
    list.push(...pathLookupCandidates())
    const fromLauncher = pyLauncherCandidate()
    if (fromLauncher) list.push(fromLauncher)
  }
  const denied = AUTO_DENY_PATTERNS.map((s) => s.toLowerCase())
  return cleanCandidates(list).filter((p) => {
    const lower = p.toLowerCase()
    return !denied.some((d) => lower.includes(d))
  })
}

/** 缓存 key：任何一项变了都要重算 */
function cacheKey(o) {
  const cfg = readConfiguredPython(o.configFile)
  return JSON.stringify([
    String(process.env.PYTHON_EXE || '').trim(),
    cfg ? cfg.value : '',
    cfg ? cfg.fingerprint : '',
    (o.candidates || []).join('|'),
    o.allowProbe !== false,
  ])
}

/**
 * 真正做一次解析（不读缓存）。**任何异常都被吞掉**，最坏返回 null。
 * @returns {{exe:string, source:string}|null}
 */
function detect(o) {
  const misses = []
  try {
    // ① 环境变量：显式指定的优先级最高
    const envExe = String(process.env.PYTHON_EXE || '').trim()
    if (envExe) {
      if (isRunnableFile(envExe)) return { exe: envExe, source: 'PYTHON_EXE' }
      // 写错了也不能把整条链路卡死 —— 记一笔，继续往下找
      misses.push(`PYTHON_EXE 指向的路径不存在：${envExe}`)
    }

    // ② 配置文件里用户填的路径
    const cfg = readConfiguredPython(o.configFile)
    if (cfg && cfg.value) {
      if (isRunnableFile(cfg.value)) return { exe: cfg.value, source: cfg.label }
      misses.push(`配置里的解释器不存在：${cfg.value}（${cfg.label}）`)
    }

    // ③ 调用方给的候选
    for (const c of cleanCandidates(o.candidates || [])) {
      if (isRunnableFile(c)) return { exe: c, source: 'candidates' }
    }

    // ④ 自动探测
    for (const c of collectAutoCandidates(o.allowProbe !== false)) {
      if (isRunnableFile(c)) return { exe: c, source: 'auto' }
    }

    // ⑤ 全都没有
    if (!misses.length) {
      misses.push('本机没找到任何可用的 Python 解释器（查过：常见安装路径 / uv / PATH / py -3）')
    }
    return null
  } catch (e) {
    misses.push('解析 Python 解释器时异常：' + String(e?.message || e))
    return null
  } finally {
    lastMisses = misses
    if (misses.length && typeof o.log === 'function') {
      try { o.log('Python 解析：' + misses.join('；')) } catch { /* ignore */ }
    }
  }
}

/**
 * 解析出一个**确定存在**的 Python 解释器。
 *
 * @param {object} [opts]
 * @param {string} [opts.configFile]        额外要读的配置文件（优先于默认的 wechat-bot/config.json）
 * @param {string[]} [opts.candidates]      调用方自带的候选路径
 * @param {boolean} [opts.allowProbe=true]  false = 不跑子进程探测（只用静态候选）
 * @param {(s:string)=>void} [opts.log]     日志回调
 * @returns {{exe:string, source:string}|null} 找不到返回 null（**不抛**）
 */
export function resolvePython(opts = {}) {
  const o = {
    configFile: '',
    candidates: [],
    allowProbe: true,
    log: NOOP,
    ...opts,
  }
  try {
    const key = cacheKey(o)
    if (cache && cache.key === key) return cache.value
    const value = detect(o)
    cache = { key, value }
    return value
  } catch {
    return null
  }
}

/**
 * 只要路径（绝大多数调用点要的就是这个）。
 * @returns {string|null}
 */
export function resolvePythonExe(opts = {}) {
  const r = resolvePython(opts)
  return r ? r.exe : null
}

/** 清掉缓存（配置刚被改过、或刚装了新 Python 时调用） */
export function invalidatePythonCache() {
  cache = null
  lastMisses = []
  versionCache.clear()
}

/** 读一句版本號（面板展示用；失败返回空串，不影响主流程） */
function readVersion(exe) {
  if (versionCache.has(exe)) return versionCache.get(exe)
  let v = ''
  try {
    const out = runQuiet(exe, ['-V'])
    v = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || ''
  } catch {
    v = ''
  }
  versionCache.set(exe, v)
  return v
}

/**
 * 诊断信息（日志/面板用）：解释是否找到、从哪找到的、为什么没找到。
 * @returns {{found:boolean, exe:string, source:string, version:string, misses:string[]}}
 */
export function describePython(opts = {}) {
  const before = lastMisses
  const r = resolvePython(opts)
  return {
    found: !!r,
    exe: r ? r.exe : '',
    source: r ? r.source : '',
    version: r ? readVersion(r.exe) : '',
    misses: r ? [] : (lastMisses.length ? lastMisses.slice() : before.slice()),
  }
}

/**
 * 「解释器 + 脚本」双校验：缺什么就明确说缺什么，方便调用点写人话提示。
 * ★ 所有 spawn/execFile 之前都应该过这一关 —— 解释器或脚本不存在时
 *   **直接返回，绝不 spawn**（否则 ENOENT 会变成打死整个宿主的 error 事件）。
 *
 * @param {string} script 要执行的 .py 脚本（不存在也算失败）
 * @returns {{ok:boolean, exe:string, source:string, reason:string}}
 */
export function checkPythonScript(script, opts = {}) {
  const r = resolvePython(opts)
  if (!r) {
    return {
      ok: false, exe: '', source: '',
      reason: '没找到可用的 Python 解释器（可设环境变量 PYTHON_EXE，或在 wechat-bot/config.json 里填 pythonPath）',
    }
  }
  if (script && !existsSync(script)) {
    return { ok: false, exe: r.exe, source: r.source, reason: `脚本不存在：${script}` }
  }
  return { ok: true, exe: r.exe, source: r.source, reason: '' }
}

/** 报错也要能指出「该去哪配」——统一的一句话提示 */
export function pythonHint() {
  return `可用环境变量 PYTHON_EXE 覆盖，或在 ${join(dshHome(), 'wechat-bot', 'config.json')} 里填 pythonPath`
}

/** 插件/桥的诊断面板偶尔会想看这个 */
export const runtimePaths = {
  dshHome: dshHome(),
  configFile: join(dshHome(), 'wechat-bot', 'config.json'),
}
