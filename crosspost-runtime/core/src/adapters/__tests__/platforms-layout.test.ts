// 适配器目录归属 = 平台分级（2026-09-26）
//
// 目录按分级分成 `private/`（默认勾选）与 `beta/`（未纳入默认派发）之后，"新增平台忘了归位"
// 或"改了分级没挪文件"这两件事都**不会在运行时报错**——它们只会让目录与分级悄悄不一致，
// 而下一个人照目录去理解分级就会被误导。所以这里把它钉成断言。
//
// 分级口径只有一处：`crosspost-runtime/src/platform-matrix.mjs` 的 `ENABLED_PLATFORMS`
// （+ `platform-ids.mjs` 的 `TARGET_PLATFORMS` 给出全集）。本文件不重复任何名单。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENABLED_PLATFORMS } from '../../../../src/platform-matrix.mjs'
import { TARGET_PLATFORMS } from '../../../../src/platform-ids.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLATFORMS = path.resolve(here, '..', 'platforms')
const PRIVATE = path.join(PLATFORMS, 'private')
const BETA = path.join(PLATFORMS, 'beta')

const ids = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))

/**
 * 不对应独立平台 id 的适配器：它们是某个平台的**第二种实现**，必须与那个平台同目录。
 * 目前只有微信公众号的官方 API 通道（`weixin-official`），它服务的就是默认勾选的 `weixin`。
 */
const SAME_DIR_AS_PLATFORM = { 'weixin-official': 'weixin' }

describe('适配器目录归属与平台分级一致', () => {
  it('默认勾选的平台，适配器都在 private/', () => {
    const have = ids(PRIVATE)
    expect(ENABLED_PLATFORMS.filter((id) => !have.includes(id))).toEqual([])
  })

  it('未纳入默认派发的平台，适配器都在 beta/', () => {
    const have = ids(BETA)
    const betaIds = TARGET_PLATFORMS.filter((id) => !ENABLED_PLATFORMS.includes(id))
    expect(betaIds.filter((id) => !have.includes(id))).toEqual([])
  })

  it('反向：private/ 里不许有未勾选的平台，beta/ 里不许有已勾选的平台', () => {
    const enabled = new Set(ENABLED_PLATFORMS)
    const bad = []
    for (const f of ids(PRIVATE))
      if (!enabled.has(f) && !(f in SAME_DIR_AS_PLATFORM))
        bad.push(`private/${f}.ts 是未纳入默认派发的平台`)
    for (const f of ids(BETA)) if (enabled.has(f)) bad.push(`beta/${f}.ts 是默认勾选的平台`)
    expect(bad).toEqual([])
  })

  it('某个平台的第二种实现与它同目录', () => {
    const bad = []
    for (const [impl, platform] of Object.entries(SAME_DIR_AS_PLATFORM)) {
      const inPrivate = fs.existsSync(path.join(PRIVATE, `${impl}.ts`))
      const platformInPrivate = fs.existsSync(path.join(PRIVATE, `${platform}.ts`))
      if (inPrivate !== platformInPrivate)
        bad.push(`${impl}.ts 与 ${platform}.ts 不在同一个目录（它服务的是后者）`)
    }
    expect(bad).toEqual([])
  })

  it('目录里出现的每个适配器都对应一个已知平台（或已登记的同一平台实现）', () => {
    const known = new Set([...TARGET_PLATFORMS, ...Object.keys(SAME_DIR_AS_PLATFORM)])
    const stray = [...ids(PRIVATE), ...ids(BETA)].filter((f) => !known.has(f))
    expect(stray).toEqual([])
  })
})
