/**
 * 头条（mp.toutiao.com）适配器
 *
 * 本适配器只做「存草稿」：
 * 头条的 article/publish 接口在 pgc_id='0'（新建）、save='0'、timer_status='0'（不设定时）
 * 的组合下等价于新建一篇草稿，回包里的 pgc_id 就是草稿 id；这里不会再调用任何发表接口。
 *
 * 为什么必须落在页面上下文：
 * mp.toutiao.com 会校验页面内生成的签名（ttwid 等），扩展后台/Node 直连会被拒，
 * 因此正文表单最终交给 runtime.pageOp('toutiaoPublish') 在页面里 fetch 出去。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const log = createLogger('ToutiaoAdapter')

/** 账号信息（登录态判定） */
const ACCOUNT_ENDPOINT = 'https://mp.toutiao.com/mp/agw/media/get_media_info'
/** 草稿保存接口（回包只给 pgc_id） */
const DRAFT_ENDPOINT =
  'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231'
/** 图文编辑器地址，同时是发布用 tab 的落地页与草稿回跳地址的基址 */
const EDITOR_PAGE = 'https://mp.toutiao.com/profile_v4/graphic/publish'
/** CSRF token 探测（token 在响应头里） */
const CSRF_ENDPOINT = 'https://mp.toutiao.com/ttwid/check/'
/** 正文图上传 */
const IMAGE_ENDPOINT =
  'https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web'

const EDITOR_ORIGIN = 'https://mp.toutiao.com'
const EDITOR_TAB_PATTERN = 'https://mp.toutiao.com/*'
const EDITOR_TAB_TIMEOUT = 30000

/** 平台自有图床的图片无需再转存，正文里直接沿用 */
const OWN_CDN_HOSTS = ['pstatp.com', 'toutiao.com', 'byteimg.com']

/** 空 figure（正文转换后常见的残留） */
const EMPTY_FIGURE = /<figure\b[^>]*>\s*<\/figure>/gi
/** 连续空行 */
const BLANK_RUN = /\n{3,}/g
/** 任意 img 标签（含 processImages 产出的自闭合形态） */
const IMG_TAG = /<img\b[^>]*>/gi

interface ToutiaoAccount {
  id?: number | string
  screen_name?: string
  https_avatar_url?: string
}

interface ToutiaoAccountReply {
  data?: { user?: ToutiaoAccount }
}

interface ToutiaoImageReply {
  code?: number
  message?: string
  data?: {
    image_url?: string
    image_uri?: string
    image_width?: number
    image_height?: number
  }
}

interface ToutiaoDraftReply {
  err_no?: number
  message?: string
  data?: { pgc_id?: number | string }
}

interface ToutiaoPageOpReply {
  success?: boolean
  error?: string
  data?: ToutiaoDraftReply
}

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'toutiao',
    name: '头条',
    icon: 'https://sf1-ttcdn-tos.pstatp.com/obj/ttfe/pgcfe/sz/mp_logo.png',
    homepage: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
    removeLinks: true,
    removeEmptyImages: true,
    removeDataAttributes: true,
    flattenNestedBold: true,
    unwrapSingleChildSpans: true,
  }

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.toutiao.com/*',
      headers: {
        Origin: EDITOR_ORIGIN,
        Referer: EDITOR_PAGE,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 本次调用自建的发布用 tab；复用用户已有 tab 时为 null（收尾不得关闭别人的页面） */
  private ownedTabId: number | null = null

  // ============ 公开入口 ============

  async checkAuth(): Promise<AuthResult> {
    try {
      const reply = await this.get<ToutiaoAccountReply>(ACCOUNT_ENDPOINT)
      const user = reply?.data?.user
      if (!user || !user.id) {
        // 接口通了但没有可用账号信息：按未登录处理，不额外编造 error
        return { isAuthenticated: false }
      }
      return {
        isAuthenticated: true,
        userId: String(user.id),
        username: user.screen_name,
        avatar: user.https_avatar_url,
      }
    } catch (error) {
      log.debug('checkAuth 探测失败:', error)
      return { isAuthenticated: false, error: describeError(error) }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const content = await this.toEditorHtml(article, options)
        const body = this.toDraftBody(article, content)
        const reply = await this.publishViaContentScript(DRAFT_ENDPOINT, body)

        if (reply.err_no !== 0 || !reply.data?.pgc_id) {
          throw new Error(reply.message || '发布失败')
        }
        const pgcId = reply.data.pgc_id

        return this.createResult(true, {
          postId: String(pgcId),
          postUrl: `${EDITOR_PAGE}?pgc_id=${pgcId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.warn('存草稿失败:', error)
      return this.createResult(false, { error: describeError(error) })
    }
  }

  // ============ 页面通道（浏览器扩展侧的私有协议） ============
  // 注意：下面三个方法是对外可观测的稳定入口（干净房间的行为差分 harness 会直接调用并比对
  // 返回值与调用轨迹），只允许改内部实现，不要改名或改签名。

  /**
   * 取得可用的头条 tab。
   * 命中用户已打开的头条页就直接复用（收尾不关它）；否则新建编辑器页并等加载完成。
   */
  async ensureToutiaoTab(): Promise<number> {
    const tabs = this.runtime.tabs
    if (!tabs) throw new Error('发布头条需要浏览器提供 tabs API')

    const opened = await tabs.query(EDITOR_TAB_PATTERN)
    if (opened.length > 0) {
      this.ownedTabId = null
      return opened[0].id
    }

    const created = await tabs.create(EDITOR_PAGE, false)
    await tabs.waitForLoad(created.id, EDITOR_TAB_TIMEOUT)
    this.ownedTabId = created.id
    return created.id
  }

  /**
   * 在头条页面的 MAIN world 里发出草稿请求，返回回包里的业务数据。
   * 收尾只关闭「本次自建」的 tab；关闭失败不影响发布结果。
   */
  async publishViaContentScript(url: string, body: string): Promise<ToutiaoDraftReply> {
    if (!this.runtime.pageOp) throw new Error('发布头条需要使用浏览器页面通道')

    const tabId = await this.ensureToutiaoTab()
    try {
      const reply = await this.runtime.pageOp<ToutiaoPageOpReply>(tabId, 'toutiaoPublish', [
        url,
        body,
      ])
      if (!reply || reply.success !== true) {
        throw new Error(reply?.error || '发布请求未成功')
      }
      return reply.data as ToutiaoDraftReply
    } finally {
      const owned = this.ownedTabId
      if (owned !== null) {
        this.ownedTabId = null
        try {
          await this.runtime.tabs?.close(owned)
        } catch (error) {
          log.debug('关闭发布用 tab 失败（忽略）:', error)
        }
      }
    }
  }

  /** 读取头条 CSRF token：只认响应头，拿不到就是空串（后续由页面侧签名兜底） */
  async getCsrfToken(): Promise<string> {
    const response = await this.runtime.fetch(CSRF_ENDPOINT, {
      method: 'HEAD',
      credentials: 'include',
      headers: {
        'x-secsdk-csrf-request': '1',
        'x-secsdk-csrf-version': '1.2.22',
      },
    })
    return response.headers.get('x-ware-csrf-token') || ''
  }

  // ============ 图片 ============

  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const download = await fetch(src)
    if (!download.ok) throw new Error(`下载图片未成功: ${src}`)
    const blob = await download.blob()

    const csrfToken = await this.getCsrfToken()

    const form = new FormData()
    form.append('image', blob, 'image.jpg')
    const response = await this.runtime.fetch(IMAGE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-secsdk-csrf-token': csrfToken },
      body: form,
    })

    let reply: ToutiaoImageReply
    try {
      reply = (await response.json()) as ToutiaoImageReply
    } catch {
      // 回包不是 JSON（含被风控 / 未登录时返回的 HTML 或纯文本）
      throw new Error('无法解析图片上传响应')
    }

    const data = reply.code === 0 ? reply.data : undefined
    if (!data) throw new Error(reply.message || '上传图片未成功')
    if (!data.image_url || !data.image_uri) throw new Error('上传结果缺少必要的图片字段')

    return {
      url: data.image_url,
      // 这一组属性是头条编辑器固定的图片描述，与真实 MIME 无关，原样给出即可
      attrs: {
        class: '',
        'ic-uri': '',
        image_type: 'image/png',
        mime_type: '',
        web_uri: data.image_uri,
        img_width: String(data.image_width || 0),
        img_height: String(data.image_height || 0),
      },
    }
  }

  // ============ 正文与表单 ============

  /** 正文变换：清残留 → 逐图转存 → 包成编辑器要求的 pgc-img 结构 */
  private async toEditorHtml(article: Article, options?: PublishOptions): Promise<string> {
    const cleaned = (article.html || '').replace(EMPTY_FIGURE, '').replace(BLANK_RUN, '\n')

    const uploaded = await this.processImages(cleaned, (src) => this.uploadImageByUrl(src), {
      skipPatterns: OWN_CDN_HOSTS,
      onProgress: options?.onImageProgress,
    })

    return uploaded.replace(
      IMG_TAG,
      (tag) => `<div class="pgc-img">${tag}<p class="pgc-img-caption"></p></div>`,
    )
  }

  /** 组装存草稿表单；content_word_cnt 取的是「图片替换并包裹之后」的 HTML 串长度 */
  private toDraftBody(article: Article, content: string): string {
    const extra = {
      content_source: 100000000402,
      content_word_cnt: content.length,
      is_multi_title: 0,
      sub_titles: [] as string[],
      gd_ext: {
        entrance: '',
        from_page: 'publisher_mp',
        enter_from: 'PC',
        device_platform: 'mp',
        is_message: 0,
      },
    }

    const fields: Record<string, string> = {
      pgc_id: '0',
      source: '29',
      extra: JSON.stringify(extra),
      content,
      title: article.title,
      search_creation_info: JSON.stringify({ searchTopOne: 0, abstract: '', clue_id: '' }),
      title_id: `${Date.now()}_${Math.random().toString().slice(2, 18)}`,
      mp_editor_stat: '{}',
      is_refute_rumor: '0',
      save: '0',
      timer_status: '0',
      is_fans_article: '0',
      govern_forward: '0',
      praise: '0',
      disable_praise: '0',
      tree_plan_article: '0',
      activity_tag: '0',
      trends_writing_tag: '0',
      claim_exclusive: '0',
      timer_time: '',
      educluecard: '',
      draft_form_data: JSON.stringify({ coverType: 3 }),
      pgc_feed_covers: '[]',
      article_ad_type: '3',
    }

    return new URLSearchParams(fields).toString()
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
