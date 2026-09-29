/**
 * 选题库「一键生成」状态条（#topics-banner）四态冒烟 + 截图（2026-09-17）
 *
 * 设计取舍：状态条的四态（running / done / failed / idle）里，running/done/failed 都依赖
 * 一次真实生成任务（会写接入项目的 drafts/ 并消耗 token）。
 * 本脚本**只验证前端状态机**：把 `/proxy/topics/generate`（POST）与
 * `/proxy/topics/generate/status`（GET）用 page.route 接管，绝不放真实任务出去。
 *
 * 运行：node tests/console-topics-banner.mjs          （需 Console 在跑；系统 Chrome）
 *       CONSOLE_TEST_PORT=9540 node tests/console-topics-banner.mjs
 *       BANNER_SHOT_DIR=/tmp node tests/console-topics-banner.mjs   （默认 /tmp）
 */
// v2.3.1：playwright 由 crosspost-runtime 那棵树提供（core 不再单独装依赖树），走包名解析
import { chromium } from 'playwright'

const PORT = Number(process.env.CONSOLE_TEST_PORT || 9540)
const BASE = `http://127.0.0.1:${PORT}`
const SHOT_DIR = process.env.BANNER_SHOT_DIR || '/tmp'
const results = []

// 状态接口的当前应答；测试内逐步改写
let statusPayload = { state: 'idle' }
let lastGenerateBody = null

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 720 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text())
})
page.on('dialog', (d) => d.accept())

await page.route('**/proxy/topics/generate/status*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(statusPayload),
  }),
)
await page.route('**/proxy/topics/generate', (route) => {
  if (route.request().method() === 'POST') {
    try {
      lastGenerateBody = JSON.parse(route.request().postData() || '{}')
    } catch {
      lastGenerateBody = null
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, task: { pid: 1, state: 'running' } }),
    })
  }
  return route.continue()
})

const banner = page.locator('#topics-banner')
const cls = () => banner.getAttribute('class')
const text = async () => (await banner.textContent()).replace(/\s+/g, ' ').trim()
// 截图：用 locator 截图（自动滚入视口；page.clip 在元素位于视口外时会截空/报错）
const shot = async (name) => {
  if ((await banner.count()) === 0) return
  await banner.screenshot({
    path: `${SHOT_DIR}/crosspost-banner-${name}.png`,
    animations: 'disabled',
  })
}

// 再次点同一行：mock 下生成永不真正结束，按钮会保持 disabled（真实环境由轮询后的 loadTopics 重建表格）
const clickFirstGen = async () => {
  const b = page.locator('#topics-tbody [data-gen-slot]').first()
  await b.evaluate((el) => {
    el.disabled = false
  })
  await b.click()
}

try {
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 20000 })

  // v2.79：选题库是**项目级**资源——不选项目时默认域是空的，表格里没有可生成行。
  // 所以先像用户那样选上项目（未接入项目的部署则记录跳过，而不是让 locator 超时）。
  const projectIds = await page.$$eval('#project-select option', (os) =>
    os.map((o) => o.value).filter(Boolean),
  )
  const pid = projectIds[0] || ''
  if (pid) {
    await page.selectOption('#project-select', pid)
    await page.waitForTimeout(400)
  }
  await page.click('.tab[data-view="topics"]')
  await page
    .waitForFunction(
      () => document.querySelectorAll('#topics-tbody [data-gen-slot]').length > 0,
      null,
      { timeout: 15000 },
    )
    .catch(() => {})
  await page.waitForTimeout(300)
  results.push([
    '选题作用域',
    true,
    pid ? `项目 ${pid}（选题库按项目解析，v2.76+）` : '未接入项目（跳过）',
  ])

  const firstBtn = page.locator('#topics-tbody [data-gen-slot]').first()
  const slot = await firstBtn.getAttribute('data-gen-slot')
  const keyword = await firstBtn.getAttribute('data-gen-keyword')
  results.push([
    '选题库有可生成行',
    !!(slot && keyword),
    `${slot} / ${String(keyword).slice(0, 18)}…`,
  ])

  // 1) idle：未点之前必须是隐藏 + 空 HTML（不再是常驻的 pstats 一行）
  results.push([
    'idle·隐藏且无 pstats 残类',
    (await cls()).includes('hidden') &&
      !(await cls()).includes('pstats') &&
      (await text()).trim() === '',
    await cls(),
  ])

  // 2) running：点击 → confirm（脚本自动接受）→ 立刻进入 running 骨架，不等第一次轮询
  statusPayload = {
    state: 'running',
    slot,
    keyword,
    startedAt: new Date(Date.now() - 65000).toISOString(),
    finishedAt: null,
    exitCode: null,
    draftId: null,
    logFile: null,
    logTail: '',
    error: null,
  }
  await firstBtn.click()
  await page.waitForTimeout(400)
  const runText = await text()
  results.push([
    'running·骨架与身份',
    (await cls()).includes('tgen--running') &&
      (await banner.getAttribute('aria-busy')) === 'true' &&
      runText.includes('生成中') &&
      runText.includes('仅写草稿') &&
      runText.includes(String(keyword).slice(0, 12)),
    (await cls()) + ' | ' + runText.slice(0, 90),
  ])
  results.push([
    'running·时长由计时器每秒刷新',
    /\d+ 秒|已运行/.test(runText) &&
      (await page.locator('#topics-banner [data-tgen-time]').count()) === 1,
    runText.slice(0, 60),
  ])
  const barAnim = await page
    .locator('#topics-banner .tgen-bar > i')
    .evaluate((el) => getComputedStyle(el).animationName)
  results.push(['running·进度线在动', barAnim !== 'none', barAnim])
  await shot('running-light')

  // 3) done：状态转 done + 关联标题回填（loadTopics 之后补文案）
  const draftId = '2099-01-01-tips-banner-smoke'
  statusPayload = {
    state: 'done',
    slot,
    keyword,
    startedAt: new Date(Date.now() - 96000).toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    draftId,
    logFile: '/tmp/x.log',
    logTail: '',
    error: null,
  }
  await page.waitForTimeout(4600) // 轮询 4s
  const doneText = await text()
  results.push([
    'done·绿色语义 + 草稿深链 + 用时',
    (await cls()).includes('tgen--done') &&
      (await cls()).includes('tgen--ok') &&
      doneText.includes('生成完成') &&
      doneText.includes('未推送') &&
      doneText.includes('用时') &&
      doneText.includes(String(keyword).slice(0, 12)),
    (await cls()) + ' | ' + doneText.slice(0, 100),
  ])
  const href = await page.locator('#topics-banner a').first().getAttribute('href')
  results.push(['done·链接指向草稿详情', href === `#/articles/${draftId}`, href || 'null'])
  await shot('done-light')

  // 4) failed：错误骨架 + 折叠日志 + 重试按钮（含原 slot/关键词）
  statusPayload = {
    state: 'failed',
    slot,
    keyword,
    startedAt: new Date(Date.now() - 30000).toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 7,
    draftId: null,
    logFile: '/tmp/x.log',
    logTail: 'step 3/5 failed: render\nError: boom',
    error: 'boom',
  }
  await clickFirstGen()
  await page.waitForTimeout(4800)
  const errText = await text()
  results.push([
    'failed·红色语义 + exit 码 + 日志折叠',
    (await cls()).includes('tgen--failed') &&
      (await cls()).includes('tgen--err') &&
      errText.includes('生成失败') &&
      errText.includes('exit=7') &&
      errText.includes('失败日志') &&
      (await page.locator('#topics-banner details pre').count()) === 1,
    (await cls()) + ' | ' + errText.slice(0, 110),
  ])
  const retry = page.locator('#topics-banner [data-tgen-retry]')
  results.push([
    'failed·重试按钮带原 slot/关键词',
    (await retry.count()) === 1 &&
      (await retry.getAttribute('data-tgen-retry')) === slot &&
      (await retry.getAttribute('data-tgen-kw')) === keyword,
    `${await retry.count()} 个`,
  ])
  await shot('failed-light')

  // 6) dark 主题：同一套结构，颜色由变量接管（在点"重试"之前截失败态，否则会被 running 覆盖）
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark')
    try {
      localStorage.setItem('console-theme', 'dark')
    } catch {
      /* 忽略隐私模式 */
    }
  })
  await page.waitForTimeout(300)
  const darkBg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor)
  results.push(['dark·底色切到深色语义变量', darkBg.includes('40, 36, 48'), darkBg])
  await shot('failed-dark')

  // 5) 重试按钮真的会重新发起生成请求（POST /proxy/topics/generate）
  lastGenerateBody = null
  await retry.click()
  await page.waitForTimeout(500)
  results.push([
    '重试·重新 POST 同 slot/关键词',
    !!lastGenerateBody && lastGenerateBody.slot === slot && lastGenerateBody.keyword === keyword,
    JSON.stringify(lastGenerateBody),
  ])

  statusPayload = {
    state: 'running',
    slot,
    keyword,
    startedAt: new Date(Date.now() - 20000).toISOString(),
    finishedAt: null,
    exitCode: null,
    draftId: null,
    logFile: null,
    logTail: '',
    error: null,
  }
  // 不必再点按钮：上一步的"重试"已经把生成重新拉起来了（按钮此刻仍是 disabled）
  await page.waitForTimeout(4500)
  await shot('running-dark')
  results.push(['dark·运行态仍为 running', (await cls()).includes('tgen--running'), await cls()])

  // 7) 降级：prefers-reduced-motion 下进度线不再扫动（信息仍在）
  const rm = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1180, height: 720 },
  })
  const rmPage = await rm.newPage()
  await rmPage.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 20000 })
  // 状态条此刻是 idle（DOM 被清空），故注入一个与运行时同构的进度线节点来量规则本身
  const rmAnim = await rmPage.evaluate(() => {
    const host = document.createElement('div')
    host.className = 'tgen tgen--running tgen--accent'
    host.innerHTML = '<div class="tgen-bar"><i></i></div>'
    document.body.appendChild(host)
    const el = host.querySelector('.tgen-bar > i')
    const cs = getComputedStyle(el)
    const out = { name: cs.animationName, width: cs.width }
    host.remove()
    return out
  })
  results.push(['reduced-motion·进度线停动', rmAnim.name === 'none', JSON.stringify(rmAnim)])
  await rm.close()
} catch (e) {
  results.push(['脚本异常', false, String(e.message).slice(0, 200)])
}

results.push(['无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0'])

console.log('=== 选题库生成状态条 四态冒烟 ===')
let pass = 0
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`)
  if (ok) pass++
}
console.log(`\n通过 ${pass}/${results.length}`)
console.log(`截图目录: ${SHOT_DIR}/crosspost-banner-*.png`)
await browser.close()
process.exit(pass === results.length ? 0 : 1)
