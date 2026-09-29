// CodeAdapter / BaseAdapter 基类行为单测（2026-09-10 阶段 D1）
// 用假 runtime + 假 Response 覆盖基类公共路径，不发真实请求。
import { describe, it, expect } from 'vitest'
import { CodeAdapter } from '../code-adapter'
import type { ImageUploadResult } from '../code-adapter'
import { BaseAdapter } from '../base'
import type { RuntimeInterface } from '../../runtime/interface'
import type { AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../types'

const META: PlatformMeta = {
  id: 'test',
  name: 'Test',
  icon: 'https://example.com/i.ico',
  homepage: 'https://example.com',
  capabilities: ['article'],
}

function fakeResponse(
  body: string,
  init: { ok?: boolean; status?: number; statusText?: string; contentType?: string } = {},
): Response {
  const { ok = true, status = 200, statusText = 'OK', contentType } = init
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? (contentType ?? null) : null),
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
}

function makeRuntime(opts: {
  fetch: RuntimeInterface['fetch']
  headerRules?: RuntimeInterface['headerRules']
}): RuntimeInterface {
  return {
    type: 'node',
    fetch: opts.fetch,
    headerRules: opts.headerRules,
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    session: { get: async () => null, set: async () => {} },
    dom: {
      parseHTML: async () => ({}) as Document,
      querySelector: () => null,
      querySelectorAll: () => [],
      getTextContent: () => '',
      getInnerHTML: () => '',
    },
  } as RuntimeInterface
}

// ── CodeAdapter 测试子类：把 protected 方法以 public 包装暴露 ──
class TestCodeAdapter extends CodeAdapter {
  meta: PlatformMeta = META
  async checkAuth(): Promise<AuthResult> {
    return { isAuthenticated: false }
  }
  async publish(): Promise<SyncResult> {
    return this.createResult(true)
  }
  callCreateResult = (ok: boolean, data?: Partial<SyncResult>) => this.createResult(ok, data)
  callDelay = (ms: number) => this.delay(ms)
  callAddHeaderRule = (rule: Omit<HeaderRule, 'id'>) => this.addHeaderRule(rule)
  callWithHeaderRules = <T>(rules: Array<Omit<HeaderRule, 'id'>>, fn: () => Promise<T>) =>
    this.withHeaderRules(rules, fn)
  callGet = <T = unknown>(url: string, headers?: Record<string, string>) =>
    this.get<T>(url, headers)
  callPostJson = <T = unknown>(
    url: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>,
  ) => this.postJson<T>(url, data, headers)
  callPostForm = <T = unknown>(
    url: string,
    data: Record<string, string>,
    headers?: Record<string, string>,
  ) => this.postForm<T>(url, data, headers)
  callProcessImages = (
    content: string,
    uploadFn: (src: string) => Promise<ImageUploadResult>,
    options?: { skipPatterns?: string[]; onProgress?: (c: number, t: number) => void },
  ) => this.processImages(content, uploadFn, options)
  headerRuleIdsSnapshot = () => (this as unknown as { headerRuleIds: string[] }).headerRuleIds
}

const RULE: Omit<HeaderRule, 'id'> = {
  urlFilter: '*://example.com/*',
  headers: { Origin: 'https://example.com' },
}

describe('CodeAdapter 基类', () => {
  it('createResult 携带平台 id、success 与时间戳，并合并 data', async () => {
    const a = new TestCodeAdapter()
    const r = a.callCreateResult(true, { postUrl: 'https://x/1' })
    expect(r.platform).toBe('test')
    expect(r.success).toBe(true)
    expect(typeof r.timestamp).toBe('number')
    expect(r.postUrl).toBe('https://x/1')
  })

  it('delay 正常 resolve', async () => {
    const a = new TestCodeAdapter()
    await expect(a.callDelay(0)).resolves.toBeUndefined()
  })

  it('runtime 无 headerRules 时 addHeaderRule 返回 null', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('{}') }))
    await expect(a.callAddHeaderRule(RULE)).resolves.toBeNull()
  })

  it('withHeaderRules 执行前后自动增删规则，并返回 fn 结果', async () => {
    const a = new TestCodeAdapter()
    const removed: string[] = []
    let seq = 0
    await a.init(
      makeRuntime({
        fetch: async () => fakeResponse('{}'),
        headerRules: {
          add: async () => `rule-${++seq}`,
          remove: async (id: string) => {
            removed.push(id)
          },
          clear: async () => {},
        },
      }),
    )

    const out = await a.callWithHeaderRules([RULE, RULE], async () => 'done')
    expect(out).toBe('done')
    expect(removed).toEqual(['rule-1', 'rule-2'])
    expect(a.headerRuleIdsSnapshot()).toEqual([]) // 已清理
  })

  it('withHeaderRules 在 fn 抛错时仍清理规则', async () => {
    const a = new TestCodeAdapter()
    const removed: string[] = []
    await a.init(
      makeRuntime({
        fetch: async () => fakeResponse('{}'),
        headerRules: {
          add: async () => 'rule-x',
          remove: async (id: string) => {
            removed.push(id)
          },
          clear: async () => {},
        },
      }),
    )

    await expect(
      a.callWithHeaderRules([RULE], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(removed).toEqual(['rule-x'])
    expect(a.headerRuleIdsSnapshot()).toEqual([])
  })

  it('get 解析 JSON 响应', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('{"ok":1}') }))
    await expect(a.callGet('https://example.com/a')).resolves.toEqual({ ok: 1 })
  })

  it('get 非 JSON 响应返回原文', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('plain-text') }))
    await expect(a.callGet('https://example.com/b')).resolves.toBe('plain-text')
  })

  it('get 响应 !ok 时抛 HTTP 错误', async () => {
    const a = new TestCodeAdapter()
    await a.init(
      makeRuntime({
        fetch: async () => fakeResponse('', { ok: false, status: 500, statusText: 'Err' }),
      }),
    )
    await expect(a.callGet('https://example.com/c')).rejects.toThrow(/HTTP 500/)
  })

  it('postJson 发送 JSON body 并解析响应', async () => {
    const a = new TestCodeAdapter()
    let seen: RequestInit | undefined
    await a.init(
      makeRuntime({
        fetch: async (_url: string, options?: RequestInit) => {
          seen = options
          return fakeResponse('{"id":"1"}')
        },
      }),
    )
    const out = await a.callPostJson('https://example.com/d', { title: 'x' })
    expect(out).toEqual({ id: '1' })
    expect(seen?.method).toBe('POST')
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(seen?.body).toBe(JSON.stringify({ title: 'x' }))
  })

  it('postForm 发送 urlencoded body', async () => {
    const a = new TestCodeAdapter()
    let seen: RequestInit | undefined
    await a.init(
      makeRuntime({
        fetch: async (_url: string, options?: RequestInit) => {
          seen = options
          return fakeResponse('{"ok":true}')
        },
      }),
    )
    await expect(a.callPostForm('https://example.com/e', { a: '1', b: '2' })).resolves.toEqual({
      ok: true,
    })
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(String(seen?.body)).toContain('a=1')
  })

  it('processImages 无图片时原样返回，不调用 uploadFn', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('{}') }))
    let called = 0
    const out = await a.callProcessImages('纯文本\n\n没有图片', async () => {
      called += 1
      return { url: 'x' }
    })
    expect(out).toBe('纯文本\n\n没有图片')
    expect(called).toBe(0)
  })

  it('processImages 跳过 skipPatterns 命中的图片', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('{}') }))
    let called = 0
    const content = '![a](https://skip.me/x.png)'
    const out = await a.callProcessImages(
      content,
      async () => {
        called += 1
        return { url: 'https://cdn/x.png' }
      },
      { skipPatterns: ['skip.me'] },
    )
    expect(out).toBe(content)
    expect(called).toBe(0)
  })

  it('processImages 替换 markdown 图片 URL 并回报进度', async () => {
    const a = new TestCodeAdapter()
    await a.init(makeRuntime({ fetch: async () => fakeResponse('{}') }))
    const progress: Array<[number, number]> = []
    const out = await a.callProcessImages(
      '![alt](https://img.me/x.png)',
      async (src) => ({ url: `https://cdn/${src.split('/').pop()}` }),
      { onProgress: (c, t) => progress.push([c, t]) },
    )
    expect(out).toBe('![alt](https://cdn/x.png)')
    expect(progress).toEqual([[1, 1]])
  })
})

// ── BaseAdapter 测试子类 ──
class TestBaseAdapter extends BaseAdapter {
  meta: PlatformMeta = META
  async checkAuth(): Promise<AuthResult> {
    return { isAuthenticated: false }
  }
  async publish(): Promise<SyncResult> {
    return this.createResult(true)
  }
  callRequest = <T = unknown>(url: string, options?: RequestInit) => this.request<T>(url, options)
  callRequestWithRetry = <T = unknown>(url: string, options?: RequestInit, maxRetries?: number) =>
    this.requestWithRetry<T>(url, options, maxRetries)
  callCreateResult = (ok: boolean, data?: Partial<SyncResult>) => this.createResult(ok, data)
}

describe('BaseAdapter 基类', () => {
  it('request 依 content-type 解析 JSON', async () => {
    const a = new TestBaseAdapter()
    await a.init(
      makeRuntime({
        fetch: async () =>
          fakeResponse('{"v":2}', { contentType: 'application/json; charset=utf-8' }),
      }),
    )
    await expect(a.callRequest('https://example.com/a')).resolves.toEqual({ v: 2 })
  })

  it('request 非 JSON 时返回文本', async () => {
    const a = new TestBaseAdapter()
    await a.init(
      makeRuntime({ fetch: async () => fakeResponse('hello', { contentType: 'text/plain' }) }),
    )
    await expect(a.callRequest('https://example.com/b')).resolves.toBe('hello')
  })

  it('request 响应 !ok 时抛 HTTP 错误', async () => {
    const a = new TestBaseAdapter()
    await a.init(
      makeRuntime({
        fetch: async () => fakeResponse('', { ok: false, status: 403, statusText: 'Forbidden' }),
      }),
    )
    await expect(a.callRequest('https://example.com/c')).rejects.toThrow(/HTTP 403/)
  })

  it('requestWithRetry 首次成功即返回', async () => {
    const a = new TestBaseAdapter()
    let calls = 0
    await a.init(
      makeRuntime({
        fetch: async () => {
          calls += 1
          return fakeResponse('{"ok":1}', { contentType: 'application/json' })
        },
      }),
    )
    await expect(a.callRequestWithRetry('https://example.com/d', {}, 3)).resolves.toEqual({ ok: 1 })
    expect(calls).toBe(1)
  })

  it('requestWithRetry 重试耗尽后抛最后一次错误', async () => {
    const a = new TestBaseAdapter()
    let calls = 0
    await a.init(
      makeRuntime({
        fetch: async () => {
          calls += 1
          return fakeResponse('', { ok: false, status: 500, statusText: 'Boom' })
        },
      }),
    )
    await expect(a.callRequestWithRetry('https://example.com/e', {}, 1)).rejects.toThrow(/HTTP 500/)
    expect(calls).toBe(1)
  })

  it('createResult 使用 meta.id', async () => {
    const a = new TestBaseAdapter()
    expect(a.callCreateResult(false, { error: 'x' })).toMatchObject({
      platform: 'test',
      success: false,
      error: 'x',
    })
  })
})
