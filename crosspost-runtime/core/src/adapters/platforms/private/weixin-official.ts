/**
 * 微信公众号「官方 API 通道」适配器
 *
 * 与基于浏览器代理的 `weixin` 适配器不同，本通道直接用 AppID/AppSecret 换 access_token，
 * 再走官方接口：正文图上传、封面素材上传、草稿新增/列表/删除。全程恒为**草稿**，
 * 绝不触发发表（发表需要人工在后台确认）。
 *
 * 两条不能省的平台约束：
 *  - 正文图必须换成**平台域名下的直链**（`/media/uploadimg` 的 `url`），外链图会被
 *    防盗链拦成空白；封面必须走永久素材（`/material/add_material?type=thumb`）拿 media_id。
 *  - 凭证只从调用方注入（env / .env 由上层解析），本模块不读任何配置文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseAdapter } from '../../base'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../../types'
import type { Draft, PublishOptions } from '../../types'
import { processImages } from '../../../lib/render/images'
import type { ImageSourceKind } from '../../../lib/render/images'

const API_ROOT = 'https://api.weixin.qq.com/cgi-bin'
const ROUTE_TOKEN = '/stable_token'
const ROUTE_BODY_IMAGE = '/media/uploadimg'
const ROUTE_THUMB = '/material/add_material'
const ROUTE_DRAFT_ADD = '/draft/add'
const ROUTE_DRAFT_LIST = '/draft/batchget'
const ROUTE_DRAFT_DELETE = '/draft/delete'

const DEFAULT_EXPIRES_IN = 7200
/** 提前这么多秒失效，避免边界上拿着即将过期的 token 发请求 */
const EXPIRY_MARGIN_SECONDS = 300
const MIN_TTL_SECONDS = 60
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 15000
const RETRY_BACKOFF_MS = 300
/** 单次「注」列表页大小：草稿接口的 count 上限即 20 */
const DRAFT_PAGE_SIZE = 20

/** 官方接口的错误回包（errcode 为 0 表示成功） */
export interface WechatErrorPayload {
  errcode?: number
  errmsg?: string
}

export interface WeixinOfficialOptions {
  appId: string
  appSecret: string
  /** access_token 落盘缓存位置；缺省放用户配置目录 */
  tokenCachePath?: string
}

/** 草稿新增的入参：字段名与官方 payload 一一对应 */
export interface WechatDraftInput {
  title: string
  html: string
  thumbMediaId: string
  author?: string
  digest?: string
  contentSourceUrl?: string
  picCrop2351?: string
  picCrop11?: string
}

interface CachedToken {
  token: string
  /** 秒级时间戳 */
  expiresAt: number
}

/**
 * 已知错误码 → 可执行的中文处置建议。
 * 未收录的错误码走兜底文案，并把原始 errcode/errmsg 一起带出，方便排查。
 */
const ERRLIST: Record<number, string> = {
  40007: '封面 media_id 无效：请重新上传封面。',
  40013: 'AppID 无效：请在公众号后台核对 AppID。',
  40125: 'AppSecret 无效：请检查凭证配置。',
  40164: 'IP 未在白名单：请在公众号后台「设置与开发 → 基本配置 → IP白名单」里加入服务器出口 IP。',
  45009: '接口调用频率超限：请等待后重试。',
  45110: '作者字段超长（>8 字节）：已自动截断处理。',
  45166: '内容含非法链接（# 锚点等）：请检查文章。',
}

/**
 * 把官方错误回包翻成异常。
 * 已知码给出处置建议，未知码给出原始信息（errcode + errmsg + 调用点）。
 */
export function wechatError(response: WechatErrorPayload, context: string): Error {
  const code = Number(response?.errcode ?? 0)
  const detail = `[${context}] errcode=${code} errmsg=${response?.errmsg ?? ''}`
  const advice = ERRLIST[code]
  return advice ? new Error(`${advice}${detail}`) : new Error(`微信接口返回未知错误：${detail}`)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 空串（含只有空白）按「未提供」处理：官方接口对空作者/空摘要会报错 */
function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 带超时的 fetch：超时即中止，避免图片下载把整次发布挂住 */
async function fetchWithin(
  url: string,
  init: RequestInit,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Buffer 的底层是 ArrayBufferLike，转成 Blob 能接受的独立视图 */
function toBlobPart(bytes: Buffer): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export class WeixinOfficialAdapter extends BaseAdapter {
  readonly meta: PlatformMeta = {
    id: 'weixin-official',
    name: '微信公众号(官方API)',
    icon: 'https://mp.weixin.qq.com/favicon.ico',
    homepage: 'https://mp.weixin.qq.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  private readonly appId: string
  private readonly appSecret: string
  private readonly tokenCachePath: string
  /** 进程内 token；比磁盘缓存优先，force 刷新时被覆盖 */
  private memToken: CachedToken | null = null

  constructor(options: WeixinOfficialOptions) {
    super()
    this.appId = options.appId ?? ''
    this.appSecret = options.appSecret ?? ''
    this.tokenCachePath =
      options.tokenCachePath ??
      path.join(os.homedir(), '.config', 'crosspost', 'weixin-official-token.json')
  }

  /* ────────────────────────── access_token ────────────────────────── */

  /**
   * 取 access_token。优先用进程内缓存，其次用磁盘缓存，最后才打网络。
   * `force` 为真时跳过两层缓存（用于 token 被服务端提前作废的场景）。
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force) {
      if (this.isFresh(this.memToken)) return this.memToken.token
      const stored = this.readTokenCache()
      if (stored) {
        this.memToken = stored
        return stored.token
      }
    }

    const response = await this.callTokenEndpoint(force)
    const token = typeof response.access_token === 'string' ? response.access_token : ''
    if (!token) throw new Error('获取 access_token 失败：响应无 token')

    const ttl = this.resolveTtl(response.expires_in)
    this.memToken = { token, expiresAt: Math.floor(Date.now() / 1000) + ttl }
    this.writeTokenCache(this.memToken)
    return token
  }

  /** 官方给的是「还能用多少秒」；留出安全边界，并给一个下限避免雪崩式重取 */
  private resolveTtl(expiresIn: unknown): number {
    const raw = isNumber(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN
    return Math.max(raw - EXPIRY_MARGIN_SECONDS, MIN_TTL_SECONDS)
  }

  private isFresh(token: CachedToken | null): token is CachedToken {
    return token !== null && token.expiresAt * 1000 > Date.now()
  }

  private readTokenCache(): CachedToken | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.tokenCachePath, 'utf8')) as Record<
        string,
        unknown
      >
      const token = typeof parsed.token === 'string' ? parsed.token : ''
      if (!token) return null
      if (typeof parsed.appId === 'string' && parsed.appId !== this.appId) return null
      if (!isNumber(parsed.expiresAt) || parsed.expiresAt * 1000 <= Date.now()) return null
      return { token, expiresAt: parsed.expiresAt }
    } catch {
      // 文件不存在 / 内容损坏 / 无权限：一律当作没有缓存
      return null
    }
  }

  private writeTokenCache(token: CachedToken): void {
    try {
      fs.mkdirSync(path.dirname(this.tokenCachePath), { recursive: true })
      fs.writeFileSync(
        this.tokenCachePath,
        JSON.stringify({
          token: token.token,
          expiresAt: token.expiresAt,
          appId: this.appId,
          updatedAt: Date.now(),
        }),
      )
    } catch {
      // 缓存写不进去只影响下次启动多打一次网络，不该让发布失败
    }
  }

  /* ────────────────────────── 官方接口底座 ────────────────────────── */

  /**
   * 读回包：先按 JSON 解析，非 JSON（网关 HTML 错误页等）时按文本兜底。
   * errcode 非 0 一律翻成异常，调用方只需要处理「成功的那条路」。
   */
  private async readPayload(response: Response, context: string): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown>
    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      const text = await response.text()
      throw new Error(`微信接口返回非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    const code = Number(payload.errcode ?? 0)
    if (code !== 0)
      throw wechatError({ errcode: code, errmsg: String(payload.errmsg ?? '') }, context)
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}：${context}`)
    return payload
  }

  private async callTokenEndpoint(force: boolean): Promise<Record<string, unknown>> {
    const response = await fetch(`${API_ROOT}${ROUTE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: this.appId,
        secret: this.appSecret,
        force_refresh: force,
      }),
    })
    return this.readPayload(response, 'stable_token')
  }

  /** 带 token 的 JSON 调用：token 在拼 URL 前取，保证一次调用只换一次 token */
  private async callJson(
    route: string,
    context: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken()
    const response = await fetch(`${API_ROOT}${route}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return this.readPayload(response, context)
  }

  /** 带 token 的 multipart 调用：不要手写 Content-Type，交给运行时补 boundary */
  private async callMultipart(
    route: string,
    context: string,
    extraQuery: string,
    form: FormData,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken()
    const response = await fetch(`${API_ROOT}${route}?access_token=${token}${extraQuery}`, {
      method: 'POST',
      body: form,
    })
    return this.readPayload(response, context)
  }

  /* ────────────────────────── 对外能力 ────────────────────────── */

  /** 检查凭证是否可用：以能否换到 access_token 为准 */
  async checkAuth(): Promise<AuthResult> {
    try {
      await this.getAccessToken()
      return { isAuthenticated: true, username: `AppID ${this.appId.slice(0, 6)}...` }
    } catch (error) {
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /** 上传正文插图，返回平台直链（该地址不会被防盗链拦） */
  async uploadImage(file: Blob, filename = 'image.png'): Promise<string> {
    const form = new FormData()
    form.append('media', file, filename)
    const payload = await this.callMultipart(ROUTE_BODY_IMAGE, 'media/uploadimg', '', form)
    const url = typeof payload.url === 'string' ? payload.url : ''
    if (!url) throw new Error('正文图上传失败：响应无 url')
    return url
  }

  /** 上传封面为永久素材，返回 thumb_media_id */
  async uploadThumb(coverPath: string): Promise<string> {
    const form = new FormData()
    form.append(
      'media',
      new Blob([toBlobPart(fs.readFileSync(coverPath))]),
      path.basename(coverPath),
    )
    const payload = await this.callMultipart(
      ROUTE_THUMB,
      'material/add_material',
      '&type=thumb',
      form,
    )
    const mediaId = typeof payload.media_id === 'string' ? payload.media_id : ''
    if (!mediaId) throw new Error('封面上传失败：响应无 media_id')
    return mediaId
  }

  /**
   * 新增草稿（恒草稿）。可选字段按「提供了才下发」处理：
   * 官方接口对 author/digest 的 null 与缺省含义不同，不能凭空补空串。
   */
  async createDraft(input: WechatDraftInput): Promise<Record<string, unknown>> {
    const article: Record<string, unknown> = {
      title: input.title,
      author: nonBlank(input.author),
      digest: nonBlank(input.digest),
      content: input.html,
      thumb_media_id: input.thumbMediaId,
      need_open_comment: 1,
    }
    if (nonBlank(input.contentSourceUrl)) article.content_source_url = input.contentSourceUrl
    if (nonBlank(input.picCrop2351)) article.pic_crop_235_1 = input.picCrop2351
    if (nonBlank(input.picCrop11)) article.pic_crop_1_1 = input.picCrop11
    return this.callJson(ROUTE_DRAFT_ADD, 'draft/add', { articles: [article] })
  }

  /**
   * 草稿列表。
   * 返回项保留 `mediaId` 字段（与既有调用方一致，勿改成 Draft.id）。
   */
  async getDrafts(): Promise<Draft[]> {
    const payload = await this.callJson(ROUTE_DRAFT_LIST, 'draft/batchget', {
      offset: 0,
      count: DRAFT_PAGE_SIZE,
      no_content: 1,
    })
    const items = Array.isArray(payload.item) ? payload.item : []
    const drafts = items.map((raw) => {
      const entry = (raw ?? {}) as Record<string, unknown>
      const content = (entry.content ?? {}) as Record<string, unknown>
      const news = Array.isArray(content.news_item) ? content.news_item : []
      const headline = (news[0] ?? {}) as Record<string, unknown>
      return {
        mediaId: typeof entry.media_id === 'string' ? entry.media_id : '',
        title: typeof headline.title === 'string' ? headline.title : '',
        updatedAt: isNumber(entry.update_time) ? entry.update_time : 0,
      }
    })
    return drafts as unknown as Draft[]
  }

  /** 删除草稿（不可恢复） */
  async delete(mediaId: string): Promise<void> {
    await this.callJson(ROUTE_DRAFT_DELETE, 'draft/delete', { media_id: mediaId })
  }

  /* ────────────────────────── 发布（恒草稿） ────────────────────────── */

  /**
   * 一轮发布：正文图先换成平台直链 → 封面转永久素材 → 建草稿。
   * 任一步失败都返回失败结果（不抛给调用方），草稿链接即后台编辑页。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      const html = await this.uploadBodyImages(article.html ?? '')
      const cover = article.cover ?? ''
      if (!cover || !fs.existsSync(cover)) {
        return this.createResult(false, {
          draftOnly: true,
          error: '缺少封面：请先生成封面（generateCover）并传入本地路径（article.cover）',
        })
      }

      const thumbMediaId = await this.uploadThumb(cover)
      const extra = (options ?? {}) as PublishOptions & Partial<WechatDraftInput>
      const draft = await this.createDraft({
        title: article.title,
        html,
        thumbMediaId,
        author: extra?.author,
        digest: extra?.digest,
        contentSourceUrl: extra?.contentSourceUrl,
      })

      const mediaId = draft.media_id
      return this.createResult(true, {
        draftOnly: true,
        postId: mediaId as string,
        postUrl: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&appmsgid=${mediaId}&token=&lang=zh_CN`,
        message: '草稿已创建（微信官方 API 通道）',
      })
    } catch (error) {
      return this.createResult(false, { draftOnly: true, error: reasonOf(error) })
    }
  }

  /** 正文图管线：本地图读盘、远程图带重试下载，再换成平台直链 */
  private async uploadBodyImages(html: string): Promise<string> {
    const result = await processImages(html, {
      uploader: (source, kind) => this.ingestImage(source, kind),
    })
    return result.html
  }

  private async ingestImage(source: string, kind: ImageSourceKind): Promise<string> {
    const bytes = kind === 'local' ? fs.readFileSync(source) : await this.downloadImage(source)
    return this.uploadImage(new Blob([toBlobPart(bytes)]), 'img.png')
  }

  /**
   * 远程图下载：网络错误/5xx 重试，4xx 直接失败（重试无意义）。
   */
  private async downloadImage(url: string): Promise<Buffer> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await pause(RETRY_BACKOFF_MS * attempt)
      let response: Response
      try {
        response = await fetchWithin(url, { method: 'GET' })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }
      if (response.ok) return Buffer.from(await response.arrayBuffer())
      const failure = new Error(`下载图片失败：HTTP ${response.status}`)
      if (response.status < 500) throw failure
      lastError = failure
    }
    throw lastError ?? new Error(`下载图片失败：${url}`)
  }
}
