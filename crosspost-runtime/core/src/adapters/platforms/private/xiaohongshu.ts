/**
 * 小红书（创作服务平台）适配器
 *
 * 这个平台**没有草稿 HTTP 接口**：长文草稿要落到创作者页面的 IndexedDB
 * （`draft-database-v1` / `article-draft`），而 IndexedDB 是 per-origin 存储，
 * 因此保存动作只能发生在已经打开创作者域的标签页里，经 `runtime.pageOp`
 * 把正文投递进去。适配器因此只做三件事：
 *
 *   1. 判定登录态并记住 `userId`（草稿对象的 `uid` 字段要用它）；
 *   2. 把 Markdown 正文转成编辑器接受的 ProseMirror JSON（顺带把图片传上去）；
 *   3. 找一个创作者域的标签页，调用两个页面操作把草稿写进去。
 *
 * 编辑器 schema 很窄：只接受纯段落 + 图片，别的块级结构与行内样式一律降级，
 * 细节见 lib/markdown-to-prosemirror.ts。
 */
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../../types'
import type { PublishOptions } from '../../types'
import {
  markdownToProseMirror,
  type PMImageUploadResult,
} from '../../../lib/markdown-to-prosemirror'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Xiaohongshu')

/** 创作者平台首页（拿不到 userId 时，用它判断"当前标签页算不算创作者域"） */
const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'

/** 长文编辑器所在页面；既是复用标签页的匹配串，也是新标签页的落地地址 */
const EDITOR_URL = `${CREATOR_ORIGIN}/publish/publish?from=menu&target=article`

/** 图片预览兜底域：页面操作没回 `x-ros-preview-url` 时按这个规则拼 */
const PREVIEW_HOST = 'https://ros-preview.xhscdn.com'

/** 长文正文的纯文字上限 */
const MAX_PLAIN_TEXT = 10_000

/** 超出上限时抛的错误；类型化是为了让调用方能按类别识别，而不必认文案 */
class XhsTextTooLongError extends Error {
  constructor(readonly plainTextLength: number) {
    super(`小红书长文只支持 ${MAX_PLAIN_TEXT} 字以内的纯文字，当前正文约 ${plainTextLength} 字`)
    this.name = 'XhsTextTooLongError'
  }
}

/** 保存草稿的结果：由页面侧 IndexedDB 写入实现 */
interface XhsDraftAck {
  success: boolean
  error?: string
}

/** 图片上传结果：`previewUrl` 是展示地址，`fileId` 是编辑器要求的资源标识 */
interface XhsUploadAck extends XhsDraftAck {
  fileId?: string
  previewUrl?: string
}

/**
 * 页面通道需要的两条请求头规则。
 *
 * 为什么不做成实例字段 `HEADER_RULES`：小红书的规则依赖「本次调用是否真的
 * 打到了创作者域」，所以它在方法体内按需装载、并在收尾处显式卸载；放在实例
 * 字段上会让适配器在未被调用时也带着规则。
 */
const CREATOR_HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://creator.xiaohongshu.com/*',
    headers: {
      Origin: CREATOR_ORIGIN,
      Referer: EDITOR_URL,
    },
    resourceTypes: ['xmlhttprequest'],
  },
  {
    urlFilter: '*://ros-upload.xiaohongshu.com/*',
    headers: {
      Origin: CREATOR_ORIGIN,
      Referer: `${CREATOR_ORIGIN}/`,
    },
    resourceTypes: ['xmlhttprequest'],
  },
]

/** `data:` URI 的拆分形态 */
const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * 把 HTML 与 Markdown 里"看得见的字"数出来。
 *
 * 输入可能来自 `article.markdown`（正常链路），也可能被上游塞了 HTML；
 * 两种形态都要能算，所以先按有没有标签分流，最后统一折叠空白。
 */
function countPlainText(input: string): number {
  if (!input) return 0

  let text: string
  if (/<[^>]+>/.test(input)) {
    text = input
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
  } else {
    text = input
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
  }

  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim().length
}

/** 按 UUID v4 形状生成草稿主键：IndexedDB 以它为主键，写同一个 id 即覆盖 */
function newDraftId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const n = Math.floor(Math.random() * 16)
    const v = ch === 'x' ? n : (n & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 把任意形态的图片输入变成可上传的字节与 MIME */
async function readImageBytes(src: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (src.startsWith('data:')) {
    const parts = DATA_URI_RE.exec(src)
    if (!parts) throw new Error('图片 data URI 格式不正确，无法解析出字节')
    const raw = atob(parts[2])
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return { bytes, mime: parts[1] }
  }

  const res = await fetch(src)
  const blob = await res.blob()
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/jpeg' }
}

/**
 * 取图片宽高。Node 或裁剪过的运行时没有 `createImageBitmap`，这时宽高退化为 0
 * ——只是预览比例不好看，草稿本身仍能写入，所以这里只告警不抛。
 */
async function measureImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') {
    logger.warn('当前运行时没有 createImageBitmap，图片宽高按 0 记录')
    return { width: 0, height: 0 }
  }
  try {
    // Uint8Array 与 BlobPart 的类型声明在部分 TS 版本下不兼容，运行时是合法输入
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch (error) {
    logger.warn('图片尺寸解析失败，按 0 记录：', error)
    return { width: 0, height: 0 }
  }
}

/** 字节转 base64（逐块拼接，避免超长参数把调用栈撑爆） */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export class XiaohongshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xiaohongshu',
    name: '小红书',
    icon: 'https://www.xiaohongshu.com/favicon.ico',
    homepage: 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=article',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 登录态缓存：草稿对象的 `uid` 字段必须带上它，所以在 checkAuth 时留一份 */
  private cachedUserId: string | null = null

  /** 本次调用自己开的标签页（复用用户标签页时为 undefined） */
  private openedTabId: number | undefined

  async checkAuth(): Promise<AuthResult> {
    await this.setupHeaderRules()
    try {
      const res = await this.runtime.fetch(`${CREATOR_ORIGIN}/api/galaxy/user/info`, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      const payload = (await res.json()) as {
        success?: boolean
        data?: { userId?: string; userName?: string; userAvatar?: string }
      }

      if (!payload?.success || !payload.data) {
        this.cachedUserId = null
        return { isAuthenticated: false, error: '小红书创作者中心未返回登录信息' }
      }

      const id = payload.data.userId ?? null
      this.cachedUserId = id
      return {
        isAuthenticated: true,
        userId: id ?? undefined,
        username: payload.data.userName,
        avatar: payload.data.userAvatar,
      }
    } catch (error) {
      this.cachedUserId = null
      return { isAuthenticated: false, error: (error as Error).message }
    } finally {
      await this.clearHeaderRules()
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      // 规则先挂上：后续任何失败路径都由收尾处的 clearHeaderRules 统一卸载
      await this.setupHeaderRules()

      if (!this.runtime.pageOp) {
        throw new Error('小红书草稿要写进页面 IndexedDB，需要浏览器扩展的页面通道支持')
      }

      // 草稿正文来自 Markdown（编辑器的 schema 不接受 HTML 结构），字数按纯文字算
      const markdown = article.markdown || ''
      const wordCount = this.getPlainTextLength(markdown)
      if (wordCount > MAX_PLAIN_TEXT) throw new XhsTextTooLongError(wordCount)

      const tabId = await this.ensureXHSTab()
      const richJson = await this.markdownToRichJson(
        markdown,
        async (src) => {
          const uploaded = await this.uploadImageByUrl(src)
          const attrs = uploaded.attrs || {}
          return {
            url: uploaded.url,
            width: Number(attrs.width) || 0,
            height: Number(attrs.height) || 0,
            fileId: attrs.fileId === undefined ? undefined : String(attrs.fileId),
          }
        },
        options?.onImageProgress,
      )

      // 草稿主键紧接正文确定
      const draftId = this.generateUUID()

      // 草稿对象的 uid 字段：有缓存用缓存，没有就先探一次登录态。
      // 注意只有「探测明确说未登录」才算失败：平台可能给出 userId 缺失但仍算已登录的会话，
      // 这时草稿照写（uid 以缓存/探测结果为准，缺失就传 null）。
      let uid = this.cachedUserId
      if (!uid) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('未登录小红书创作服务平台，请先在浏览器里登录后重试')
        }
        uid = auth.userId ?? this.cachedUserId
      }

      const ack = await this.runtime.pageOp<XhsDraftAck>(tabId, 'xhsSaveDraft', [
        draftId,
        article.title,
        richJson,
        uid,
        wordCount,
      ])
      if (!ack?.success) {
        throw new Error(ack?.error || '页面通道没能把草稿写进草稿箱')
      }

      logger.info(`草稿已写入本地草稿库: ${draftId}（${wordCount} 字）`)
      return this.createResult(true, {
        postId: draftId,
        postUrl: EDITOR_URL,
        draftOnly: true,
        message: '草稿已存入小红书「草稿箱 → 长文笔记」，请到创作服务平台确认',
      })
    } catch (error) {
      logger.error('保存小红书草稿失败：', error)
      return this.createResult(false, { error: (error as Error).message })
    } finally {
      await this.clearHeaderRules()
      await this.releaseTab()
    }
  }

  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.pageOp) {
      throw new Error('小红书图片要先上传到创作者图床，需要浏览器扩展的页面通道支持')
    }
    if (!this.runtime.tabs) {
      throw new Error('小红书图片上传需要浏览器标签页支持，才能拿到页面签名')
    }

    // 图片也走页面通道（页面签名函数只在创作者域的页面里存在），所以先要一个创作者标签页
    const tabId = await this.ensureXHSTab()
    const { bytes, mime } = await readImageBytes(src)
    const { width, height } = await measureImage(bytes, mime)

    const ack = await this.runtime.pageOp<XhsUploadAck>(tabId, 'xhsUploadPermit', [
      bytesToBase64(bytes),
      mime,
    ])
    if (!ack?.success || !ack.fileId) {
      throw new Error(ack?.error || '图片上传没有拿到资源标识')
    }

    // 宽高交给编辑器排版用；页面操作回的是 CDN 预览地址，缺失时按规则拼一个
    return {
      url: ack.previewUrl || `${PREVIEW_HOST}/${ack.fileId}`,
      attrs: { fileId: ack.fileId, width, height },
    }
  }

  /** 装载页面通道要用的请求头规则；收尾处由 publish 统一清除 */
  private async setupHeaderRules(): Promise<void> {
    await this.addHeaderRules(CREATOR_HEADER_RULES)
  }

  /** 纯文字字数（小红书按"看得见的字"限流，不含 HTML 长度与空白） */
  private getPlainTextLength(content: string): number {
    return countPlainText(content)
  }

  /** 生成草稿主键（UUID v4 形状） */
  private generateUUID(): string {
    return newDraftId()
  }

  /** 正文 → 编辑器 schema 的 ProseMirror JSON；图片在这一步顺带上传 */
  private async markdownToRichJson(
    markdown: string,
    uploadImage: (src: string) => Promise<PMImageUploadResult>,
    onImageProgress?: (current: number, total: number) => void,
  ): Promise<Record<string, unknown>> {
    return markdownToProseMirror(markdown, { uploadImage, onImageProgress })
  }

  /**
   * 拿到一个创作者域的标签页。
   *
   * IndexedDB 是 per-origin 的，`pageOp` 必须落在 `creator.xiaohongshu.com`
   * 的页面里才能碰到草稿库；用户自己已经开着这个域时就复用它（发布后不关，
   * 那是用户的标签页），否则新开一个并在收尾时关掉。
   */
  private async ensureXHSTab(): Promise<number> {
    if (!this.runtime.pageOp) {
      throw new Error('小红书草稿要写进页面 IndexedDB，需要浏览器扩展的页面通道支持')
    }
    if (!this.runtime.tabs) {
      throw new Error('小红书发布需要浏览器标签页支持，才能写入页面草稿库')
    }

    const existing = await this.runtime.tabs.query('https://creator.xiaohongshu.com/*')
    if (existing.length > 0) {
      logger.debug('复用已打开的创作者平台标签页:', existing[0].id)
      this.openedTabId = undefined
      return existing[0].id
    }

    const tab = await this.runtime.tabs.create(EDITOR_URL, false)
    await this.runtime.tabs.waitForLoad(tab.id, 30_000)
    logger.debug('已打开创作者平台发布页:', tab.id)
    this.openedTabId = tab.id
    return tab.id
  }

  /** 关掉本次自建的标签页；关闭失败不影响草稿结果 */
  private async releaseTab(): Promise<void> {
    const tabId = this.openedTabId
    this.openedTabId = undefined
    if (tabId === undefined || !this.runtime.tabs) return
    try {
      await this.runtime.tabs.close(tabId)
    } catch (error) {
      logger.warn('关闭创作者平台标签页失败（草稿已写入，忽略）：', error)
    }
  }
}
