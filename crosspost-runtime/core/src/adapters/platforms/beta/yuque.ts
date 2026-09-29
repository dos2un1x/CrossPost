/**
 * 语雀（yuque）适配器
 *
 * 「只存草稿」的落法：先用 `status: 0` 新建一篇文档（不是发表），再把服务端转好的
 * lake 正文写回去。全流程不碰任何上线接口，返回的链接是编辑页。
 *
 * 两条必须保住的行为：
 * · 建文档必须早于图片转存 —— 附件接口要求 `attachable_id` 等于刚建出来的文档 id；
 * · 最后一次保存的回包**不做校验**：语雀侧保存失败时引擎仍会报成功，
 *   这是既有行为（真链路上的已知风险），不是漏写。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const log = createLogger('Yuque')

/** 语雀自己的图床域名：正文里已经是这些地址的图不必重传 */
const IMAGE_SKIP = ['yuque.com', 'cdn.nlark.com']

/** 正文里出现的请求入口 */
const ENDPOINT = {
  commonUsed: 'https://www.yuque.com/api/mine/common_used',
  docs: 'https://www.yuque.com/api/docs',
  convert: 'https://www.yuque.com/api/docs/convert',
  attach: 'https://www.yuque.com/api/upload/attach',
} as const

/** `checkAuth` 判定失败时给外界的解释 */
const NEED_LOGIN = '语雀登录凭据缺失或已失效，请先在浏览器里登录语雀'

/** 没建出文档就想传图（例如独立调用上传）时的报错 */
const NO_DOCUMENT = '语雀草稿 id 尚未就绪，无法把图片挂到文档上'

/** 「常用」列表里第一本书的作者，用来填 `AuthResult` */
interface YuqueAuthor {
  id: number
  name: string
  avatar_url: string
}

/** 「常用」列表里第一本书 */
interface YuqueBook {
  target_id: number
  user: YuqueAuthor
}

/** `GET /api/mine/common_used` 的回包 */
interface CommonUsedPayload {
  data?: { books?: YuqueBook[] }
}

/** 新建文档的回包 */
interface CreateDocPayload {
  data?: { id: number | string }
  message?: string
}

/** markdown → lake 转换的回包 */
interface ConvertPayload {
  data?: { content?: string }
}

/** 附件上传的回包 */
interface AttachPayload {
  data?: { url?: string }
}

/** 底层 fetch 抛错时，把任意异常折成可读文案 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class YuqueAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'yuque',
    name: '语雀',
    icon: 'https://gw.alipayobjects.com/zos/rmsportal/UTjFYEzMSYVwzxIGVhMu.png',
    homepage: 'https://www.yuque.com/dashboard',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
    // doPreFilter + processDocCode (旧版)
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
  }

  /** 已选定的「常用」知识库；`null` 表示这一轮还没探测过 */
  private book: YuqueBook | null = null

  /** 请求头里要带的 CSRF 令牌；`checkAuth` 探测失败时会把它清掉 */
  private csrf = ''

  /** 当前草稿 id：建文档成功后才被赋值，图片上传要用它 */
  private documentId: number | string | null = null

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.yuque.com/api/*',
      headers: {
        Origin: 'https://www.yuque.com',
        Referer: 'https://www.yuque.com/dashboard',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ───────────────────────── 登录态 ─────────────────────────

  /**
   * 取会话里的 CSRF 令牌：命中实例缓存就直接复用，否则读一次 cookie 并记住。
   *
   * 令牌会随会话刷新，所以**探测失败时由 `checkAuth` 把缓存清掉**，下一次重新读；
   * 探测成功则一直用到实例被换掉为止。实例不跨运行时复用（`init` 会重新注入）。
   *
   * `getCookie` 在纯代理模式下是可选的：能力缺失与「拿不到值」对外是同一件事
   * （都要用户去登录），所以两个分支抛同一句话，只有调用轨迹能区分。
   */
  private async readCsrfToken(): Promise<string> {
    if (this.csrf) return this.csrf
    const jar = this.runtime.getCookie
    if (!jar) throw new Error(NEED_LOGIN)
    const value = await jar.call(this.runtime, '.yuque.com', 'yuque_ctoken')
    if (!value) throw new Error(NEED_LOGIN)
    this.csrf = value
    return value
  }

  /** 拉「常用」列表：既是登录探测，也是知识库来源 */
  private async queryCommonBooks(token: string): Promise<CommonUsedPayload> {
    const response = await this.runtime.fetch(ENDPOINT.commonUsed, {
      method: 'GET',
      credentials: 'include',
      headers: { 'x-csrf-token': token },
    })
    return (await response.json()) as CommonUsedPayload
  }

  /** 记住要落草稿的那本书（恒取「常用」列表的第一项，不提供选择） */
  private rememberBook(books: YuqueBook[]): void {
    this.book = books[0]
  }

  /** 是否已经选定知识库与作者 */
  private get ready(): boolean {
    return this.book !== null
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const token = await this.readCsrfToken()
      const payload = await this.queryCommonBooks(token)
      const books = payload.data?.books
      if (!Array.isArray(books) || books.length === 0) {
        // 判定不成立等同没登录：令牌缓存一并作废，下次重新读
        this.csrf = ''
        log.debug('「常用」列表里没有可用的知识库，按未登录处理')
        return { isAuthenticated: false }
      }
      this.rememberBook(books)
      const author = books[0].user
      return {
        isAuthenticated: true,
        userId: String(author.id),
        username: author.name,
        avatar: author.avatar_url,
      }
    } catch (error) {
      // 探测失败说明这次拿到的令牌未必还能用，缓存作废，下次重新读
      this.csrf = ''
      log.debug('语雀登录态探测失败', error)
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /**
   * 保证「令牌 + 知识库」都就绪。
   *
   * 已经探测过登录时直接放行：`checkAuth` 成功时才记住令牌，两者要么都有、要么都没有，
   * 因此「已缓存知识库但没令牌」不是一个可达状态，不必重复读 cookie。
   * 没探测过才去取令牌；`checkAuth` 内部会复用这次取到的值。
   */
  private async ensureBookReady(): Promise<void> {
    if (this.ready) return
    await this.readCsrfToken()
    const auth = await this.checkAuth()
    if (!auth.isAuthenticated || !this.ready) throw new Error(NEED_LOGIN)
  }

  // ───────────────────────── 发布（只存草稿） ─────────────────────────

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () =>
        this.saveAsDraft(article, options),
      )
    } catch (error) {
      log.error('语雀草稿保存流程失败', error)
      return this.createResult(false, { error: reasonOf(error) })
    }
  }

  /** 规则作用域内的主流程：建文档 → 转存图片 → 服务端转 lake → 写正文 */
  private async saveAsDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    await this.ensureBookReady()

    const documentId = await this.createDocument(article.title)
    this.documentId = documentId
    log.debug(`语雀草稿已建出：${String(documentId)}`)

    const replaced = await this.processImages(
      article.markdown || '',
      (src) => this.uploadImageByUrl(src),
      {
        skipPatterns: IMAGE_SKIP,
        onProgress: options?.onImageProgress,
      },
    )
    const lake = await this.convertToLake(replaced)
    await this.writeContent(documentId, lake)

    return this.createResult(true, {
      postId: String(documentId),
      postUrl: `https://www.yuque.com/go/doc/${String(documentId)}/edit`,
      draftOnly: options?.draftOnly ?? true,
    })
  }

  /** `POST /api/docs`：建一篇未发布（`status: 0`）的文档，返回它的 id */
  private async createDocument(title: string): Promise<number | string> {
    const response = await this.runtime.fetch(ENDPOINT.docs, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': this.csrf },
      body: JSON.stringify({
        title,
        type: 'Doc',
        format: 'lake',
        book_id: this.book?.target_id,
        status: 0,
      }),
    })
    const payload = (await response.json()) as CreateDocPayload
    const id = payload.data?.id
    if (!id) throw new Error(payload.message || '语雀没有返回新建文档的 id')
    return id
  }

  /** `POST /api/docs/convert`：让语雀自己把 markdown 转成 lake */
  private async convertToLake(markdown: string): Promise<string> {
    const response = await this.runtime.fetch(ENDPOINT.convert, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': this.csrf },
      body: JSON.stringify({ from: 'markdown', to: 'lake', content: markdown }),
    })
    const payload = (await response.json()) as ConvertPayload
    const content = payload.data?.content
    if (!content) throw new Error('语雀没有把正文转换成 lake 格式')
    return content
  }

  /**
   * `PUT /api/docs/<id>/content`：写入正文。
   *
   * 回包**不看状态、不解析业务字段**，只留一条日志 —— 保存失败也要返回成功，
   * 这一条是与现行为对齐的硬要求。
   */
  private async writeContent(documentId: number | string, lake: string): Promise<void> {
    const body = `<div class="lake-content" typography="traditional">${lake}</div>`
    const response = await this.runtime.fetch(
      `https://www.yuque.com/api/docs/${String(documentId)}/content`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': this.csrf },
        body: JSON.stringify({
          format: 'lake',
          body_asl: lake,
          body,
          body_html: body,
          draft_version: 0,
          sync_dynamic_data: false,
          save_type: 'auto',
          edit_type: 'Lake',
        }),
      },
    )
    log.debug(`语雀保存回包状态 ${response.status}（按既有行为不校验）`)
  }

  // ───────────────────────── 图片转存 ─────────────────────────

  /** 按地址转存一张图：先下载成 Blob，再挂到当前草稿上 */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (this.documentId === null) throw new Error(NO_DOCUMENT)
    const blob = await this.downloadImage(src)
    const form = new FormData()
    // 直接收下载得到的 Blob：再包一层会丢掉 MIME，快照里 `type` 会变空串
    form.append('file', blob, 'image.jpg')
    const response = await this.runtime.fetch(
      `${ENDPOINT.attach}?attachable_type=Doc&attachable_id=${String(this.documentId)}&type=image`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': this.csrf },
        body: form,
      },
    )
    const payload = (await response.json()) as AttachPayload
    const url = payload.data?.url
    if (!url) throw new Error(`语雀附件接口没有返回图片地址：${src}`)
    return { url }
  }

  /**
   * 下载原图。
   *
   * 走**全局 `fetch`**（不经过请求头规则注入）：`Origin`/`Referer` 只对语雀自己的
   * 接口有意义，取外站图片时带上反而是噪声。非 2xx 直接抛错，由 `processImages`
   * 逐图吞掉并保留原地址。
   */
  private async downloadImage(src: string): Promise<Blob> {
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`原图下载未成功（HTTP ${response.status}）：${src}`)
    }
    return response.blob()
  }
}
