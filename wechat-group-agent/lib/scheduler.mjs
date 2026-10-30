/**
 * 定时调度内核（2026-10-30）
 *
 * 职责边界：这里**只管"什么时候该跑"**，不管"跑的时候发什么"——
 * 执行（拼内容 / 找群 / 发送）在 index.js 的 runScheduleTask 里。
 * 分开的理由：时间计算是最容易出错又最容易被测的部分，单独一份才能写测试；
 * 而发送依赖 bridge / LLM / 群状态，混进来就没法单独验了。
 *
 * 支持的时间类型：
 *   daily    每天 HH:MM
 *   weekly   每周若干天（weekdays：1=周一 … 7=周日）的 HH:MM
 *   interval 每 N 分钟
 *   once     只跑一次（本地时间）
 *   cron     标准五段（分 时 日 月 周），dow 0/7 = 周日
 *
 * 三条硬规矩（都是真实事故 / 常识）：
 *   1. 错过的任务不无脑补跑：关机一整天的人，不该在晚上 23 点收到"早上 9 点的天气"。
 *      超过 catchUpMs（默认 6 小时）就跳过，并推进到下一次。
 *   2. 失败也要重排：markRun 无论 ok 与否都推进 nextRunAt，
 *      否则一个失败任务会被巡检每 30 秒重试一次，把宿主和微信都打爆。
 *   3. 绝不抛异常给调用方：插件和 DSH 共用事件循环，这里抛出去会把整个 DSH 拖死。
 *
 * 纯 ESM、零依赖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const DAY = 86_400_000
const WHEN_KINDS = ['daily', 'weekly', 'interval', 'once', 'cron']
const ACTION_KINDS = ['text', 'llm', 'weather', 'search']
const WD_NAME = ['一', '二', '三', '四', '五', '六', '日']

const LIMITS = { name: 60, text: 2000, prompt: 1000, city: 40, query: 200, expr: 120, room: 120, at: 40, hint: 300 }
const MAX_HISTORY = 50

const pad2 = (n) => String(n).padStart(2, '0')
const clampStr = (v, max) => String(v ?? '').trim().slice(0, max)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 1=周一 … 7=周日（和 cron 的 0=周日 不是一套，别混） */
function weekdayIso(d) {
  const w = d.getDay()          // 0=周日
  return w === 0 ? 7 : w
}

function parseHm(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return { h, mi }
}

/**
 * 一次性时间的入参很杂：前端 <input type="datetime-local"> 给的是字符串，
 * 但有些调用方直接给毫秒时间戳（数字或纯数字字符串）。两种都认。
 */
function parseOnceAt(v) {
  if (isNum(v)) return v > 0 ? Math.floor(v) : null
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d{10,15}$/.test(s)) return Number(s)                    // 毫秒时间戳
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0)
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

/** 当天（from 所在日）的 h:mi 时刻 */
function atTime(from, h, mi) {
  const d = new Date(from)
  d.setHours(h, mi, 0, 0)
  return d.getTime()
}

// ── cron ────────────────────────────────────────────────────────────
function parseCronField(part, min, max, out) {
  const [rangePart, stepStr] = String(part).split('/')
  const step = stepStr === undefined ? 1 : Number(stepStr)
  if (!Number.isInteger(step) || step < 1) return false
  let lo, hi
  if (rangePart === '*') { lo = min; hi = max } else if (/^\d+$/.test(rangePart)) {
    lo = Number(rangePart); hi = lo
  } else {
    const m = String(rangePart).match(/^(\d+)-(\d+)$/)
    if (!m) return false
    lo = Number(m[1]); hi = Number(m[2])
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false
  if (lo < min || hi > max || lo > hi) return false
  for (let v = lo; v <= hi; v += step) out.add(v)
  return true
}

/** 解析五段 cron。不合法返回 null（不抛）。dow 段 0 和 7 都是周日。 */
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return null
  const spec = [['minute', 0, 59], ['hour', 0, 23], ['dom', 1, 31], ['month', 1, 12], ['dow', 0, 7]]
  const out = {}
  for (let i = 0; i < 5; i++) {
    const set = new Set()
    for (const p of parts[i].split(',')) {
      if (!parseCronField(p.trim(), spec[i][1], spec[i][2], set)) return null
    }
    out[spec[i][0]] = set
  }
  if (out.dow.has(7)) { out.dow.delete(7); out.dow.add(0) }
  // Vixie 语义：dom 和 dow 都被限制时取"或"，否则会出现"1号且必须是周一"这种永远等不到的表达式
  out.domRestricted = parts[2] !== '*'
  out.dowRestricted = parts[4] !== '*'
  return out
}

function nextCronTime(c, from) {
  const floor = new Date(from)
  floor.setSeconds(0, 0)
  floor.setMinutes(floor.getMinutes() + 1)         // 从头分钟的下一分钟开始找
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const hours = [...c.hour].sort((a, b) => a - b)
  const minutes = [...c.minute].sort((a, b) => a - b)
  for (let day = 0; day < 366; day++) {
    const cur = new Date(start)
    cur.setDate(start.getDate() + day)
    if (!c.month.has(cur.getMonth() + 1)) continue
    const domOk = c.dom.has(cur.getDate())
    const dowOk = c.dow.has(cur.getDay())
    let dayOk = true
    if (c.domRestricted && c.dowRestricted) dayOk = domOk || dowOk
    else if (c.domRestricted) dayOk = domOk
    else if (c.dowRestricted) dayOk = dowOk
    if (!dayOk) continue
    for (const h of hours) {
      for (const mi of minutes) {
        const t = new Date(cur)
        t.setHours(h, mi, 0, 0)
        if (t.getTime() >= floor.getTime()) return t.getTime()
      }
    }
  }
  return 0
}

// ── 时间计算 ─────────────────────────────────────────────────────────
/**
 * 下一次该跑的时刻（本地时区）。
 * @param when 时间配置
 * @param from 基准（一般是上次跑的时间或 now）
 * @param now  当前时间（interval 用来把过期的时间补齐到未来）
 * @returns 毫秒；0 = 不再运行
 */
export function computeNextRunAt(when, from = Date.now(), now = from) {
  const w = when || {}
  const base = isNum(from) ? from : Date.now()
  const cur = isNum(now) ? now : base
  switch (w.kind) {
    case 'daily': {
      const t = parseHm(w.time)
      if (!t) return 0
      let n = atTime(base, t.h, t.mi)
      if (n <= base) n += DAY
      return n
    }
    case 'weekly': {
      const t = parseHm(w.time)
      const days = Array.isArray(w.weekdays) ? w.weekdays.filter((x) => Number.isInteger(x) && x >= 1 && x <= 7) : []
      if (!t || !days.length) return 0
      const d0 = new Date(base)
      d0.setHours(0, 0, 0, 0)
      for (let i = 0; i < 14; i++) {
        const d = new Date(d0)
        d.setDate(d0.getDate() + i)
        d.setHours(t.h, t.mi, 0, 0)
        if (d.getTime() > base && days.includes(weekdayIso(d))) return d.getTime()
      }
      return 0
    }
    case 'interval': {
      const step = Math.max(1, Number(w.everyMinutes) || 1) * 60_000
      let n = base + step
      // 落后太多（关机/插件停用）就按步长补到未来，而不是吐出一个过去的时间
      for (let i = 0; i < 10_000 && n <= cur; i++) n += step
      return n
    }
    case 'once': {
      const at = parseOnceAt(w.at)
      if (!at) return 0
      return at > base ? at : 0
    }
    case 'cron': {
      const expr = String(w.expr || w.cron || '').trim()
      const c = parseCron(expr)
      if (!c) return 0
      return nextCronTime(c, base)
    }
    default:
      return 0
  }
}

/** 人话描述，面板/工具输出直接用。 */
export function describeWhen(when) {
  const w = when || {}
  const t = String(w.time || '')
  switch (w.kind) {
    case 'daily': return `每天 ${t || '??:??'}`
    case 'weekly': {
      const days = Array.isArray(w.weekdays) ? w.weekdays.slice().sort((a, b) => a - b) : []
      const txt = days.length ? days.map((d) => '周' + (WD_NAME[d - 1] || '?')).join('/') : '每周'
      return `${txt} ${t || '??:??'}`
    }
    case 'interval': return `每 ${Number(w.everyMinutes) || '?'} 分钟`
    case 'once': {
      const at = parseOnceAt(w.at)
      if (!at) return '一次性（时间无效）'
      const d = new Date(at)
      return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}（只跑一次）`
    }
    case 'cron': return `cron：${String(w.expr || w.cron || '')}`
    default: return '未知时间类型'
  }
}

export function validateWhen(when) {
  const w = when || {}
  if (!WHEN_KINDS.includes(w.kind)) return { ok: false, error: '时间类型只能是：' + WHEN_KINDS.join(' / ') }
  if (w.kind === 'daily' || w.kind === 'weekly') {
    if (!parseHm(w.time)) return { ok: false, error: '时间要是 HH:MM，比如 09:30' }
  }
  if (w.kind === 'weekly') {
    const days = Array.isArray(w.weekdays) ? w.weekdays.filter((x) => Number.isInteger(x) && x >= 1 && x <= 7) : []
    if (!days.length) return { ok: false, error: '每周任务至少要选一天' }
  }
  if (w.kind === 'interval') {
    const n = Number(w.everyMinutes)
    if (!Number.isFinite(n) || n < 1 || n > 100_000) return { ok: false, error: '间隔分钟数要在 1 ~ 100000 之间' }
  }
  if (w.kind === 'once') {
    if (parseOnceAt(w.at) == null) return { ok: false, error: '一次性时间填不对（要 YYYY-MM-DDTHH:MM）' }
  }
  if (w.kind === 'cron') {
    const expr = String(w.expr || w.cron || '').trim()
    if (!expr) return { ok: false, error: 'cron 表达式不能为空' }
    if (!parseCron(expr)) return { ok: false, error: 'cron 要是五段（分 时 日 月 周），比如 0 9 * * *' }
  }
  return { ok: true }
}

export function validateAction(action) {
  const a = action || {}
  if (!ACTION_KINDS.includes(a.kind)) return { ok: false, error: '动作类型只能是：' + ACTION_KINDS.join(' / ') }
  if (a.kind === 'text' && !String(a.text || '').trim()) return { ok: false, error: '固定文案不能为空' }
  if (a.kind === 'llm' && !String(a.prompt || '').trim()) return { ok: false, error: '给 AI 的提示词不能为空' }
  if (a.kind === 'search' && !String(a.query || '').trim()) return { ok: false, error: '联网查询词不能为空' }
  return { ok: true }
}

/** 名字没填就按动作自动起一个（用户多半懒得填，空着列表里很难认）。 */
function autoName(action, when) {
  const a = action || {}
  const head = { weather: '播天气', text: '发提醒', llm: '自己写一句', search: '联网播报' }[a.kind] || '定时任务'
  switch (when?.kind) {
    case 'daily': return `每天 ${String(when.time || '')} ${head}`.trim()
    case 'weekly': return `每周 ${String(when.time || '')} ${head}`.trim()
    case 'interval': return `每 ${Number(when.everyMinutes) || '?'} 分钟 ${head}`.trim()
    case 'once': return `一次性 ${head}`
    case 'cron': return `定时 ${head}`
    default: return head
  }
}

export function newTaskId() {
  return 's_' + randomUUID().replace(/-/g, '').slice(0, 10)
}

/**
 * 清洗外部输入（面板表单 / 对话工具）成标准 task。
 * 非法直接 throw —— 调用方（upsert）负责转成 {ok:false}。
 */
export function normalizeTask(input, prev = null) {
  const raw = input && typeof input === 'object' ? input : {}
  const id = String(raw.id || prev?.id || '').trim() || newTaskId()

  const whenIn = raw.when && typeof raw.when === 'object' ? raw.when : {}
  const when = { kind: String(whenIn.kind || prev?.when?.kind || 'daily').trim().toLowerCase() }
  if (whenIn.time !== undefined || prev?.when?.time !== undefined) when.time = String(whenIn.time ?? prev?.when?.time ?? '')
  if (whenIn.weekdays !== undefined || prev?.when?.weekdays !== undefined) {
    const arr = whenIn.weekdays ?? prev?.when?.weekdays ?? []
    when.weekdays = [...new Set(String(arr).split ? (Array.isArray(arr) ? arr : String(arr).split(/[,，\s]+/)) : [])]
      .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 7).sort((a, b) => a - b)
  }
  if (whenIn.everyMinutes !== undefined || prev?.when?.everyMinutes !== undefined) {
    when.everyMinutes = Number(whenIn.everyMinutes ?? prev?.when?.everyMinutes ?? 60)
  }
  if (whenIn.at !== undefined || prev?.when?.at !== undefined) when.at = whenIn.at ?? prev?.when?.at
  // 前端 cron 字段名是 when.cron，早先文档里叫 expr —— 两个都认，存成 expr
  const cronRaw = whenIn.expr ?? whenIn.cron ?? prev?.when?.expr ?? prev?.when?.cron
  if (cronRaw !== undefined) when.expr = clampStr(cronRaw, LIMITS.expr)
  const wv = validateWhen(when)
  if (!wv.ok) throw new Error(wv.error)

  const actIn = raw.action && typeof raw.action === 'object' ? raw.action : {}
  const action = { kind: String(actIn.kind || prev?.action?.kind || 'text').trim().toLowerCase() }
  if (actIn.text !== undefined || prev?.action?.text !== undefined) action.text = clampStr(actIn.text ?? prev?.action?.text ?? '', LIMITS.text)
  if (actIn.prompt !== undefined || prev?.action?.prompt !== undefined) action.prompt = clampStr(actIn.prompt ?? prev?.action?.prompt ?? '', LIMITS.prompt)
  if (actIn.city !== undefined || prev?.action?.city !== undefined) action.city = clampStr(actIn.city ?? prev?.action?.city ?? '', LIMITS.city)
  if (actIn.query !== undefined || prev?.action?.query !== undefined) action.query = clampStr(actIn.query ?? prev?.action?.query ?? '', LIMITS.query)
  // hint：给"AI 润色"的额外要求（比如"要带当天运势、穿衣和开车注意事项"）
  if (actIn.hint !== undefined || prev?.action?.hint !== undefined) action.hint = clampStr(actIn.hint ?? prev?.action?.hint ?? '', LIMITS.hint)
  // polish：让 AI 用机器人的语气改写（天气/联网用）。默认开，用户可关。
  action.polish = actIn.polish !== undefined ? actIn.polish !== false : (prev?.action?.polish !== false)
  const av = validateAction(action)
  if (!av.ok) throw new Error(av.error)

  const tgtIn = raw.target && typeof raw.target === 'object' ? raw.target : {}
  const target = {
    room: clampStr(tgtIn.room ?? prev?.target?.room ?? '', LIMITS.room),
    at: clampStr(tgtIn.at ?? prev?.target?.at ?? '', LIMITS.at),
    sticker: tgtIn.sticker !== undefined ? tgtIn.sticker === true : (prev?.target?.sticker === true),
  }

  const name = clampStr(raw.name ?? prev?.name ?? '', LIMITS.name) || autoName(action, when)
  return {
    id,
    name,
    enabled: raw.enabled !== undefined ? raw.enabled !== false : (prev ? prev.enabled !== false : true),
    when,
    action,
    target,
    ignoreQuiet: raw.ignoreQuiet !== undefined ? raw.ignoreQuiet !== false : (prev ? prev.ignoreQuiet !== false : true),
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
    lastRunAt: prev?.lastRunAt || 0,
    nextRunAt: 0,             // 由调用方（upsert / markRun）按当前时间算
    lastOk: prev?.lastOk ?? null,
    lastError: prev?.lastError ? String(prev.lastError).slice(0, 300) : '',
    runCount: prev?.runCount || 0,
  }
}

export function createScheduler({ file, log = () => {}, catchUpMs = 6 * 3_600_000 } = {}) {
  const state = { version: 1, tasks: [], history: [] }
  let lastError = ''

  function load() {
    if (!file || !existsSync(file)) return
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(j?.tasks)) state.tasks = j.tasks.filter((t) => t && typeof t === 'object' && t.id)
      if (Array.isArray(j?.history)) state.history = j.history.filter((h) => h && typeof h === 'object')
    } catch (e) {
      // 文件坏了不能让插件起不来：留一份坏的备查，然后从空开始
      lastError = String(e?.message || e).slice(0, 200)
      try { renameSync(file, file + '.bad-' + Date.now()) } catch { /* ignore */ }
      try { log('任务文件损坏，已备份并从空开始：' + lastError) } catch { /* ignore */ }
    }
  }

  function persist() {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8')
      renameSync(tmp, file)      // 原子替换：写一半断电也不会留下半个文件
    } catch (e) {
      try { log('任务保存失败：' + String(e?.message || e).slice(0, 160)) } catch { /* ignore */ }
    }
  }

  const clone = (t) => JSON.parse(JSON.stringify(t))
  const find = (id) => state.tasks.find((t) => t.id === id) || null

  function pushHistory(entry) {
    state.history.unshift({
      at: Number(entry?.at) || Date.now(),
      id: String(entry?.id || ''),
      name: String(entry?.name || '').slice(0, LIMITS.name),
      ok: entry?.ok === true,
      error: String(entry?.error || '').slice(0, 200),
      preview: String(entry?.preview || '').slice(0, 120),
    })
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY
  }

  /** nextRunAt 丢了（老数据/手工改过）就按现在补一个，免得任务永远不跑 */
  function ensureNext(t) {
    if (t && t.enabled && !t.nextRunAt) {
      const n = computeNextRunAt(t.when, Math.max(t.lastRunAt || 0, Date.now()))
      if (n) t.nextRunAt = n
    }
    return t
  }

  load()

  return {
    /** 任务清单（含实时 nextRunAt 兜底） */
    list() {
      try {
        for (const t of state.tasks) ensureNext(t)
        return state.tasks.map(clone)
      } catch (e) { log('list 失败：' + String(e?.message || e)); return [] }
    },

    get(id) {
      const t = find(String(id || ''))
      return t ? clone(ensureNext(t)) : null
    },

    /** 新增或整体替换（带 id = 更新）。要么全过校验要么一个字不改。 */
    upsert(input) {
      try {
        const prev = input?.id ? find(String(input.id)) : null
        const t = normalizeTask(input, prev)
        const now = Date.now()
        t.nextRunAt = computeNextRunAt(t.when, Math.max(t.lastRunAt || 0, now), now)
        const idx = prev ? state.tasks.indexOf(prev) : -1
        if (idx >= 0) state.tasks[idx] = t
        else state.tasks.push(t)
        persist()
        return { ok: true, task: clone(t) }
      } catch (e) {
        return { ok: false, error: String(e?.message || e).slice(0, 200) }
      }
    },

    /** 局部改（面板只改一个开关时用） */
    patch(id, partial) {
      const prev = find(String(id || ''))
      if (!prev) return { ok: false, error: '找不到任务：' + id }
      const merged = {
        ...clone(prev),
        ...(partial || {}),
        when: { ...(prev.when || {}), ...((partial || {}).when || {}) },
        action: { ...(prev.action || {}), ...((partial || {}).action || {}) },
        target: { ...(prev.target || {}), ...((partial || {}).target || {}) },
      }
      merged.id = prev.id
      return this.upsert(merged)
    },

    remove(id) {
      const idx = state.tasks.findIndex((t) => t.id === String(id || ''))
      if (idx < 0) return { ok: false, error: '找不到任务：' + id }
      const [removed] = state.tasks.splice(idx, 1)
      persist()
      return { ok: true, removed: clone(removed) }
    },

    setEnabled(id, enabled) {
      const t = find(String(id || ''))
      if (!t) return { ok: false, error: '找不到任务：' + id }
      t.enabled = enabled !== false
      t.updatedAt = Date.now()
      if (t.enabled) t.nextRunAt = computeNextRunAt(t.when, Math.max(t.lastRunAt || 0, Date.now()))
      persist()
      return { ok: true, task: clone(t) }
    },

    /**
     * 到点的任务。顺手把"错过太久"的推进到下一次（并记一条 history），
     * 这样同一条不会因为没人执行而每次巡检都写一条记录。
     */
    due(now = Date.now()) {
      try {
        const out = []
        let dirty = false
        for (const t of state.tasks) {
          if (!t.enabled) continue
          ensureNext(t)
          if (!t.nextRunAt || t.nextRunAt > now) continue
          const late = now - t.nextRunAt
          if (late > catchUpMs) {
            pushHistory({ at: now, id: t.id, name: t.name, ok: false, error: `错过 ${Math.round(late / 3_600_000)} 小时，已跳过` })
            // ★ 必须按 **now** 往后推，不能按旧的 nextRunAt 推：
            //   按旧时间推算出来的是"错过的那一次的下一班"，那个时刻往往**也已经是过去**
            //   → 下一轮巡检立刻又到期，任务会连着补发好几次（回归用例：错过10小时那条）。
            t.nextRunAt = computeNextRunAt(t.when, now, now)
            t.updatedAt = now
            dirty = true
            continue
          }
          out.push(clone(t))
        }
        if (dirty) persist()
        return out
      } catch (e) { log('due 失败：' + String(e?.message || e)); return [] }
    },

    /**
     * 记一次执行结果并排下一次。
     * ★ 无论成功失败都必须推进 nextRunAt：不然失败的任务会被每 30 秒重试一次。
     */
    markRun(id, info = {}) {
      try {
        const t = find(String(id || ''))
        if (!t) return { ok: false, error: '找不到任务：' + id }
        const at = Number(info?.at) || Date.now()
        const ok = info?.ok === true
        t.lastRunAt = at
        t.lastOk = ok
        t.lastError = ok ? '' : String(info?.error || '失败').slice(0, 300)
        t.runCount = (t.runCount || 0) + 1
        t.updatedAt = at
        pushHistory({ at, id: t.id, name: t.name, ok, error: t.lastError, preview: info?.preview || '' })
        t.nextRunAt = computeNextRunAt(t.when, Math.max(t.lastRunAt, Date.now()), Date.now())
        persist()
        return { ok: true, task: clone(t) }
      } catch (e) {
        return { ok: false, error: String(e?.message || e).slice(0, 200) }
      }
    },

    /** 不落盘，只算"按这个配置下次什么时候跑"（面板「预览下次时间」用） */
    preview(input) {
      try {
        const base = typeof input === 'string' ? find(input) : input
        if (!base) return { ok: false, error: '没有可预览的任务' }
        const t = normalizeTask(base)
        const nextRunAt = computeNextRunAt(t.when, Date.now())
        return { ok: true, describe: describeWhen(t.when), nextRunAt, name: t.name }
      } catch (e) {
        return { ok: false, error: String(e?.message || e).slice(0, 200) }
      }
    },

    history(limit = 30) {
      try { return state.history.slice(0, Math.max(1, Number(limit) || 30)).map(clone) } catch { return [] }
    },

    clearHistory() {
      try { state.history = []; persist(); return { ok: true } } catch { return { ok: false, error: '清空失败' } }
    },

    stats() {
      const now = Date.now()
      let enabled = 0
      let nextAt = 0
      for (const t of state.tasks) {
        if (t.enabled) enabled++
        if (t.enabled && t.nextRunAt && (!nextAt || t.nextRunAt < nextAt)) nextAt = t.nextRunAt
      }
      return { total: state.tasks.length, enabled, nextAt, catchUpMs, lastError, file: file || '' }
    },

    /** 面板上偶尔要显示"人话"的时间，直接复用内核的实现，别在前端再写一份 */
    describeWhen,
  }
}

export default createScheduler
