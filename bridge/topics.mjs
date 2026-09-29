/**
 * 选题库域（从 run-bridge.mjs 拆分，2026-08-24）
 * topic-pool.json 读写、一键生成任务（draft-only）、落选删除（仅 rejected，删除前备份）
 *
 * 2026-09-18（v2.01，引擎自治）两项改造：
 *
 * 1. **路径惰性解析**：原先 `const paths = loadPaths()` 在 import 期执行，桥一启动
 *    就把单一路径固化到进程整个生命周期。这既让配置变更无法生效，也使"多项目接入"
 *    在架构上不可能成立（所有项目共用同一份路径）。现改为每次调用重新解析。
 *
 * 2. **不再代跑接入方脚本**：原先 `startTopicGenerate` 直接 spawn
 *    `generateOnceScript`（指向仓库外某个写作项目的 shell 脚本）——引擎执行某个
 *    具体接入方的业务脚本，是边界越界最严重的一处。现改为**能力钩子**：
 *    引擎只做编排（并发保护、状态机、轮询），执行方由接入项目经
 *    `registerGenerateProvider()` 提供；未提供则返回结构化错误，绝不 spawn 外部脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getArticlesDir } from '../crosspost-runtime/src/articles.mjs'
import { pushHumanFeedback } from '../crosspost-runtime/src/editorial-memory.mjs'
import { getTopicPoolFile, getHistoryDir, getLogsDir } from '../crosspost-runtime/src/resources.mjs'
import { currentProject } from '../crosspost-runtime/src/project-context.mjs'
import {
  resolveGenerateProvider,
  callGenerateProvider,
} from '../crosspost-runtime/src/generate.mjs'

/** 懒解析：每次属性读取都反映当前 paths.json/env（见文件头第 1 点） */

/**
 * 栏目**显示顺序**（内建栏目按这个序；项目自定义的栏目排在其后，按名字）。
 *
 * 这里只决定"先后"，不决定"有没有"——栏目 id 由项目声明，引擎不设白名单
 * （校验形状请用 `normalizeSlotId()`）。
 */
const SLOT_ORDER = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']

/** 同一天之内，这个栏目排在第几（未知栏目排在已知栏目之后，而不是用 -1 抢到最前） */
const slotRank = (slot) => {
  const i = SLOT_ORDER.indexOf(slot)
  return i >= 0 ? i : SLOT_ORDER.length
}
// 排序状态优先级：同一天内 未生成(adopted)/已生成(generated) 优先，落选(rejected) 沉底
const TOPIC_STATUS_ORDER = ['generated', 'adopted', 'rejected']

let topicGenTask = null // 当前手动生成任务 {pid, startedAt, state, exitCode, logTail, draftId} | {hook:true,...}

/* ── 生成能力解析（v2.01 钩子；v2.51 增加跨进程 http 提供者）──────────────
 * 引擎不内建生成能力，三层来源按优先级解析（详见 src/generate.mjs 文件头）：
 *   ① 进程内钩子 `registerGenerateProvider()`（内嵌场景，同进程）
 *   ② 当前项目 manifest 的 `capabilities.generate = {kind:"http",url:"…"}`（跨进程）
 *   ③ 无项目上下文时，引擎配置 `generate.provider`
 * ②③ 之间**没有回退**：选中了项目就以那个项目的 manifest 为准，它没声明就是
 * "没有"——否则会复现 v2.33 修掉的那类"界面写 A、实际是 B"的缺陷。 */
let generateProvider = null

/** 注册生成能力提供者（内嵌场景调用）。传 null 可注销。返回注销函数。 */
export function registerGenerateProvider(fn) {
  generateProvider = typeof fn === 'function' ? fn : null
  return () => {
    generateProvider = null
  }
}

/**
 * 解析**当前请求上下文**的生成能力（含进程内钩子层）。
 * @returns {{provided:boolean, kind?:string, source?:string, url?:string, reason?:string, code?:string}}
 */
export function resolveGenerate() {
  if (typeof generateProvider === 'function')
    return { provided: true, kind: 'inprocess', source: '引擎进程内已注册的 provider' }
  return resolveGenerateProvider(currentProject())
}

/** 当前是否具备生成能力（Console/doctor 据此决定是否渲染入口） */
export function hasGenerateProvider() {
  return resolveGenerate().provided
}

/** 读选题库（topic-pool.json），文件缺失/损坏返回空列表 */
export function readTopicPool() {
  try {
    // v2.76：选题库按项目解析（项目上下文 → <内容工作区>/history/topic-pool.json）
    const d = JSON.parse(fs.readFileSync(getTopicPoolFile(), 'utf8'))
    return Array.isArray(d.topics) ? d.topics : []
  } catch {
    return []
  }
}

/** 原子写选题库（tmp+rename） */
export function writeTopicPool(topics) {
  const target = getTopicPoolFile() // v2.76：跟着当前项目走
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const data = {
    _note:
      '选题库:每轮评分后 TOP 1-5 候选全量入库;status=adopted(采用,未生成文章)/generated(已生成,含articleId)/rejected(落选,含reason);落选可经 Console 人工删除(删除前自动备份);generated/adopted 不可删。',
    topics,
  }
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, target)
  return data
}

/**
 * 读文章库，构建 id -> {title,status} 映射供关联展示。
 * 仅解析被选题池引用的 articleId 子集，避免每次 /proxy/topics 全库 readdir+read+parse。
 */
export function loadArticleMeta() {
  // 2026-09-18（v2.01）：改从 articles.mjs 取文章库位置，与 CROSSPOST_ARTICLES_DIR
  // 一致。此前用 paths.workspace 反推，会忽略该环境变量（沙箱隔离下读到真实文章库）。
  const ARTICLES_DIR = getArticlesDir()
  const out = new Map()
  if (!fs.existsSync(ARTICLES_DIR)) return out
  const pool = readTopicPool()
  const wanted = new Set(pool.map((t) => t.articleId).filter(Boolean))
  if (!wanted.size) return out
  for (const id of wanted) {
    const p = path.join(ARTICLES_DIR, `${id}.json`)
    if (!fs.existsSync(p)) continue
    try {
      const a = JSON.parse(fs.readFileSync(p, 'utf8'))
      out.set(a.id, { title: a.title, status: a.status })
    } catch {
      /* skip */
    }
  }
  return out
}

/** 合并选题库 + 文章元信息 → 面板列表（日期新→旧 → 状态优先级 → 栏目 → rank） */
export function listTopics() {
  const pool = readTopicPool()
  const arts = loadArticleMeta()
  const out = pool.map((t) => ({
    ...t,
    articleTitle: t.articleId ? arts.get(t.articleId)?.title || '' : '',
    articleStatus: t.articleId ? arts.get(t.articleId)?.status || '' : '',
  }))
  out.sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      TOPIC_STATUS_ORDER.indexOf(a.status) - TOPIC_STATUS_ORDER.indexOf(b.status) ||
      slotRank(a.slot) - slotRank(b.slot) ||
      (a.rank ?? 99) - (b.rank ?? 99),
  )
  return out
}

/** 删除落选选题（仅 status=rejected；删除前自动备份；generated/adopted 拒绝）。authorized 校验在路由层 */
export function deleteTopic(id) {
  const topics = readTopicPool()
  const target = topics.find((t) => t.id === id)
  if (!target) return { error: `选题不存在: ${id}` }
  if (target.status !== 'rejected') {
    return {
      error: `仅允许删除落选(rejected)选题，当前状态=${target.status}（generated/adopted 不可删）`,
    }
  }
  // 删除前自动备份整个选题库（防误删，与文章库每日备份同思路；本地时区时间戳）
  try {
    const bakDir = path.join(getHistoryDir(), 'backups') // v2.76：项目级
    fs.mkdirSync(bakDir, { recursive: true })
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    fs.copyFileSync(getTopicPoolFile(), path.join(bakDir, `topic-pool-${stamp}.json`))
  } catch {
    /* 备份失败不阻塞删除（记录在返回里） */
  }
  const remaining = topics.filter((t) => t.id !== id)
  writeTopicPool(remaining)
  // 编辑记忆：人工删除落选选题 = 负反馈（2026-08-25 B-1；失败不阻塞删除）
  try {
    pushHumanFeedback('topic-delete', { id, keyword: target.keyword, reason: target.reason })
  } catch {
    /* 记忆写入失败不阻塞 */
  }
  return { ok: true, deleted: target, remaining: remaining.length }
}

/**
 * 启动一键生成任务（v2.01：改为**能力钩子**，引擎不再 spawn 任何外部脚本）
 *
 * 执行由接入项目注册的 provider 负责；引擎只做：
 *   ① 并发保护（同一时刻仅一个任务）② 状态机（running/done/failed）③ 轮询读取
 * provider 应返回 { taskId?, logFile? } 或 { error }。未注册 provider 时返回
 * 结构化错误 `generate_not_provided`，**绝不**回退到执行外部脚本。
 */
export function startTopicGenerate(slot, keyword) {
  return new Promise((resolve) => {
    if (topicGenTask && topicGenTask.state === 'running') {
      resolve({ error: '已有生成任务在运行，请等待完成' })
      return
    }
    const gen = resolveGenerate()
    if (!gen.provided) {
      // 能力缺项：明确告知，而非静默失败或越界代跑（Console 据此隐藏入口）
      resolve({
        error: 'generate_not_provided',
        message:
          '当前接入项目未提供「一键生成」能力（引擎不再代跑外部脚本）。' +
          `原因：${gen.reason || '未声明'}。` +
          '项目侧可在 manifest 里声明 HTTP 端点：' +
          '"capabilities": { "generate": { "kind": "http", "url": "http://127.0.0.1:<port>/generate" } }，' +
          '详见 docs/integration.md。',
        capability: 'generate',
        provided: false,
        code: gen.code || null,
        reason: gen.reason || null,
      })
      return
    }
    // 本地时区日期（沿用历史日志命名 date +%Y-%m-%d）
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const logFile = path.join(getLogsDir(), `run-${slot}-${localDate}-manual.log`) // v2.76：项目级

    topicGenTask = {
      pid: null,
      slot,
      keyword,
      state: 'running',
      startedAt: new Date().toISOString(),
      exitCode: null,
      logFile,
      draftId: null,
      logTail: '',
      hook: true,
      via: gen.kind,
      provider: { kind: gen.kind, source: gen.source || null, url: gen.url || null },
    }

    // http 提供者由引擎发一次 POST（异步任务还会轮询状态端点）；进程内钩子直接调用。
    // 两者返回结构一致：{taskId?, logFile?, logTail?, error?, message?}
    const runProvider =
      gen.kind === 'http'
        ? () =>
            callGenerateProvider(gen, {
              slot,
              keyword,
              projectId: gen.projectId,
              onProgress: applyProviderProgress,
            })
        : () => generateProvider(slot, keyword)

    Promise.resolve()
      .then(runProvider)
      .then((out) => {
        const r = out && typeof out === 'object' ? out : {}
        if (topicGenTask.state !== 'running') return // provider 已自行收敛状态，勿覆盖
        if (r.error) {
          topicGenTask.state = 'failed'
          topicGenTask.exitCode = 1
          // v2.51：把**人话**留给 Console。此前只存 `r.error`（一个错误码），
          // 用户看到的就是 `generate_provider_timeout` 这种裸码——正是 v2.42 修过
          // 的那类"只显示错误码"的毛病。
          topicGenTask.error = String(r.message || r.error)
          topicGenTask.errorCode = String(r.error)
        } else {
          topicGenTask.state = 'done'
          topicGenTask.exitCode = 0
        }
        topicGenTask.finishedAt = new Date().toISOString()
        // draftId 与 taskId 是两件事（v2.54 修）：
        //   · http 提供者：taskId 是**它自己的任务号**，draftId 才是生成的草稿 id；
        //     它没报 draftId 时**绝不**用 taskId 顶替——否则选题库会写入一个
        //     不存在的 articleId，Console 的「查看《…》」链接必然 404。
        //   · 进程内旧钩子：契约里 taskId 本来就是草稿 id，保持原语义。
        if (r.draftId) topicGenTask.draftId = String(r.draftId)
        else if (r.taskId && gen.kind !== 'http') topicGenTask.draftId = String(r.taskId)
        if (r.taskId) topicGenTask.providerTaskId = String(r.taskId)
        if (r.logFile) topicGenTask.logFile = String(r.logFile)
        if (r.logTail) topicGenTask.logTail = String(r.logTail).split('\n').slice(-6).join('\n')
        if (topicGenTask.state === 'done')
          backfillGeneratedTopic(slot, keyword, topicGenTask.draftId)
      })
      .catch((e) => {
        if (topicGenTask.state !== 'running') return
        topicGenTask.state = 'failed'
        topicGenTask.exitCode = 1
        topicGenTask.error = String((e && e.message) || e)
        topicGenTask.finishedAt = new Date().toISOString()
      })

    resolve({
      ok: true,
      task: { state: 'running', logFile, via: 'provider', providerKind: gen.kind },
    })
  })
}

/**
 * 把提供者上报的进度同步进当前任务（供 Console 轮询显示）。
 *
 * v2.51：异步 http 任务可能跑几十分钟，期间 Console 只能靠 `/proxy/topics/…/status`
 * 看到进度。没有这个回调，界面上就是一串"运行中"直到某刻突然结束——用户无法
 * 判断它是慢还是卡死。
 */
function applyProviderProgress(p) {
  if (!topicGenTask || topicGenTask.state !== 'running') return
  if (p.draftId) topicGenTask.draftId = String(p.draftId)
  if (p.taskId) topicGenTask.providerTaskId = String(p.taskId)
  if (p.logFile) topicGenTask.logFile = String(p.logFile)
  if (typeof p.logTail === 'string' && p.logTail)
    topicGenTask.logTail = p.logTail.split('\n').slice(-6).join('\n')
}

/** 生成成功后回填选题库 articleId + status（失败不阻塞） */
function backfillGeneratedTopic(slot, keyword, draftId) {
  try {
    const topics = readTopicPool()
    const target = topics.find(
      (t) => t.slot === slot && t.keyword === keyword && t.status !== 'generated',
    )
    if (target && draftId) {
      target.status = 'generated'
      target.articleId = draftId
      target.reason = 'Console 一键生成'
      writeTopicPool(topics)
    }
  } catch {
    /* 回填失败不阻塞 */
  }
}

/**
 * 当前生成任务状态（供轮询）。
 *
 * v2.01：附带 `provided`，Console 据此决定是否渲染入口。
 * v2.51：附带 `provider`（谁提供、经什么、端点在哪）—— 多项目下"按钮为什么
 * 能点/不能点"必须能自证，否则又回到"界面说 A、实际是 B"那一类。
 */
export function getTopicGenStatus() {
  const gen = resolveGenerate()
  const provider = gen.provided
    ? {
        kind: gen.kind,
        source: gen.source || null,
        url: gen.url || null,
        projectId: gen.projectId ?? null,
      }
    : null
  const unavailable = gen.provided ? null : { code: gen.code || null, reason: gen.reason || null }

  if (!topicGenTask) return { state: 'idle', provided: gen.provided, provider, unavailable }
  return {
    state: topicGenTask.state,
    provided: gen.provided,
    provider: provider || topicGenTask.provider || null,
    providerKind: topicGenTask.via || null,
    unavailable,
    via: topicGenTask.hook ? 'provider' : null,
    slot: topicGenTask.slot,
    keyword: topicGenTask.keyword,
    startedAt: topicGenTask.startedAt,
    finishedAt: topicGenTask.finishedAt || null,
    exitCode: topicGenTask.exitCode,
    draftId: topicGenTask.draftId || null,
    providerTaskId: topicGenTask.providerTaskId || null,
    logFile: topicGenTask.logFile || null,
    logTail: topicGenTask.logTail || '',
    error: topicGenTask.error || null,
    errorCode: topicGenTask.errorCode || null,
  }
}
