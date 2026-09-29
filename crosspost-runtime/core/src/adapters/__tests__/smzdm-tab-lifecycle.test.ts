// smzdm 适配器的 tab 收尾契约（2026-09-29）
//
// 为什么单列一条：投稿页 tab **只在成功时关闭**曾是 smzdm 独有的写法（xhs/toutiao 都在 finally）。
// 于是"一次失败的推送"会在浏览器里留下一个由我们开的 tab，后续每次发布都把它当"既有 tab"复用，
// 从此再也不关 —— 使用者看到的就是"改写之后不再自动关闭标签页"。
//
// 这里用假 runtime 把四条路径钉死：成功关 / 失败也关 / 用户自己的 tab 不关 / 会话记忆里的孤儿 tab 要关。
import { describe, it, expect } from 'vitest'
import { SmzdmAdapter } from '../platforms/private/smzdm'
import type { RuntimeInterface } from '../../runtime/interface'
import type { Article } from '../../types'

const TOUGAO_PAGE = 'https://post.smzdm.com/tougao/'
const TOUGAO_HTML = '<a href="/edit/art-1" class="release-new">新建文章</a>'
const OWNED_KEY = 'crosspost.smzdm.ownedTabs'

/** 立即返回的适配器：把 1.5s+0.8s 的节奏等待去掉，测试只关心收尾分支 */
class FastSmzdmAdapter extends SmzdmAdapter {
  protected override delay(): Promise<void> {
    return Promise.resolve()
  }
}

interface Harness {
  runtime: RuntimeInterface
  /** 浏览器里"当前"的标签页 */
  open: { id: number; url: string }[]
  created: string[]
  closed: number[]
  session: Map<string, unknown>
  setToken: (token: string | null) => void
}

function makeHarness(opts: { open?: { id: number; url: string }[] } = {}): Harness {
  const open = [...(opts.open ?? [])]
  const created: string[] = []
  const closed: number[] = []
  const session = new Map<string, unknown>()
  let token: string | null = 'csrf-1'

  const runtime = {
    type: 'node',
    fetch: async (url: string) => {
      const u = String(url)
      if (u.startsWith('https://post.smzdm.com/api/editor/article/submit'))
        return new Response(JSON.stringify({ error_code: 0 }), { status: 200 })
      if (u.startsWith('https://post.smzdm.com/tougao/')) return new Response(TOUGAO_HTML)
      return new Response(JSON.stringify({ error_code: 0 }), { status: 200 })
    },
    pageOp: async () => ({ success: true, token }),
    tabs: {
      query: async () => open.map((t) => ({ ...t })),
      create: async (url: string) => {
        const id = 100 + created.length
        created.push(url)
        open.push({ id, url })
        return { id, url }
      },
      waitForLoad: async () => {},
      close: async (id: number) => {
        closed.push(id)
        const i = open.findIndex((t) => t.id === id)
        if (i >= 0) open.splice(i, 1)
      },
    },
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    session: {
      get: async (key: string) => session.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        session.set(key, value)
      },
    },
    dom: {
      parseHTML: async () => ({}) as Document,
      querySelector: () => null,
      querySelectorAll: () => [],
      getTextContent: () => '',
      getInnerHTML: () => '',
    },
  } as unknown as RuntimeInterface

  return {
    runtime,
    open,
    created,
    closed,
    session,
    setToken: (t) => {
      token = t
    },
  }
}

const ARTICLE = { title: '标题', html: '<p>正文</p>' } as unknown as Article

async function publishWith(h: Harness) {
  const adapter = new FastSmzdmAdapter()
  await adapter.init(h.runtime)
  return adapter.publish(ARTICLE)
}

describe('smzdm：投稿页 tab 的收尾契约', () => {
  it('① 本次自建 + 成功 → 关掉它', async () => {
    const h = makeHarness()
    const r = await publishWith(h)
    expect(r.success).toBe(true)
    expect(h.created).toEqual([TOUGAO_PAGE])
    expect(h.closed).toEqual([100])
    expect(h.open).toHaveLength(0)
  })

  it('② 本次自建 + 失败（取不到 CSRF token）→ 也要关掉，不留孤儿 tab', async () => {
    const h = makeHarness()
    h.setToken(null)
    const r = await publishWith(h)
    expect(r.success).toBe(false)
    expect(h.closed).toEqual([100])
    expect(h.open).toHaveLength(0)
  })

  it('③ 复用用户自己的投稿页 → 不许关（也记不进归属记忆）', async () => {
    const h = makeHarness({ open: [{ id: 9, url: TOUGAO_PAGE }] })
    const r = await publishWith(h)
    expect(r.success).toBe(true)
    expect(h.created).toEqual([])
    expect(h.closed).toEqual([])
    expect(h.session.get(OWNED_KEY) ?? null).toBeNull()
  })

  it('④ 复用"会话记忆里由我们开过"的 tab（上次失败的遗留）→ 成功时认领并关掉', async () => {
    const h = makeHarness({ open: [{ id: 9, url: TOUGAO_PAGE }] })
    h.session.set(OWNED_KEY, [9])
    const r = await publishWith(h)
    expect(r.success).toBe(true)
    expect(h.closed).toEqual([9])
    // 关掉之后要从记忆里摘除，避免影响下一次
    expect(h.session.get(OWNED_KEY)).toEqual([])
  })
})
