/**
 * 一点号适配器（mp.yidianzixun.com）
 *
 * 平台特征：
 * - 登录信息不是接口返回的，而是内联在首页 HTML 的 <script id="__val_"> 里；
 *   其中的 window.mpcode 需要作为 x-mp-code 附到后续接口请求上。
 * - 平台接口不区分 2xx/4xx：错误也是非 JSON 响应体，所以这里不做 ok 判定，
 *   直接把响应文本当 JSON 解；解不开就让它按 SyntaxError 抛出。
 * - 发布走 /model/Article 的 JSON 接口，靠 status / isPubed / notSaveToStore 保证只落草稿。
 * - 正文图片先请平台服务端转存（/api/getImageFromUrl），不成功再退回 multipart 直传。
 * - 平台不校验 Origin/Referer，因此本适配器没有 HEADER_RULES。
 */
import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'

const logger = createLogger('YidianAdapter')

/** 平台主域：首页、页面接口、发布接口都挂在这个域下 */
const YIDIAN_ORIGIN = 'https://mp.yidianzixun.com'

/** 自定义请求共用的 Accept */
const ACCEPT_HEADER = 'application/json, text/plain, */*'

/** 首页里承载登录态的内联脚本（属性可有可无） */
const BOOT_SCRIPT_RE = /<script id="__val_"[^>]*>([\s\S]*?)<\/script>/
const MP_CODE_RE = /window\.mpcode\s*=\s*['"]([a-f0-9]+)['"]/
const MP_USER_RE = /window\.mpuser\s*=\s*(\{[\s\S]*?\})\s*;/
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp)/i

/** 首页内联脚本里描述的登录用户 */
interface BootUser {
  id?: string | number
  media_name?: string
  media_pic?: string
}

/** 图片转存 / 图片上传的公共回包形状 */
interface MediaResponse {
  status?: string
  inner_addr?: string
  url?: string
}

/** 把任意异常收敛成可读文案 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class YidianAdapter extends CodeAdapter {
  override readonly meta: PlatformMeta = {
    id: 'yidian',
    name: '一点号',
    icon: 'https://www.yidianzixun.com/favicon.ico',
    homepage: YIDIAN_ORIGIN,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
    removeLinks: true,
  }

  /** 从首页脚本里刮出的 x-mp-code；缺失只告警，不阻断流程 */
  private mpCode = ''

  /** 登录态探测：首页 HTML 里刮 window.mpuser（顺带缓存 window.mpcode） */
  override async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.request(YIDIAN_ORIGIN)
      return this.readBootData(await response.text())
    } catch (error) {
      return { isAuthenticated: false, error: errorText(error) }
    }
  }

  /** 平台接口统一入口：一律带 cookie，其余初始化参数由调用方给出 */
  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.runtime.fetch(url, { credentials: 'include', ...init })
  }

  /** 平台接口的响应按 JSON 解析；平台用非 JSON 响应体表达错误，这里照原样抛 */
  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init)
    return JSON.parse(await response.text()) as T
  }

  /** 请求头：Accept 恒定，Content-Type 按需，x-mp-code 有则带 */
  private getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: ACCEPT_HEADER }
    if (contentType) headers['Content-Type'] = contentType
    if (this.mpCode) headers['x-mp-code'] = this.mpCode
    return headers
  }

  /** 发布/上传前确保 x-mp-code 已就绪；拿不到只告警，让平台用业务错误回应 */
  private async ensureMpCode(): Promise<void> {
    if (this.mpCode) return
    await this.checkAuth()
    if (!this.mpCode) logger.warn('未取得 x-mp-code，一点号可能拒绝后续请求')
  }

  /** 从首页内联脚本里解析登录用户，并把 mpcode 缓存下来 */
  private readBootData(html: string): AuthResult {
    const script = BOOT_SCRIPT_RE.exec(html)?.[1]
    if (!script) return { isAuthenticated: false, error: '未能获取用户数据' }

    const code = MP_CODE_RE.exec(script)
    if (code) {
      this.mpCode = code[1]
    } else {
      logger.warn('首页脚本里没有 window.mpcode')
    }

    const userRaw = MP_USER_RE.exec(script)
    if (!userRaw) return { isAuthenticated: false, error: '未登录' }

    let user: BootUser
    try {
      user = JSON.parse(userRaw[1]) as BootUser
    } catch {
      return { isAuthenticated: false, error: '用户数据解析未成功' }
    }

    if (!user || !user.id) return { isAuthenticated: false, error: '未登录' }

    return {
      isAuthenticated: true,
      userId: String(user.id),
      username: user.media_name,
      avatar: user.media_pic,
    }
  }

  /** 正文图片：先服务端转存，拿不到内链再走 multipart 直传 */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    await this.ensureMpCode()

    try {
      const transfer = await this.requestJson<MediaResponse>(
        `${YIDIAN_ORIGIN}/api/getImageFromUrl?src=${encodeURIComponent(src)}`,
        { headers: this.getHeaders() },
      )
      if (transfer && transfer.status === 'success' && transfer.inner_addr) {
        return { url: transfer.inner_addr }
      }
      logger.debug('一点号服务端转存未成功，改用 multipart 直传')
    } catch (error) {
      logger.debug('一点号服务端转存失败，改用 multipart 直传', error)
    }

    return this.uploadImageByMultipart(src)
  }

  /** 兜底通道：下载原图后以 upfile 字段 multipart 直传 */
  private async uploadImageByMultipart(src: string): Promise<ImageUploadResult> {
    const download = await this.runtime.fetch(src)
    const blob = await download.blob()
    const ext = IMAGE_EXT_RE.exec(src)?.[1] || 'png'
    const form = new FormData()
    form.append('upfile', blob, `image_${Date.now()}.${ext}`)

    const uploaded = await this.requestJson<MediaResponse>(
      `${YIDIAN_ORIGIN}/upload?action=uploadimage&picType=wemedia_cnt`,
      { method: 'POST', headers: this.getHeaders(), body: form },
    )
    if (!uploaded || uploaded.status !== 'success' || !uploaded.url) {
      throw new Error(`上传图片未成功: ${JSON.stringify(uploaded)}`)
    }
    return { url: uploaded.url }
  }

  /** 存草稿：POST /model/Article，回包 id 即草稿 id */
  override async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const startedAt = Date.now()

    try {
      await this.ensureMpCode()

      const content = await this.processImages(article.html || '', (src) =>
        this.uploadImageByUrl(src),
      )

      const result = await this.requestJson<{ id?: string | number }>(
        `${YIDIAN_ORIGIN}/model/Article`,
        {
          method: 'POST',
          headers: this.getHeaders('application/json;charset=UTF-8'),
          body: JSON.stringify({
            title: article.title,
            cate: '',
            cateB: '',
            coverType: 'default',
            covers: [],
            content,
            hasSubTitle: 0,
            subTitle: '',
            original: 0,
            reward: 0,
            videos: [],
            audios: [],
            votes: {
              vote_id: '',
              vote_options: [],
              vote_end_time: '',
              vote_title: '',
              vote_type: 1,
              isAdded: false,
            },
            import_url: '',
            import_hash: '',
            wm_globallink: '',
            wm_globaltime: '',
            lastSaveTime: '',
            images: [],
            goods: [],
            tags: [],
            outsideImages: [],
            is_mobile: 0,
            // status=0 / isPubed=false：只落草稿，不进入发布态
            status: 0,
            activity_id: 0,
            join_activity: 0,
            isPubed: false,
            dirty: false,
            image_urls: {},
            minTimingHour: 3,
            maxTimingDay: 7,
            editorType: 'articleEditor',
            wm_content_source: { type: 1 },
            notSaveToStore: true,
          }),
        },
      )

      if (!result || !result.id) {
        throw new Error(`同步错误: ${JSON.stringify(result)}`)
      }

      return this.createResult(true, {
        postId: result.id as string,
        postUrl: `${YIDIAN_ORIGIN}/#/Writing/${result.id}`,
        draftOnly: true,
        timestamp: startedAt,
      })
    } catch (error) {
      return this.createResult(false, { error: errorText(error), timestamp: startedAt })
    }
  }
}
