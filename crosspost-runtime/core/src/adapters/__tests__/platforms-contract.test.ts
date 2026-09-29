// 平台适配器静态契约（2026-09-10 阶段 D1）：覆盖全部公开适配器（27 个平台 + weixin-official）。
// 2026-09-26：9 个原"转写"适配器补齐类型后一并纳入（此前它们既无类型检查也不在这份契约里，
// 正是这个缺口让它们悄悄漂了很久）；用例集合改为对 TARGET_PLATFORMS 求集合相等，不再手写数字。
// 只做静态断言（meta / capabilities / preprocessConfig / HEADER_RULES 形状 / 必需方法），不触网。
//
// canonical id 以 crosspost-runtime/src/platform-ids.mjs 的 TARGET_PLATFORMS 为单一来源；
// 运行时侧另有 tests/platform-ids-contract.test.mjs 做集合一致性校验（含 27 个平台适配器）。
import { describe, it, expect } from 'vitest'
import type { PlatformAdapter } from '../types'
import type { PlatformCapability, Article } from '../../types'
import type { RuntimeInterface } from '../../runtime/interface'
import { TARGET_PLATFORMS } from '../../../../src/platform-ids.mjs'
import {
  BaijiahaoAdapter,
  BilibiliAdapter,
  CnblogsAdapter,
  CSDNAdapter,
  Cto51Adapter,
  DayuAdapter,
  DoubanAdapter,
  DouyinAdapter,
  EastmoneyAdapter,
  ImoocAdapter,
  JianshuAdapter,
  JuejinAdapter,
  NeteaseAdapter,
  OschinaAdapter,
  SegmentfaultAdapter,
  SmzdmAdapter,
  SohuAdapter,
  SohufocusAdapter,
  ToutiaoAdapter,
  WeiboAdapter,
  WeixinAdapter,
  WeixinOfficialAdapter,
  WoshipmAdapter,
  XiaohongshuAdapter,
  XueqiuAdapter,
  YidianAdapter,
  YuqueAdapter,
  ZhihuAdapter,
} from '../platforms'

const ALLOWED_CAPS: PlatformCapability[] = [
  'article',
  'draft',
  'image_upload',
  'categories',
  'tags',
  'cover',
  'schedule',
]

interface Case {
  name: string
  id: string
  make: () => PlatformAdapter
  /** 是否声明了 HEADER_RULES / preprocessConfig（weixin-official 走官方 API 通道，两者皆无） */
  hasHeaderRules: boolean
  hasPreprocessConfig: boolean
}

const CASES: Case[] = [
  {
    name: 'BaijiahaoAdapter',
    id: 'baijiahao',
    make: () => new BaijiahaoAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'BilibiliAdapter',
    id: 'bilibili',
    make: () => new BilibiliAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'CnblogsAdapter',
    id: 'cnblogs',
    make: () => new CnblogsAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'CSDNAdapter',
    id: 'csdn',
    make: () => new CSDNAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'Cto51Adapter',
    id: 'cto51',
    make: () => new Cto51Adapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'DayuAdapter',
    id: 'dayu',
    make: () => new DayuAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'DoubanAdapter',
    id: 'douban',
    make: () => new DoubanAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'DouyinAdapter',
    id: 'douyin',
    make: () => new DouyinAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'EastmoneyAdapter',
    id: 'eastmoney',
    make: () => new EastmoneyAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'ImoocAdapter',
    id: 'imooc',
    make: () => new ImoocAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'JianshuAdapter',
    id: 'jianshu',
    make: () => new JianshuAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'JuejinAdapter',
    id: 'juejin',
    make: () => new JuejinAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'NeteaseAdapter',
    id: 'netease',
    make: () => new NeteaseAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'OschinaAdapter',
    id: 'oschina',
    make: () => new OschinaAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'SegmentfaultAdapter',
    id: 'segmentfault',
    make: () => new SegmentfaultAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'SmzdmAdapter',
    id: 'smzdm',
    make: () => new SmzdmAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'SohuAdapter',
    id: 'sohu',
    make: () => new SohuAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'SohufocusAdapter',
    id: 'sohufocus',
    make: () => new SohufocusAdapter(),
    hasHeaderRules: false,
    hasPreprocessConfig: true,
  },
  {
    name: 'ToutiaoAdapter',
    id: 'toutiao',
    make: () => new ToutiaoAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'WeiboAdapter',
    id: 'weibo',
    make: () => new WeiboAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'WeixinAdapter',
    id: 'weixin',
    make: () => new WeixinAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'WeixinOfficialAdapter',
    id: 'weixin-official',
    make: () => new WeixinOfficialAdapter({ appId: 'test', appSecret: 'test' }),
    hasHeaderRules: false,
    hasPreprocessConfig: false,
  },
  {
    name: 'WoshipmAdapter',
    id: 'woshipm',
    make: () => new WoshipmAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'XiaohongshuAdapter',
    id: 'xiaohongshu',
    make: () => new XiaohongshuAdapter(),
    hasHeaderRules: false,
    hasPreprocessConfig: false,
  },
  {
    name: 'XueqiuAdapter',
    id: 'xueqiu',
    make: () => new XueqiuAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'YidianAdapter',
    id: 'yidian',
    make: () => new YidianAdapter(),
    hasHeaderRules: false,
    hasPreprocessConfig: true,
  },
  {
    name: 'YuqueAdapter',
    id: 'yuque',
    make: () => new YuqueAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
  {
    name: 'ZhihuAdapter',
    id: 'zhihu',
    make: () => new ZhihuAdapter(),
    hasHeaderRules: true,
    hasPreprocessConfig: true,
  },
]

describe('平台适配器静态契约（TARGET_PLATFORMS + weixin-official）', () => {
  it('用例集合与单一来源一致：既有 27 个平台 id，也有每个的适配器实现', () => {
    const covered = CASES.map((c) => c.id)
    expect([...covered].sort()).toEqual([...TARGET_PLATFORMS, 'weixin-official'].sort())
  })

  for (const c of CASES) {
    describe(c.name, () => {
      const adapter = c.make()

      it('meta.id 与单一来源（TARGET_PLATFORMS）一致', () => {
        expect(adapter.meta.id).toBe(c.id)
      })

      it('meta 基本信息完整', () => {
        expect(typeof adapter.meta.name).toBe('string')
        expect(adapter.meta.name.length).toBeGreaterThan(0)
        expect(adapter.meta.icon).toMatch(/^https?:\/\//)
        expect(adapter.meta.homepage).toMatch(/^https?:\/\//)
      })

      it('capabilities 合法且含 article', () => {
        expect(Array.isArray(adapter.meta.capabilities)).toBe(true)
        expect(adapter.meta.capabilities).toContain('article')
        for (const cap of adapter.meta.capabilities) {
          expect(ALLOWED_CAPS).toContain(cap)
        }
      })

      it('实现 PlatformAdapter 必需方法', () => {
        expect(typeof adapter.init).toBe('function')
        expect(typeof adapter.checkAuth).toBe('function')
        expect(typeof adapter.publish).toBe('function')
      })

      it('preprocessConfig 输出格式合法', () => {
        if (!c.hasPreprocessConfig) {
          expect(adapter.preprocessConfig).toBeUndefined()
          return
        }
        expect(adapter.preprocessConfig?.outputFormat).toMatch(/^(html|markdown)$/)
      })

      it('HEADER_RULES 形状合法（若声明）', () => {
        // HEADER_RULES 在适配器中为 private，这里以运行时结构做形状校验（与既有冒烟测试一致）
        const rules = (
          adapter as unknown as {
            HEADER_RULES?: Array<{
              urlFilter?: unknown
              headers?: unknown
              resourceTypes?: unknown
            }>
          }
        ).HEADER_RULES
        if (!c.hasHeaderRules) {
          expect(rules).toBeUndefined()
          return
        }
        expect(Array.isArray(rules)).toBe(true)
        expect((rules || []).length).toBeGreaterThan(0)
        for (const r of rules || []) {
          expect(typeof r.urlFilter).toBe('string')
          expect(r.headers === undefined || typeof r.headers === 'object').toBe(true)
          if (r.resourceTypes !== undefined) expect(Array.isArray(r.resourceTypes)).toBe(true)
        }
      })
    })
  }
})

// ── checkAuth 静态行为（mock runtime，不发真实请求） ──
// 目的：驱动各适配器 checkAuth 的解析/兜底分支；未登录时必须返回结构而非抛错。
function fakeResponse(body = '<html><body>not logged in</body></html>'): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/html' },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
}

function fakeRuntime(): RuntimeInterface {
  return {
    type: 'node',
    fetch: async () => fakeResponse(),
    getCookie: async () => null,
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    session: { get: async () => null, set: async () => {} },
    headerRules: { add: async () => 'r1', remove: async () => {}, clear: async () => {} },
    dom: {
      parseHTML: async () => ({}) as Document,
      querySelector: () => null,
      querySelectorAll: () => [],
      getTextContent: () => '',
      getInnerHTML: () => '',
    },
  } as RuntimeInterface
}

describe('checkAuth 未登录兜底（mock runtime）', () => {
  for (const c of CASES) {
    it(`${c.name} 未登录返回结构且不抛错`, async () => {
      const adapter = c.make()
      await adapter.init(fakeRuntime())
      const r = await adapter.checkAuth()
      expect(typeof r.isAuthenticated).toBe('boolean')
      expect(r.isAuthenticated).toBe(false)
    })
  }
})

// ── publish 失败兜底（mock runtime 返回失败响应） ──
// 目的：驱动各适配器 publish 主体（多数以 .catch(→createResult(false)) 收尾）；
// 断言「返回 SyncResult 或抛错」皆可，绝不出现挂起/未处理拒绝。
const SAMPLE_ARTICLE = {
  title: '契约测试',
  markdown: '# 标题\n\n正文内容',
  html: '<h1>标题</h1><p>正文内容</p>',
} as unknown as Article

function failingRuntime(): RuntimeInterface {
  const rt = fakeRuntime()
  return {
    ...rt,
    fetch: async () =>
      ({
        ok: false,
        status: 500,
        statusText: 'MockFailure',
        headers: { get: () => 'text/html' },
        text: async () => '<html>fail</html>',
        json: async () => {
          throw new Error('not json')
        },
      }) as unknown as Response,
  } as RuntimeInterface
}

describe('publish 失败兜底（mock runtime）', () => {
  for (const c of CASES) {
    it(`${c.name} publish 不挂起且不产生未处理拒绝`, { timeout: 20000 }, async () => {
      const adapter = c.make()
      await adapter.init(failingRuntime())
      let result: unknown
      let threw: unknown
      try {
        result = await adapter.publish(SAMPLE_ARTICLE, { draftOnly: true })
      } catch (e) {
        threw = e
      }
      // 允许两种形态：返回结果，或抛错（都不算失败；关键是终止且无未处理拒绝）
      if (threw === undefined) {
        expect(typeof (result as { success?: unknown })?.success).toBe('boolean')
      } else {
        expect(String(threw)).toBeTruthy()
      }
    })
  }
})
