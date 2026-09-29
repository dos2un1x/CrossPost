/**
 * 微博（头条文章）适配器
 *
 * 平台侧只有一条「草稿」通道：先开一篇空草稿拿 id，再把正文写进去。两条请求缺一不可 ——
 * 少了前一条就没有 id，少了后一条就只剩一篇空稿。
 *
 * 与其它平台的两处结构性差别：
 *
 * · **正文图片不走同步上传**，而是把原图地址交给微博的转存服务、再轮询转存结果；
 *   正文扫描也由本文件自带（`<figure>` 段落优先、独立 `<img>` 其次、Markdown 图片最后），
 *   因为微博要求正文里的图片自带 `data-pid`，基类那套统一替换给不出这个属性。
 * · **`data:` 图片在两条路径上的待遇相反**：正文里的 data URI 原样留着不动，而封面是
 *   data URI 时会走图床直传接口真的传上去。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { parseMarkdownImages } from '../../../lib/markdown-images'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Weibo')

/** 编辑器页：登录态探测与用户信息都从这一页读 */
const EDITOR_URL = 'https://card.weibo.com/article/v5/editor'

/** 微博文章编辑器根地址 */
const CARD_ROOT = 'https://card.weibo.com'

/** 图床直传接口（`data:` 图片走这条） */
const PIC_UPLOAD_URL = 'https://picupload.weibo.com/interface/pic_upload.php'

/** 图床直传接口的固定查询串（各参数由平台约定，本仓不自造） */
const PIC_UPLOAD_QUERY = 'app=miniblog&s=json&p=1&data=1&url=&markpos=1&logo=0&nick=&file_source=4'

/** 转存成功的图片统一挂在这个前缀下（回包里的原地址一律不用） */
const IMAGE_HOST = 'https://wx3.sinaimg.cn/large'

/** 草稿创建接口的成功码（数字比较，与保存接口的字符串比较刻意不同） */
const CREATE_CODE = 100000

/** 请求标识的字符集与固定长度：够长的部分由随机字符补足 */
const RID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const RID_LENGTH = 43

/** 图片转存任务的轮询上限与间隔 */
const POLL_LIMIT = 30
const POLL_INTERVAL_MS = 1000

/** 相邻两张正文图片之间的等待 */
const IMAGE_GAP_MS = 300

/** 已经落在微博图床上的图片不必再传一次 */
const HOSTED_PATTERNS = ['sinaimg.cn', 'weibo.com']

/** `<figure>…</figure>` 整段（段落里带不带 `<img>` 都算命中） */
const FIGURE_BLOCK = /<figure\b[^>]*>[\s\S]*?<\/figure>/gi

/** 单个 `<img …>` 标签 */
const IMG_TAG = /<img\b[^>]*>/gi

/** 标签自身携带的 `src` 取值 */
const IMG_SRC = /\bsrc\s*=\s*"([^"]*)"/i

/** `data:` 形式的图片地址 */
const DATA_URI = /^data:([^;]+);base64,(.+)$/

/** 编辑器页里内联的用户配置：`config: JSON.parse('…')`，捕获单引号里的那段串 */
const EMBEDDED_CONFIG = /config:\s*JSON\.parse\('([\s\S]+?)'\)/

/** 去掉相邻标签之间的空白：微博编辑器对缩进敏感 */
const BETWEEN_TAGS = />\s+</g

/** 微博对本文档声明的能力 */
const CAPABILITIES: PlatformMeta['capabilities'] = ['article', 'draft', 'image_upload', 'cover']

/**
 * 请求头规则：微博的接口都要求同源来源，而扩展发出的 XHR 默认不是。
 * 卡片站与图床站各一条，按各自期望的 `Origin` 给出。
 */
const HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://card.weibo.com/*',
    headers: {
      Origin: 'https://card.weibo.com',
      Referer: 'https://card.weibo.com/article/v5/editor',
    },
    resourceTypes: ['xmlhttprequest'],
  },
  {
    urlFilter: '*://picupload.weibo.com/*',
    headers: {
      Origin: 'https://weibo.com',
      Referer: 'https://weibo.com/',
    },
    resourceTypes: ['xmlhttprequest'],
  },
]

/** 编辑器页解析出来的当前用户 */
interface WeiboUser {
  uid: string
  nick?: string
  avatar?: string
}

/** 微博接口回包里我们会读到的字段 */
interface WeiboReply {
  code?: number | string
  msg?: string
  message?: string
  data?: WeiboReplyData
}

/** 回包 `data` 上各接口用到的字段 */
interface WeiboReplyData {
  id?: string | number
  uid?: string | number
  nick?: string
  avatar_large?: string
  pics?: Record<string, { pid?: string }>
}

/** 转存任务的一项 */
interface WeiboTransferTask {
  pid?: string
  task_status_code?: number
}

/** 正文里一处待转存的图片 */
interface ContentImage {
  /** 片段起点 */
  start: number
  /** 片段终点（不含） */
  end: number
  /** 原图地址 */
  src: string
  /** 片段自身是不是一整段 `<figure>` */
  figure: boolean
}

/** 一处待落地的替换 */
interface ContentEdit {
  start: number
  end: number
  text: string
}

/** 把任意异常收敛成可读文案 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 回包里的业务错误文案（平台原样透传的文本不改写） */
function replyMessage(reply: WeiboReply | undefined | null): string | undefined {
  if (reply === undefined || reply === null) return undefined
  return reply.msg ?? reply.message
}

/**
 * 用浏览器自带的 `btoa` 做 base64。
 *
 * 先按 UTF-8 取字节、再逐字节映射成 Latin-1 字符：请求标识里可能出现非 ASCII 字符
 * （uid 理论上是数字串，但这条通道不该假设输入），直接 `btoa(原文)` 会因码点越界而抛错。
 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 摘掉 `<img>` 标签上的 `src` */
function imageSource(tag: string): string {
  const matched = IMG_SRC.exec(tag)
  return matched === null ? '' : matched[1]
}

/**
 * 正文图片扫描。
 *
 * 三段各扫一遍、按位置合并；`<figure>` 段里已经算过的 `<img>` 不再单独计一次 ——
 * 同一张图在正文里只应被替换一次。
 */
function locateContentImages(html: string): ContentImage[] {
  const found: ContentImage[] = []
  const taken: Array<[number, number]> = []

  const overlaps = (start: number, end: number): boolean =>
    taken.some(([from, to]) => start < to && end > from)

  FIGURE_BLOCK.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = FIGURE_BLOCK.exec(html)) !== null) {
    const start = block.index
    const end = start + block[0].length
    const src = imageSource(block[0])
    if (src === '') continue
    found.push({ start, end, src, figure: true })
    taken.push([start, end])
  }

  IMG_TAG.lastIndex = 0
  let tag: RegExpExecArray | null
  while ((tag = IMG_TAG.exec(html)) !== null) {
    const start = tag.index
    const end = start + tag[0].length
    if (overlaps(start, end)) continue
    const src = imageSource(tag[0])
    if (src === '') continue
    found.push({ start, end, src, figure: false })
  }

  let cursor = 0
  for (const ref of parseMarkdownImages(html)) {
    const start = html.indexOf(ref.full, cursor)
    if (start === -1) continue
    cursor = start + ref.full.length
    if (overlaps(start, cursor)) continue
    found.push({ start, end: cursor, src: ref.src, figure: false })
  }

  return found.sort((a, b) => a.start - b.start)
}

/** 按位置把替换写回正文：从后往前拼，先出现者胜 */
function spliceByPosition(html: string, edits: ContentEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start)
  const kept: ContentEdit[] = []
  let consumed = 0
  for (const edit of ordered) {
    if (edit.start < consumed) continue
    kept.push(edit)
    consumed = edit.end
  }

  let tail = html.length
  let assembled = ''
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const edit = kept[i]
    assembled = edit.text + html.slice(edit.end, tail) + assembled
    tail = edit.start
  }
  return html.slice(0, tail) + assembled
}

export class WeiboAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'weibo',
    name: '微博',
    icon: 'https://weibo.com/favicon.ico',
    homepage: 'https://card.weibo.com/article/v5/editor',
    capabilities: CAPABILITIES,
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html' as const,
  }

  /**
   * 本平台要用到的请求头规则。注册动作由基类的成对设施完成，这里只把规则本身挂到实例上
   * —— 静态契约测试与运行时的排障面板都按实例属性读它。
   */
  readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = HEADER_RULES

  /** 登录期间取到的用户信息；发布路径直接复用，不重复请求编辑器页 */
  private user: WeiboUser | null = null

  // ───────────────────────── 登录态 ─────────────────────────

  /**
   * 登录态探测：走基类模板（注入两条规则 → GET 编辑器页 → 解析内联配置）。
   * 运行时尚未注入时，基类会在请求处抛错并被它自己的 catch 收敛成 `{isAuthenticated:false}`。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.checkAuthWithRules(
      EDITOR_URL,
      (payload) => {
        const config = this.parseEditorConfig(String(payload))
        if (config === null || !config.uid) return null
        this.user = {
          uid: String(config.uid),
          nick: config.nick,
          avatar: config.avatar_large,
        }
        return {
          userId: this.user.uid,
          username: this.user.nick,
          avatar: this.user.avatar,
        }
      },
      { headerRules: HEADER_RULES },
    )
  }

  // ───────────────────────── 发布 ─────────────────────────

  /**
   * 存草稿。整个过程包在 `withHeaderRules` 里 —— 卡片站与图床站的请求都要带来源头。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(HEADER_RULES, async () => {
        const user = await this.ensureUser()

        const content = await this.streamContentImages(this.compact(article.html || ''), {
          onProgress: options?.onImageProgress,
        })

        const created = await this.createDraft(user.uid)
        if (created.code !== CREATE_CODE || !created.data?.id) {
          throw new Error(replyMessage(created) ?? '草稿创建未成功')
        }
        // 草稿 id 原样透传（数字就还是数字）：判据按原值比对，规整成字符串会被判成行为差异
        const draftId = created.data.id

        const cover = await this.uploadCover(article.cover)

        const saved = await this.saveDraft(user.uid, draftId, article.title, content, cover)
        if (String(saved.code) !== String(CREATE_CODE)) {
          throw new Error(replyMessage(saved) ?? `正文保存未成功（错误码 ${String(saved.code)}）`)
        }

        return this.createResult(true, {
          postId: draftId as unknown as string,
          postUrl: `${CARD_ROOT}/article/v5/editor#/draft/${draftId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      logger.error(`微博存草稿失败：${describeError(error)}`)
      return this.createResult(false, { error: describeError(error) })
    }
  }

  // ───────────────────────── 图片 ─────────────────────────

  /**
   * 按地址转存一张图片。
   *
   * `data:` 开头的直接走图床直传；其余交给微博的转存服务。两条分支的判失败方式不同 ——
   * 转存那条会把「提交转存」的异常吞掉继续轮询，是否成功由轮询结果说了算。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (src.startsWith('data:')) return this.uploadDataUri(src)

    const user = await this.ensureUser()
    const uid = user.uid

    const rid = this.makeRid()
    const submitUrl = `${CARD_ROOT}/article/v5/aj/editor/plugins/asyncuploadimg?uid=${uid}&_rid=${rid}`
    try {
      const response = await this.runtime.fetch(submitUrl, {
        method: 'POST',
        credentials: 'include',
        headers: this.draftHeaders(rid),
        body: new URLSearchParams({ 'urls[0]': src }),
      })
      await response.json()
    } catch (error) {
      logger.warn(`图片转存提交未成功，继续查询任务结果：${describeError(error)}`)
    }

    const pid = await this.queryTransfer(uid, src)
    return { url: `${IMAGE_HOST}/${pid}.jpg`, attrs: { 'data-pid': pid } }
  }

  /**
   * 把一段 base64 图片数据直传图床。
   * 对外可见：调用方手上只有 base64 正文（没有文件名）时用它。
   */
  async uploadImageBase64(imageData: string, mimeType: string): Promise<ImageUploadResult> {
    return this.uploadDataUri(`data:${mimeType};base64,${imageData}`)
  }

  // ───────────────────────── 草稿两步 ─────────────────────────

  /** 第一步：开一篇空草稿，拿到 id */
  private async createDraft(uid: string): Promise<WeiboReply> {
    const rid = this.makeRid()
    const url = `${CARD_ROOT}/article/v5/aj/editor/draft/create?uid=${uid}&_rid=${rid}`
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: this.draftHeaders(rid),
      body: new URLSearchParams({}),
    })
    return (await response.json()) as WeiboReply
  }

  /** 第二步：把标题、正文与封面写进草稿（`status='0'` 即「仍然是草稿」） */
  private async saveDraft(
    uid: string,
    draftId: string | number,
    title: string,
    content: string,
    cover: string,
  ): Promise<WeiboReply> {
    const rid = this.makeRid()
    const url = `${CARD_ROOT}/article/v5/aj/editor/draft/save?uid=${uid}&id=${draftId}&_rid=${rid}`
    const form = new URLSearchParams({
      // 表单取值一律是字符串（`URLSearchParams` 对数字也做同样转换），只有 `postId` 保留平台原值
      id: String(draftId),
      title,
      subtitle: '',
      type: '',
      status: '0',
      publish_at: '',
      error_msg: '',
      error_code: '0',
      collection: '[]',
      free_content: '',
      content,
      cover,
      summary: '',
      writer: '',
      extra: 'null',
      is_word: '0',
      article_recommend: '[]',
      follow_to_read: '1',
      isreward: '1',
      pay_setting: '{"ispay":0,"isvclub":0}',
      source: '0',
      action: '1',
      content_type: '0',
      save: '1',
    })
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: this.draftHeaders(rid),
      body: form,
    })
    return (await response.json()) as WeiboReply
  }

  // ───────────────────────── 内部：用户信息 ─────────────────────────

  /** 缓存优先；没缓存就自己去编辑器页取（发布路径不依赖 `checkAuth` 先被调用） */
  private async ensureUser(): Promise<WeiboUser> {
    if (this.user !== null) return this.user

    let user: WeiboUser | null = null
    try {
      user = await this.getUserConfig()
    } catch (error) {
      // 页面在网络层就取不到：失败归失败，但原因照实上报，别盖成「没登录」
      logger.warn(`发布前读取微博编辑器页失败：${describeError(error)}`)
      throw error
    }
    if (user === null || !user.uid) throw new Error('请先登录微博')
    return user
  }

  /**
   * 读编辑器页并解析出当前用户。
   *
   * **页面取不到（网络层异常）时向上抛**；页面拿到了、但里面没有可用的用户配置时返回
   * `null` —— 调用方据此区分「请求失败」与「没登录」这两种不同的失败原因。
   */
  private async getUserConfig(): Promise<WeiboUser | null> {
    if (this.user !== null) return this.user

    const response = await this.runtime.fetch(EDITOR_URL, { credentials: 'include' })
    const html = await response.text()
    const config = this.parseEditorConfig(html)
    if (config === null || !config.uid) return null

    this.user = {
      uid: String(config.uid),
      nick: config.nick,
      avatar: config.avatar_large,
    }
    return this.user
  }

  /**
   * 从编辑器页的 HTML 里读内联用户配置。
   *
   * 页面把它写成 `config: JSON.parse('…')`：先取单引号里的那段串，再做两次反转义
   * （`\'` → `'`、`\\` → `\`），最后交给 `JSON.parse`。任一步不成 → `null`。
   */
  private parseEditorConfig(html: string): WeiboReplyData | null {
    const matched = EMBEDDED_CONFIG.exec(html)
    if (matched === null) return null
    try {
      const literal = matched[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
      return JSON.parse(literal) as WeiboReplyData
    } catch (error) {
      logger.debug(`编辑器页内联配置不是合法 JSON：${describeError(error)}`)
      return null
    }
  }

  // ───────────────────────── 内部：正文图片 ─────────────────────────

  /** 去掉标签之间的空白，避免微博编辑器把缩进渲染成额外空行 */
  private compact(html: string): string {
    return html.replace(BETWEEN_TAGS, '><')
  }

  /**
   * 把正文里的图片逐张转存并替换。
   *
   * 与基类 `processImages` 的差别：已经是微博图床的图片跳过、`data:` 图片跳过（原样留），
   * 替换结果一律是「`<figure class="image">` 包一张带 `data-pid` 的图」（原文本来就是
   * `<figure>` 段落的，只换里面的 `<img>`、外壳保留）；单张失败只记日志、保留原文。
   */
  private async streamContentImages(
    content: string,
    options?: { onProgress?: (current: number, total: number) => void },
  ): Promise<string> {
    const images = locateContentImages(content)
    if (images.length === 0) return content

    const total = images.length
    const done = new Map<string, ImageUploadResult>()
    const edits: ContentEdit[] = []
    let handled = 0

    for (const image of images) {
      if (HOSTED_PATTERNS.some((pattern) => image.src.includes(pattern))) continue
      if (image.src.startsWith('data:')) continue

      handled += 1
      options?.onProgress?.(handled, total)

      let uploaded = done.get(image.src)
      if (uploaded === undefined) {
        try {
          uploaded = await this.uploadImageByUrl(image.src)
          done.set(image.src, uploaded)
        } catch (error) {
          logger.error(
            `${handled}/${total} 号图片转存失败，正文保留原地址：${describeError(error)}`,
          )
        }
      }

      if (uploaded !== undefined) {
        const pid = String(uploaded.attrs?.['data-pid'] ?? '')
        const tag = `<img src="${uploaded.url}" data-pid="${pid}" />`
        const text = image.figure
          ? content.slice(image.start, image.end).replace(IMG_TAG, tag)
          : `<figure class="image">${tag}</figure>`
        edits.push({ start: image.start, end: image.end, text })
      }

      await this.delay(IMAGE_GAP_MS)
    }

    logger.debug(`正文候选图片 ${total} 张，实际替换 ${edits.length} 处`)
    return spliceByPosition(content, edits)
  }

  /** 封面：转存失败不影响发布，退化成不带封面 */
  private async uploadCover(cover: string | undefined): Promise<string> {
    if (!cover) return ''
    try {
      const uploaded = await this.uploadImageByUrl(cover)
      return uploaded.url
    } catch (error) {
      logger.warn(`封面上传未成功，本次不带封面：${describeError(error)}`)
      return ''
    }
  }

  /** 轮询转存任务，拿到图床上的 pid */
  private async queryTransfer(uid: string, src: string): Promise<string> {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      const rid = this.makeRid()
      const url = `${CARD_ROOT}/article/v5/aj/editor/plugins/asyncimginfo?uid=${uid}&_rid=${rid}`
      const response = await this.runtime.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: this.draftHeaders(rid),
        body: new URLSearchParams({ 'urls[0]': src }),
      })
      const reply = (await response.json()) as { data?: WeiboTransferTask[] }
      const task = reply.data?.[0]

      if (task !== undefined && task.task_status_code === 1 && task.pid) return task.pid
      if (task !== undefined && task.task_status_code === 2) throw new Error('图片转存失败')

      await this.delay(POLL_INTERVAL_MS)
    }
    throw new Error('图片转存超时')
  }

  /** `data:` 图片：拆出类型与正文，转成 Blob 后直传图床 */
  private async uploadDataUri(src: string): Promise<ImageUploadResult> {
    const matched = DATA_URI.exec(src)
    if (matched === null) throw new Error('图片 data URI 格式不合法')

    const mime = matched[1]
    const decoded = atob(matched[2])
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i)

    // 直传不带来源头：图床这条通道靠 cookie 与 multipart 形状本身
    const url = `${PIC_UPLOAD_URL}?${PIC_UPLOAD_QUERY}&_rid=${this.makeRid()}`
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: new Blob([bytes], { type: mime }),
    })
    const reply = (await response.json()) as WeiboReply
    const pid = reply.data?.pics?.pic_1?.pid
    if (!pid) throw new Error(`图片直传未成功：${JSON.stringify(reply)}`)
    return { url: `${IMAGE_HOST}/${pid}.jpg`, attrs: { 'data-pid': pid } }
  }

  // ───────────────────────── 内部：请求标识 ─────────────────────────

  /**
   * 生成一个请求标识（查询串里的 `_rid` 与请求头 `SN-REQID` 用同一个值）。
   *
   * `uid&时间戳` 先做 URL-safe base64（`+`→`-`、`/`→`_`、去掉 `=`），不足 43 位时用
   * 字符集里的随机字符补齐，最后截到 43 位。每次请求都要新生成一个。
   */
  private makeRid(): string {
    const raw = `${this.user?.uid ?? String(undefined)}&${Date.now()}`
    const seed = toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    let rid = seed
    while (rid.length < RID_LENGTH) {
      rid += RID_CHARSET.charAt(Math.floor(Math.random() * RID_CHARSET.length))
    }
    return rid.slice(0, RID_LENGTH)
  }

  /** 卡片站接口统一的请求头；同一请求的查询串与 `SN-REQID` 共用一个标识 */
  private draftHeaders(rid: string): Record<string, string> {
    return {
      'Content-Type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/plain, */*',
      'SN-REQID': rid,
    }
  }
}
