// AdapterRegistry 公开面单测（2026-09-10 阶段 D1）
// 覆盖 register / registerAll / get（实例化+缓存+未知 id+未设 runtime）/ getAllMeta / has /
// getRegisteredIds / clear / setRuntime（清缓存）。纯内存，不触网。
import { describe, it, expect, beforeEach } from 'vitest'
import { adapterRegistry } from '../registry'
import type { AdapterRegistryEntry, PlatformAdapter } from '../types'
import type { RuntimeInterface } from '../../runtime/interface'
import type { AuthResult, PlatformMeta, SyncResult } from '../../types'

const runtime = {} as RuntimeInterface

function makeMeta(id: string): PlatformMeta {
  return {
    id,
    name: id.toUpperCase(),
    icon: 'https://example.com/i.ico',
    homepage: 'https://example.com',
    capabilities: ['article'],
  }
}

interface FakeAdapter extends PlatformAdapter {
  initCalls: number
}

function makeAdapter(meta: PlatformMeta): FakeAdapter {
  return {
    meta,
    initCalls: 0,
    async init() {
      this.initCalls += 1
    },
    async checkAuth(): Promise<AuthResult> {
      return { isAuthenticated: false }
    },
    async publish(): Promise<SyncResult> {
      return { platform: meta.id, success: true, timestamp: Date.now() }
    },
  }
}

function makeEntry(id: string, created: FakeAdapter[]): AdapterRegistryEntry {
  const meta = makeMeta(id)
  return {
    meta,
    factory: () => {
      const a = makeAdapter(meta)
      created.push(a)
      return a
    },
  }
}

beforeEach(() => {
  adapterRegistry.clear()
})

describe('AdapterRegistry', () => {
  it('register / has / getRegisteredIds / getAllMeta', () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('alpha', created))
    adapterRegistry.register(makeEntry('beta', created))

    expect(adapterRegistry.has('alpha')).toBe(true)
    expect(adapterRegistry.has('nope')).toBe(false)
    expect(adapterRegistry.getRegisteredIds().sort()).toEqual(['alpha', 'beta'])
    expect(
      adapterRegistry
        .getAllMeta()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['alpha', 'beta'])
  })

  it('registerAll 批量注册', () => {
    const created: FakeAdapter[] = []
    adapterRegistry.registerAll([
      makeEntry('a', created),
      makeEntry('b', created),
      makeEntry('c', created),
    ])
    expect(adapterRegistry.getRegisteredIds().sort()).toEqual(['a', 'b', 'c'])
  })

  it('重复注册同一 id 覆盖旧项', () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('dup', created))
    adapterRegistry.register(makeEntry('dup', created))
    expect(adapterRegistry.getRegisteredIds()).toEqual(['dup'])
    expect(adapterRegistry.getAllMeta()).toHaveLength(1)
  })

  it('get 未知 id → null', async () => {
    await expect(adapterRegistry.get('missing')).resolves.toBeNull()
  })

  it('未 setRuntime 时 get 已注册项 → 抛错', async () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('gamma', created))
    await expect(adapterRegistry.get('gamma')).rejects.toThrow(/Runtime not set/)
  })

  it('setRuntime 后 get → 实例化并 init，且缓存同一实例', async () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('delta', created))
    adapterRegistry.setRuntime(runtime)

    const first = await adapterRegistry.get('delta')
    const second = await adapterRegistry.get('delta')
    expect(first).toBe(second)
    expect(created).toHaveLength(1) // factory 只调用一次
    expect((first as FakeAdapter).initCalls).toBe(1) // init 只调用一次
  })

  it('setRuntime 清空实例缓存（重新 get 得到新实例）', async () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('epsilon', created))
    adapterRegistry.setRuntime(runtime)

    const first = await adapterRegistry.get('epsilon')
    adapterRegistry.setRuntime(runtime)
    const second = await adapterRegistry.get('epsilon')
    expect(first).not.toBe(second)
    expect(created).toHaveLength(2)
  })

  it('clear 清空注册项与实例缓存', async () => {
    const created: FakeAdapter[] = []
    adapterRegistry.register(makeEntry('zeta', created))
    adapterRegistry.setRuntime(runtime)
    await adapterRegistry.get('zeta')

    adapterRegistry.clear()
    expect(adapterRegistry.getRegisteredIds()).toEqual([])
    expect(adapterRegistry.has('zeta')).toBe(false)
    await expect(adapterRegistry.get('zeta')).resolves.toBeNull()
  })
})
