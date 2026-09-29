/**
 * 东方财富 · 财富号（cfh）适配器。
 *
 * 这个平台和同组其它平台的四处不同，写在最前面，读代码时按它对照：
 *
 * 1. **正文只认 HTML**（`outputFormat: 'html'`），所以进 `publish` 的是上游预处理过的
 *    `article.html`，`markdown` 在这里没有消费者；
 * 2. **图片不落本地**：http(s) 的图把链接交给平台自己抓，只有 `data:` 才由我们转成
 *    Blob 走二进制上传 —— 因此这里没有「下载失败」这条路径；
 * 3. **存草稿分两步**：先建一篇只放空容器的草稿换到 id，再把处理完的正文更新进去。
 *    第二步失败时平台上会留一篇空草稿，这是平台既有行为，不是本适配器的取舍；
 * 4. **设备号要持久化**：32 位十六进制串，落 `runtime.storage`，跨会话复用同一个。
 *
 * 凭据走 cookie `ct` / `ut`，但它们不是 Cookie 头，而是拼进 URL 查询串 / 请求体 / 表单。
 * 每次 `checkAuth` 与 `publish` 都重新读一遍（会话里可能换人），实例字段只当作「最近一次
 * 读到的值」，供几步之后的图片上传复用。
 */
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const log = createLogger('eastmoney-cfh')

/* ─────────────────────── 平台端点与魔数（逐字固定） ─────────────────────── */

/** 登录态探测；`platform=` 留空也是协议的一部分 */
const AUTHOR_API = 'https://caifuhaoapi.eastmoney.com/api/v2/getauthorinfo'
/** 草稿读写的统一入口：真正的动作写在请求体的 `path` 里 */
const DRAFT_GATEWAY = 'https://emfront.eastmoney.com/apifront/Tran/GetData?platform='
/** 图片转存的两条通道：给链接（平台去抓）/ 给二进制（我们抓成 Blob 再传） */
const IMAGE_LINK_API = 'https://gbapi.eastmoney.com/iimage/image/byLink?platform='
const IMAGE_BLOB_API = 'https://gbapi.eastmoney.com/iimage/image?platform='
/** 草稿编辑页；建新草稿时 hash 不带 id，更新时拼 `?id=<draftId>` */
const EDITOR_PAGE = 'https://mp.eastmoney.com/collect/pc_article/index.html#/'
/** 固定动作名。只走这一个（草稿保存），本适配器永不触碰发布接口 */
const DRAFT_ACTION = 'draft/api/Article/SaveDraft'

/** 登录 cookie 所在域与两个名字 */
const COOKIE_DOMAIN = '.eastmoney.com'
/** 设备号在 `runtime.storage` 里的键 */
const DEVICE_ID_KEY = 'eastmoney_deviceId'
/** 正文容器的固定 class：平台编辑器按它取内容 */
const EDITOR_FRAME_CLASS = 'xeditor_content cfh_web'
/** `parm` 第 1 项那个占位符：由服务端替换，客户端原样送 */
const IP_PLACEHOLDER = '$IP$'
/** 平台没给错误说明时的兜底措辞 */
const NO_REASON = '平台没有给出原因'
/** 已经在平台自家图床上的图不必再转存（`data:` 不受它影响） */
const OWN_IMAGE_HOSTS = ['gbres.dfcfw.com']

/* ─────────────────────────── 请求头规则（声明契约） ─────────────────────────── */

const PLATFORM_HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://mp.eastmoney.com/*',
    headers: {
      Origin: 'https://mp.eastmoney.com',
      HOST: 'emfront.eastmoney.com',
    },
    resourceTypes: ['xmlhttprequest'],
  },
]

/* ─────────────────────────────── 回包形状 ─────────────────────────────── */

/** `getauthorinfo` 只用到这几个字段 */
interface AuthorPayload {
  Success?: unknown
  Result?: {
    accountId?: string
    accountName?: string
    portrait?: string
  }
}

/** 草稿接口的外层信封 */
interface DraftEnvelope {
  RRquestSuccess?: unknown
  RCode?: unknown
  RMsg?: string
  /** 它是**字符串**，里面还有一层 JSON */
  RData?: unknown
}

/** 拆开 `RData` 之后的内层载荷 */
interface DraftPayload {
  error_code?: number
  me?: string
  draft_id?: string
}

/** 两个图片接口共用的回包 */
interface ImagePayload {
  code?: number
  message?: string
  data?: { url?: string }
}

/* ─────────────────────────── parm 字段表与组装 ─────────────────────────── */

/**
 * `parm` 的字段名次序。
 *
 * **顺序就是协议**：每一项在请求体里都被序列化成「只有一个键的对象」，23 项合成一个数组
 * 再 `JSON.stringify` 成字符串放进外层 `parm`。这里只声明键序，取值由 `serializeParm`
 * 按同一次序喂进来 —— 值表与键表分开写，是为了让「顺序」只有一个来源。
 */
const PARM_FIELDS = [
  'ip',
  'deviceid',
  'version',
  'plat',
  'product',
  'ctoken',
  'utoken',
  'draftid',
  'drafttype',
  'type',
  'title',
  'text',
  'columns',
  'cover',
  'issimplevideo',
  'videos',
  'vods',
  'isoriginal',
  'tgProduct',
  'spcolumns',
  'textsource',
  'replyauthority',
  'modules',
]

/** 按 `PARM_FIELDS` 的次序拼出 `parm` 字符串（值表缺项会得到 `undefined`，便于早暴露） */
function serializeParm(values: Record<string, string>): string {
  return JSON.stringify(PARM_FIELDS.map((field) => ({ [field]: values[field] })))
}

/** 平台编辑器的正文容器：两个阶段共用同一个壳，建草稿阶段里面是空的 */
function frameEditor(body: string): string {
  return `<div class="${EDITOR_FRAME_CLASS}">${body}</div>`
}

/** 异常 → 可读文案 */
function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 图片回包取地址：`code` 必须是数字 200，且 `data.url` 真值 */
function pickImageUrl(payload: ImagePayload): string {
  const url = payload?.data?.url
  if (payload?.code !== 200 || !url) {
    throw new Error(
      `平台图床没有接收这张图：${payload?.message || NO_REASON}（code: ${payload?.code}）`,
    )
  }
  return url
}

export class EastmoneyAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'eastmoney',
    name: '东方财富',
    icon: 'https://mp.eastmoney.com/collect/pc_article/favicon.ico',
    homepage: 'https://mp.eastmoney.com',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  readonly HEADER_RULES = PLATFORM_HEADER_RULES

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
    // 结构整理：先看容器再谈清理，顺序按"外层 → 内层"
    convertSectionToDiv: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    // 噪音清理
    removeComments: true,
    removeSpecialTags: true,
    processCodeBlocks: true,
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
    removeTrailingBr: true,
    // 属性精简与收尾压缩
    removeDataAttributes: true,
    removeSrcset: true,
    removeSizes: true,
    compactHtml: true,
  }

  /** 最近一次读到的 `ct`；图片上传会复用它 */
  private ctoken = ''
  /** 最近一次读到的 `ut` */
  private utoken = ''
  /** 设备号：本实例内记忆化，首次用到时才落 storage */
  private deviceId = ''

  // ─────────────────────────── 登录态 ───────────────────────────

  async checkAuth(): Promise<AuthResult> {
    try {
      await this.loadCredentials()
      const response = await this.runtime.fetch(
        `${AUTHOR_API}?platform=&ctoken=${this.ctoken}&utoken=${this.utoken}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'x-requested-with': 'fetch' },
        },
      )
      const payload = (await response.json()) as AuthorPayload
      // `Success` 是数字 1 才认（字符串 '1' 不算），账号 id 也得有值
      if (payload.Success !== 1 || !payload.Result?.accountId) return { isAuthenticated: false }
      return {
        isAuthenticated: true,
        userId: payload.Result.accountId,
        username: payload.Result.accountName,
        avatar: payload.Result.portrait,
      }
    } catch (error) {
      log.debug('登录态没探成功', asMessage(error))
      return { isAuthenticated: false, error: asMessage(error) }
    }
  }

  /**
   * 读 `ct` / `ut`。
   *
   * 两个 cookie 都先读到手再判空（读的顺序与失败措辞都不区分是谁缺），这样"缺一个"与
   * "缺两个"在调用序列上是一样的。读成功才写进实例字段 —— 失败时保持上一次的值不动。
   */
  private async loadCredentials(): Promise<void> {
    const readCookie = this.runtime.getCookie
    if (!readCookie) {
      throw new Error('当前运行环境拿不到 cookie，请先在浏览器里登录东方财富财富号')
    }
    const ct = await readCookie.call(this.runtime, COOKIE_DOMAIN, 'ct')
    const ut = await readCookie.call(this.runtime, COOKIE_DOMAIN, 'ut')
    if (!ct || !ut) throw new Error('未检测到东方财富的登录信息，请先登录财富号')
    this.ctoken = ct
    this.utoken = ut
  }

  // ─────────────────────────── 存草稿 ───────────────────────────

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        await this.loadCredentials()
        const deviceId = await this.resolveDeviceId()

        // 第一步：把一篇只有空容器的草稿建出来，拿它的 id
        const draftId = await this.writeDraft(deviceId, '', article.title, '')
        if (!draftId) throw new Error('草稿接口没有返回草稿 id，正文没有落点')

        // 第二步：图片转存后的正文更新进这篇草稿
        const body = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          { skipPatterns: OWN_IMAGE_HOSTS, onProgress: options?.onImageProgress },
        )
        await this.writeDraft(deviceId, draftId, article.title, body)

        return this.createResult(true, {
          postId: draftId,
          postUrl: `${EDITOR_PAGE}?id=${draftId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.debug('存草稿没走完', asMessage(error))
      return this.createResult(false, { error: asMessage(error) })
    }
  }

  /**
   * 往草稿接口发一次 `draft/api/Article/SaveDraft`。
   *
   * `draftId` 为空串＝新建（编辑页不带 id、`draftid` 传空），否则＝更新已建的那篇。
   * 回包里能带回来 id 就带回来（新建阶段必须拿到，更新阶段可以没有）。
   *
   * 回包是**三层**：HTTP `ok` → 外层信封 JSON → 内层 `RData`（还是字符串，再解一次 JSON）。
   * 三层依次校验，任一不成立就抛，由 `publish` 收敛成 `success:false`。
   */
  private async writeDraft(
    deviceId: string,
    draftId: string,
    title: string,
    body: string,
  ): Promise<string | undefined> {
    const pageUrl = draftId === '' ? EDITOR_PAGE : `${EDITOR_PAGE}?id=${draftId}`
    const parm = serializeParm({
      ip: IP_PLACEHOLDER,
      deviceid: deviceId,
      version: '100',
      plat: 'web',
      product: 'CFH',
      ctoken: this.ctoken,
      utoken: this.utoken,
      draftid: draftId,
      drafttype: '0',
      type: '0',
      title: encodeURIComponent(title),
      text: encodeURIComponent(frameEditor(body)),
      columns: '2',
      cover: '',
      issimplevideo: '0',
      videos: '',
      vods: '',
      isoriginal: '0',
      tgProduct: '',
      spcolumns: '',
      textsource: '0',
      replyauthority: '',
      modules: encodeURIComponent('[]'),
    })

    const response = await this.runtime.fetch(DRAFT_GATEWAY, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageUrl, path: DRAFT_ACTION, parm }),
    })

    // 先取正文再判 ok：状态码与错误体都在回包里，解析失败与 HTTP 失败要分开报
    const raw = await response.text()
    if (!response.ok) throw new Error(`草稿接口拒绝了这个请求（HTTP ${response.status}）`)

    let envelope: DraftEnvelope
    try {
      envelope = JSON.parse(raw) as DraftEnvelope
    } catch {
      throw new Error('草稿接口的外层响应不是合法 JSON')
    }
    if (!envelope.RRquestSuccess || envelope.RCode !== 200) {
      throw new Error(`草稿接口返回失败：${envelope.RMsg || NO_REASON}`)
    }

    let payload: DraftPayload
    try {
      payload = JSON.parse(String(envelope.RData)) as DraftPayload
    } catch {
      throw new Error('草稿接口的数据层不是合法 JSON')
    }
    if (payload.error_code !== 0) {
      throw new Error(`草稿数据层返回失败：${payload.me || NO_REASON}`)
    }
    return payload.draft_id
  }

  /** 设备号：实例缓存 → storage → 现生成并回写（32 位大写十六进制，16 字节） */
  private async resolveDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId

    const saved = await this.runtime.storage.get(DEVICE_ID_KEY)
    if (saved) {
      this.deviceId = String(saved)
      return this.deviceId
    }

    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    this.deviceId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
    await this.runtime.storage.set(DEVICE_ID_KEY, this.deviceId)
    return this.deviceId
  }

  // ─────────────────────────── 图片 ───────────────────────────

  /**
   * 按地址转存一张图。
   *
   * `data:` 走二进制通道（基类先把 data URI 抓成 Blob，这一步走全局 `fetch`）；
   * 其余一律把链接原样交给平台，由平台自己取图。两条通道都**不判 HTTP `ok`**，
   * 只看回包里的 `code`/`data.url`。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (src.startsWith('data:')) {
      const blob = await this.dataUriToBlob(src)
      return { url: await this.uploadBinary(blob) }
    }

    const form = new URLSearchParams()
    form.set('noinlist', '1')
    form.set('linkUrl', src)
    form.set('ctoken', this.ctoken)
    form.set('utoken', this.utoken)
    const response = await this.runtime.fetch(IMAGE_LINK_API, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    return { url: pickImageUrl((await response.json()) as ImagePayload) }
  }

  /** 二进制上传：表单里文件名取 MIME 子类型当扩展名，取不到就是 `png` */
  private async uploadBinary(blob: Blob): Promise<string> {
    const form = new FormData()
    form.append('file', blob, `${Date.now()}.${blob.type.split('/')[1] || 'png'}`)
    form.append('noinlist', '1')
    form.append('utoken', this.utoken)
    form.append('ctoken', this.ctoken)

    const response = await this.runtime.fetch(IMAGE_BLOB_API, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    return pickImageUrl((await response.json()) as ImagePayload)
  }
}
