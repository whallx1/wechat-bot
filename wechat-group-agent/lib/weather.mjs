// 天气取数：open-meteo 为主（免密钥、免注册），wttr.in 兜底
//
// 为什么单独抽成 lib：定时任务「每天播天气」要能脱离插件生命周期单独跑/单独测。
//
// 实测结论（2026-10-30）：
//  - open-meteo 地理编码 + forecast 在本网络都通，返回时区按 timezone=auto 给到当地时区
//  - 地理编码同名城市很多（「石河子」能搜到新疆石河子市和甘肃石河子），取第一个有经纬度的即可
//  - wttr.in 的 ?format=j1 也通，但它用的是 WWO 天气码、描述是英文（lang=zh 没生效），
//    所以兜底时也要自己映射成 WMO 码再出中文，不能直接信 weatherDesc
//  - 全程不抛异常：定时任务里一次 throw 会打断整个调度循环，所以失败统一返回 { ok:false, error }
const DEFAULT_TIMEOUT_MS = 15_000
const GEO_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 地名不会变，缓存 7 天，省掉每次定时任务的一趟地理编码

// 城市名 → { lat, lon, name, admin1, at }，模块级缓存（进程重启即失效，无所谓）
const geoCache = new Map()

/** WMO weather_code → 中文天气 */
export const WMO_ZH = {
  0: '晴',
  1: '少云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
}

// wttr.in 用的是 WorldWeatherOnline 码，和 WMO 不是一套，必须转换后才能复用 WMO_ZH
const WWO_TO_WMO = {
  113: 0, 116: 2, 119: 3, 122: 3, 143: 45, 176: 61, 179: 71, 182: 85, 185: 66,
  200: 95, 227: 75, 230: 75, 248: 45, 260: 48, 263: 51, 266: 53, 281: 56, 284: 57,
  293: 61, 296: 61, 299: 63, 302: 63, 305: 65, 308: 65, 311: 66, 314: 67, 317: 85,
  320: 86, 323: 71, 326: 71, 329: 73, 332: 73, 335: 75, 338: 75, 350: 77, 353: 80,
  356: 81, 359: 82, 362: 85, 365: 86, 368: 85, 371: 86, 374: 77, 377: 77, 386: 95,
  389: 95, 392: 95, 395: 95,
}

const EMOJI_DAY = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️', 56: '🌧️', 57: '🌧️',
  61: '🌦️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
  71: '❄️', 73: '❄️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '🌨️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
}
const EMOJI_NIGHT = { ...EMOJI_DAY, 0: '🌙', 1: '🌙', 2: '☁️' }

/** weather_code + 白天/黑夜 → 一个 emoji。识别不了就给个中性图标，不要返回空串 */
export function weatherEmoji(code, isDay) {
  const c = Number(code)
  const table = isDay === false ? EMOJI_NIGHT : EMOJI_DAY
  if (Number.isFinite(c) && table[c]) return table[c]
  return isDay === false ? '🌙' : '🌤️'
}

/** weather_code → 中文描述；未知码返回 ''（上层自己决定省掉） */
export function wmoDesc(code) {
  const c = Number(code)
  return Number.isFinite(c) && WMO_ZH[c] ? WMO_ZH[c] : ''
}

// ---------- 取值防御：字段可能整个缺失，也可能是 null/NaN/字符串 ----------

/** 转数字，失败返回 null（不要 undefined，避免拼进字符串） */
function num(v) {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

/** 温度：固定 1 位小数（整度数也显示 .0，整段文字保持一致） */
function fmt1(v) {
  const n = num(v)
  return n === null ? null : n.toFixed(1)
}

/** 非温度数值：去掉多余小数（紫外线 3、风速 4.8，不要 3.0） */
function fmtTrim(v, digits = 1) {
  const n = num(v)
  if (n === null) return null
  return String(Number(n.toFixed(digits)))
}

function fmtInt(v) {
  const n = num(v)
  return n === null ? null : String(Math.round(n))
}

/** 度数 → 八方位中文（236° → 西南） */
function dirToZh(deg) {
  const d = num(deg)
  if (d === null) return ''
  const x = ((d % 360) + 360) % 360
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return names[Math.floor((x + 22.5) / 45) % 8]
}

/** 紫外线分级：<3 低、3-5 中等、6-7 高、8-10 很高、11+ 极高 */
function uvLevel(uv) {
  const n = num(uv)
  if (n === null) return ''
  if (n < 3) return '低'
  if (n <= 5) return '中等'
  if (n <= 7) return '高'
  if (n <= 10) return '很高'
  return '极高'
}

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** '2026-10-30' → '10月30日'。手写切分而不用 Date，避免本地时区把日期挪到前一天 */
function fmtMonthDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return ''
  return `${Number(m[2])}月${Number(m[3])}日`
}

/** '2026-10-30' → '周五'。用 Date.UTC 取星期，避免时区偏移 */
function fmtWeekday(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return WEEK_ZH[d.getUTCDay()] || ''
}

/** '2026-10-30T08:49' / '08:49' → '08:49' */
function hhmm(s) {
  const str = String(s || '')
  const i = str.indexOf('T')
  const t = i >= 0 ? str.slice(i + 1) : str
  return t.slice(0, 5)
}

/** '06:48 AM' → '06:48'（wttr.in 的天文时间带 AM/PM） */
function ampmTo24(s) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s || '').trim())
  if (!m) return hhmm(s)
  let h = Number(m[1])
  const pm = /PM/i.test(m[3])
  if (pm && h !== 12) h += 12
  if (!pm && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

/** '0' / '300' / '1200' → '00:00' / '03:00' / '12:00'（wttr.in 的小时字段） */
function wttrHour(t) {
  const s = String(t ?? '').padStart(4, '0')
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`
}

// ---------- 网络 ----------

async function getJson(url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': 'wechat-group-agent/1.0', accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = await res.json()
    return { ok: true, json }
  } catch (e) {
    // 超时要单独说清楚，否则排障时只会看到一个看不懂的 AbortError
    if (e?.name === 'AbortError') return { ok: false, error: `请求超时（${timeoutMs}ms）` }
    return { ok: false, error: e?.message || String(e) }
  } finally {
    // 必须清掉，否则这个 timer 会吊住事件循环，定时任务里表现为进程不退出
    clearTimeout(timer)
  }
}

async function geocode(city, timeoutMs) {
  const key = String(city || '').trim()
  const hit = geoCache.get(key)
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return { ok: true, geo: hit }

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(key)}&count=5&language=zh&format=json`
  const r = await getJson(url, timeoutMs)
  if (!r.ok) return { ok: false, error: `地理编码失败：${r.error}` }

  const list = arr(r.json?.results)
  const g = list.find((x) => num(x?.latitude) !== null && num(x?.longitude) !== null)
  if (!g) {
    // 用户写的常常是「XX市XX区XX街道」这种，搜不到时提示他换个更通用的名字
    return { ok: false, error: `没查到「${key}」这个城市，换个更通用的名字，比如只写市名` }
  }
  const geo = {
    lat: num(g.latitude),
    lon: num(g.longitude),
    name: String(g.name || key),
    admin1: String(g.admin1 || ''),
    country: String(g.country || ''),
    at: Date.now(),
  }
  geoCache.set(key, geo)
  return { ok: true, geo }
}

// ---------- open-meteo ----------

/** 从「当前小时」起每 3 小时取一条，最多 6 条，且只取当天剩余的（不足就少列） */
function sampleHourly(hourly, curTimeStr, count = 6) {
  const times = arr(hourly?.time)
  if (!times.length) return []
  const today = String(curTimeStr || times[0] || '').slice(0, 10)
  const curHour = Number(String(curTimeStr || '').slice(11, 13))
  const hour = Number.isFinite(curHour) ? curHour : 0

  const idxs = []
  for (let i = 0; i < times.length; i++) {
    if (String(times[i]).slice(0, 10) === today) idxs.push(i)
  }
  if (!idxs.length) return []

  const todayHour = (i) => Number(String(times[i]).slice(11, 13))
  let start = idxs.find((i) => todayHour(i) >= hour)
  if (start === undefined) start = idxs[0] // 跨天等极端情况：从头开始，别返回空

  const out = []
  for (let k = start; k < times.length && out.length < count; k += 3) {
    if (String(times[k]).slice(0, 10) !== today) break
    const code = num(arr(hourly?.weather_code)[k])
    out.push({
      time: String(times[k]).slice(11, 16),
      temp: num(arr(hourly?.temperature_2m)[k]),
      code,
      desc: wmoDesc(code),
      pop: num(arr(hourly?.precipitation_probability)[k]),
    })
  }
  return out
}

function buildRawOpenMeteo(j, name) {
  const cur = j?.current || {}
  const daily = j?.daily || {}
  const hourly = j?.hourly || {}

  const date = String(arr(daily.time)[0] || '')
  const curCode = num(cur.weather_code)
  const dayCode = num(arr(daily.weather_code)[0])
  const tmrCode = num(arr(daily.weather_code)[1])
  const isDay = num(cur.is_day) !== null ? num(cur.is_day) === 1 : null

  return {
    source: 'open-meteo',
    name,
    date,
    isDay,
    tz: j?.timezone || '',
    current: {
      time: String(cur.time || ''),
      temp: num(cur.temperature_2m),
      feels: num(cur.apparent_temperature),
      humidity: num(cur.relative_humidity_2m),
      wind: {
        speed: num(cur.wind_speed_10m),
        deg: num(cur.wind_direction_10m),
        dir: dirToZh(cur.wind_direction_10m),
      },
      code: curCode,
      desc: wmoDesc(curCode),
    },
    daily: {
      max: num(arr(daily.temperature_2m_max)[0]),
      min: num(arr(daily.temperature_2m_min)[0]),
      sunrise: hhmm(arr(daily.sunrise)[0]),
      sunset: hhmm(arr(daily.sunset)[0]),
      uv: num(arr(daily.uv_index_max)[0]),
      pop: num(arr(daily.precipitation_probability_max)[0]),
      code: dayCode,
      desc: wmoDesc(dayCode),
    },
    hourly: sampleHourly(hourly, String(cur.time || '')),
    tomorrow: {
      date: String(arr(daily.time)[1] || ''),
      max: num(arr(daily.temperature_2m_max)[1]),
      min: num(arr(daily.temperature_2m_min)[1]),
      code: tmrCode,
      desc: wmoDesc(tmrCode),
    },
  }
}

async function fetchWeatherOpenMeteo({ city, timeoutMs }) {
  const geo = await geocode(city, timeoutMs)
  if (!geo.ok) return geo

  const q = [
    `latitude=${geo.geo.lat}`,
    `longitude=${geo.geo.lon}`,
    'current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    'daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max',
    'hourly=temperature_2m,weather_code,precipitation_probability',
    'timezone=auto',
    'forecast_days=2',
  ].join('&')
  const r = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`, timeoutMs)
  if (!r.ok) return { ok: false, error: `天气预报失败：${r.error}` }

  const name = geo.geo.name || city
  const raw = buildRawOpenMeteo(r.json, name)
  if (!raw.date && raw.current.temp === null) {
    return { ok: false, error: '天气预报返回的数据不完整' }
  }
  return {
    ok: true,
    city,
    resolvedName: name,
    region: [geo.geo.admin1, geo.geo.country].filter(Boolean).join(' · '),
    text: formatWeatherText(raw, { name }),
    raw,
  }
}

// ---------- wttr.in 兜底 ----------

function buildRawWttr(j, city) {
  const cc = arr(j?.current_condition)[0] || {}
  const days = arr(j?.weather)
  const today = days[0] || {}
  const tomorrow = days[1] || {}
  const ast = arr(today.astronomy)[0] || {}
  const h = arr(today.hourly)

  const toWmo = (v) => {
    const wwo = num(v)
    return wwo === null ? null : (WWO_TO_WMO[wwo] ?? null)
  }

  // 用观测时间定「现在几点」，再据此截当天剩余的小时
  const obs = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(cc.observation_time || ''))
  let curHour = 0
  if (obs) {
    let hh = Number(obs[1])
    const pm = /PM/i.test(obs[3])
    if (pm && hh !== 12) hh += 12
    if (!pm && hh === 12) hh = 0
    curHour = hh
  }

  const curCode = toWmo(cc.weatherCode)
  const popToday = h.reduce((mx, x) => Math.max(mx, num(x?.chanceofrain) ?? 0), 0)
  // wttr 的当天天气码取中午那一档，比取第一档（凌晨）更能代表「今天什么天」
  const midday = h.find((x) => num(x?.time) === 1200) || h[Math.floor(h.length / 2)] || {}
  const dayCode = toWmo(midday.weatherCode)
  const tmrMid = (arr(tomorrow.hourly).find((x) => num(x?.time) === 1200) || arr(tomorrow.hourly)[4] || {})
  const tmrCode = toWmo(tmrMid.weatherCode)

  // wttr 的 hourly 本身就是 3 小时一档，所以步长是 1 条
  const startIdx = Math.max(0, h.findIndex((x) => num(x?.time) !== null && num(x.time) / 100 >= curHour))
  const hourly = []
  for (let k = startIdx; k < h.length && hourly.length < 6; k++) {
    const x = h[k] || {}
    const code = toWmo(x.weatherCode)
    hourly.push({
      time: wttrHour(x.time),
      temp: num(x.tempC),
      code,
      desc: wmoDesc(code),
      pop: num(x.chanceofrain),
    })
  }

  const name = String(arr(j?.nearest_area)[0]?.areaName?.[0]?.value || city || '')

  return {
    source: 'wttr.in',
    name,
    date: String(today.date || ''),
    isDay: curHour >= 6 && curHour < 19,
    tz: '',
    current: {
      time: `${String(curHour).padStart(2, '0')}:00`,
      temp: num(cc.temp_C),
      feels: num(cc.FeelsLikeC),
      humidity: num(cc.humidity),
      wind: {
        speed: num(cc.windspeedKmph),
        deg: num(cc.winddirDegree),
        dir: dirToZh(cc.winddirDegree),
      },
      code: curCode,
      desc: wmoDesc(curCode),
    },
    daily: {
      max: num(today.maxtempC),
      min: num(today.mintempC),
      sunrise: ampmTo24(ast.sunrise),
      sunset: ampmTo24(ast.sunset),
      uv: num(today.uvIndex),
      pop: h.length ? popToday : null,
      code: dayCode,
      desc: wmoDesc(dayCode),
    },
    hourly,
    tomorrow: {
      date: String(tomorrow.date || ''),
      max: num(tomorrow.maxtempC),
      min: num(tomorrow.mintempC),
      code: tmrCode,
      desc: wmoDesc(tmrCode),
    },
  }
}

/** 降级入口：平时由 fetchWeather 自动调用，导出是为了能单独测到兜底链路 */
export async function fetchWeatherWttr({ city = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const key = String(city || '').trim()
  if (!key) return { ok: false, error: '没有配置城市' }
  const r = await getJson(`https://wttr.in/${encodeURIComponent(key)}?format=j1&lang=zh`, timeoutMs)
  if (!r.ok) return { ok: false, error: `wttr.in 请求失败：${r.error}` }
  if (!arr(r.json?.current_condition).length || !arr(r.json?.weather).length) {
    return { ok: false, error: `wttr.in 没查到「${key}」的天气` }
  }
  const raw = buildRawWttr(r.json, key)
  const name = raw.name || key
  return { ok: true, city: key, resolvedName: name, region: '', text: formatWeatherText(raw, { name }), raw }
}

// ---------- 排版 ----------

/**
 * 把结构化天气拼成适合微信群阅读的多行中文。
 * 任何字段缺失就省掉那一项，绝不出现 undefined/NaN。
 */
export function formatWeatherText(raw, { name = '' } = {}) {
  if (!raw || typeof raw !== 'object') return ''
  const c = raw.current || {}
  const d = raw.daily || {}
  const t = raw.tomorrow || {}
  const title = name || raw.name || ''
  const emoji = weatherEmoji(c.code, raw.isDay)

  const lines = []
  const md = fmtMonthDay(raw.date)
  const wd = fmtWeekday(raw.date)
  lines.push(`${emoji} ${title} · 今日天气${md ? `（${md}${wd ? ` ${wd}` : ''}）` : ''}`)

  // 现在
  const nowParts = []
  const temp = fmt1(c.temp)
  if (temp !== null) nowParts.push(`现在 ${temp}℃`)
  const feels = fmt1(c.feels)
  if (feels !== null) nowParts.push(`体感 ${feels}℃`)
  // 体感塞在中文括号里，所以括号后面不再补空格（对齐「…（体感 -3.0℃）· 晴」的排版）
  let nowLine = nowParts.length === 2 ? `${nowParts[0]}（${nowParts[1]}）` : (nowParts[0] || '')
  if (c.desc) nowLine += (nowLine.endsWith('）') ? '· ' : (nowLine ? ' · ' : '')) + c.desc
  const hum = fmtInt(c.humidity)
  if (hum !== null) nowLine += `${nowLine ? ' ｜ ' : ''}湿度 ${hum}%`
  const ws = fmtTrim(c.wind?.speed)
  const wd2 = String(c.wind?.dir || '')
  if (ws !== null) nowLine += `${nowLine ? ' ｜ ' : ''}${wd2 ? `${wd2}风 ${ws}km/h` : `风速 ${ws}km/h`}`
  else if (wd2) nowLine += `${nowLine ? ' ｜ ' : ''}${wd2}风`
  if (nowLine) lines.push(nowLine)

  // 全天
  const dmin = fmt1(d.min)
  const dmax = fmt1(d.max)
  let dayLine = ''
  if (dmin !== null && dmax !== null) dayLine = `全天 ${dmin}℃ ~ ${dmax}℃`
  else if (dmax !== null) dayLine = `全天最高 ${dmax}℃`
  else if (dmin !== null) dayLine = `全天最低 ${dmin}℃`
  const pop = fmtInt(d.pop)
  if (pop !== null) dayLine += `${dayLine ? ' ｜ ' : ''}降水概率 ${pop}%`
  if (dayLine) lines.push(dayLine)

  // 日出日落 / 紫外线
  let sunLine = ''
  const sr = String(d.sunrise || '')
  const ss = String(d.sunset || '')
  if (sr && ss) sunLine = `日出 ${sr} · 日落 ${ss}`
  else if (sr) sunLine = `日出 ${sr}`
  else if (ss) sunLine = `日落 ${ss}`
  const uv = fmtTrim(d.uv)
  const lv = uvLevel(d.uv)
  if (uv !== null) sunLine += `${sunLine ? ' ｜ ' : ''}紫外线 ${uv}${lv ? `（${lv}）` : ''}`
  if (sunLine) lines.push(sunLine)

  // 逐小时
  const hourly = arr(raw.hourly).filter((x) => x && x.time)
  if (hourly.length) {
    lines.push('')
    lines.push('🕒 逐小时（每 3 小时）')
    for (const x of hourly) {
      const parts = [x.time]
      const tp = fmt1(x.temp)
      if (tp !== null) parts.push(`${tp}℃`)
      if (x.desc) parts.push(x.desc)
      const p = fmtInt(x.pop)
      if (p !== null && Number(p) > 0) parts.push(`☔${p}%`)
      lines.push(parts.join(' '))
    }
  }

  // 明天
  const tmin = fmt1(t.min)
  const tmax = fmt1(t.max)
  let tLine = ''
  if (tmin !== null && tmax !== null) tLine = `明天 ${tmin}℃ ~ ${tmax}℃`
  else if (tmax !== null) tLine = `明天最高 ${tmax}℃`
  else if (tmin !== null) tLine = `明天最低 ${tmin}℃`
  if (t.desc) tLine += `${tLine ? ' ｜ ' : ''}${t.desc}`
  if (tLine) {
    lines.push('')
    lines.push(tLine)
  }

  return lines.join('\n')
}

// ---------- 穿搭建议（纯规则，不依赖 AI） ----------

/**
 * 按温度/温差/降水/风/紫外线算穿搭。纯本地规则，**永远不会失败**。
 * 为什么不用 AI 写：用户要的是「每天稳定有穿搭」，AI 一返回空就只剩天气了（真实事故）。
 */
export function dressingAdvice(raw) {
  if (!raw || typeof raw !== 'object') return ''
  const c = raw.current || {}
  const d = raw.daily || {}
  const max = num(d.max)
  const min = num(d.min)
  const pop = num(d.pop)
  const uv = num(d.uv)
  const wind = num(c.wind?.speed)
  const code = num(d.code)

  const parts = []
  // 主体（按白天最高温定基调）
  const base = max === null ? '' :
    max <= 0 ? '羽绒服 + 厚毛衣，围巾手套别省' :
    max <= 8 ? '厚外套或棉服 + 毛衣，里面再套一件保暖内衣' :
    max <= 15 ? '夹克/风衣 + 长袖 + 薄毛衣，早晚扛得住' :
    max <= 22 ? '薄外套 + 长袖衬衫或 T 恤，刚好舒服' :
    max <= 28 ? '长袖或短袖都行，备一件薄外套在包里' :
    '短袖为主，注意防晒补水'
  if (base) parts.push(base)

  // 温差
  const diff = (max !== null && min !== null) ? (max - min) : null
  if (diff !== null && diff >= 10) parts.push(`昼夜温差 ${fmt1(diff)}℃，早出晚归多带一件`)
  else if (min !== null && min <= 3) parts.push('清晨接近冰点，出门别只穿单件')

  // 降水 / 风 / 紫外线
  if (pop !== null && pop >= 50) parts.push('有雨，记得带伞')
  else if (code !== null && [51,53,55,61,63,65,80,81,82,95,96,99].includes(code)) parts.push('可能下雨，伞放包里')
  if (wind !== null && wind >= 20) parts.push('风不小，外套选防风的')
  if (uv !== null && uv >= 6) parts.push('紫外线强，帽子/防晒安排上')

  return parts.join('；')
}

// ---------- 出行/开车提示（纯规则） ----------

const RAIN_CODES = [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]
const SNOW_CODES = [71, 73, 75, 77, 85, 86]

export function travelAdvice(raw) {
  if (!raw || typeof raw !== 'object') return ''
  const c = raw.current || {}
  const d = raw.daily || {}
  const min = num(d.min)
  const pop = num(d.pop)
  const wind = num(c.wind?.speed)
  const code = num(d.code)
  const parts = []
  if (code !== null && SNOW_CODES.includes(code)) parts.push('有雪，路面可能湿滑结冰，慢一点、别急刹')
  else if ((pop !== null && pop >= 40) || (code !== null && RAIN_CODES.includes(code))) parts.push('可能下雨，路面湿滑，注意车距')
  else if (min !== null && min <= 0) parts.push('清晨低温，桥面/背阴处可能结霜，启动别急加速')
  if (wind !== null && wind >= 20) parts.push('风大，高速上留神横风')
  if (min !== null && min < 5) parts.push('早晚视线差，出门早点、开灯')
  if (!parts.length) parts.push('路况正常，正常开就行')
  return parts.join('；')
}

// ---------- 运势（娱乐向，纯本地确定性生成） ----------

const FORTUNE_LEVELS = [
  { tag: '大吉', text: '今天运气在线，想办的事容易顺' },
  { tag: '小吉', text: '整体挺顺，按计划走就行' },
  { tag: '中平', text: '平稳的一天，别急，慢慢来反而快' },
  { tag: '小凶', text: '小磕碰有点，凡事留个心眼就好' },
]
const FORTUNE_COLORS = ['暖橙', '雾蓝', '松绿', '奶白', '砖红', '烟紫', '麦黄']
const FORTUNE_YI = ['把拖着的事收个尾', '和老朋友聊两句', '早点睡', '整理桌面', '给自己买点好吃的', '出去走走晒太阳', '把想说的话说出口']
const FORTUNE_JI = ['冲动下单', '硬碰硬地争', '熬夜刷手机', '空腹喝咖啡', '把话说太满', '临时改大计划']

/** 简单的字符串哈希 → 同一天同一城市结果稳定，换天就换。 */
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return Math.abs(h)
}

/**
 * 今日运势（娱乐向）。用「日期+城市」做种子，保证当天固定、隔天变化，且不重复调用任何外部服务。
 * @param {object} raw 天气 raw
 * @param {string} salt 一般传城市名，让不同城市看到不同结果
 */
export function fortuneToday(raw, salt = '') {
  const day = String(raw?.date || new Date().toISOString().slice(0, 10))
  const seed = hashStr(day + '|' + String(salt || raw?.name || ''))
  const lv = FORTUNE_LEVELS[seed % FORTUNE_LEVELS.length]
  const color = FORTUNE_COLORS[(seed >> 3) % FORTUNE_COLORS.length]
  const luckyNo = ((seed >> 7) % 99) + 1
  const yi = FORTUNE_YI[(seed >> 11) % FORTUNE_YI.length]
  const ji = FORTUNE_JI[(seed >> 17) % FORTUNE_JI.length]
  return { tag: lv.tag, text: lv.text, color, luckyNo, yi, ji }
}

/**
 * 天气简报：天气 + 穿搭 + 运势，三块**必到**（★ 用户明确要的三样）。
 * 天气取真实数据；穿搭/运势纯本地算 —— 所以 AI 润色挂了也不会缺内容。
 */
export function composeWeatherBrief(raw, { name = '', hint = '' } = {}) {
  const base = formatWeatherText(raw, { name })
  if (!base) return ''
  const dress = dressingAdvice(raw)
  const travel = travelAdvice(raw)
  const f = fortuneToday(raw, name)
  const lines = [base, '']
  if (dress) lines.push(`👕 穿搭：${dress}`)
  if (travel) lines.push(`🚗 出行：${travel}`)
  lines.push(`🔮 运势：${f.tag} · ${f.text}｜幸运色 ${f.color}，幸运数字 ${f.luckyNo}｜宜${f.yi}，忌${f.ji}`)
  if (hint) lines.push(`（今日重点：${String(hint).slice(0, 60)}）`)
  return lines.join('\n')
}

// ---------- 对外主入口 ----------

/**
 * 查天气。成功返回 { ok:true, city, resolvedName, text, raw }，失败返回 { ok:false, error }。
 * 永不抛异常。
 *
 * @param {{ city?: string, timeoutMs?: number }} opts
 */
export async function fetchWeather({ city = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = String(city || '').trim()
  if (!key) return { ok: false, error: '没有配置城市' }

  const first = await fetchWeatherOpenMeteo({ city: key, timeoutMs })
  if (first.ok) return first

  // open-meteo 挂了/被墙了再试 wttr.in：宁可数据糙一点，也别让定时任务今天没得播
  const second = await fetchWeatherWttr({ city: key, timeoutMs })
  if (second.ok) return { ...second, degraded: true, degradedFrom: first.error }

  return { ok: false, error: `天气获取失败：${first.error}；降级 wttr.in 也失败：${second.error}` }
}

export default fetchWeather
