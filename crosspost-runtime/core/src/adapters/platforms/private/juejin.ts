/**
 * 掘金适配器 —— 只存草稿，不做发表。
 *
 * 平台侧的几件事实决定了这里的分工：
 * 1. 写接口一律要求 `x-secsdk-csrf-token`，而它只能从 `sys/token` 的**响应头**里读出来；
 *    同一会话内取一次就够，实例上缓存。
 * 2. 正文里的外链图片要先搬进 ImageX（字节的图片服务），五步：
 *    取上传令牌 → AWS4 签名申请上传地址（Apply）→ 字节直传 TOS → Commit → 用 StoreUri
 *    换编辑器可显示的地址。令牌有有效期，多图共用一份。
 * 3. 草稿正文走 Markdown 原文（`mark_content`），渲染交给掘金编辑器。
 *
 * 图片链路的失败不影响发布：单张搬不过去就把原地址留在正文里。
 */
import { randomUUID } from 'node:crypto'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { Category, PublishOptions } from '../../types'
import { signAWS4, crc32 } from '../../../lib'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Juejin')

/** 掘金主站 */
const SITE_ORIGIN = 'https://juejin.cn'
/** 业务接口所在域 */
const API_ORIGIN = 'https://api.juejin.cn'
/** ImageX（字节图片服务）网关 */
const IMAGEX_ORIGIN = 'https://imagex.bytedanceapi.com'

/**
 * ImageX 的两个裸字面量：`aid` 供令牌与取图接口用，`ServiceId` 供 Apply / Commit 用。
 * 两份独立来源都只把它们写成常量，没有注释或推导可佐证语义 —— 原样保留，不臆造。
 */
const IMAGEX_AID = '2608'
const IMAGEX_SERVICE_ID = '73owjymdk6'

/** 令牌失效前多久就提前作废 */
const TOKEN_EXPIRE_MARGIN_MS = 60_000
/** 草稿日志里回包正文的截断长度 */
const RESPONSE_LOG_CHARS = 300
/** 解析失败时报错文案里回包正文的截断长度 */
const PARSE_ERROR_CHARS = 100

/**
 * 取 CSRF 的请求要自报 SDK 版本，头名与取值都是平台侧的固定契约。
 */
const CSRF_HEADERS = {
  'x-secsdk-csrf-request': '1',
  'x-secsdk-csrf-version': '1.2.10',
}
/** 令牌所在的响应头 */
const CSRF_HEADER_NAME = 'x-ware-csrf-token'

const USER_INFO_API = `${API_ORIGIN}/user_api/v1/user/get`
const CSRF_API = `${API_ORIGIN}/user_api/v1/sys/token`
const DRAFT_API = `${API_ORIGIN}/content_api/v1/article_draft/create`
const CATEGORY_API = `${API_ORIGIN}/tag_api/v1/query_category_briefs`
const TOKEN_API = `${API_ORIGIN}/imagex/v2/gen_token?aid=${IMAGEX_AID}`
const IMAGE_URL_API = `${API_ORIGIN}/imagex/v2/get_img_url?aid=${IMAGEX_AID}`
const IMAGE_APPLY_API = `${IMAGEX_ORIGIN}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`

/** 正文里带这些子串的图不重复搬（已经是掘金自家图床的图） */
const BUILTIN_IMAGE_PATTERNS = [
  'juejin.cn',
  'p1-juejin',
  'p3-juejin',
  'p6-juejin',
  'p9-juejin',
  'byteimg.com',
]

/** `gen_token` 回包里的上传令牌 */
interface ImageTokenPayload {
  AccessKeyId?: string
  SecretAccessKey?: string
  SessionToken?: string
  /** 平台给的 ISO 字符串，这里只用来算缓存有效期 */
  ExpiredTime?: string
}

interface GenTokenPayload {
  err_no?: number
  err_msg?: string
  data?: { token?: ImageTokenPayload }
}

/** Apply 回包里的一处上传地址 */
interface UploadAddress {
  StoreInfos?: Array<{ StoreUri?: string; Auth?: string }>
  UploadHosts?: string[]
  SessionKey?: string
}

interface ApplyPayload {
  Result?: { UploadAddress?: UploadAddress }
}

interface CommitPayload {
  Result?: unknown
}

interface ImageUrlPayload {
  err_no?: number
  err_msg?: string
  data?: { main_url?: string; backup_url?: string }
}

interface DraftPayload {
  err_no?: number
  err_msg?: string
  data?: { id?: string | number }
}

interface CategoryPayload {
  data?: Array<{ category_id?: string | number; category_name?: string }>
}

export class JuejinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'juejin',
    name: '掘金',
    icon: 'https://lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/static/favicons/favicon-32x32.png',
    homepage: 'https://juejin.cn',
    capabilities: ['article', 'draft', 'image_upload', 'categories', 'tags', 'cover'],
  }

  /** 掘金按 Markdown 原文提交，渲染交给编辑器 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /**
   * 业务接口与 ImageX 都要带掘金站点的来源信息（浏览器不允许页面直接设这两个头，
   * 只能经运行时的请求头规则注入）。规则只在请求期间生效，收尾由基类负责。
   */
  readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://api.juejin.cn/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 实例级请求标识：`gen_token` 与 `get_img_url` 共用同一个，多张图不换。
   * 用 32 位十六进制 + 毫秒时间戳拼成，构造时算一次。
   */
  private readonly deviceId = `${randomUUID().replace(/-/g, '')}${Date.now().toString()}`

  /** 缓存下来的 CSRF 令牌 */
  private csrfToken: string | null = null
  /** 缓存下来的上传令牌与它的失效时刻 */
  private imageToken: ImageTokenPayload | null = null
  private imageTokenExpireAt = 0

  /** 登录态：读用户信息接口的 `data.user_id`（回包不是 JSON 时按未登录处理） */
  override async checkAuth(): Promise<AuthResult> {
    return this.checkAuthWithRules(
      USER_INFO_API,
      (payload) => {
        const data = (payload as { data?: Record<string, unknown> } | null)?.data
        if (!data || !data.user_id) return null
        return {
          isAuthenticated: true,
          userId: String(data.user_id),
          username: data.user_name as string | undefined,
          avatar: data.avatar_large as string | undefined,
        }
      },
      { headerRules: this.HEADER_RULES },
    )
  }

  /** 发布（平台侧只有「建草稿」这一条写路径） */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const draftOnly = options?.draftOnly ?? true

    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const csrf = await this.getCsrfToken()
        const markdown = await this.processImages(
          article.markdown || '',
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: BUILTIN_IMAGE_PATTERNS,
            onProgress: options?.onImageProgress,
          },
        )
        const draft = await this.createDraft(article.title, markdown, csrf)
        logger.info('掘金草稿已创建', draft.postId)

        return this.createResult(true, {
          postId: draft.postId,
          postUrl: draft.postUrl,
          draftOnly,
        })
      })
    } catch (error) {
      logger.error('掘金草稿创建失败', error)
      return this.createResult(false, { error: describe(error) })
    }
  }

  /** 分类列表：平台只给「简要」列表，映射成本引擎的 `Category` */
  async getCategories(): Promise<Category[]> {
    const response = await this.runtime.fetch(CATEGORY_API, {
      method: 'GET',
      credentials: 'include',
    })
    const payload = (await response.json()) as CategoryPayload
    const raw = payload.data
    if (!raw) return []
    return raw.map((item) => ({
      id: String(item.category_id),
      name: String(item.category_name),
    }))
  }

  /**
   * 取 CSRF 令牌：HEAD 一次，只读响应头（正文是空的）。
   * 拿到就缓存在实例上，同一会话后续调用不再发请求。
   */
  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken

    const response = await this.runtime.fetch(CSRF_API, {
      method: 'HEAD',
      credentials: 'include',
      headers: CSRF_HEADERS,
    })
    const raw = response.headers.get(CSRF_HEADER_NAME)
    if (!raw) {
      throw new Error('掘金没有下发 CSRF 令牌，无法创建草稿')
    }

    const parts = raw.split(',')
    if (parts.length < 2) {
      throw new Error(`掘金下发的 CSRF 令牌格式不认识：${raw}`)
    }

    this.csrfToken = parts[1]
    return this.csrfToken
  }

  /** 建草稿：回包先判 HTTP 状态，再判业务码与草稿 id */
  private async createDraft(
    title: string,
    markdown: string,
    csrf: string,
  ): Promise<{ postId: string; postUrl: string }> {
    const body = JSON.stringify({
      brief_content: '',
      category_id: '0',
      cover_image: '',
      edit_type: 10,
      html_content: 'deprecated',
      link_url: '',
      mark_content: markdown,
      tag_ids: [],
      title,
    })

    const response = await this.runtime.fetch(DRAFT_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-secsdk-csrf-token': csrf,
      },
      body,
    })

    const text = await response.text()
    logger.debug('草稿创建响应（截断）:', text.slice(0, RESPONSE_LOG_CHARS))

    if (!response.ok) {
      throw new Error(`掘金建草稿接口返回 HTTP ${response.status}：${text}`)
    }

    let payload: DraftPayload
    try {
      payload = JSON.parse(text) as DraftPayload
    } catch {
      throw new Error(`掘金建草稿接口的回包不是 JSON：${text.slice(0, PARSE_ERROR_CHARS)}`)
    }

    if (payload.err_no && payload.err_no !== 0) {
      throw new Error(payload.err_msg || `掘金建草稿失败，错误码 ${payload.err_no}`)
    }

    const draftId = payload.data?.id
    if (!draftId) {
      throw new Error(payload.err_msg || '掘金建草稿接口没有返回草稿 id')
    }

    // 平台回包的 id 原样透传（数字就还是数字）——判据按原值比对，不要在这里规整成字符串
    return {
      postId: draftId as unknown as string,
      postUrl: `${SITE_ORIGIN}/editor/drafts/${draftId}`,
    }
  }

  /** 上传本地图片：与按地址转存走同一条链，但失败**抛出**（不静默保留原图） */
  override async uploadImage(blob: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const stored = await this.uploadToImageX(blob)
      return stored.url
    })
  }

  /**
   * 按地址转存：先把图抓下来，再走 ImageX 五步链。
   * 任何一步失败都只降级 —— 正文保留原地址，发布继续。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const blob = await this.grabImage(src)
      return await this.uploadToImageX(blob)
    } catch (error) {
      logger.warn('这张图没能搬进掘金图床，正文保留原地址', error)
      return { url: src }
    }
  }

  /**
   * 取原图字节。
   * `data:` URI 交给宿主自己的 fetch（不需要 cookie）；普通地址走运行时通道，
   * 并要求 2xx —— 拿不到就抛，由调用方决定怎么降级。
   */
  private async grabImage(src: string): Promise<Blob> {
    if (src.startsWith('data:')) {
      const inline = await fetch(src)
      return inline.blob()
    }

    const response = await this.runtime.fetch(src, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`原图下载失败：HTTP ${response.status}`)
    }
    return response.blob()
  }

  /** ImageX 五步链：令牌 → Apply → TOS → Commit → 换可显示地址 */
  private async uploadToImageX(blob: Blob): Promise<ImageUploadResult> {
    const token = await this.getImageToken()
    const address = await this.applyUpload(token)
    const storeInfo = address.StoreInfos?.[0]
    if (!storeInfo || !storeInfo.StoreUri) {
      throw new Error('ImageX 给的上传地址里没有 store uri')
    }

    const sessionKey = address.SessionKey ?? ''
    await this.putToTOS(address, blob)
    await this.commitUpload(token, sessionKey)

    return { url: await this.resolveImageUrl(storeInfo.StoreUri) }
  }

  /** 第 1 步：取上传令牌（带缓存，到期前 60 秒作废） */
  private async getImageToken(): Promise<ImageTokenPayload> {
    if (this.imageToken && Date.now() < this.imageTokenExpireAt - TOKEN_EXPIRE_MARGIN_MS) {
      return this.imageToken
    }

    const url = `${TOKEN_API}&uuid=${this.deviceId}&client=web`
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    const text = await response.text()

    let payload: GenTokenPayload
    try {
      payload = JSON.parse(text) as GenTokenPayload
    } catch {
      throw new Error('掘金图片令牌接口的回包不是 JSON')
    }

    if (payload.err_no && payload.err_no !== 0) {
      throw new Error(payload.err_msg || `掘金图片令牌接口报错 ${payload.err_no}`)
    }

    const token = payload.data?.token
    if (!token || !token.AccessKeyId || !token.SecretAccessKey) {
      throw new Error('掘金图片令牌接口没有返回可用的凭证')
    }

    this.imageToken = token
    this.imageTokenExpireAt = token.ExpiredTime ? new Date(token.ExpiredTime).getTime() : 0
    return token
  }

  /** 第 2 步：AWS4 签名后申请上传地址 */
  private async applyUpload(token: ImageTokenPayload): Promise<UploadAddress> {
    const signed = await signAWS4({
      method: 'GET',
      url: IMAGE_APPLY_API,
      accessKeyId: token.AccessKeyId as string,
      secretAccessKey: token.SecretAccessKey as string,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(IMAGE_APPLY_API, {
      method: 'GET',
      headers: signed.headers,
    })
    const payload = (await response.json()) as ApplyPayload
    const address = payload?.Result?.UploadAddress
    if (!address) {
      throw new Error('ImageX 没有返回上传地址')
    }
    return address
  }

  /**
   * 第 3 步：把字节直传 TOS。
   * `Content-CRC32` 是 TOS 的强制校验位，缺了会被拒。
   */
  private async putToTOS(address: UploadAddress, blob: Blob): Promise<void> {
    const storeInfo = address.StoreInfos?.[0] as { StoreUri: string; Auth?: string }
    const host = address.UploadHosts?.[0] ?? ''
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()))

    const response = await this.runtime.fetch(`https://${host}/${storeInfo.StoreUri}`, {
      method: 'PUT',
      headers: {
        Authorization: storeInfo.Auth ?? '',
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-CRC32': checksum,
      },
      body: blob,
    })
    if (!response.ok) {
      throw new Error(`TOS 上传失败（HTTP ${response.status}）：${await response.text()}`)
    }
  }

  /** 第 4 步：提交这次上传；会话键挂在查询串上，请求体是空的 */
  private async commitUpload(token: ImageTokenPayload, sessionKey: string): Promise<void> {
    const url = `${IMAGEX_ORIGIN}/?Action=CommitImageUpload&Version=2018-08-01&SessionKey=${encodeURIComponent(
      sessionKey,
    )}&ServiceId=${IMAGEX_SERVICE_ID}`
    const signed = await signAWS4({
      method: 'POST',
      url,
      accessKeyId: token.AccessKeyId as string,
      secretAccessKey: token.SecretAccessKey as string,
      securityToken: token.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      headers: {
        ...signed.headers,
        'Content-Length': '0',
      },
    })
    const payload = (await response.json()) as CommitPayload
    if (!payload?.Result) {
      throw new Error('ImageX 没有确认图片提交结果')
    }
  }

  /** 第 5 步：用 StoreUri 换编辑器里能直接显示的地址 */
  private async resolveImageUrl(storeUri: string): Promise<string> {
    const url = `${IMAGE_URL_API}&uuid=${this.deviceId}&uri=${encodeURIComponent(
      storeUri,
    )}&img_type=private`
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    const payload = (await response.json()) as ImageUrlPayload

    if (payload.err_no && payload.err_no !== 0) {
      throw new Error(payload.err_msg || `掘金取图接口报错 ${payload.err_no}`)
    }

    const resolved = payload.data?.main_url || payload.data?.backup_url
    if (!resolved) {
      throw new Error('掘金取图接口没有返回可用的图片地址')
    }
    return resolved
  }
}

/** 把任意异常收敛成可读文案 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
