// zhihu 适配器冒烟测试（2026-08-28 阶段 C2）
// 只测静态契约（preprocessConfig/capabilities/HEADER_RULES 形状），不触网。
import { describe, it, expect } from 'vitest'
import { ZhihuAdapter } from '../platforms/private/zhihu'

describe('ZhihuAdapter 静态契约', () => {
  const adapter = new ZhihuAdapter()

  it('capabilities 包含文章/草稿/图床', () => {
    expect(adapter.meta.capabilities).toContain('article')
    expect(adapter.meta.capabilities).toContain('draft')
    expect(adapter.meta.capabilities).toContain('image_upload')
  })

  it('preprocessConfig 为 HTML 输出格式且包含空行预防开关', () => {
    expect(adapter.preprocessConfig.outputFormat).toBe('html')
    expect(adapter.preprocessConfig.removeEmptyLines).toBe(true)
    expect(adapter.preprocessConfig.removeEmptyDivs).toBe(true)
    expect(adapter.preprocessConfig.convertSectionToDiv).toBe(true)
  })

  it('HEADER_RULES 形状合法（urlFilter + headers）', () => {
    for (const rule of adapter.HEADER_RULES || []) {
      expect(typeof rule.urlFilter).toBe('string')
      expect(rule.headers && typeof rule.headers).toBe('object')
      expect(Array.isArray(rule.resourceTypes)).toBe(true)
    }
  })

  it('checkAuth 方法存在且失败不抛（未连接时返回结构）', async () => {
    expect(typeof adapter.checkAuth).toBe('function')
    // 网络失败/未连接时应返回 { isAuthenticated: false, ... } 而非抛错
    const r = await adapter.checkAuth()
    expect(typeof r.isAuthenticated).toBe('boolean')
  })
})
