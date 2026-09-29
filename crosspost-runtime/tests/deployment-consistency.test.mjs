// 部署一致性测试（v2.18）
//
// 背景（实际踩到）：`~/.dsh/.agent-presets/crosspost/` 是**安装副本**，
// 其中 `plugins/crosspost.js` 不是符号链接而是独立的旧文件。
// 于是仓库里的修复**不会**自动生效到已安装的 preset 上：
// 实测发现安装版仍是 2026-09-12 的副本，仍硬编码 `/usr/local/bin/node`
// 并用顶层 `loadPaths()`——v2.02 的两处修复它一个都没有。
//
// 这类漂移很隐蔽：仓库测试全绿，但 DSH 会话里跑的是另一份代码。
// 本测试把"已安装副本与仓库是否一致"变成显式断言。
//
// 设计取舍：**安装路径不存在时跳过**（默认预设路径只在作者机器上存在），
// 因此它不会在别人的机器上误报；而在本机它是一道真实护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
const INSTALLED_PRESET = path.join(DSH_HOME, '.agent-presets', 'crosspost')

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/**
 * 需要与仓库保持一致的已安装文件（**必须是"应逐字相同"的源文件**）。
 *
 * 注意 `preset.yml`：它的 description 会显示给用户（DSH 预设列表），
 * 曾长期写着"11 平台（…B站…）"而实际是"默认勾选 12 个、B站为 beta"。
 * 用户可见的文案漂移与代码漂移一样会误导人，故同样纳入一致性护栏。
 *
 * **刻意不纳入**（它本来就不该逐字相同）：
 *   · `agent.cordis.yml` —— 安装版与仓库版仅 YAML 缩进不同（历史遗留），
 *     且它是预设组合定义，改动风险高、收益不明，留待人工核对。
 */
const SYNCED_FILES = ['plugins/crosspost.js', 'preset.yml']

test('部署一致性：已安装 preset 的插件副本与仓库一致（无静默漂移）', (t) => {
  if (!fs.existsSync(INSTALLED_PRESET)) {
    t.skip(`${INSTALLED_PRESET} 不存在（非本机部署）`)
    return
  }

  const mismatched = []
  const missing = []
  for (const rel of SYNCED_FILES) {
    const installed = path.join(INSTALLED_PRESET, rel)
    const repo = path.join(REPO, 'preset', 'crosspost', rel)
    if (!fs.existsSync(repo)) continue // 仓库没有则不在同步范围
    if (!fs.existsSync(installed)) {
      missing.push(rel)
      continue
    }
    if (sha256(installed) !== sha256(repo)) mismatched.push(rel)
  }

  assert.deepEqual(missing, [], `已安装 preset 缺少以下文件：${missing.join(', ')}`)
  assert.deepEqual(
    mismatched,
    [],
    `已安装 preset 的以下文件与仓库不一致（仓库的修复不会自动生效到 DSH 会话）：\n` +
      mismatched.map((m) => `  ${path.join(INSTALLED_PRESET, m)}`).join('\n') +
      `\n修法：cp preset/crosspost/<file> ${INSTALLED_PRESET}/<file>（改前先备份）`,
  )
})

test('部署一致性：已安装插件不得残留硬编码 node 路径（注释除外）', (t) => {
  const installed = path.join(INSTALLED_PRESET, 'plugins', 'crosspost.js')
  if (!fs.existsSync(installed)) {
    t.skip('未安装 preset')
    return
  }
  const src = fs.readFileSync(installed, 'utf8')
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /\/usr\/local\/bin\/node/.test(line))
    .filter(({ line }) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .map(({ line, i }) => `${i}: ${line.trim()}`)
  assert.deepEqual(
    offenders,
    [],
    `已安装插件仍硬编码 node 路径（在无 /usr/local/bin/node 的机器上会直接失败）：\n${offenders.join('\n')}`,
  )
})

test('部署一致性：仓库 preset 插件自身可被 fresh 进程导入（安装前的最后一道门）', async (t) => {
  const repoPlugin = path.join(REPO, 'preset', 'crosspost', 'plugins', 'crosspost.js')
  if (!fs.existsSync(repoPlugin)) {
    t.skip('仓库无 preset 插件')
    return
  }
  // 该插件 `import '@deepseek-ai/dsh-tools'`——那是 **DSH 宿主提供的包**，
  // 只有装了 DSH（或其 preset 目录里有 node_modules）才可解析。
  // 干净 clone 里没有它，此时**跳过而不是失败**：这测的是"部署前的最后一道门"，
  // 而"没装 DSH"的环境本来就不该跑这道门。
  // （实测踩到：在干净 clone 里本测试误报为失败，属测试自身的环境假设错误。）
  if (!canResolveDshTools()) {
    t.skip('当前环境无 @deepseek-ai/dsh-tools（未安装 DSH），跳过导入检查')
    return
  }
  try {
    const m = await import(new URL(`file://${repoPlugin}`).href)
    assert.equal(typeof m.apply, 'function', '插件必须导出 apply 函数')
  } catch (e) {
    assert.fail(
      `仓库 preset 插件导入失败——同步到已安装副本后会让该预设下所有 DSH 会话失败：${e.message}`,
    )
  }
})

/**
 * 定时链路的写作规范本体（`cordis.patch.yml` 叠加层）**只有一份，且在引擎仓库之外**。
 *
 * 为什么值得一条护栏：这份叠加层实际住在**接入方仓库**那侧、`~/.dsh` 里只留软链，这带来两类静默失败——
 *   · 有人把它改回普通文件（拷一份回来）→ 在接入方那侧的修改**不再生效**，
 *     而运行照旧成功，只是用的还是旧规范（"改了没反应"最难查）；
 *   · 软链目标被删/改名 → profile 组合失败 → 定时任务整轮不产出。
 * 两者都不会在任何"跑一下看看"里暴露，所以钉在这里。
 *
 * 判据**不写死任何 profile 名或目录名**（那是某台机器的部署细节）：对每个带 `cordis.patch.yml`
 * 的 profile 断言"读出来的真身不在引擎仓库里"；其中是软链的那些额外断言目标可读、不是空壳。
 * 非本机部署（没有 profiles 目录）跳过。
 */
test('部署一致性：写作规范叠加层只有一份，且不在引擎仓库里', (t) => {
  const profilesRoot = path.join(DSH_HOME, 'profiles')
  let names = []
  try {
    names = fs
      .readdirSync(profilesRoot)
      .filter((n) => fs.existsSync(path.join(profilesRoot, n, 'cordis.patch.yml')))
  } catch {
    /* 没有 profiles 目录 */
  }
  if (!names.length) {
    t.skip(`${profilesRoot} 下没有带 cordis.patch.yml 的 profile（非本机部署）`)
    return
  }

  const symlinked = []
  for (const name of names) {
    const link = path.join(profilesRoot, name, 'cordis.patch.yml')
    const target = fs.realpathSync(link)
    assert.ok(
      !target.startsWith(REPO + path.sep),
      `${link} 的真身在引擎仓库里（${target}）——写作规范又回到引擎侧了`,
    )
    if (fs.lstatSync(link).isSymbolicLink()) symlinked.push(link)
  }

  // 软链那一份是定时链路真正用的：目标必须读得出来，不能是空壳/坏链
  for (const link of symlinked) {
    assert.ok(fs.statSync(link).size > 1000, `${link} 的目标读出来几乎为空，可能已损坏`)
  }
})

/** 能否解析 @deepseek-ai/dsh-tools（即本机是否装了 DSH） */
function canResolveDshTools() {
  try {
    createRequire(path.join(REPO, 'preset', 'crosspost', 'plugins', 'x.js')).resolve(
      '@deepseek-ai/dsh-tools',
    )
    return true
  } catch {
    return false
  }
}
