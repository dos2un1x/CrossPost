/**
 * 豆瓣（douban）适配器
 *
 * 这个平台在正文链路上和其它平台都不一样：正文取 **Markdown**，再交给 Draft.js 转换器
 * 变成豆瓣编辑器认识的结构化文档；草稿保存走的是移动端 rexxar 的 dwarf 接口，
 * 请求体里的 `draft_props` 是**字符串**（内容对象的 JSON 文本），不是嵌套对象。
 *
 * 因此这里有三处必须成对出现的投影，少一处草稿就会缺图或缺正文：
 *   1. 正文里的图片地址被换成平台图床地址（`processImages` 的替换）；
 *   2. 同一份上传结果按**新地址**为键存进映射表，供 Draft.js 转换器补全图片实体；
 *   3. 从转换产物的 `entityMap` 里按顺序收集图片 id，写成草稿的 `image_ids`。
 *
 * 另外记住两个域名的分工：登录页与图片上传都在 `www.douban.com`，
 * 草稿保存却打在 `m.douban.com` —— 而请求头规则只覆盖 `www.`。
 */
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { DoubanImageData } from '../../../lib'
import { markdownToDraft } from '../../../lib'
import { createLogger } from '../../../lib/logger'
import type { RuntimeInterface } from '../../../runtime/interface'
import type { PlatformAdapter, PublishOptions } from '../../types'

const log = createLogger('douban')

/** 页面地址（登录态与上传凭证都从这两个页面里抠） */
const MINE_PAGE = 'https://www.douban.com/mine/'
const NOTE_CREATE_PAGE = 'https://www.douban.com/note/create'

/** 草稿保存接口：注意域是 m.，和上面两个页面不同源 */
const DRAFT_API = 'https://m.douban.com/rexxar/api/v2/dwarf/drafts'

/** 图片上传接口（走的是小组相册那条老通道，与草稿协议无关） */
const PHOTO_API = 'https://www.douban.com/j/group/topic/add_photo'

/** 正文续编入口；`draft_id` 指向刚建好的草稿 */
const DRAFT_EDITOR = 'https://www.douban.com/topic/create?subtype=note&draft_id='

/** 已是本站图床的地址不必重传 */
const HOSTED_IMAGE_PATTERNS = ['doubanio.com', 'douban.com']

/** 页面里取用户名的标题 */
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i
/** 个人主页链接里的数字 uid */
const PEOPLE_RE = /people\/(\d+)/i
/** 头像：只认 class 出现在 src 之前的那种写法（属性顺序敏感） */
const AVATAR_RE = /<img[^>]*class="[^"]*avatar[^"]*"[^>]*\ssrc="([^"]*)"/i
/** 新建日记页里的隐藏字段 */
const NOTE_ID_RE = /name=["']note_id["'][^>]*value=["']([^"']*)["']/i
const CSRF_FIELD_RE = /name=["']ck["'][^>]*value=["']([^"']*)["']/i
/** 新建日记页初始化状态里的上传凭证，形如 uid:token */
const UPLOAD_TOKEN_RE = /upload_auth_token['"]?\s*:\s*['"]([^'"]+)['"]/i

/** 图片上传回包 */
interface PhotoUploadResponse {
  r?: unknown
  err?: string
  msg?: string
  photo?: {
    id?: string
    url?: string
    src?: string
    thumb?: string
    width?: number
    height?: number
    file_name?: string
    file_size?: number
  }
}

/** 草稿保存回包 */
interface DraftCreateResponse {
  code?: unknown
  msg?: string
  id?: unknown
  data?: { id?: unknown }
}

/** Draft.js 文档：只关心图片实体表 */
interface DraftDocument {
  entityMap?: Record<string, { type?: string; data?: { id?: unknown } }>
}

/**
 * 把回包里的草稿 id 取出来：顶层 `id` 优先，其次 `data.id`（两种回包形态都存在过）。
 * 取不到返回空串。
 */
function pickDraftId(payload: DraftCreateResponse): string {
  const raw = payload.id ?? payload.data?.id
  return raw === undefined || raw === null ? '' : String(raw)
}

/** 按顺序收集 Draft.js 文档里所有图片实体的平台图片 id；取不到 id 的实体不算数 */
function collectImageIds(document: unknown): string[] {
  let draft: DraftDocument = {}
  if (typeof document === 'string') {
    try {
      draft = JSON.parse(document) as DraftDocument
    } catch {
      return []
    }
  } else if (document && typeof document === 'object') {
    draft = document as DraftDocument
  }

  const ids: string[] = []
  for (const entity of Object.values(draft.entityMap ?? {})) {
    if (entity?.type !== 'IMAGE') continue
    const raw = entity.data?.id
    if (raw === undefined || raw === null || raw === '') continue
    ids.push(String(raw))
  }
  return ids
}

/**
 * 按候选域依次读 cookie。
 *
 * `getCookie` 在运行时接口里是可选能力，纯 Node 运行时没有它 —— 用可选链取，
 * 结果是 `undefined`，交给调用方按「缺 cookie」处理。
 */
async function readCookie(
  runtime: RuntimeInterface,
  domainCandidates: string[],
  name: string,
): Promise<string> {
  for (const domain of domainCandidates) {
    const value = await runtime.getCookie?.(domain, name)
    if (value) return value
  }
  return ''
}

export class DoubanAdapter extends CodeAdapter implements PlatformAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban',
    name: '豆瓣',
    icon: 'https://www.douban.com/favicon.ico',
    homepage: 'https://www.douban.com/note/create',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.douban.com/*',
      headers: {
        Origin: 'https://www.douban.com',
        Referer: 'https://www.douban.com',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 登录态缓存：发布与图片上传都要用 */
  private auth: AuthResult | null = null
  /** 图片上传需要的页面凭证（`uid:token`），从新建日记页里抠出来 */
  private uploadAuthToken = ''
  /** 新建日记页里的隐藏字段；当前发布链路不再使用，仅按基线提取 */
  private noteId = ''
  private legacyCk = ''

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(MINE_PAGE, {
        method: 'GET',
        credentials: 'include',
      })
      const page = await response.text()

      const username = TITLE_RE.exec(page)?.[1]?.trim() ?? ''
      const userId = PEOPLE_RE.exec(page)?.[1] ?? ''
      if (!username || !userId) {
        log.debug('个人主页缺少用户名或 uid，判定为未登录')
        return { isAuthenticated: false }
      }

      const avatar = AVATAR_RE.exec(page)?.[1] ?? ''
      const result: AuthResult = { isAuthenticated: true, userId, username, avatar }
      this.auth = result

      // 上传凭证在另一个页面上，取不到不影响登录判定
      await this.loadUploadCredentials()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`登录态检查失败：${message}`)
      return { isAuthenticated: false, error: message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const draftOnly = options?.draftOnly ?? true
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        // 这一步不看返回值：它的副作用（登录信息 + 上传凭证）才是后续要用的东西
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('豆瓣未登录，请先在浏览器里登录后再发布')
        }

        const imageData = new Map<string, DoubanImageData>()
        const markdown = article.markdown || ''
        const replaced = await this.processImages(
          markdown,
          async (src) => {
            const { url, data } = await this.uploadPhoto(src)
            // 转换器按**新地址**查这份数据；正文里也已经是新地址
            imageData.set(url, data)
            return { url }
          },
          { skipPatterns: HOSTED_IMAGE_PATTERNS, onProgress: options?.onImageProgress },
        )

        const document = markdownToDraft(replaced, imageData)
        const draftProps = {
          title: article.title,
          // 转换器给的是 JSON 文本；草稿里要放**对象**（随后整体再被序列化进 draft_props）
          content: typeof document === 'string' ? (JSON.parse(document) as unknown) : document,
          image_ids: collectImageIds(document),
          topic_tag_ids: [] as string[],
          subtype: 'note',
        }

        const ck = await readCookie(this.runtime, ['www.douban.com', 'douban.com'], 'ck')
        if (!ck) {
          throw new Error('没有取到豆瓣登录 cookie（ck），无法保存草稿')
        }

        const response = await this.runtime.fetch(DRAFT_API, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'X-CSRF-TOKEN': ck,
            Accept: 'application/json, text/plain, */*',
          },
          body: JSON.stringify({ draft_props: JSON.stringify(draftProps) }),
        })
        const payload = (await response.json()) as DraftCreateResponse

        // 这套接口的失败回包**省略** code，所以「没有 code」才是成功
        if (payload.code !== undefined && payload.code !== 0) {
          throw new Error(payload.msg ?? `豆瓣草稿保存失败（code=${String(payload.code)}）`)
        }

        const draftId = pickDraftId(payload)
        if (!draftId) {
          throw new Error('豆瓣没有返回草稿 id')
        }

        log.debug(`草稿已保存：${draftId}`)
        return this.createResult(true, {
          postId: draftId,
          postUrl: `${DRAFT_EDITOR}${draftId}`,
          draftOnly,
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`发布失败：${message}`)
      return this.createResult(false, { error: message })
    }
  }

  /**
   * 这个平台没有「按地址转存」这条独立入口：图片上传只在 `publish` 内部发生，
   * 而且需要同时交出正文地址与完整图片数据两份投影（见 `uploadPhoto`）。
   * 因此这里只保留调用面，直接拒绝，避免出现一条半成品的外部上传路径。
   */
  override async uploadImageByUrl(_src: string): Promise<ImageUploadResult> {
    throw new Error('这个平台没有实现按地址转存图片')
  }

  /**
   * 图片转存的主流程：下载原图 → 打小组相册接口 → 返回正文用的地址**与**
   * 供 Draft.js 图片实体使用的完整数据（两者是同一次上传的两个投影）。
   */
  private async uploadPhoto(src: string): Promise<{ url: string; data: DoubanImageData }> {
    if (!this.uploadAuthToken) {
      // 图片路径可能没经过 checkAuth，自己补一次
      await this.checkAuth()
      if (!this.uploadAuthToken) {
        throw new Error('缺少豆瓣图片上传凭证，请重新登录后再试')
      }
    }

    const ck = await readCookie(this.runtime, ['www.douban.com', 'douban.com'], 'ck')
    if (!ck) {
      throw new Error('没有取到豆瓣登录 cookie（ck），无法上传图片')
    }

    const download = await fetch(src)
    if (!download.ok) {
      throw new Error(`配图拉取失败：HTTP ${download.status}`)
    }
    const blob = await download.blob()

    const form = new FormData()
    form.append('ck', ck)
    form.append('image_file', new File([blob], 'image.jpg', { type: 'image/png' }), 'image.jpg')
    form.append('primary_color', '')
    form.append('upload_auth_token', this.uploadAuthToken)

    const response = await this.runtime.fetch(PHOTO_API, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const payload = (await response.json()) as PhotoUploadResponse

    // 这里的判据要用严格比较：字符串 '0' 不算成功
    if (payload.r !== 0) {
      throw new Error(payload.err ?? payload.msg ?? '豆瓣图片上传接口返回失败')
    }

    const photo = payload.photo
    if (!photo?.url) {
      throw new Error('豆瓣图片上传回包缺少图片地址')
    }

    const url = photo.url
    return {
      url,
      data: {
        id: String(photo.id ?? ''),
        url,
        thumb: photo.thumb || url,
        width: photo.width,
        height: photo.height,
        file_name: photo.file_name,
        file_size: photo.file_size,
      },
    }
  }

  /** 从新建日记页抠出上传凭证与两个隐藏字段；任何一步失败都只记日志 */
  private async loadUploadCredentials(): Promise<void> {
    try {
      const response = await this.runtime.fetch(NOTE_CREATE_PAGE, {
        method: 'GET',
        credentials: 'include',
      })
      const page = await response.text()

      this.noteId = NOTE_ID_RE.exec(page)?.[1] ?? ''
      this.legacyCk = CSRF_FIELD_RE.exec(page)?.[1] ?? ''
      this.uploadAuthToken = UPLOAD_TOKEN_RE.exec(page)?.[1] ?? ''

      if (!this.uploadAuthToken) {
        log.debug('新建日记页里没有 upload_auth_token，图片上传会缺凭证')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`读取上传凭证页失败，图片上传可能不可用：${message}`)
    }
  }
}
