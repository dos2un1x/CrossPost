/**
 * 开源中国（oschina）适配器。
 *
 * 全链路只有 HTTP 接口，不注入页面、不读页面 HTML：
 *
 * 1. 登录态：`myDetails` 一次探测，判定成立时把作者 id 缓存下来（后续存草稿与取名图片
 *    文件名都要用）。判定不成立时返回带 `error` 的失败结构；只有请求本身出问题才把异常
 *    的 message 带出去。
 * 2. 发布：调用草稿保存接口，`contentType` 随正文实际形态在 Markdown / HTML 之间切换
 *    （正文里的 Markdown 只有空白时会改用 HTML），回跳地址是草稿编辑页。
 * 3. 配图：先把原图拉成二进制，再以 multipart 提交到创作图床；接口回包的 `result` 本身
 *    就是图片地址，不再套字段。
 *
 * `Origin` / `Referer` 只在发布那一段临时注入（登录探测裸跑）。所有接口都不看 HTTP 状态码：
 * 平台把业务成败放在回包的 `success` 字段里，4xx/5xx 的响应体只要还能解析就继续按业务字段判。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'

/** 接口基址：登录探测、草稿保存、图床都在同一台 API 主机下 */
const API_BASE = 'https://apiv1.oschina.net/oschinapi'

/** 登录态探测：回包里有作者 id 才算登录 */
const PROFILE_ENDPOINT = `${API_BASE}/user/myDetails`

/** 草稿保存接口（只落草稿，没有发表动作） */
const DRAFT_ENDPOINT = `${API_BASE}/api/draft/save_draft`

/** 正文配图图床：回包 `result` 直接是图片地址 */
const IMAGE_ENDPOINT = `${API_BASE}/ai/creation/project/uploadDetail`

/** 站点主页，草稿回跳地址由它拼出 */
const BLOG_BASE = 'https://my.oschina.net'

/** 正文按 Markdown 提交 */
const CONTENT_TYPE_MARKDOWN = 1

/** 正文按 HTML 提交 */
const CONTENT_TYPE_HTML = 2

/** 猜不出图片文件名时用的占位名（无扩展名） */
const FALLBACK_IMAGE_NAME = 'image'

/** 平台统一的回包外壳：成败看 `success`，业务数据在 `result`，失败说明常在 `message` */
interface ApiReply<TResult> {
  success?: boolean
  result?: TResult
  message?: string
}

/** `myDetails` 回包里的账号信息 */
interface AuthorInfo {
  userId?: number | string
  userVo?: AuthorProfile
}

/** `myDetails` 回包里的展示信息（可能整块缺失） */
interface AuthorProfile {
  name?: string
  portraitUrl?: string
}

/** `save_draft` 回包里的草稿标识 */
interface SavedDraft {
  id?: number | string
}

/** 把任意异常收敛成一句可读文案 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从图片地址里取一个上传用的文件名：用 URL 解析出的 pathname 的最后一段。
 *
 * 地址不是合法 URL、或末段为空/纯空白时退回占位名 —— 平台只按内容识别图片，名字只求可读。
 */
function imageFileNameOf(src: string): string {
  try {
    const last = new URL(src).pathname.split('/').pop()
    if (last && last.trim() !== '') return last
  } catch {
    // 不是合法 URL：交给占位名
  }
  return FALLBACK_IMAGE_NAME
}

export class OschinaAdapter extends CodeAdapter {
  override readonly meta: PlatformMeta = {
    id: 'oschina',
    name: '开源中国',
    icon: 'https://www.oschina.net/favicon.ico',
    homepage: 'https://my.oschina.net',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 只有发布链路要伪装成来自站内编辑器；登录探测不带这一层 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://apiv1.oschina.net/oschinapi/*',
      headers: {
        Origin: BLOG_BASE,
        Referer: `${BLOG_BASE}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** `myDetails` 拿到的作者 id（字符串形态）；为空表示这颗实例还没确认过登录态 */
  private authorId: string | null = null

  /**
   * 探测登录态。
   *
   * 业务判定：`success` 为真且 `result.userId` 为真值 —— 两者缺一都当「没登录」，
   * 并把作者 id 缓存下来供发布复用。只有请求/解析本身出错才把异常原文放进 `error`。
   */
  override async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(PROFILE_ENDPOINT, { credentials: 'include' })
      const reply = (await response.json()) as ApiReply<AuthorInfo>
      const author = reply?.result

      if (!reply?.success || !author || !author.userId) {
        return { isAuthenticated: false, error: '开源中国没有确认登录状态，请先在浏览器里登录' }
      }

      const authorId = String(author.userId)
      this.authorId = authorId

      return {
        isAuthenticated: true,
        userId: authorId,
        username: author.userVo?.name || authorId,
        avatar: author.userVo?.portraitUrl,
      }
    } catch (error) {
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /**
   * 保存草稿。
   *
   * 单一入参：这个平台没有需要外部传入的发布选项，草稿态是固定的，也就没有图片进度回调。
   * 作者 id 缺失时先补一次探测，探测不过就终止；随后按正文实际形态决定 `contentType`。
   */
  override async publish(article: Article): Promise<SyncResult> {
    const startedAt = Date.now()

    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (!this.authorId) {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) {
            throw new Error('开源中国尚未登录，无法保存草稿')
          }
        }

        // Markdown 只有空白时这个平台改吃 HTML —— 判定用的是去除首尾空白后的正文，
        // 提交的仍是原文（不去掉两端的空白）。
        const asMarkdown = (article.markdown || '').trim().length > 0
        const body = await this.processImages(
          asMarkdown ? article.markdown || '' : article.html || '',
          (src) => this.uploadImageByUrl(src),
        )

        const response = await this.runtime.fetch(DRAFT_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: article.title,
            user: Number(this.authorId),
            content: body,
            contentType: asMarkdown ? CONTENT_TYPE_MARKDOWN : CONTENT_TYPE_HTML,
            catalog: 0,
            originUrl: '',
            privacy: true,
            disableComment: false,
          }),
        })
        const reply = (await response.json()) as ApiReply<SavedDraft>
        const draftId = reply?.result?.id

        if (!reply?.success || !draftId) {
          throw new Error(reply?.message || '开源中国没有接下这篇草稿：回包里没有草稿标识')
        }

        const postId = String(draftId)
        return {
          platform: this.meta.id,
          success: true,
          postId,
          postUrl: `${BLOG_BASE}/u/${String(this.authorId)}/blog/write/draft/${postId}`,
          draftOnly: true,
          timestamp: startedAt,
        }
      })
    } catch (error) {
      return {
        platform: this.meta.id,
        success: false,
        error: reasonOf(error),
        timestamp: startedAt,
      }
    }
  }

  /**
   * 把正文里的一张图转存到创作图床。
   *
   * 没有作者 id 时顺手补一次登录探测，但**不看探测结果**：图床接口自己会拒未登录的请求，
   * 这里不替它做判断（也因此单独调这个方法不会因为未登录就提前失败）。
   */
  override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.authorId) {
      await this.checkAuth()
    }

    const origin = await this.runtime.fetch(src)
    const bits = await origin.blob()

    const form = new FormData()
    form.append('file', bits, imageFileNameOf(src))

    const response = await this.runtime.fetch(IMAGE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const reply = (await response.json()) as ApiReply<unknown>

    if (!reply?.success || !reply.result) {
      throw new Error(reply?.message || '开源中国图床没有回可用的图片地址')
    }

    return { url: String(reply.result) }
  }
}
