// 选题库视图（2026-08-24 app.js 拆分 Phase 1）
import { getJSON, postJSON } from './api.mjs'
import { TOPICS_PAGE_SIZE } from './const.mjs'
import { slotName } from './slot-lexicon.mjs'
import { store } from './state.mjs'
import { $, escapeHtml, fmtTime, renderPager } from './utils.mjs'
import { loadArticles } from './views-articles.mjs'

/**
 * 读选题库并重渲染列表。
 * @param {{ keepBanner?: boolean }} [opts] keepBanner=true 时不动状态条——
 *   轮询收尾会先写 done/failed 再调本函数（用于回填关联文章），此时必须保留结果条。
 */
export async function loadTopics(opts = {}) {
  try {
    const data = await getJSON('/proxy/topics')
    store.topics = data.topics || []
    renderTopicFilters()
    applyTopicFilters()
  } catch (err) {
    $('#topics-tbody').innerHTML =
      `<tr><td colspan="7" class="empty">无法连接 Bridge: ${escapeHtml(err.message)}</td></tr>`
  }
  // 能力探测（v2.42）：后端 `/proxy/topics/generate` 在"未提供能力"时返回 **501**，
  // 路由注释里写的是"Console 依 provided:false 隐藏入口"——而此前 Console 从不问，
  // 于是页面上摆着 24 个点了必然失败的「一键生成」按钮。
  // 只有**显式** provided === false 才禁用：字段缺失（老的 mock / 桥未升级）时不改行为。
  try {
    const st = await getJSON('/proxy/topics/generate/status')
    store.topicGenProvided = st && st.provided === false ? false : true
    // v2.51：能力可以来自「项目 manifest 声明的 HTTP 端点」或「引擎进程内钩子」，
    // 多项目下同一个页面在不同项目上答案不同——把来源留在手边，别只留一个布尔。
    store.topicGenProvider = (st && st.provider) || null
    store.topicGenUnavailable = (st && st.unavailable) || null
  } catch {
    store.topicGenProvided = true
    store.topicGenProvider = null
    store.topicGenUnavailable = null
  }
  applyGenerateAvailability()
  // 状态条只表达"生成/删除进行中的事"：轮询那一路在收尾时会自行写入 done/failed；
  // 其余情况（首屏进入、手动刷新列表）一律收回，避免残留上次结果或 HTML 里的静态兜底文案。
  if (!opts.keepBanner && !store.topicGenPoll) dismissTopicBanner()
}

/** 能力未提供时：禁用所有「一键生成」按钮并说明原因（而不是让人点了才知道） */
function applyGenerateAvailability() {
  const btns = document.querySelectorAll('#topics-tbody [data-gen-slot]')
  if (store.topicGenProvided === false) {
    const why =
      (store.topicGenUnavailable && store.topicGenUnavailable.reason) ||
      '当前接入项目未提供「一键生成」能力（引擎不再代跑外部脚本）'
    for (const b of btns) {
      b.disabled = true
      b.title = `${why} · 运行 npm run doctor 查看详情`
    }
    return
  }
  // v2.51：可用时也把来源写在按钮上——"这个按钮背后是谁"应当一点就知，
  // 否则切了项目之后没人能解释为什么某天能点、某天不能点。
  const p = store.topicGenProvider
  if (p && (p.source || p.url)) {
    const desc = `「一键生成」由 ${p.source || p.kind} 提供${p.url ? ` · 端点 ${p.url}` : ''}`
    for (const b of btns) if (!b.title) b.title = desc
  }
}

/** 收起状态条（回到 idle）：隐藏 + 清空（index.html 的静态兜底文案只服务"JS 尚未接管"的窗口） */
function dismissTopicBanner() {
  const el = $('#topics-banner')
  if (!el) return
  el.className = 'tgen tgen--idle hidden'
  el.textContent = ''
  el.removeAttribute('aria-busy')
}

function renderTopicFilters() {
  const sel = $('#tf-slot')
  const cur = sel.value
  const slots = [...new Set(store.topics.map((t) => t.slot))].sort((a, b) =>
    slotName(a).localeCompare(slotName(b)),
  )
  sel.innerHTML =
    '<option value="">全部栏目</option>' +
    slots.map((s) => `<option value="${s}">${escapeHtml(slotName(s))}</option>`).join('')
  sel.value = cur
}

function applyTopicFilters() {
  store.topicsFilter = {
    slot: $('#tf-slot').value,
    status: $('#tf-status').value,
    date: $('#tf-date').value,
    q: $('#tf-q').value.trim().toLowerCase(),
  }
  store.topicsPage = 1
  renderTopics()
}

function filteredTopics() {
  const f = store.topicsFilter
  let list = store.topics.filter((t) => {
    if (f.slot && t.slot !== f.slot) return false
    if (f.status && t.status !== f.status) return false
    if (
      f.q &&
      !(
        String(t.keyword || '')
          .toLowerCase()
          .includes(f.q) ||
        String(t.title || '')
          .toLowerCase()
          .includes(f.q)
      )
    )
      return false
    if (f.date) {
      const days = f.date === '7d' ? 7 : 30
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      if ((t.date || '') < cutoff) return false
    }
    return true
  })
  // 内建栏目按固定序；项目自定义的栏目排在其后（`indexOf` 未命中是 -1，会把它抢到最前，
  // 所以这里显式映射成"已知序之后"）——栏目 id 由项目声明，引擎不设白名单。
  const SLOT_ORDER = ['morning', 'hotspot', 'noon', 'hotspot2', 'tips', 'evening']
  const slotRank = (slot) => {
    const i = SLOT_ORDER.indexOf(slot)
    return i >= 0 ? i : SLOT_ORDER.length
  }
  const STATUS_ORDER = ['generated', 'adopted', 'rejected'] // 同一天内 可操作(生成/未生成) 优先，落选沉底
  list.sort(
    (a, b) =>
      (b.date || '').localeCompare(a.date || '') ||
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      slotRank(a.slot) - slotRank(b.slot) ||
      (a.rank ?? 99) - (b.rank ?? 99),
  )
  return list
}

function topicStatusBadge(t) {
  if (t.status === 'generated') return '<span class="tstatus gen">✓ 已生成</span>'
  if (t.status === 'adopted') return '<span class="tstatus pend">◔ 未生成</span>'
  return `<span class="tstatus rej">✕ 落选</span>${t.reason ? `<div class="t-reason" title="${escapeHtml(t.reason)}">${escapeHtml((t.reason || '').slice(0, 40))}</div>` : ''}`
}

function renderTopics() {
  const list = filteredTopics()
  const total = list.length
  const pages = Math.max(1, Math.ceil(total / TOPICS_PAGE_SIZE))
  if (store.topicsPage > pages) store.topicsPage = pages
  const pageList = list.slice(
    (store.topicsPage - 1) * TOPICS_PAGE_SIZE,
    store.topicsPage * TOPICS_PAGE_SIZE,
  )

  $('#topics-summary').textContent =
    `共 ${total} 条 · 已生成 ${list.filter((t) => t.status === 'generated').length} · 未生成 ${list.filter((t) => t.status === 'adopted').length} · 落选 ${list.filter((t) => t.status === 'rejected').length}`

  const tb = $('#topics-tbody')
  if (!pageList.length) {
    $('#topics-empty').classList.remove('hidden')
    tb.innerHTML = ''
  } else {
    $('#topics-empty').classList.add('hidden')
    tb.innerHTML = pageList
      .map((t) => {
        // 评分展示：有分显示分值；legacy（v2 规则前无评分）降级显示"旧"，其余无分显示 —（2026-08-24 迁移）
        const sc =
          typeof t.topicScore === 'number'
            ? `<span class="score-badge ${t.topicScore >= 40 ? 'pass' : 'fail'}">${t.topicScore}</span>`
            : t.legacy
              ? '<span style="color:var(--ink-faint);font-size:11px" title="v2 评分规则前数据，无历史评分">旧</span>'
              : '<span style="color:var(--ink-faint)">—</span>'
        const linked = t.articleId
          ? `<a href="#/articles/${encodeURIComponent(t.articleId)}" class="t-article">${escapeHtml(t.articleTitle || t.articleId)}</a><div class="t-reason">${escapeHtml(t.articleStatus || '')}</div>`
          : '<span style="color:var(--ink-faint)">—</span>'
        const canGen = t.status !== 'generated' || !t.articleId
        const genBtn = canGen
          ? `<button class="btn mini ${t.status === 'rejected' ? 'ghost' : 'primary'}" data-gen-slot="${escapeHtml(t.slot)}" data-gen-keyword="${escapeHtml(t.keyword)}" data-gen-date="${escapeHtml(t.date)}" data-gen-id="${escapeHtml(t.id)}">一键生成</button>`
          : ''
        // 落选选题可删除（仅 rejected；删除前自动备份）；generated/adopted 不可删
        const delBtn =
          t.status === 'rejected'
            ? `<button class="btn mini danger" data-del-id="${escapeHtml(t.id)}" data-del-keyword="${escapeHtml(t.keyword)}" title="删除落选选题（自动备份，不可恢复）">删除</button>`
            : ''
        const actCell =
          [genBtn, delBtn].filter(Boolean).join(' ') ||
          '<span style="color:var(--ink-faint)">—</span>'
        return `<tr>
        <td class="nowrap">${t.date || ''}</td>
        <td class="nowrap">${escapeHtml(slotName(t.slot))}</td>
        <td><b>${escapeHtml(t.keyword || '')}</b>${t.title ? `<div class="t-reason">${escapeHtml((t.title || '').slice(0, 48))}</div>` : ''}</td>
        <td>${sc}</td>
        <td>${topicStatusBadge(t)}</td>
        <td>${linked}</td>
        <td class="nowrap">${actCell}</td>
      </tr>`
      })
      .join('')
  }
  renderPager(
    $('#topics-pager'),
    total,
    store.topicsPage,
    (pg) => {
      store.topicsPage = pg
      renderTopics()
    },
    TOPICS_PAGE_SIZE,
  )
}

/* ── 选题库「一键生成」状态条（2026-09-17 重构）──
   原来每次轮询都整条 innerHTML 覆盖、颜色内联写死（深色主题下 spinner 看不见），
   且成功后只留一个 draftId、丢掉了"哪个栏目/哪条选题"。现在：
   ① topicBannerView 是纯函数（状态对象 → HTML），四态结构固定；
   ② renderTopicBanner 只负责 class 切换 + 写入，running 期间仅由计时器更新时长文本；
   ③ 颜色/结构全部走 .tgen 组件族（styles.css），明暗两主题自动成立。 */

/** 状态对象 → 状态条 HTML（纯函数，无 DOM/请求依赖，便于单测） */
export function topicBannerView(st = {}) {
  const s = st.state || 'idle'
  if (s === 'idle') return ''
  const slot = slotName(st.slot) || ''
  const kw = String(st.keyword || '')
  const kwHtml = kw
    ? `<div class="tgen-meta"><span class="tgen-kw" title="${escapeHtml(kw)}">${escapeHtml(kw)}</span><span class="tgen-time" data-tgen-time>${escapeHtml(topicGenElapsed(st))}</span></div>`
    : ''
  // 内容条：footer 有内容时与 meta 同层排一行，避免多出一条空气泡
  const addBar = (footer) =>
    (footer ? `<div class="tgen-bar-slot">${footer}</div>` : '') +
    '<div class="tgen-bar"><i></i></div>'

  if (s === 'running') {
    const sub = st.sub || '正在生成（仅写草稿，不推送）'
    return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成中')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-pill">${escapeHtml(st.pill || '仅写草稿，不推送')}</span>
      </div>
      <div class="tgen-head"><span class="tgen-sub">${escapeHtml(sub)}</span></div>
      ${kwHtml}
      ${addBar('')}`
  }

  if (s === 'done') {
    const title = st.articleTitle || st.draftId || ''
    const link = st.draftId
      ? `<a href="#/articles/${encodeURIComponent(st.draftId)}">查看《${escapeHtml(title)}》</a>`
      : ''
    return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成完成')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-sub">${escapeHtml(st.sub || '草稿已进入文章列表（未推送）')}</span>
      </div>
      ${kwHtml}
      ${addBar(`<div class="tgen-actions">${link}</div>`)}`
  }

  // failed（或删除等一过性操作的结果：由调用方给 title/sub/pill/tone）
  const head = st.sub || '生成失败'
  const tail = st.logTail ? String(st.logTail).slice(0, 400) : ''
  const details = tail
    ? `<details class="tgen-details"><summary>失败日志（尾部 400 字符）</summary><pre>${escapeHtml(tail)}</pre></details>`
    : ''
  const retry =
    s === 'failed' && st.slot && st.keyword
      ? `<button class="btn mini ghost" data-tgen-retry="${escapeHtml(st.slot)}" data-tgen-kw="${escapeHtml(st.keyword)}">重试</button>`
      : ''
  return `
      <div class="tgen-head">
        <span class="tgen-dot"></span>
        <span class="tgen-title">${escapeHtml(st.title || '生成失败')}${slot ? ` · ${escapeHtml(slot)}` : ''}</span>
        <span class="tgen-sub">${escapeHtml(head)}</span>
      </div>
      ${kwHtml}
      ${addBar(`<div class="tgen-actions">${retry}</div>${details}`)}`
}

/** 逻辑状态名 → DOM 修饰类名（done/failed 对外统一表现为"完成色/失败色" ok/err） */
const BANNER_TONE = { done: 'ok', failed: 'err' }

/** 写入状态条：classList 恒为 tgen + 状态修饰；idle 隐藏（不再借用 .pstats）
 *  tone 可显式覆盖（"删除落选选题"用 tone:'accent'——一过性操作，不假装生成成功/失败） */
function renderTopicBanner(st = {}) {
  const el = $('#topics-banner')
  if (!el) return
  const state = st.state || 'idle'
  const tone = st.tone || BANNER_TONE[state] || 'accent'
  el.className = `tgen tgen--${state} tgen--${tone}${state === 'idle' ? ' hidden' : ''}`
  el.innerHTML = topicBannerView(st)
  if (state === 'running') el.setAttribute('aria-busy', 'true')
  else el.removeAttribute('aria-busy')
}

/** 失败态（前端异常 / 启动 409 / 能力未提供 等）：沿用状态条结构，保留重试入口
 *
 * v2.42：允许调用方用 `ctx.title` / `ctx.sub` 覆盖默认文案——"当前接入项目未提供
 * 该能力"与"生成失败（exit=?）"是两回事，混在一起会让人以为功能坏了。 */
function renderTopicBannerError(msg, ctx = {}) {
  renderTopicBanner({
    ...ctx,
    state: 'failed',
    title: ctx.title || undefined,
    sub: ctx.sub || '启动失败',
    logTail: ctx.logTail || String(msg || ''),
  })
}

/** 时长文案：running 用 startedAt→now（每秒刷新），done/failed 用 startedAt→finishedAt 并带起跑时刻 */
export function topicGenElapsed(st = {}, now = Date.now()) {
  const t0 = Date.parse(st.startedAt || '')
  if (!t0) return ''
  const t1 = st.finishedAt ? Date.parse(st.finishedAt) : now
  if (!t1) return ''
  const s = Math.max(0, Math.round((t1 - t0) / 1000))
  const dur = s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  if (st.finishedAt) return `${fmtTime(st.startedAt)} 起跑 · 用时 ${dur}`
  return `已运行 ${dur}`
}

/** 运行中：只更新时长文本（不重建整条 HTML，避免每秒重排 + 丢焦点） */
function tickTopicBannerTime(st) {
  const el = document.querySelector('#topics-banner [data-tgen-time]')
  if (!el || !el.offsetParent) return
  el.textContent = topicGenElapsed(st)
}

function stopTopicBannerTick() {
  if (store.topicBannerTick) {
    clearInterval(store.topicBannerTick)
    store.topicBannerTick = null
  }
}

function startTopicBannerTick(cm) {
  stopTopicBannerTick()
  store.topicBannerTick = setInterval(() => tickTopicBannerTime(cm), 1000)
}

/** 一键生成（draft-only，恒不推送）：立即进 running，再按 4s 轮询推进到 done/failed */
async function startTopicGenerate(slot, keyword) {
  const btn = document.querySelector(
    `[data-gen-slot="${CSS.escape(slot)}"][data-gen-keyword="${CSS.escape(keyword)}"]`,
  )
  if (btn) {
    btn.disabled = true
    btn.textContent = '生成中…'
  }
  const started = { state: 'running', slot, keyword, startedAt: new Date().toISOString() }
  renderTopicBanner(started)
  startTopicBannerTick(started)
  try {
    const r = await postJSON('/proxy/topics/generate', { slot, keyword })
    // v2.42：优先透出后端的**人类可读 message**。
    // 此前只 `throw new Error(r.error)`，于是"当前接入项目未提供「一键生成」能力"
    // 这句解释被丢掉，使用者只看到 `generate_not_provided` 这个错误码，
    // 会以为功能坏了——实际是 P0 起改由项目侧提供能力（见 doctor 的 generate-capability）。
    if (r.error) {
      const e = new Error(r.message || r.error)
      e.code = r.error
      throw e
    }
    // 轮询状态直至 done/failed
    clearInterval(store.topicGenPoll)
    const poll = setInterval(async () => {
      try {
        const st = await getJSON('/proxy/topics/generate/status')
        if (st.state === 'running') {
          renderTopicBanner({ ...st, state: 'running' })
          tickTopicBannerTime(st)
          return
        }
        clearInterval(poll)
        store.topicGenPoll = null
        stopTopicBannerTick()
        if (st.state === 'done') {
          renderTopicBanner({ ...st, state: 'done' })
        } else {
          // 头行给 exit 码，副行给后端 error（缺 error 时不留空，也不与标题"生成失败"重复）
          renderTopicBanner({
            ...st,
            state: 'failed',
            title: `生成失败（exit=${st.exitCode ?? '?'}）`,
            sub: st.error || '进程退出，详见下方日志',
          })
        }
        await loadTopics({ keepBanner: true })
        await loadArticles()
        // 关联文章标题只有在 loadTopics() 之后才知道：补一次成功态文案（不改结构）
        if (st.state === 'done' && st.draftId) {
          const t = (store.topics || []).find((x) => x.articleId === st.draftId)
          if (t && t.articleTitle) {
            const doneState = { ...st, state: 'done', articleTitle: t.articleTitle }
            renderTopicBanner(doneState)
            startTopicBannerTick(doneState)
          }
        }
      } catch (e) {
        clearInterval(poll)
        store.topicGenPoll = null
        stopTopicBannerTick()
        renderTopicBannerError(String(e.message || e), {
          slot,
          keyword,
          startedAt: started.startedAt,
        })
      }
    }, 4000)
    store.topicGenPoll = poll
  } catch (e) {
    stopTopicBannerTick()
    // 「能力未提供」不是"生成失败"：给出可执行的说明，并提示去 doctor 看详情
    const notProvided = e && e.code === 'generate_not_provided'
    renderTopicBannerError(String(e.message || e), {
      slot,
      keyword,
      startedAt: started.startedAt,
      ...(notProvided
        ? {
            title: '「一键生成」不可用',
            sub: '当前接入项目未提供该能力（引擎不再代跑外部脚本）· 可运行 npm run doctor 查看详情',
          }
        : {}),
    })
    if (btn) {
      btn.disabled = false
      btn.textContent = '一键生成'
    }
  }
}

/** 删除落选选题（仅 rejected；删除前 bridge 自动备份；generated/adopted 接口拒绝） */
async function deleteTopic(id, keyword) {
  const tone = { tone: 'accent', pill: '删除前自动备份' }
  renderTopicBanner({
    ...tone,
    state: 'running',
    title: '删除中',
    sub: '正在移除落选选题（备份 topic-pool.json 后生效）',
    keyword: keyword || id,
    startedAt: new Date().toISOString(),
  })
  try {
    const r = await postJSON('/proxy/topics/delete', { id, authorized: true })
    if (r.error) throw new Error(r.error)
    renderTopicBanner({
      ...tone,
      state: 'done',
      title: '已删除',
      sub: `落选选题「${(r.deleted && r.deleted.keyword) || keyword || id}」已移除（剩余 ${r.remaining} 条选题）`,
    })
    await loadTopics()
  } catch (e) {
    renderTopicBanner({
      ...tone,
      state: 'failed',
      title: '删除失败',
      sub: String(e.message || e),
    })
  }
}

/** 视图初始化：绑定选题库事件 */
export function initTopicsView() {
  $('#tf-slot').addEventListener('change', applyTopicFilters)
  $('#tf-status').addEventListener('change', applyTopicFilters)
  $('#tf-date').addEventListener('change', applyTopicFilters)
  $('#tf-q').addEventListener('input', applyTopicFilters)
  $('#topics-tbody').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-id]')
    if (delBtn) {
      const id = delBtn.dataset.delId
      const keyword = delBtn.dataset.delKeyword
      if (
        !confirm(
          `删除落选选题「${keyword}」？\n\n将从选题库移除（已自动备份 topic-pool.json，备份文件在 history/backups/）。\n仅允许删除落选(rejected)选题，此操作不可撤销。`,
        )
      )
        return
      deleteTopic(id, keyword)
      return
    }
    const btn = e.target.closest('[data-gen-slot]')
    if (!btn) return
    const slot = btn.dataset.genSlot
    const keyword = btn.dataset.genKeyword
    const date = btn.dataset.genDate
    if (
      !confirm(
        `一键生成（仅写草稿，不推送）？\n\n栏目: ${slotName(slot)}（${date}）\n选题: ${keyword}\n\n生成后草稿进入文章列表，由人工后续操作。`,
      )
    )
      return
    startTopicGenerate(slot, keyword)
  })
  // 状态条上的「重试」（失败态）：用原 slot + 关键词再跑一次（恒 draft-only）。
  // 状态条在 #topics-tbody 之外，故单独委托。
  $('#topics-banner').addEventListener('click', (e) => {
    const retry = e.target.closest('[data-tgen-retry]')
    if (!retry) return
    const slot = retry.dataset.tgenRetry
    const keyword = retry.dataset.tgenKw
    if (!confirm(`重试一键生成（仅写草稿，不推送）？\n\n栏目: ${slotName(slot)}\n选题: ${keyword}`))
      return
    startTopicGenerate(slot, keyword)
  })
}
