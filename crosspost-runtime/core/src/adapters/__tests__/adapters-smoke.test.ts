// 适配器静态契约冒烟（2026-08-28 阶段 C2 扩展：juejin/weibo/weixin-official）
// 只测 meta/preprocessConfig/HEADER_RULES 形状，不触网。
import { describe, it, expect } from 'vitest'
import { JuejinAdapter } from '../platforms/private/juejin'
import { WeiboAdapter } from '../platforms/beta/weibo'
import { WeixinOfficialAdapter } from '../platforms/private/weixin-official'

describe('JuejinAdapter 静态契约', () => {
  const a = new JuejinAdapter()
  it('meta 与能力', () => {
    expect(a.meta.id).toBe('juejin')
    expect(a.meta.capabilities).toContain('article')
    expect(a.meta.capabilities).toContain('image_upload')
  })
  it('preprocessConfig 为 markdown 输出', () => {
    expect(a.preprocessConfig.outputFormat).toBe('markdown')
  })
})

describe('WeiboAdapter 静态契约', () => {
  const a = new WeiboAdapter()
  it('meta 与能力', () => {
    expect(a.meta.id).toBe('weibo')
    expect(a.meta.capabilities).toContain('article')
    expect(a.meta.capabilities).toContain('image_upload')
  })
  it('preprocessConfig 为 html 输出', () => {
    expect(a.preprocessConfig.outputFormat).toBe('html')
  })
  it('checkAuth 方法存在且失败不抛', async () => {
    expect(typeof a.checkAuth).toBe('function')
    const r = await a.checkAuth()
    expect(typeof r.isAuthenticated).toBe('boolean')
  })
})

describe('WeixinOfficialAdapter 静态契约', () => {
  // 构造需要凭证参数（仅测 meta，不触网）
  const a = new WeixinOfficialAdapter({ appId: 'test', appSecret: 'test' })
  it('meta 与能力（官方 API 通道）', () => {
    expect(a.meta.id).toBe('weixin-official')
    expect(a.meta.capabilities).toContain('article')
    expect(a.meta.capabilities).toContain('image_upload')
  })
})
