/**
 * DSH 升级自检脚本的契约测试（v2.38）
 *
 * 为什么值得测：`preset/upgrade-check.sh` 是**DSH 升级后唯一的安全网**——
 * 2026-09-10 那次升级连续打坏三处依赖，全靠"用户反馈"才发现；这个脚本把那些
 * 检查固化下来。它一旦给出**假失败**，使用者就会学会忽略它，而它恰恰是最该被相信的。
 *
 * 本轮实测撞到的正是这一点：
 *   ✖ profile <profile> bundle <本地 bundle> 在当前部署缺失
 * 而该 bundle 确实存在——它是 `file:` 装的**本地 bundle**，装在 profile 自己的
 * node_modules 里，本来就不该出现在 DSH 部署目录中。脚本只查了部署目录。
 * 假失败 + 没有任何 ↳ 提示 = 使用者只能靠猜。
 *
 * 另外同一文件里还有一处"写死 /usr/local/bin/node"（与 install-launchd.sh 同款缺陷），
 * 会让第 3 节报成"插件导入失败"，把排查方向带偏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'preset', 'upgrade-check.sh')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-upgrade-check-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

/** 经由**软链**调用（模拟 ~/.dsh/upgrade-check.sh 的真实用法），DSH_HOME 指向空目录 */
function runViaSymlink(env = {}, prepare = null) {
  const linkDir = fs.mkdtempSync(path.join(tmp, 'link-'))
  const link = path.join(linkDir, 'upgrade-check.sh')
  fs.symlinkSync(SCRIPT, link)
  const dshHome = fs.mkdtempSync(path.join(tmp, 'dshhome-'))
  // prepare 拿到隔离出来的 DSH_HOME，可以在脚本跑之前铺好 fixture（profile / 软链）
  if (prepare) prepare(dshHome)
  const r = spawnSync('/bin/bash', [link], {
    encoding: 'utf8',
    env: {
      HOME: tmp,
      PATH: process.env.PATH || '/usr/bin:/bin',
      DSH_HOME: dshHome,
      DSH_BIN: path.join(tmp, 'no-such-dsh'), // 让第 0 节快速判负，不真的跑 dsh
      UNZSTD: '',
      ...env,
    },
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

test('经软链调用时，REPO_PRESETS 从脚本真实路径推导（不再假设仓库在某个固定位置）', () => {
  const { stdout } = runViaSymlink()
  assert.match(
    stdout,
    /crosspost/,
    '应扫描到仓库内的 crosspost 预设（说明 REPO_PRESETS 解析到了仓库的 preset/ 目录）',
  )
})

test('node 解析不出来时明确失败，且给出 CROSSPOST_NODE 的修法', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: '/nonexistent/node' })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stderr}${r.stdout}`, /找不到.*node|CROSSPOST_NODE/)
})

test('CROSSPOST_NODE 生效（显式指定的 node 被采用，脚本继续往下跑）', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: process.execPath })
  assert.match(r.stdout, /部署与启动链/, '给了可用 node 就应进入检查流程')
})

test('静态护栏：不得把绝对路径当作 node 的默认值，且必须用 command -v node', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  const hardDefault = src
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => !line.trim().startsWith('#'))
    .filter(({ line }) => /:-["']?\/[^"'}]*\/node/.test(line))
  assert.deepEqual(
    hardDefault.map(({ line, i }) => `${i}: ${line.trim()}`),
    [],
    'node 默认值不得写死绝对路径',
  )
  assert.ok(/command -v node/.test(src), '必须优先用 `command -v node` 解析')
})

test('静态护栏：bundle 解析必须覆盖 profile 自己的 node_modules（本地 bundle 在那里）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  // 旧实现只有 `-d "$DEPLOY/node_modules/$b"`，任何自带本地 bundle 的 profile 都会假失败
  assert.ok(
    /"\$pdir\/node_modules\/\$b"/.test(src),
    '必须先查 profile 自己的 node_modules（file: 装的本地 bundle 只在那里）',
  )
  assert.ok(
    /"\$DSH_HOME\/profiles\/node_modules\/\$b"/.test(src),
    '应查共享的 profiles/node_modules',
  )
  assert.ok(/"\$DEPLOY\/node_modules\/\$b"/.test(src), '最后才查 DSH 部署目录')
})

/**
 * 软链分类契约（2026-09-25，仓库目录改名后实测踩到）。
 *
 * 背景：第 1 节原先只把断链分两类 ——「部署内有同名包」= 失败，其余一律
 * **"旧版本残留（无害，Node 解析会跳过）"**。可是 DSH 是按**包名**解析 profile 的插件行的，
 * 包名由 `~/.dsh/profiles/node_modules/<包名>` 这条软链落到仓库路径上：
 * 仓库目录一改名，软链目标就指向不存在的旧路径，
 * 而它与 `$DEPLOY` 毫无关系 —— 于是被归进"无害，可清理"，脚本还主动建议把它删掉。
 * 真实后果是那一行插件静默消失（改名后 `crosspost-client` 正是如此）。
 *
 * 为什么用 fixture 而不看本机：本机那条链已经修好，而这条分类逻辑必须**永远**有效 ——
 * 它守的是"下一次改名/下一次挪仓库"。fixture 在任何机器上都跑。
 */
test('软链分类：被插件行引用的断链必须报失败，不得判成"无害旧残留"', () => {
  const r = runViaSymlink({ CROSSPOST_NODE: process.execPath }, (dshHome) => {
    const profile = path.join(dshHome, 'profiles', 'web')
    const shared = path.join(dshHome, 'profiles', 'node_modules')
    fs.mkdirSync(profile, { recursive: true })
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(
      path.join(profile, 'cordis.patch.yml'),
      ['- insert:', '    - id: ghost', "      name: 'ghost-plugin'", ''].join('\n'),
    )
    // 断链的典型形态：目标写着一个**已不存在的旧仓库路径**
    fs.symlinkSync(
      '/nonexistent/old-repo/preset/crosspost/plugins/ghost-plugin',
      path.join(shared, 'ghost-plugin'),
    )
  })

  assert.notEqual(r.status, 0, '被插件行引用的断链会让那一行插件消失，脚本必须判负')

  const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('ghost-plugin'))
  assert.ok(lines.length > 0, '脚本应至少提到这条断链（否则它根本不在检查范围内）')
  // 误判的痕迹是那句「旧版本残留（…无害，可清理）」—— 被归进残留时，脚本会主动
  // 建议把它删掉。注意不能只匹配"无害"二字：正确提示里也有"不是无害残留"这样的解释。
  assert.ok(
    lines.every((l) => !l.includes('旧版本残留')),
    `被插件行引用的断链被判成"旧版本残留（无害，可清理）"——这是改名后最危险的一次误判，` +
      `提示还会引导使用者把它删掉：\n${lines.join('\n')}`,
  )
  assert.ok(
    lines.some((l) => l.includes('插件行引用')),
    `提示必须点明"被插件行引用"（否则使用者只会看到一条软链名，不知道它是一条接线）：\n${lines.join('\n')}`,
  )
})
