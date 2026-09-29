/**
 * 大鱼号（UC 号）适配器
 *
 * 平台侧没有可用的「先说你好」接口：账号信息（utoken / wmid / 图片上传签名 / 头像）
 * 全部内联在 `https://mp.dayu.com/dashboard/index` 返回的 HTML 里那段
 * `var globalConfig = {…};` 字面量中。它不是严格 JSON（裸键名、单引号、尾逗号都可能出现），
 * 所以这里先做一层「JSON 化」尝试，失败再退回逐键正则，改版时不至于直接崩。
 *
 * 发布只走「保存草稿」端点（`/dashboard/save-draft`）：不触碰任何发表接口，
 * 端点的响应只回草稿 `_id`，据此拼出编辑页地址。封面没有单独上传步骤——
 * 直接取本次正文里第一张上传成功的图。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'

/** 会话信息在 HTML 中的定位锚点（含尾随空格，与页面模板一致） */
const CONFIG_OPEN = 'var globalConfig = '
const CONFIG_CLOSE = 'var G = {'

/** globalConfig 里本适配器需要的五个键 */
const CONFIG_FIELDS = ['utoken', 'nsImageUploadSign', 'wmid', 'weMediaName', 'wmAvator'] as const

const LOGIN_PAGE = 'https://mp.dayu.com/dashboard/index'
const DRAFT_ENDPOINT = 'https://mp.dayu.com/dashboard/save-draft'
const UPLOAD_ENDPOINT = 'https://ns.dayu.com/article/imageUpload'

/**
 * 页面内联配置的形状。JSON.parse 的结果不做字段校验：声明为必填只是为了取用方便，
 * 运行时缺键仍然是 undefined，因此 `utoken` 真值判定必须保留。
 */
interface DayuGlobalConfig {
  utoken: string
  nsImageUploadSign: string
  wmid: string
  weMediaName: string
  wmAvator: string
}

/** 从 globalConfig 里摘出来的、后续请求要复用的账号上下文 */
interface DayuAccount {
  utoken: string
  uploadSign: string
  uid: string
  title: string
  avatar: string
}

/** 保存草稿的回包：失败时给 `error` 字符串，成功时给 `data._id` */
interface DayuDraftReply {
  error?: string
  data?: { _id?: string }
}

/** 图片上传回包 */
interface DayuUploadReply {
  data?: { imgInfo?: { org_url?: string; url?: string } }
}

export class DayuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dayu',
    name: '大鱼号',
    icon: 'https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico',
    homepage: 'https://mp.dayu.com/dashboard/account/profile',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
  }

  /** 编辑器与图片 CDN 都要求带来源头，缺了会被判定为跨站 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.dayu.com/*',
      headers: { Origin: 'https://mp.dayu.com', Referer: 'https://mp.dayu.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ns.dayu.com/*',
      headers: { Origin: 'https://mp.dayu.com', Referer: 'https://mp.dayu.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 最近一次探测到的账号上下文；为空说明还没登录过 */
  private account: DayuAccount | null = null

  /** 本次发布里上传成功的图片，按上传顺序保留，[0] 充当封面 */
  private uploaded: Array<{ org_url: string; url: string }> = []

  // ============ 登录态 ============

  async checkAuth(): Promise<AuthResult> {
    try {
      // 登录页无论 401 还是 200 都返回 HTML：这里只看正文里有没有配置块，
      // 不把 HTTP 状态当判定依据（未登录页同样是 200）。
      const response = await this.runtime.fetch(LOGIN_PAGE, {
        method: 'GET',
        credentials: 'include',
      })
      const account = this.readAccount(await response.text())
      if (!account) return { isAuthenticated: false }

      this.account = account
      return {
        isAuthenticated: true,
        userId: account.uid,
        username: account.title,
        avatar: account.avatar,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /** 从登录页 HTML 里摘出账号上下文；没有配置块或缺 utoken 都算未登录 */
  private readAccount(html: string): DayuAccount | null {
    const config = this.readInlineConfig(html)
    if (!config || !config.utoken) return null

    return {
      utoken: config.utoken,
      uploadSign: config.nsImageUploadSign,
      uid: config.wmid,
      title: config.weMediaName,
      avatar: this.absoluteAvatar(config.wmAvator),
    }
  }

  /**
   * 截出 `var globalConfig = ` 与 `var G = {` 之间的片段并解析。
   * 锚点缺失直接判为查不到配置（未登录），不抛错。
   */
  private readInlineConfig(html: string): DayuGlobalConfig | null {
    const openAt = html.indexOf(CONFIG_OPEN)
    if (openAt < 0) return null

    const from = openAt + CONFIG_OPEN.length
    const closeAt = html.indexOf(CONFIG_CLOSE, from)
    const raw = closeAt < 0 ? html.slice(from) : html.slice(from, closeAt)

    return this.parseGlobalConfig(raw)
  }

  /** 两级解析：先容错 JSON 化，再逐键正则兜底 */
  private parseGlobalConfig(raw: string): DayuGlobalConfig | null {
    const parsed = this.parseAsJson(raw)
    if (parsed) return parsed

    const salvaged: Record<string, string> = {}
    for (const field of CONFIG_FIELDS) {
      const value = this.pickFieldByRegex(raw, field)
      if (value !== undefined) salvaged[field] = value
    }
    return Object.keys(salvaged).length > 0 ? (salvaged as unknown as DayuGlobalConfig) : null
  }

  /**
   * 把「像 JS 对象字面量」的片段修成 JSON：去尾分号 → 单引号换双引号 →
   * 给裸键名补引号 → 去掉 `,}` / `,]` 这类尾随逗号。修不干净就返回 null。
   */
  private parseAsJson(raw: string): DayuGlobalConfig | null {
    const jsonish = raw
      .trim()
      .replace(/;\s*$/, '')
      .replace(/'/g, '"')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1')

    try {
      const value: unknown = JSON.parse(jsonish)
      return value && typeof value === 'object' ? (value as DayuGlobalConfig) : null
    } catch {
      return null
    }
  }

  /** 单键兜底：`key` 与值之间允许出现引号/冒号/空白 */
  private pickFieldByRegex(raw: string, field: string): string | undefined {
    const matched = new RegExp(`${field}['":\\s]+['"]([^'"]+)['"]`).exec(raw)
    return matched ? matched[1] : undefined
  }

  /** 头像可能是 `//host/path` 形式，补上协议；已经是 http(s) 的原样保留 */
  private absoluteAvatar(raw: string | undefined): string {
    if (!raw) return ''
    return raw.includes('http') ? raw : raw.replace('//', 'https://')
  }

  // ============ 发布（只存草稿） ============

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        // 封面取本次正文首图，所以每次发布都要把上传记录清零
        this.uploaded = []

        if (!this.account) {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) throw new Error('大鱼号账号尚未登录')
        }
        const account = this.account as DayuAccount

        const content = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['dayu.com', 'uc.cn'],
            onProgress: options?.onImageProgress,
          },
        )

        const reply = await this.postForm<DayuDraftReply>(
          DRAFT_ENDPOINT,
          {
            title: article.title,
            content,
            author: account.title,
            coverImg: this.uploaded[0]?.url || '',
            article_type: '1',
            utoken: account.utoken,
            cover_from: 'auto',
          },
          {
            'Content-Type': 'application/x-www-form-urlencoded',
            utoken: account.utoken,
          },
        )

        if (reply.error) throw new Error(reply.error)
        const draftId = reply.data?._id
        if (!draftId) throw new Error('草稿保存未成功')

        return this.createResult(true, {
          postId: draftId,
          postUrl: `https://mp.dayu.com/dashboard/article/write?draft_id=${draftId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  // ============ 图片 ============

  /**
   * 图片上传：先把图（远程地址或 data URI 一视同仁）取成 Blob，再以老式表单
   * （`upfile` + 一堆元数据字段）提交到素材接口。上传成功即记入 `uploaded`，供封面兜底取用。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const account = this.account
    if (!account) throw new Error('未登录')

    const blob = await this.loadImage(src)
    const filename = `${Date.now()}.jpg`

    const form = new FormData()
    form.append('upfile', blob, filename)
    form.append('type', blob.type || 'image/jpeg')
    form.append('id', 'WU_FILE_1')
    form.append('fileid', `uploadm-${Math.floor(Math.random() * 1e6)}`)
    form.append('name', filename)
    form.append('lastModifiedDate', new Date().toString())
    form.append('size', String(blob.size))

    const query = [
      'appid=website',
      'fromMaterial=0',
      `wmid=${account.uid}`,
      `wmname=${encodeURIComponent(account.title)}`,
      `sign=${account.uploadSign}`,
    ].join('&')

    const reply = await this.sendForm<DayuUploadReply>(`${UPLOAD_ENDPOINT}?${query}`, form)
    const url = reply?.data?.imgInfo?.url
    if (!url) throw new Error('上传图片未成功')

    this.uploaded.push({ org_url: src, url })
    return { url }
  }

  /** 取图：任何非 2xx 都算下载失败，错误里带上原地址便于定位 */
  private async loadImage(src: string): Promise<Blob> {
    const response = await fetch(src)
    if (!response.ok) throw new Error(`下载图片未成功: ${src}`)
    return response.blob()
  }

  /** multipart 提交（不额外声明 Content-Type，交给 FormData 自己带 boundary） */
  private async sendForm<T>(url: string, form: FormData): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }
}
