/**
 * 思否（SegmentFault）适配器。
 *
 * 与其他平台不同的三点：
 *
 * 1. 没有独立的鉴权接口可复用 —— 写草稿要用的那个 `token` 只能从发布页 HTML 里抠出来，
 *    因此正文图片的转存**依赖发布流程已经走到取 token 这一步**；
 *    脱离 `publish` 单独调 `uploadImageByUrl` 必然拿不到凭证。
 * 2. 平台回包不走统一的 `{code, data}` 信封，而是"明文串 / 业务数组 / 业务对象"三种形态混用，
 *    其中数组形态的业务信息在**第二个**元素里，第一个元素只是业务码。
 * 3. 平台会把风控结果（禁言、锁定）直接做成 HTML/纯文本下发，这类文本要原样带出去，
 *    不能被本地的兜底文案覆盖。
 */

import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'

/** 草稿保存接口：只落草稿 */
const DRAFT_ENDPOINT = 'https://segmentfault.com/gateway/draft'
/** 正文配图接口 */
const IMAGE_ENDPOINT = 'https://segmentfault.com/gateway/image'
/** 发布页：草稿凭证 `token` 的唯一来源 */
const WRITE_PAGE = 'https://segmentfault.com/write'
/** 账号设置页：用页面里的用户主页链接判断登录态 */
const SETTINGS_PAGE = 'https://segmentfault.com/user/settings'
/** 图片直链兜底前缀（回包只给了文件名时使用） */
const IMAGE_CDN_PREFIX = 'https://image-static.segmentfault.com/'

/** 页面里账号头像的位置 */
const AVATAR_PATTERN = /src="(https:\/\/avatar-static\.segmentfault\.com\/[^"]+)"/i
/** 页面里登录用户的主页链接 */
const PROFILE_PATTERN = /href="\/u\/([^"/]+)"/i
/** 新版页面把服务端数据序列化后内嵌，`Token` 就在里面 */
const SERVER_DATA_PATTERN = /serverData(?:\\?"|")\s*:\s*\{[^{}]*\\?"Token\\?"\s*:\s*\\?"([^"\\]+)/
/** 旧版页面的全局配置赋值起点（含赋值号与它后面的空格——与页面原文逐字一致） */
const LEGACY_PROPS_MARK = 'window.g_initialProps = '
/** 旧版页面配置块的收尾（缩进的那一个 `</script>`） */
const LEGACY_PROPS_END = ';\n\t</script>'
/** 平台下发的风控文案：出现任一关键词就原样带出 */
const RISK_WORDS = ['禁言', '锁定']

/** 把任意异常收敛成可读文案（非 Error 也有内容） */
function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 是否命中了平台的风控文案 */
function looksRestricted(html: string): boolean {
  return RISK_WORDS.some((word) => html.includes(word))
}

/** 从页面里取第一个捕获组，取不到就是 undefined */
function firstGroup(pattern: RegExp, page: string): string | undefined {
  const matched = pattern.exec(page)
  return matched ? matched[1] : undefined
}

export class SegmentfaultAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'segmentfault',
    name: '思否',
    icon: 'https://imgcache.iyiou.com/Company/2016-05-11/cf-segmentfault.jpg',
    homepage: 'https://segmentfault.com/user/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://segmentfault.com/gateway/*',
      headers: {
        Origin: 'https://segmentfault.com',
        Referer: 'https://segmentfault.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 发布页里抠出来的草稿凭证；只在 `publish` 流程内被赋值 */
  private sessionToken: string | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(SETTINGS_PAGE, { credentials: 'include' })
      const page = await response.text()
      const profile = firstGroup(PROFILE_PATTERN, page)
      if (!profile) {
        return {
          isAuthenticated: false,
          error: '当前浏览器里没有可用的思否登录态，请先登录后再试',
        }
      }
      return {
        isAuthenticated: true,
        userId: profile,
        username: profile,
        avatar: firstGroup(AVATAR_PATTERN, page),
      }
    } catch (error) {
      return { isAuthenticated: false, error: readable(error) }
    }
  }

  async publish(article: Article): Promise<SyncResult> {
    const startedAt = Date.now()
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        this.sessionToken = await this.readSessionToken()
        const content = await this.processImages(
          article.markdown || article.html || '',
          (src: string) => this.uploadImageByUrl(src),
        )
        const saved = await this.saveDraft(article.title, content)
        return {
          platform: this.meta.id,
          success: true,
          postId: saved as string,
          postUrl: `https://segmentfault.com/write?draftId=${String(saved)}`,
          draftOnly: true,
          timestamp: startedAt,
        }
      })
    } catch (error) {
      return {
        platform: this.meta.id,
        success: false,
        error: readable(error),
        timestamp: startedAt,
      }
    }
  }

  /**
   * 把一张正文配图转存到平台图床。
   *
   * 与草稿接口共用同一张凭证，所以没跑过 `publish` 的实例到这里就直接失败
   * （`processImages` 会把单图失败吞掉，不阻断发布）。
   */
  override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const token = this.sessionToken
    if (!token) {
      throw new Error('尚未取得思否草稿凭证，无法转存正文配图（该凭证只在发布流程内获取）')
    }

    const downloaded = await this.runtime.fetch(src)
    const image = await downloaded.blob()

    const form = new FormData()
    form.append('image', image)

    const response = await this.runtime.fetch(IMAGE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { token },
      body: form,
    })

    const ack = await this.decodeBody(await response.text(), '图片转存')
    const url = this.pickImageUrl(ack)
    if (!url) {
      const reason = this.failureText(ack)
      throw new Error(reason === '' ? '思否图床没有返回可用的图片地址' : reason)
    }
    return { url }
  }

  // ───────────────────────── 内部实现 ─────────────────────────

  /** 取草稿凭证：先认新版的服务器数据，再退回旧版的全局配置块 */
  private async readSessionToken(): Promise<string> {
    const response = await this.runtime.fetch(WRITE_PAGE, { credentials: 'include' })
    const page = await response.text()

    const inline = firstGroup(SERVER_DATA_PATTERN, page)
    if (inline) return inline

    const markAt = page.indexOf(LEGACY_PROPS_MARK)
    if (markAt === -1) {
      throw new Error('思否发布页里找不到草稿凭证的内嵌数据，页面可能已改版')
    }
    const openAt = markAt + LEGACY_PROPS_MARK.length
    const closeAt = page.indexOf(LEGACY_PROPS_END, openAt)
    if (closeAt === -1) {
      throw new Error('思否发布页的内嵌数据没有正常收尾，解析不了草稿凭证')
    }

    // 两个标记之间是赋值号之后的对象字面量，原样解析（多一个字符都算页面结构变了）
    const props = page.slice(openAt, closeAt)
    let parsed: { global?: { sessionInfo?: { key?: unknown } } }
    try {
      parsed = JSON.parse(props) as typeof parsed
    } catch (error) {
      throw new Error(`思否发布页的内嵌数据不是合法 JSON：${readable(error)}`)
    }

    const key = parsed?.global?.sessionInfo?.key
    if (typeof key !== 'string' || key === '') {
      throw new Error('思否发布页给出的草稿凭证是空的，请重新登录后再试')
    }
    return key
  }

  /** POST 一份草稿，成功时回草稿 id（平台可能给数字） */
  private async saveDraft(title: string, content: string): Promise<unknown> {
    const response = await this.runtime.fetch(DRAFT_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        token: this.sessionToken as string,
        accept: '*/*',
      },
      body: JSON.stringify({
        title,
        tags: [],
        text: content,
        object_id: '',
        type: 'article',
      }),
    })

    const ack = await this.decodeBody(await response.text(), '保存草稿')
    const saved = this.pickDraftId(ack)
    if (saved === undefined) {
      const reason = this.failureText(ack)
      throw new Error(reason === '' ? '思否没有返回草稿 id，草稿可能没有落库' : reason)
    }
    return saved
  }

  /**
   * 把回包文本解成业务数据。
   *
   * 平台有三种下发音：明文 `Unauthorized`、风控文案、正常 JSON。前两种在这里变成异常，
   * 且风控文案**原样**抛出；非 JSON 的其它文本按"解析不了"处理并带上原文。
   */
  private async decodeBody(raw: string, action: string): Promise<unknown> {
    if (raw.trim() === 'Unauthorized') {
      throw new Error(`思否拒绝了这次${action}请求：登录态已失效或草稿凭证不对`)
    }
    if (looksRestricted(raw)) {
      throw new Error(raw)
    }
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new Error(`思否没有给出可解析的${action}回包：${raw}`)
    }
  }

  /** 草稿 id：数组形态在第二个元素上，对象形态直接在 `id` 上 */
  private pickDraftId(ack: unknown): unknown {
    const payload = Array.isArray(ack) ? ack[1] : ack
    if (payload === null || typeof payload !== 'object') return undefined
    const id = (payload as Record<string, unknown>).id
    return id ? id : undefined
  }

  /**
   * 失败文案：数组编号为 1 时取第二元素；否则按
   * `message → msg → error → errMsg → 整个回包` 依次兜底。
   */
  private failureText(ack: unknown): string {
    if (Array.isArray(ack) && ack[0] === 1) {
      const first = ack[1]
      return typeof first === 'string' && first !== '' ? first : '思否拒绝了这次草稿保存请求'
    }
    if (ack !== null && typeof ack === 'object') {
      const bag = ack as Record<string, unknown>
      for (const key of ['message', 'msg', 'error', 'errMsg']) {
        const value = bag[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
    return JSON.stringify(ack)
  }

  /**
   * 图床回包 → 图片地址。
   *
   * 对象形态取 `result`；数组形态取第二元素，第二元素为空时用第三元素（文件名）
   * 拼 CDN 前缀；编号为 1 的数组是失败回包，不产出地址。
   */
  private pickImageUrl(ack: unknown): string | undefined {
    if (Array.isArray(ack)) {
      if (ack[0] === 1) return undefined
      const payload = ack[1]
      if (typeof payload === 'string' && payload !== '') return payload
      if (payload !== null && typeof payload === 'object') {
        const inner = (payload as Record<string, unknown>).result
        if (typeof inner === 'string' && inner !== '') return inner
      }
      const file = ack[2]
      return typeof file === 'string' && file !== '' ? `${IMAGE_CDN_PREFIX}${file}` : undefined
    }
    if (ack !== null && typeof ack === 'object') {
      const value = (ack as Record<string, unknown>).result
      if (typeof value === 'string' && value !== '') return value
    }
    return undefined
  }
}

export default SegmentfaultAdapter
