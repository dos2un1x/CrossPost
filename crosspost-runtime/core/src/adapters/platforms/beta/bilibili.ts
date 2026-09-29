/**
 * 哔哩哔哩（B 站专栏）适配器。
 *
 * 三条链路都只走 HTTP 接口，不注入页面：
 *
 * 1. 登录态：探测 `nav` 接口；这一次回包同时提供用户信息与「接下来要用的 csrf」，
 *    所以探测成功后会顺手把 `bili_jct` cookie 读进来缓存，后续请求不再回头取。
 * 2. 发布：调用专栏草稿的增改接口，`save=0` 表示只落草稿、不走投稿审核；
 *    回跳地址是专栏编辑器的草稿编辑页。
 * 3. 配图：先把原图拉成二进制，再以 multipart 提交到图床接口，回包里的 `size`
 *    会作为附加属性写回正文的 `<img>`。
 *
 * `Origin` / `Referer` 由请求头规则临时注入，作用域仅覆盖发布那一段。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { PublishOptions } from '../../types'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import { createLogger } from '../../../lib/logger'

const log = createLogger('bilibili')

/** 探测登录态：带 `build`/`mobi_app` 才是 web 端认可的参数组合 */
const NAV_ENDPOINT = 'https://api.bilibili.com/x/web-interface/nav?build=0&mobi_app=web'

/** 专栏草稿的增改接口（新建与更新共用，靠 `pgc_id` 区分） */
const DRAFT_ENDPOINT = 'https://api.bilibili.com/x/article/creative/draft/addupdate'

/** 专栏正文图床：字段名沿用平台的 `upcover` */
const COVER_ENDPOINT = 'https://api.bilibili.com/x/article/creative/article/upcover'

/** 草稿回跳地址的基址，后面拼 `aid` */
const EDITOR_BASE = 'https://member.bilibili.com/platform/upload/text/edit'

/** csrf 与 cookie 同值：接口字段叫 `csrf`，浏览器里叫 `bili_jct` */
const CSRF_COOKIE = 'bili_jct'
const CSRF_DOMAIN = '.bilibili.com'

/** 已经是 B 站自家图床的地址就不必再转存一遍 */
const OWN_IMAGE_HOSTS = ['hdslb.com', 'bilibili.com', 'biliimg.com']

/** 提交时固定落在「专栏」默认分区下 */
const DEFAULT_PARTITION = '4'

/** 抓图时的固定文件名：平台侧只按内容识别，名字给个常规后缀即可 */
const UPLOAD_FILENAME = 'image.jpg'

/** `nav` 回包里我们要的那几个字段 */
interface AccountInfo {
  isLogin?: boolean
  mid?: number | string
  uname?: string
  face?: string
}

/** 平台统一的回包外壳 */
interface Envelope<T> {
  code?: number
  message?: string
  data?: T
}

/** 图床回包 */
interface CoverInfo {
  url?: string
  size?: number
}

/** 草稿回包 */
interface DraftInfo {
  aid?: number | string
}

/** 把任意异常收敛成一句可读文案 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BilibiliAdapter extends CodeAdapter {
  override readonly meta: PlatformMeta = {
    id: 'bilibili',
    name: '哔哩哔哩',
    icon: 'https://www.bilibili.com/favicon.ico',
    homepage: 'https://member.bilibili.com/platform/upload/text',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  /**
   * 只有发布链路要伪装「请求来自专栏编辑器」；登录探测裸跑，
   * 免得带上一份用不到的来源头。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://api.bilibili.com/*',
      headers: {
        Origin: 'https://member.bilibili.com',
        Referer: 'https://member.bilibili.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** nav 探测拿到的账号信息；为空表示这颗适配器还没确认过登录态 */
  private account: AccountInfo | null = null

  /** 与 cookie `bili_jct` 同值的 csrf；空串表示没拿到 */
  private csrfToken = ''

  /**
   * 探测登录态。
   *
   * 判定成立时缓存整份 `data` 并立刻取一次 csrf；「确实没登录」只返回结构，
   * 只有请求本身出问题才会带上 `error`。
   */
  override async checkAuth(): Promise<AuthResult> {
    try {
      const reply = await this.get<Envelope<AccountInfo>>(NAV_ENDPOINT)
      const info = reply?.data
      if (reply?.code !== 0 || !info?.isLogin) {
        log.debug('nav 回包说明当前不是登录状态')
        return { isAuthenticated: false }
      }

      this.account = info
      await this.captureCsrf()

      log.debug(`已确认登录：${String(info.uname ?? '')}`)
      return {
        isAuthenticated: true,
        userId: String(info.mid),
        username: info.uname,
        avatar: info.face,
      }
    } catch (error) {
      log.warn('登录态探测失败', reasonOf(error))
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /**
   * 发布到草稿箱。
   *
   * 登录缓存在探测阶段就填好了；但调用方也可能直接调 `publish`，
   * 所以缓存为空时补一次探测。csrf 缺失是硬前置：没有它平台会直接拒。
   */
  override async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (!this.account) {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) {
            throw new Error('尚未登录 B 站：请先在浏览器里登录，再重试发布')
          }
        }
        if (!this.csrfToken) {
          throw new Error('没有取到 bili_jct：请刷新一次 B 站页面后重试')
        }

        const body = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: OWN_IMAGE_HOSTS,
            onProgress: options?.onImageProgress,
          },
        )

        const reply = await this.postForm<Envelope<DraftInfo>>(DRAFT_ENDPOINT, {
          tid: DEFAULT_PARTITION,
          title: article.title,
          content: body,
          csrf: this.csrfToken,
          save: '0',
          pgc_id: '0',
        })

        if (reply?.code !== 0 || !reply?.data?.aid) {
          throw new Error(
            reply?.message
              ? `B 站没有接受这篇草稿：${reply.message}`
              : 'B 站没有接受这篇草稿：回包里没有 aid',
          )
        }

        const aid = reply.data.aid
        log.debug(`草稿已落库：aid=${String(aid)}`)
        return this.createResult(true, {
          postId: String(aid),
          postUrl: `${EDITOR_BASE}?aid=${String(aid)}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.error('草稿保存未完成', reasonOf(error))
      return this.createResult(false, { error: reasonOf(error) })
    }
  }

  /**
   * 把正文里的一张图转到 B 站图床。
   *
   * 先要 csrf（没有就直接失败），再拉原图、以 `upcover` 提交；
   * 回包里的 `size` 作为附加属性返回，由基类写进 `<img>`。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.csrfToken) {
      throw new Error('缺少 bili_jct，无法把配图转存到 B 站图床')
    }

    const origin = await fetch(src)
    if (!origin.ok) {
      throw new Error(`配图下载失败：HTTP ${origin.status}`)
    }
    const bits = await origin.blob()

    const form = new FormData()
    form.append('binary', bits, UPLOAD_FILENAME)
    form.append('csrf', this.csrfToken)

    const response = await this.runtime.fetch(COVER_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const reply = (await response.json()) as Envelope<CoverInfo>

    if (reply?.code !== 0 || !reply?.data?.url) {
      throw new Error(reply?.message || 'B 站图床没有回可用的图片地址')
    }

    return {
      url: reply.data.url,
      attrs: { size: String(reply.data.size) },
    }
  }

  /** 从 cookie 里取一次 csrf；读不到（或运行时没有该能力）就保持空串 */
  private async captureCsrf(): Promise<void> {
    if (!this.runtime.getCookie) {
      log.debug('运行时没有读取 cookie 的能力，csrf 将不可用')
      return
    }
    try {
      this.csrfToken = (await this.runtime.getCookie(CSRF_DOMAIN, CSRF_COOKIE)) ?? ''
    } catch (error) {
      log.warn('读取 bili_jct 失败', reasonOf(error))
    }
  }
}
