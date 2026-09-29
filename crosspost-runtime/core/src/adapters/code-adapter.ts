/**
 * 平台适配器基类（CodeAdapter）。
 *
 * 各平台适配器只负责「这个平台的接口长什么样」，公共部分都在这里：
 * 请求代发与响应解析、请求头规则的成对注册、正文图片的批量转存、登录态探测模板、
 * 统一结果对象的构造。
 *
 * ## 三条硬约定
 *
 * 1. **一切平台请求都走 `runtime.fetch`（携带浏览器 cookie）**，不自己拼 `Cookie` 头，
 *    也不自己读 cookie 做鉴权 —— 这是纯代理模式成立的前提。
 * 2. **`Origin` / `Referer` 只能经请求头规则注入**（浏览器不允许页面直接设置这两个头），
 *    因此基类提供「注册 → 执行 → 撤销」的成对设施，且只撤销**自己记录过**的句柄，
 *    绝不调用运行时的 `clear()`（那会误伤子类或别处注册的规则）。
 * 3. **正文图片的失败不阻断发布**：单张转存失败只记日志、正文保留原地址，
 *    宁可缺一张图，也不让整篇发不出去。
 *
 * ## 子类必须/可选实现
 *
 * · 必须：`meta`、`checkAuth()`、`publish()`；
 * · 需要图片转存时覆写 `uploadImageByUrl(src)`（基类默认直接抛错）；
 * · `uploadImage(file)` 默认走「Blob → data URI → `uploadImageByUrl`」；
 * · `preprocessConfig` 由各平台自行声明（基类不占位，避免与子类声明冲突）。
 */

import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../types'
import type { RuntimeInterface } from '../runtime/interface'
import type { PlatformAdapter, PublishOptions } from './types'
import { createLogger } from '../lib/logger'
import { parseMarkdownImages } from '../lib/markdown-images'

const log = createLogger('code-adapter')

/** 相邻两张图片之间的固定等待：平台风控要求，被跳过的图片不产生等待 */
const IMAGE_GAP_MS = 300

/**
 * 正文里的 `<img …>` 标签，捕获其中 `src` 的取值。
 *
 * `[^>]*` 是贪婪的，因此一个标签里出现多个 `src="…"`（例如 `src` 与 `data-src` 并存）时
 * 取的是**最后**一个**非空**取值 —— 空值会让正则退回更靠前的那一个 `src=`。
 * 只认识双引号，单引号属性不会被命中；大小写不敏感，允许跨行。
 */
const HTML_IMAGE = /<img[^>]*src="([^"]+)"[^>]*>/gi

/** 单张图片的上传结果 */
export interface ImageUploadResult {
  /** 替换进正文的地址 */
  url: string
  /**
   * 追加到 `<img>` 上的附加属性（**仅 HTML 形态生效**）：键是任意属性名，
   * 值会被字符串化。Markdown 形态忽略它。
   */
  attrs?: Record<string, string | number>
}

/** 正文图片批量处理的选项 */
export interface ProcessImagesOptions {
  /** 图片地址里命中任一子串就跳过（平台自己的图床域名，不必重传）；`data:` 开头的地址豁免 */
  skipPatterns?: string[]
  /** 进度回调：`current` 从 1 起、在真正开始处理这一张之前调用；`total` 是候选图片总数 */
  onProgress?: (current: number, total: number) => void
}

/** 登录态探测里，判定回调可以带回来的登录信息 */
export interface AuthIndicatorInfo {
  isAuthenticated?: boolean
  userId?: string
  username?: string
  avatar?: string
}

/** `checkAuthWithRules` 的可选项 */
export interface CheckAuthProbeOptions {
  /** 探测期间临时注入的请求头规则；为空数组或省略时裸跑 */
  headerRules?: Array<Omit<HeaderRule, 'id'>>
  /** 随请求带上的普通请求头 */
  headers?: Record<string, string>
}

/** 正文里一处待转存的图片 */
interface ImageHit {
  /** 片段在正文中的起始下标 */
  from: number
  /** 片段结束下标（不含） */
  to: number
  /** 要拿去转存的地址 */
  src: string
  /** Markdown 形态的替代文本；HTML 形态为 undefined */
  alt?: string
  /** 是否来自 Markdown 形态（决定替换后的写法） */
  markdown: boolean
}

/** 一处待落地的替换 */
interface ImageEdit {
  from: number
  to: number
  text: string
}

/** 把任意异常收敛成可读文案 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 扫描 HTML 形态：只认双引号包裹的 `src`，取值为转存对象，整段标签是替换对象 */
function locateHtmlImages(content: string): ImageHit[] {
  const hits: ImageHit[] = []
  HTML_IMAGE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HTML_IMAGE.exec(content)) !== null) {
    const src = match[1]
    hits.push({ from: match.index, to: match.index + match[0].length, src, markdown: false })
  }
  return hits
}

/**
 * 扫描 Markdown 形态。
 *
 * `parseMarkdownImages` 只回「片段 + 替代文本 + 地址」，不带位置；好在它按出现顺序
 * 返回且各片段互不重叠，于是从左往右依次 `indexOf` 就能精确还原每一处的位置。
 */
function locateMarkdownImages(content: string): ImageHit[] {
  const hits: ImageHit[] = []
  let cursor = 0
  for (const ref of parseMarkdownImages(content)) {
    const from = content.indexOf(ref.full, cursor)
    if (from === -1) continue
    hits.push({ from, to: from + ref.full.length, src: ref.src, alt: ref.alt, markdown: true })
    cursor = from + ref.full.length
  }
  return hits
}

/**
 * 先 HTML 形态、后 Markdown 形态，两组按各自的文档顺序拼接。
 * 因此进度编号不一定等于图片在正文中的视觉顺序。
 */
function locateImages(content: string): ImageHit[] {
  return [...locateHtmlImages(content), ...locateMarkdownImages(content)]
}

/** 把一处匹配渲染成替换后的片段 */
function renderImage(hit: ImageHit, uploaded: ImageUploadResult): string {
  if (hit.markdown) {
    return `![${hit.alt ?? ''}](${uploaded.url})`
  }
  let text = `<img src="${uploaded.url}"`
  for (const [name, value] of Object.entries(uploaded.attrs ?? {})) {
    text += ` ${name}="${String(value)}"`
  }
  return `${text} />`
}

/**
 * 按位置把替换落回正文。
 *
 * 不用「反复对整串做字符串替换」：那种写法在片段重复、或新地址里含 `$` 时会走样。
 * 这里先按起始位置升序挑出互不重叠的替换（先出现者胜，与「HTML 在前」的拼接顺序一致），
 * 再从后向前一次拼装，正文只被遍历一遍。
 */
function spliceImages(content: string, edits: ImageEdit[]): string {
  if (edits.length === 0) return content

  const ordered = [...edits].sort((a, b) => a.from - b.from)
  const kept: ImageEdit[] = []
  let consumed = 0
  for (const edit of ordered) {
    if (edit.from < consumed) continue
    kept.push(edit)
    consumed = edit.to
  }

  let tail = content.length
  let out = ''
  for (let i = kept.length - 1; i >= 0; i--) {
    const edit = kept[i]
    out = edit.text + content.slice(edit.to, tail) + out
    tail = edit.from
  }
  return content.slice(0, tail) + out
}

export abstract class CodeAdapter implements PlatformAdapter {
  /** 平台元信息；`id` 必须与平台注册表一致 */
  abstract readonly meta: PlatformMeta

  /** 运行时句柄；`init` resolve 之前是 undefined，不能提前使用 */
  protected runtime!: RuntimeInterface

  /** 已经注册、尚未撤销的请求头规则句柄（构造期即为空数组，`init` 前读它是安全的） */
  protected headerRuleIds: string[] = []

  /** 记下「这批句柄属于哪个运行时」：换了运行时之后旧句柄一律作废 */
  private ruleOwner: RuntimeInterface | null = null

  /**
   * 注入运行时。除赋值外不做任何事：不发请求、不注册规则、不写存储。
   * 允许被重复调用（注册中心换运行时会复用同一个实例）。
   */
  async init(runtime: RuntimeInterface): Promise<void> {
    this.runtime = runtime
  }

  /** 探测登录态。**未登录要返回结构**（`isAuthenticated: false`），不要抛错 */
  abstract checkAuth(): Promise<AuthResult>

  /** 发布（或存草稿）。失败应兜底成 `createResult(false, { error })`，不要挂起 */
  abstract publish(article: Article, options?: PublishOptions): Promise<SyncResult>

  // ───────────────────────── 请求代发 ─────────────────────────

  /**
   * 发送一次请求并解析回包。
   *
   * 解析**不看 `content-type`**：先整体按 JSON 试，失败就把原文当结果返回
   * （大量平台接口的内容类型并不规范，按 content-type 分支反而会解析失败）。
   * 响应 `!ok` 一律抛出以 `HTTP <状态码>` 起头的错误。
   */
  private async send<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.runtime.fetch(url, init)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const body = await response.text()
    try {
      return JSON.parse(body) as T
    } catch {
      return body as unknown as T
    }
  }

  /** GET，携带 cookie */
  protected get<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    return this.send<T>(url, { method: 'GET', credentials: 'include', headers })
  }

  /** POST JSON 体，自动补 JSON 内容类型（调用方同名头优先） */
  protected postJson<T = unknown>(
    url: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.send<T>(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    })
  }

  /** POST 表单体（`application/x-www-form-urlencoded`） */
  protected postForm<T = unknown>(
    url: string,
    data: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.send<T>(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(data),
    })
  }

  /** POST multipart 体。**不设内容类型**：boundary 由传输层决定 */
  protected postMultipart<T = unknown>(
    url: string,
    formData: FormData,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.send<T>(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    })
  }

  // ───────────────────────── 请求头规则 ─────────────────────────

  /**
   * 注册一条请求头规则。
   *
   * 运行时没有该能力时返回 `null` 且什么都不记（整体静默降级）；否则把运行时返回的
   * **不透明字符串句柄**原样收进内部列表并返回，基类不解析它的内容。
   */
  protected async addHeaderRule(rule: Omit<HeaderRule, 'id'>): Promise<string | null> {
    const injector = this.runtime?.headerRules
    if (!injector) return null
    const handle = await injector.add(rule)
    this.headerRuleIds.push(handle)
    this.ruleOwner = this.runtime
    return handle
  }

  /** 串行注册一批规则；日志按**累计**持有量判定，而不是本批数量 */
  protected async addHeaderRules(rules: Array<Omit<HeaderRule, 'id'>>): Promise<void> {
    for (const rule of rules) {
      await this.addHeaderRule(rule)
    }
    if (this.headerRuleIds.length > 0) {
      log.debug(`当前持有 ${this.headerRuleIds.length} 条请求头规则`)
    }
  }

  /**
   * 撤销当前记录的全部规则。
   *
   * 无能力、或列表本来就空时是 no-op（因此「成功路径 + 失败路径各调一次」是安全写法）。
   * 只有全部 `remove` 成功才清空列表：中途抛错时列表原样保留，剩下的句柄也不再撤销
   * —— 调用方据此知道还有规则挂着。
   */
  protected async clearHeaderRules(): Promise<void> {
    const injector = this.runtime?.headerRules
    if (!injector || this.headerRuleIds.length === 0) return
    await this.releaseHeaderRules([...this.headerRuleIds])
  }

  /**
   * 注册一批规则，跑完 `fn` 后撤销**这批**规则（成功、抛错两条路径都撤）。
   *
   * 注册动作在 `try` 之外：注册途中抛错时，这一批已经注册的部分不会被清理
   * （失败语义交给调用方的 `catch` 兜底）。
   *
   * 作用域语义：撤销只针对本次注册的句柄，因此嵌套调用不会互相误伤 ——
   * 内层结束时收掉内层自己的那一批，外层结束时收掉外层自己的。
   */
  protected async withHeaderRules<T>(
    rules: Array<Omit<HeaderRule, 'id'>>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const before = this.headerRuleIds.length
    await this.addHeaderRules(rules)
    const mine = this.headerRuleIds.slice(before)
    try {
      return await fn()
    } finally {
      await this.releaseHeaderRules(mine)
    }
  }

  /**
   * 撤销给定的一批句柄，并从内部列表里摘掉它们。
   *
   * 若句柄来自**另一个**运行时实例（`init` 被换过），它们在这个运行时里没有意义，
   * 直接作废而**不是**拿去 `remove` —— 撤销陈旧句柄可能误删别人的规则。
   */
  private async releaseHeaderRules(handles: string[]): Promise<void> {
    if (handles.length === 0) return
    const injector = this.runtime?.headerRules
    if (!injector) return

    if (this.ruleOwner !== this.runtime) {
      log.warn(`作废 ${handles.length} 个来自旧运行时的请求头规则句柄`)
      this.dropHandles(handles)
      return
    }

    for (const handle of handles) {
      await injector.remove(handle)
    }
    this.dropHandles(handles)
    log.debug(`已撤销 ${handles.length} 条请求头规则`)
  }

  /** 从内部列表摘掉一批句柄；列表空了就一并清掉归属标记 */
  private dropHandles(handles: string[]): void {
    this.headerRuleIds = this.headerRuleIds.filter((handle) => !handles.includes(handle))
    if (this.headerRuleIds.length === 0) this.ruleOwner = null
  }

  // ───────────────────────── 正文图片 ─────────────────────────

  /**
   * 把正文里的图片逐个转存，返回替换后的正文。
   *
   * · 扫描与正文实际格式无关：HTML 形态与 Markdown 形态各扫一遍，两组合并；
   * · `skipPatterns` 是地址的**子串**匹配（大小写敏感），但 `data:` 开头的地址豁免
   *   —— 它必须被真正上传，平台图床只接受 http 地址；
   * · 同一个地址只上传一次，结果按地址复用；进度回调按**出现次数**计，`total` 是候选总数
   *   （含被跳过与重复的），所以 `current` 的终值可能小于 `total`；
   * · 完全串行，每张之间固定等 `IMAGE_GAP_MS`；被跳过的图片不产生等待；
   * · 单张失败只记日志，该图保留原文，继续处理下一张，整体不抛错。
   */
  protected async processImages(
    content: string,
    uploadFn: (src: string) => Promise<ImageUploadResult>,
    options?: ProcessImagesOptions,
  ): Promise<string> {
    const hits = locateImages(content)
    if (hits.length === 0) return content

    const skipPatterns = options?.skipPatterns ?? []
    const total = hits.length
    const done = new Map<string, ImageUploadResult>()
    const edits: ImageEdit[] = []
    let started = 0

    for (const hit of hits) {
      const src = hit.src
      if (src === '') continue
      if (!src.startsWith('data:') && skipPatterns.some((pattern) => src.includes(pattern))) {
        log.debug('这张图已在平台自己的图床上，跳过转存')
        continue
      }

      started += 1
      options?.onProgress?.(started, total)

      let uploaded = done.get(src)
      if (uploaded === undefined) {
        try {
          uploaded = await uploadFn(src)
          done.set(src, uploaded)
        } catch (error) {
          log.error(`第 ${started}/${total} 张图片转存失败，正文保留原地址`, describeError(error))
        }
      }

      if (uploaded !== undefined) {
        edits.push({ from: hit.from, to: hit.to, text: renderImage(hit, uploaded) })
      }

      await this.delay(IMAGE_GAP_MS)
    }

    log.debug(`正文候选图片 ${total} 张，实际替换 ${edits.length} 处`)
    return spliceImages(content, edits)
  }

  /**
   * 上传一张本地图片，返回可直接写进正文的地址。
   *
   * 默认实现是「Blob → data URI → `uploadImageByUrl` → 取 `.url`」：返回值里
   * **不含 `attrs`**，需要附加属性的平台请直接覆写本方法或走 `uploadImageByUrl`。
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    const dataUri = await this.blobToDataUri(file)
    const uploaded = await this.uploadImageByUrl(dataUri)
    return uploaded.url
  }

  /**
   * 按地址转存一张图片。基类默认不支持，子类按平台接口覆写。
   */
  protected async uploadImageByUrl(_src: string): Promise<ImageUploadResult> {
    throw new Error('这个平台没有实现按地址转存图片')
  }

  // ───────────────────────── 小工具 ─────────────────────────

  /** Blob → data URI（`FileReader` + `readAsDataURL`；结果不是字符串时拒绝） */
  protected blobToDataUri(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result: unknown = reader.result
        if (typeof result === 'string') {
          resolve(result)
        } else {
          reject(new Error('Blob 读出来不是 data URI 字符串'))
        }
      }
      reader.onerror = () => reject(new Error('Blob 读取失败'))
      reader.readAsDataURL(blob)
    })
  }

  /** data URI → Blob（交给宿主把 data URI 当普通 URL 抓下来） */
  protected async dataUriToBlob(dataUri: string): Promise<Blob> {
    const response = await fetch(dataUri)
    return response.blob()
  }

  /** 定时器包装 */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  /** 构造统一结果对象；`data` 在后，因此它可以覆盖 `platform` / `success` / `timestamp` */
  protected createResult(success: boolean, data?: Partial<SyncResult>): SyncResult {
    return {
      platform: this.meta.id,
      success,
      timestamp: Date.now(),
      ...data,
    }
  }

  /**
   * 登录态探测模板：请求 `url`（GET + 携带 cookie），把回包交给判定回调。
   *
   * 回包先取文本，再尝试 `JSON.parse`；**解析失败就把原文交给回调** —— 这样同一个模板
   * 既能服务返回 JSON 的接口，也能服务返回 HTML 页面的平台（平台差异全部由调用方传入，
   * 基类不内置任何 URL 或选择器）。
   *
   * 回调返回真值即视为已登录，其字段展开进结果（回调里若带 `isAuthenticated`，以回调为准）；
   * 返回假值得到 `{ isAuthenticated: false }`（**不带 `error`**，因为「确实没登录」不是故障）。
   * 只有提供了非空规则列表时才包一层 `withHeaderRules`；整个过程任一步抛错都收敛成
   * `{ isAuthenticated: false, error }`，**绝不向调用方抛错**。
   */
  protected async checkAuthWithRules(
    url: string,
    loginIndicator: (payload: unknown) => AuthIndicatorInfo | null | undefined,
    options?: CheckAuthProbeOptions,
  ): Promise<AuthResult> {
    const probe = async (): Promise<AuthResult> => {
      const response = await this.runtime.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: options?.headers,
      })
      const raw = await response.text()
      let payload: unknown = raw
      try {
        payload = JSON.parse(raw) as unknown
      } catch {
        // 平台回的是 HTML 页面：把原文交给判定回调
      }
      const info = loginIndicator(payload)
      if (!info) return { isAuthenticated: false }
      return { isAuthenticated: true, ...info }
    }

    try {
      const rules = options?.headerRules
      return rules && rules.length > 0 ? await this.withHeaderRules(rules, probe) : await probe()
    } catch (error) {
      log.debug('登录态探测未通过', error)
      return { isAuthenticated: false, error: describeError(error) }
    }
  }
}
