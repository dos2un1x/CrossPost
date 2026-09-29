/**
 * 抖音图文（创作服务平台）适配器 —— 只存草稿
 *
 * 平台侧的三条事实决定了这里的分工：
 * 1. 草稿接口 `/web/api/media/aweme/draft` 只能在页面上下文里调用（要页面自带的登录票据），
 *    因此走 `runtime.pageOp(tabId, 'douyinPublish', [url, method, body])` 这条冻结通道。
 * 2. 图片要五步：取 STS 凭证 → AWS4 签名向 ImageX 申请上传地址（Apply）→ 字节直传 TOS →
 *    Commit 拿宽高 → 回页面通道换预览地址。凭证带缓存，同一篇里多图复用。
 * 3. 图文字数上限 8000，超出是**截断**而不是报错。
 *
 * 图片链路任何一步失败都不算发布失败：正文里保留原图地址，只是这张图不进 `image_info`。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { crc32, signAWS4 } from '../../../lib/aws4'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Douyin')

/** 创作者中心站点根 */
const CREATOR_ORIGIN = 'https://creator.douyin.com'
/** ImageX（字节图片服务）网关 */
const IMAGEX_ORIGIN = 'https://imagex.bytedanceapi.com'

/**
 * ImageX 的 ServiceId。它与下面的 `aid` 一样，在两份独立来源里都只是裸字面量，
 * 既没有注释也没有推导过程可以佐证语义与有效期 —— 原样保留，不臆造含义。
 */
const IMAGEX_SERVICE_ID = 'jm8ajry58r'
/** 创作者侧的 app id，出现在 4 个接口的查询串上。来源同样未知，原样保留。 */
const DOUYIN_AID = '1128'

/** 草稿幂等键的字符表（小写字母 + 数字） */
const CREATION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** 幂等键前缀长度 */
const CREATION_ID_PREFIX_LEN = 8

/** 图文字数上限 */
const ARTICLE_CHAR_LIMIT = 8000
/** 凭证到期前多久就提前作废 */
const CREDENTIAL_EXPIRE_MARGIN = 60_000

/** 发布用 tab 的落地页（回跳地址也用它） */
const PUBLISH_PAGE_PATH = '/creator-micro/content/post/article'
/** 创作者中心 tab 的匹配模式 */
const CREATOR_TAB_PATTERN = `${CREATOR_ORIGIN}/*`
/** 新建 tab 的加载超时 */
const TAB_LOAD_TIMEOUT_MS = 30_000

const USER_INFO_API = `${CREATOR_ORIGIN}/web/api/media/user/info/`
const UPLOAD_AUTH_API = `${CREATOR_ORIGIN}/web/api/media/upload/auth/v5/?aid=${DOUYIN_AID}`
const DRAFT_API = `${CREATOR_ORIGIN}/web/api/media/aweme/draft?aid=${DOUYIN_AID}`
const APPLY_URL = `${IMAGEX_ORIGIN}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`
const COMMIT_URL = `${IMAGEX_ORIGIN}/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`

/** 正文里带这些子串的图不重复上传（已经是抖音自家 CDN 的图） */
const BUILTIN_IMAGE_PATTERNS = [
  'douyin.com',
  'snssdk.com',
  'byteimg.com',
  'bytedanceapi.com',
  IMAGEX_SERVICE_ID,
]

/** 页面通道回包的统一外壳（扩展侧只保证 `success`，具体数据在 `data` 里） */
interface PageOpEnvelope<T> {
  success?: boolean
  error?: string
  data?: T
}

/** STS 凭证 —— `auth` 字段 JSON.parse 之后的原样形状 */
interface StsCredentials {
  AccessKeyID: string
  SecretAccessKey: string
  SessionToken: string
  /** 过期时刻（平台给的是 ISO 字符串，这里不做二次加工） */
  ExpiredTime: number | string
}

interface UploadAuthPayload {
  status_code: number
  auth: string
}

/** ApplyImageUpload 回包里的上传地址 */
interface UploadAddress {
  StoreInfos: Array<{ StoreUri: string; Auth: string }>
  UploadHosts: string[]
  SessionKey: string
}

interface ApplyPayload {
  Result?: { UploadAddress?: UploadAddress }
}

interface CommitPayload {
  Result?: { PluginResult?: Array<{ ImageWidth?: number; ImageHeight?: number }> }
}

interface PreviewPayload {
  url: { url_list: string[] }
}

interface UserInfoPayload {
  user?: {
    uid?: string | number
    nickname?: string
    avatar_larger?: { url_list?: string[] }
  }
}

interface DraftPayload {
  status_code: number
  status_msg?: string
}

/** 草稿 `image_info` 数组里的元素 */
interface DraftImageInfo {
  key: string
  value: { url: string; width: number; height: number }
}

/** 一张图走完整链路后的产物 */
interface UploadedImage {
  /** ImageX 的 StoreUri —— 正文里就用它替换原地址 */
  storeUri: string
  /** 上传真正成功时才有：可直接塞进草稿的 `image_info` */
  imageInfo?: DraftImageInfo
}

export class DouyinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douyin',
    name: '抖音图文',
    icon: 'https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico',
    homepage: 'https://creator.douyin.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 抖音图文按 Markdown 原文提交，渲染交给编辑器 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /**
   * ImageX 与 TOS 都要求带创作者站点的来源信息，否则签名会被拒。
   * 规则只在请求期间生效（基类 `withHeaderRules` 负责收尾）。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: {
        Origin: CREATOR_ORIGIN,
        Referer: `${CREATOR_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://tos-hl-x.snssdk.com/*',
      headers: {
        Origin: CREATOR_ORIGIN,
        Referer: `${CREATOR_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 当前用的创作者中心 tab */
  private activeTabId: number | null = null
  /** 该 tab 是不是本适配器开的（自己开的才负责关） */
  private activeTabOwned = false

  /** 缓存的上传凭证与它的失效时刻 */
  private cachedCredentials: StsCredentials | null = null
  private cachedCredentialsExpireAt = 0

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(USER_INFO_API, {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      })
      const payload = (await response.json()) as UserInfoPayload
      const user = payload.user
      if (user && user.nickname) {
        return {
          isAuthenticated: true,
          userId: String(user.uid || ''),
          username: user.nickname,
          avatar: user.avatar_larger?.url_list?.[0],
        }
      }
      return { isAuthenticated: false }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const imageInfo: DraftImageInfo[] = []
        const markdown = article.markdown || ''

        const processed = await this.processImages(
          markdown,
          async (src) => {
            const uploaded = await this.uploadImageFull(src)
            if (uploaded.imageInfo) {
              imageInfo.push(uploaded.imageInfo)
            }
            return { url: uploaded.storeUri }
          },
          {
            skipPatterns: BUILTIN_IMAGE_PATTERNS,
            onProgress: options?.onImageProgress,
          },
        )

        let longArticle = processed
        let truncated = false
        if (longArticle.length > ARTICLE_CHAR_LIMIT) {
          longArticle = longArticle.slice(0, ARTICLE_CHAR_LIMIT)
          truncated = true
        }

        const creationId = this.createCreationId()
        const initTimestamp = Math.floor(Date.now() / 1000)

        const body = {
          item: {
            common: {
              draft: {
                title: article.title,
                description: '',
                long_article: longArticle,
                image_info: imageInfo,
                head_poster: '',
                text_extra: '[]',
                visibility_type: 0,
                timing: 0,
                creation_id: creationId,
                init_timestamp: initTimestamp,
                req_type: 0,
              },
            },
            cover: {},
          },
        }

        const draft = await this.executeInDouyinTab<DraftPayload>(DRAFT_API, 'POST', body)
        if (draft.status_code !== 0) {
          throw new Error(draft.status_msg || '草稿保存被平台拒绝')
        }

        await this.releaseDouyinTab()

        return this.createResult(true, {
          postId: creationId,
          postUrl: `${CREATOR_ORIGIN}${PUBLISH_PAGE_PATH}?enter_from=draft&creation_id=${creationId}&init_timestamp=${initTimestamp}`,
          draftOnly: options?.draftOnly ?? true,
          message: truncated ? '正文超过抖音图文的 8000 字上限，已截断后保存草稿' : undefined,
        })
      })
    } catch (error) {
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  /**
   * 挑一个创作者中心 tab：命中已有 tab 就复用，否则新建并等它加载完。
   * 复用不接管所有权 —— 发布结束不能把用户自己的 tab 关掉。
   */
  private async ensureDouyinTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('当前运行环境没有 tabs 能力，抖音图文发布无法进行')
    }

    const candidates = await this.runtime.tabs.query(CREATOR_TAB_PATTERN)
    const reusable = candidates[0]
    if (reusable) {
      this.activeTabId = reusable.id
      this.activeTabOwned = false
      return reusable.id
    }

    const created = await this.runtime.tabs.create(`${CREATOR_ORIGIN}${PUBLISH_PAGE_PATH}`, false)
    await this.runtime.tabs.waitForLoad(created.id, TAB_LOAD_TIMEOUT_MS)
    this.activeTabId = created.id
    this.activeTabOwned = true
    return created.id
  }

  /** 收尾：只关掉本次自己开的 tab，关不掉也不影响发布结果 */
  private async releaseDouyinTab(): Promise<void> {
    if (!this.runtime.tabs || this.activeTabId === null || !this.activeTabOwned) return
    const tabId = this.activeTabId
    this.activeTabId = null
    this.activeTabOwned = false
    try {
      await this.runtime.tabs.close(tabId)
    } catch (error) {
      logger.warn('关闭抖音发布 tab 失败（忽略）', error)
    }
  }

  /**
   * 在创作者中心页面上下文里发一次请求。
   * 草稿、上传凭证、预览地址都依赖页面自身的签名环境，普通 fetch 拿不到。
   */
  private async executeInDouyinTab<T>(url: string, method: string, body?: unknown): Promise<T> {
    if (!this.runtime.pageOp) {
      throw new Error('当前运行环境没有页面通道，抖音图文发布无法进行')
    }
    const tabId = await this.ensureDouyinTab()
    const response = await this.runtime.pageOp<PageOpEnvelope<T>>(tabId, 'douyinPublish', [
      url,
      method,
      body,
    ])
    if (!response || !response.success) {
      throw new Error((response && response.error) || '创作者中心的页面请求没有成功')
    }
    return response.data as T
  }

  /** 图片链路第 1 步：取 STS 凭证，到期前 60s 就重新取 */
  private async getSTSCredentials(): Promise<StsCredentials> {
    if (
      this.cachedCredentials &&
      Date.now() < this.cachedCredentialsExpireAt - CREDENTIAL_EXPIRE_MARGIN
    ) {
      return this.cachedCredentials
    }

    const payload = await this.executeInDouyinTab<UploadAuthPayload>(UPLOAD_AUTH_API, 'GET')
    if (payload.status_code !== 0 || !payload.auth) {
      throw new Error('没能从创作者中心取到图片上传凭证')
    }

    const credentials = JSON.parse(payload.auth) as StsCredentials
    if (!credentials.AccessKeyID || !credentials.SecretAccessKey) {
      throw new Error('图片上传凭证里缺少必要字段')
    }

    this.cachedCredentials = credentials
    this.cachedCredentialsExpireAt = new Date(credentials.ExpiredTime).getTime()
    return credentials
  }

  /** 图片链路第 2 步：AWS4 签名后向 ImageX 申请上传地址 */
  private async applyImageUpload(credentials: StsCredentials): Promise<UploadAddress> {
    const signed = await signAWS4({
      method: 'GET',
      url: APPLY_URL,
      accessKeyId: credentials.AccessKeyID,
      secretAccessKey: credentials.SecretAccessKey,
      securityToken: credentials.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(APPLY_URL, {
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
   * 图片链路第 3 步：把字节直传 TOS。
   * `Content-CRC32` 是 TOS 的强制校验位，缺了会被拒。
   */
  private async uploadToTOS(address: UploadAddress, blob: Blob): Promise<void> {
    const storeInfo = address.StoreInfos[0]
    const target = `https://${address.UploadHosts[0]}/${storeInfo.StoreUri}`
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()))

    const response = await this.runtime.fetch(target, {
      method: 'PUT',
      headers: {
        Authorization: storeInfo.Auth,
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-CRC32': checksum,
      },
      body: blob,
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`TOS 上传失败（HTTP ${response.status}）：${detail}`)
    }
  }

  /** 图片链路第 4 步：提交这次上传，拿回图片宽高 */
  private async commitImageUpload(
    credentials: StsCredentials,
    sessionKey: string,
  ): Promise<CommitPayload['Result']> {
    const body = JSON.stringify({ SessionKey: sessionKey })
    const signed = await signAWS4({
      method: 'POST',
      url: COMMIT_URL,
      accessKeyId: credentials.AccessKeyID,
      secretAccessKey: credentials.SecretAccessKey,
      securityToken: credentials.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
      body,
    })

    const response = await this.runtime.fetch(COMMIT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signed.headers,
      },
      body,
    })
    const payload = (await response.json()) as CommitPayload
    const result = payload?.Result
    if (!result) {
      throw new Error('ImageX 没有确认图片提交结果')
    }
    return result
  }

  /** 图片链路第 5 步：用 StoreUri 换编辑器能显示的预览地址 */
  private async getImagePreviewUrl(storeUri: string): Promise<string> {
    const url = `${CREATOR_ORIGIN}/aweme/v1/creator/get/url/?uri=${encodeURIComponent(storeUri)}&aid=${DOUYIN_AID}`
    const payload = await this.executeInDouyinTab<PreviewPayload>(url, 'GET')
    const previewUrl = payload.url.url_list[0]
    if (!previewUrl) {
      throw new Error('没有换到图片预览地址')
    }
    return previewUrl
  }

  /**
   * 取原图字节。
   * 普通 URL 走运行时通道（扩展里能带上站点 cookie），并要求 2xx；
   * data URI 交给宿主自己的 fetch —— 它不需要 cookie，也不会被运行时的域名规则拦。
   */
  private async downloadImage(src: string): Promise<Blob | null> {
    if (src.startsWith('data:')) {
      const inline = await fetch(src, {})
      return inline.blob()
    }

    const response = await this.runtime.fetch(src, { method: 'GET' })
    if (!response.ok) {
      logger.warn('原图下载失败，正文保留该地址', src, response.status)
      return null
    }
    return response.blob()
  }

  /**
   * 一整张图：下载原图 → 凭证 → Apply → 直传 TOS → Commit → 预览地址。
   * 原图取不到不算错，把这 src 当 StoreUri 原样返回（于是它不会进 `image_info`）。
   */
  private async uploadImageFull(src: string): Promise<UploadedImage> {
    const blob = await this.downloadImage(src)
    if (!blob) {
      return { storeUri: src }
    }

    const credentials = await this.getSTSCredentials()
    const address = await this.applyImageUpload(credentials)
    const storeInfo = address.StoreInfos[0]
    if (!storeInfo || !storeInfo.StoreUri) {
      throw new Error('ImageX 给的上传地址里没有 store uri')
    }

    await this.uploadToTOS(address, blob)
    const committed = await this.commitImageUpload(credentials, address.SessionKey)
    const previewUrl = await this.getImagePreviewUrl(storeInfo.StoreUri)
    const size = committed?.PluginResult?.[0]

    return {
      storeUri: storeInfo.StoreUri,
      imageInfo: {
        key: storeInfo.StoreUri,
        value: {
          url: previewUrl,
          width: size?.ImageWidth || 0,
          height: size?.ImageHeight || 0,
        },
      },
    }
  }

  /** 基类图片入口：失败只降级（正文保留原地址），不把发布拖垮 */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const uploaded = await this.uploadImageFull(src)
      return { url: uploaded.storeUri }
    } catch (error) {
      logger.warn('图片未能上传，正文改用原图地址', error)
      return { url: src }
    }
  }

  /** 草稿幂等键：8 位随机字符 + 毫秒时间戳 */
  private createCreationId(): string {
    let prefix = ''
    for (let i = 0; i < CREATION_ID_PREFIX_LEN; i += 1) {
      const index = Math.floor(Math.random() * CREATION_ID_ALPHABET.length)
      prefix += CREATION_ID_ALPHABET[index]
    }
    return `${prefix}${Date.now()}`
  }
}
