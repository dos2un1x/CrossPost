/**
 * 简书（jianshu）适配器
 *
 * 简书没有"一次请求写完草稿"的接口，落草稿要两步：
 *   1. `POST /author/notes` 建一条空笔记，拿到笔记 id；
 *   2. `PUT /author/notes/<id>` 带 `autosave_control:1` 把正文自动存进去。
 * 两步都只产生"编辑中"的笔记，全程不碰任何发布接口。
 *
 * 另一个平台特性：账号在简书侧可能使用 Markdown 编辑器，也可能使用富文本编辑器。
 * 前者要把 Markdown 源码当正文提交，后者要提交 HTML；用哪种由 `settings/basic.json`
 * 的 `preferred_note_type` 决定，所以发布前必须先探一次登录态。
 *
 * 正文图片走简书签发的七牛上传凭证直传第三方图床；图床失败时静默退回原图地址，
 * 不阻断草稿保存。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const log = createLogger('JianshuAdapter')

/** 简书的接口全部同域，靠 cookie 鉴权 */
const SITE_ORIGIN = 'https://www.jianshu.com'
const WRITER_ENTRY = `${SITE_ORIGIN}/writer`
const ACCOUNT_INFO_API = `${SITE_ORIGIN}/settings/basic.json`
const NOTEBOOK_LIST_API = `${SITE_ORIGIN}/author/notebooks`
const NOTE_COLLECTION_API = `${SITE_ORIGIN}/author/notes`
const IMAGE_TICKET_API = `${SITE_ORIGIN}/upload_images/token.json`
/** 图片最终落在七牛（第三方域），这一跳不带站点 cookie */
const QINIU_UPLOAD_API = 'https://upload.qiniup.com/'

/** 读接口统一要求的 Accept；写接口在此基础上由基类补 Content-Type */
const JSON_ACCEPT: Record<string, string> = { Accept: 'application/json' }
/** URL 末段只要长成图片文件名就沿用它，省得每次造随机名 */
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|gif|webp|bmp|svg)$/i
/** 已经躺在简书自家图床上的图片不必再传一遍 */
const IMAGE_SKIP_PATTERNS = ['jianshu.com', 'jianshuapi.com', 'upload-images.jianshu.io']

/** `settings/basic.json` 里本适配器关心的字段 */
interface AccountInfo {
  nickname?: string
  avatar?: string
  preferred_note_type?: string
}

interface NotebookBrief {
  id?: string | number
}

interface NoteReceipt {
  id?: string | number
}

/** 七牛上传工单：token 是签名，key 是目标对象名 */
interface UploadTicket {
  token?: string
  key?: string
}

/** 简书账号的编辑器口味：markdown 交源码，plain 交富文本 */
type EditorFlavor = 'markdown' | 'plain'

export class JianshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianshu',
    name: '简书',
    icon: 'https://www.jianshu.com/favicon.ico',
    homepage: 'https://www.jianshu.com',
    capabilities: ['article', 'draft', 'image_upload', 'categories'],
  }

  /**
   * 虽然编辑器口味可能是 markdown，预处理仍按 html 声明：
   * 该字段只决定引擎是否对 `article.html` 跑 preprocessHtml，两种口味都要那份 HTML 备用。
   */
  readonly preprocessConfig: Partial<PreprocessConfig> = { outputFormat: 'html' }

  /** 写接口是 XHR 同源调用，带上 Origin/Referer 更贴近页面内行为 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.jianshu.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: WRITER_ENTRY,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 最近一次 checkAuth 探到的编辑器口味；默认按富文本处理 */
  private editorFlavor: EditorFlavor = 'plain'

  /** 命中过的默认文集 id，同一实例内复用，避免每篇都重查 */
  private cachedNotebookId: string | null = null

  // ============ 登录态 ============

  override async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(ACCOUNT_INFO_API, {
        method: 'GET',
        credentials: 'include',
      })
      const payload = (await response.json()) as { data?: AccountInfo }
      const account = payload?.data
      if (!account?.nickname) return { isAuthenticated: false }

      this.editorFlavor = account.preferred_note_type === 'markdown' ? 'markdown' : 'plain'
      return {
        isAuthenticated: true,
        username: account.nickname,
        avatar: account.avatar,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  // ============ 发布（只落草稿） ============

  override async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        // 编辑器口味只由登录接口判定，先刷新一次（失败也继续，交给后续步骤暴露问题）
        await this.checkAuth()

        const notebookId = await this.getDefaultNotebookId()
        const noteId = await this.createNote(notebookId, article.title)

        const source =
          this.editorFlavor === 'markdown' ? article.markdown || '' : article.html || ''
        const content = await this.processImages(source, (src) => this.uploadImageByUrl(src), {
          skipPatterns: IMAGE_SKIP_PATTERNS,
          onProgress: options?.onImageProgress,
        })

        await this.saveNote(noteId, article.title, content)

        return this.createResult(true, {
          postId: String(noteId),
          postUrl: `${SITE_ORIGIN}/writer#/notebooks/${notebookId}/notes/${noteId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  /** 建一条空笔记，返回它的 id */
  private async createNote(notebookId: string, title: string): Promise<string> {
    const receipt = await this.postJson<NoteReceipt>(
      NOTE_COLLECTION_API,
      { at_bottom: false, notebook_id: notebookId, title },
      JSON_ACCEPT,
    )
    if (!receipt?.id) throw new Error('草稿创建未成功')
    return String(receipt.id)
  }

  /** 把处理好的正文自动保存进笔记（autosave_control=1，不是发布） */
  private async saveNote(noteId: string, title: string, content: string): Promise<void> {
    const response = await this.runtime.fetch(`${NOTE_COLLECTION_API}/${noteId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        ...JSON_ACCEPT,
      },
      body: JSON.stringify({
        id: String(noteId),
        autosave_control: 1,
        title,
        content,
      }),
    })
    const receipt = (await response.json()) as NoteReceipt
    if (!receipt?.id) throw new Error('草稿更新未成功')
  }

  // ============ 文集 ============

  /** 账号下的文集列表（简书一次给全，不需要翻页） */
  private async getNotebooks(): Promise<NotebookBrief[]> {
    return this.fetchJson<NotebookBrief[]>(NOTEBOOK_LIST_API, JSON_ACCEPT)
  }

  /** 默认文集＝列表里的第一个；取到后记住，后续文章直接复用 */
  private async getDefaultNotebookId(): Promise<string> {
    if (this.cachedNotebookId) return this.cachedNotebookId

    const notebooks = await this.getNotebooks()
    if (!notebooks || notebooks.length === 0) throw new Error('未找到可用的文集')

    this.cachedNotebookId = String(notebooks[0].id)
    return this.cachedNotebookId
  }

  // ============ 图片 ============

  /**
   * 正文图片上传：下载原图 → 换七牛上传工单 → 直传七牛 → 取回图片地址。
   * 任一环节失败都不抛出，退回原地址（草稿里会出现外链图片），发布继续。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const download = await fetch(src)
      if (!download.ok) throw new Error('下载图片未成功')
      const blob = await download.blob()

      const fileName = this.buildImageName(src, blob.type)
      const ticket = await this.getUploadToken(fileName)

      const form = new FormData()
      form.append('token', String(ticket.token))
      form.append('key', String(ticket.key))
      form.append('file', blob, fileName)
      // 七牛要求显式声明回源协议，否则回包给的是 http 地址
      form.append('x:protocol', 'https')

      const reply = await fetch(QINIU_UPLOAD_API, { method: 'POST', body: form })
      const hosted = (await reply.json()) as { url?: string }
      if (!hosted?.url) throw new Error('图床未返回图片地址')

      return { url: hosted.url }
    } catch (error) {
      log.warn(`[jianshu] 上传图片未成功，保留原地址 ${src}:`, error)
      return { url: src }
    }
  }

  /** 向简书换一张七牛上传工单 */
  private async getUploadToken(fileName: string): Promise<UploadTicket> {
    return this.fetchJson<UploadTicket>(
      `${IMAGE_TICKET_API}?filename=${encodeURIComponent(fileName)}`,
      JSON_ACCEPT,
    )
  }

  /** 上传用的文件名：URL 末段像图片名就直接用，否则按 MIME 造一个带时间戳的名字 */
  private buildImageName(src: string, mimeType: string): string {
    if (!src.startsWith('data:')) {
      const tail = src.split('?')[0].split('#')[0].split('/').pop() || ''
      if (IMAGE_FILE_PATTERN.test(tail)) return tail
    }
    return `image_${Date.now()}.${this.extensionOf(mimeType)}`
  }

  /** `image/png` → `png`；jpeg 统一写成 jpg；MIME 缺失时用 jpg */
  private extensionOf(mimeType: string): string {
    const subtype = (mimeType || '').split('/')[1] || ''
    if (!subtype) return 'jpg'
    return subtype === 'jpeg' ? 'jpg' : subtype
  }

  // ============ 通用请求 ============

  /** 简书读接口的固定形态：同源 cookie + 指定 Accept，回包按 JSON 解 */
  private async fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const response = await this.runtime.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers,
    })
    return (await response.json()) as T
  }
}
