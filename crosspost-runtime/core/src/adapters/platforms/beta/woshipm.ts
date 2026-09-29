/**
 * 人人都是产品经理（woshipm.com）平台适配器。
 *
 * 这个平台只有「写稿页 → 存草稿」一条链路：
 *   · 登录身份与图片上传令牌都藏在写稿页的 HTML 里，一次抓取同时取两样；
 *   · 正文配图走平台自建的又拍云代理（`/tensorflow/upyun/upload`）；
 *   · 落草稿走编辑器自己的 AJAX 入口（`action=add_draft`），全程不碰发表接口。
 *
 * 两处「看起来不优雅、但必须保留」的行为写在这里，免得后来者顺手改掉：
 *   ① 标题里的引号会被**交替**换成直角引号 —— 平台把标题原样塞进编辑页的 HTML 属性值，
 *      不换的话标题会在第一个引号处被截断；
 *   ② 正文配图的转存失败一律静默退回原地址（宁可少一张图，也要让整篇存下去）；
 *      而 `uploadImage` 这条直传路径相反 —— 失败就抛给调用方。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const log = createLogger('woshipm')

/** 写稿页：登录身份、图片上传令牌、以及发布成功后的回跳地址都在这一张页面上 */
const WRITING_PAGE = 'https://www.woshipm.com/writing'

/** 编辑器落草稿的 AJAX 入口 */
const ADMIN_AJAX = 'https://www.woshipm.com/wp-admin/admin-ajax.php'

/** 又拍云代理上传入口 */
const UPLOAD_ENDPOINT = 'https://www.woshipm.com/tensorflow/upyun/upload'

/** 图床请求要装作从写稿页发出 */
const WRITING_ORIGIN = 'https://www.woshipm.com'

/** 落草稿与插图两个动作名 */
const DRAFT_ACTION = 'add_draft'
const IMAGE_ACTION = 'wpuf_insert_image'

/** 平台自家图床上的地址不必重传 */
const IMAGE_HOSTS = ['woshipm.com', 'image.woshipm.com']

/** 拿不到文件名时的兜底 */
const FALLBACK_FILENAME = 'image.png'

/** 需要净化成直角引号的三种引号 */
const QUOTES = new Set(['"', '“', '”'])

/** 把任意异常收敛成一句可读文案 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从写稿页 HTML 里取 uid。
 *
 * 页面里是一段 `var userSettings = {"uid":"1585",…}`；取不到 uid 就等同于「没登录」，
 * 因此这里返回 `null` 而不是抛错。
 */
function readUserId(html: string): string | null {
  const settings = /var\s+userSettings\s*=\s*(\{[\s\S]*?\})/.exec(html)
  if (!settings) return null
  const uid = /"uid"\s*:\s*"(\d+)"/.exec(settings[1])
  return uid ? uid[1] : null
}

/** 从写稿页 HTML 里取图片上传令牌；取不到只意味着插图少一个鉴权头，不算失败 */
function readUploadToken(html: string): string | null {
  const hit = /"jltoken"\s*:\s*"([^"]+)"/.exec(html)
  return hit ? hit[1] : null
}

/** 上传文件名取地址的最后一段；地址不成形（或没有末段）时用通用名 */
function pickFilename(src: string): string {
  try {
    const segments = new URL(src).pathname.split('/')
    return segments[segments.length - 1] || FALLBACK_FILENAME
  } catch {
    return FALLBACK_FILENAME
  }
}

/**
 * 标题引号净化：三种引号按**出现次序**交替写成 `「` 与 `」`。
 *
 * 这是有意为之的降级，不是排版修饰：平台的编辑页会把标题直接写进 HTML 属性值。
 */
function neutralizeTitle(title: string): string {
  let opening = true
  let out = ''
  for (const char of title) {
    if (QUOTES.has(char)) {
      out += opening ? '「' : '」'
      opening = !opening
    } else {
      out += char
    }
  }
  return out
}

export class WoshipmAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'woshipm',
    name: '人人都是产品经理',
    icon: 'https://www.woshipm.com/favicon.ico',
    homepage: 'https://www.woshipm.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeEmptyLines: true,
  }

  /**
   * 平台要求的三个入口都要带上 XHR 标记。`urlFilter` 按平台侧的域名原样写（不带 `www.`），
   * 是否覆盖 `www.woshipm.com` 由扩展的规则匹配实现决定 —— 这里不做「看起来更对」的改写。
   */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://woshipm.com/wp-admin/admin-ajax.php*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://woshipm.com/api2/*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://woshipm.com/tensorflow/upyun/upload*',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 写稿页里抓到的插图令牌；没走过 `checkAuth` 就一直是 `null` */
  private uploadToken: string | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const page = await this.runtime.fetch(WRITING_PAGE, { credentials: 'include' })
      const html = await page.text()
      this.uploadToken = readUploadToken(html)

      const uid = readUserId(html)
      if (!uid) return { isAuthenticated: false }

      const response = await this.runtime.fetch(
        `https://www.woshipm.com/api2/user/profile?uid=${uid}`,
        { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
      )
      const payload = (await response.json()) as {
        CODE?: number
        RESULT?: { userInfoVo?: { uid?: unknown; nickName?: string; avartar?: string } }
      }
      const profile = payload?.RESULT?.userInfoVo
      if (payload?.CODE !== 200 || !profile?.uid) return { isAuthenticated: false }

      // 平台回包里头像字段的拼写就是 `avartar`，照读，不做兼容分支
      return {
        isAuthenticated: true,
        userId: String(uid),
        username: profile.nickName,
        avatar: profile.avartar,
      }
    } catch (error) {
      log.debug('登录态探测未通过', error)
      return { isAuthenticated: false, error: describe(error) }
    }
  }

  /**
   * 只落草稿。
   *
   * 注意这里**不做登录前置检查**：平台在未登录时的表现是回一段登录页 HTML，
   * 被下面的 JSON 解析挡下来，错误类别是「响应不是有效 JSON」。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const content = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          { skipPatterns: IMAGE_HOSTS, onProgress: options?.onImageProgress },
        )

        const form = new URLSearchParams()
        form.append('action', DRAFT_ACTION)
        form.append('post_title', neutralizeTitle(article.title))
        form.append('post_content', content)

        const response = await this.runtime.fetch(ADMIN_AJAX, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: form,
        })

        // 这一条通道由适配器自己走「先读文本、再判 ok、最后手工解析」三步：
        // 登录页与错误页都是合法 HTTP 200，只有正文能说明发生了什么。
        const raw = await response.text()
        if (!response.ok) {
          throw new Error(`存草稿失败：HTTP ${response.status} - ${raw.slice(0, 200)}`)
        }

        let payload: { post_id?: unknown; url?: string; error?: string }
        try {
          payload = JSON.parse(raw) as typeof payload
        } catch {
          throw new Error(`存草稿失败：响应不是有效 JSON - ${raw.slice(0, 100)}`)
        }
        if (!payload || !payload.post_id) {
          throw new Error(`存草稿失败：${payload?.error || '响应里没有稿件编号'}`)
        }

        const postId = String(payload.post_id)
        return this.createResult(true, {
          postId,
          postUrl: payload.url || `${WRITING_PAGE}?pid=${postId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.warn('存草稿未成功', describe(error))
      return this.createResult(false, { error: describe(error) })
    }
  }

  /**
   * 按地址转存一张正文配图。
   *
   * 下载与上传的**任何**异常都在这里被吞掉，回落到原地址：正文里少一张图可以接受，
   * 整篇存不下去不行。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const response = await this.runtime.fetch(src, { credentials: 'omit' })
      if (!response.ok) {
        throw new Error(`取原图失败：HTTP ${response.status}`)
      }
      const blob = await response.blob()
      return { url: await this.transferImage(blob, pickFilename(src)) }
    } catch (error) {
      log.warn(`按地址转存失败，正文保留原地址：${describe(error)}`)
      return { url: src }
    }
  }

  /**
   * 本地图片直传。
   *
   * 与 `uploadImageByUrl` 的失败语义**相反**：这里不吞异常，失败就抛。
   */
  override async uploadImage(file: Blob, filename?: string): Promise<string> {
    return this.transferImage(file, filename || FALLBACK_FILENAME)
  }

  /** 二进制直传：不经过 data URI 中转，一步送到图床 */
  private async transferImage(blob: Blob, filename: string): Promise<string> {
    const form = new FormData()
    form.append('action', IMAGE_ACTION)
    form.append('name', filename)
    form.append('files', blob, filename)

    const headers: Record<string, string> = {
      Origin: WRITING_ORIGIN,
      Referer: WRITING_PAGE,
    }
    if (this.uploadToken) headers.jlstar = `Bearer ${this.uploadToken}`

    const response = await this.runtime.fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: form,
    })
    const payload = (await response.json()) as { data?: Array<{ url?: string }> }
    const uploaded = payload?.data
    if (!Array.isArray(uploaded) || uploaded.length === 0 || !uploaded[0]?.url) {
      throw new Error('图床响应里没有可用的图片地址')
    }
    return uploaded[0].url
  }
}
