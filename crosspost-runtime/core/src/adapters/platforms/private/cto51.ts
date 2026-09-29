/**
 * 51CTO 博客（blog.51cto.com）适配器。
 *
 * 这个平台对外只留了一条写入通道：`POST /blogger/draft`。它每次都以空的
 * `pid` / `blog_id` 建一篇新稿，适配器不需要（也没有）任何"正式发表"的调用。
 *
 * 图片走的是三段式，而不是直接传给 51CTO：
 *   ① `getUploadSign` 换一个一次性签名；
 *   ② `getUploadConfig` 用签名换腾讯云 COS 的直传表单凭证；
 *   ③ 带着凭证把文件 POST 给 COS。
 * 回包里的 URL 字段一概不采信 —— 最终地址由 COS 的 `key` 与 51CTO 的图片域名拼出来。
 */

import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { ImageUploadResult } from '../../code-adapter'
import { CodeAdapter } from '../../code-adapter'

const SITE_ORIGIN = 'https://blog.51cto.com'
/** 发布页：既有作者区块（uid / 头像），也埋着 csrf 令牌 */
const PUBLISH_PAGE = `${SITE_ORIGIN}/blogger/publish`
/** 博客首页：唯一能拿到"真实用户名"的地方（发布页的头像标签没有 alt） */
const PROFILE_PAGE = `${SITE_ORIGIN}/blogger/index`
const DRAFT_API = `${SITE_ORIGIN}/blogger/draft`
const SIGN_API = `${SITE_ORIGIN}/getUploadSign`
const CONFIG_API = `${SITE_ORIGIN}/getUploadConfig`

/** 图片的对外域名；正文里引用的地址都由它与 COS 的 key 拼成 */
const IMAGE_ORIGIN = 'https://s2.51cto.com/'

const FORM_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8'
const DRAFT_ACCEPT = 'application/json, text/javascript, */*; q=0.01'

/** 发布页里的作者区块：`more user` 是页面自己的类名，链接指主页、图片是头像 */
const AUTHOR_BLOCK =
  /<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/i

/** 页面里预埋的 csrf 令牌 */
const CSRF_META = /<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"/i

/** 首页头像标签上的用户名；两种属性书写顺序在真实页面里都出现过 */
const ALT_AFTER_UID = /<img[^>]*data-uid="[^"]*"[^>]*alt="([^"]+)"/i
const ALT_BEFORE_UID = /<img[^>]*alt="([^"]+)"[^>]*data-uid="[^"]*"/i

/** 再退一步：文档标题形如「某某的博客_51CTO博客」 */
const TITLE_NAME = /<title>\s*([^<]*?)\s*的博客/

/** 业务信封：`code` 为数字 0 才算这一步成功 */
interface SignatureEnvelope {
  code?: number
  msg?: string
  data: { sign: string }
}

interface ConfigEnvelope {
  code?: number
  msg?: string
  data: { url: string; fields: Record<string, string> }
}

interface DraftEnvelope {
  status?: number
  msg?: string
  data?: { did?: string | number }
}

/** 异常统一收敛成文案（非 Error 的抛出物也要能读） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从首页 HTML 里挑一个可用的用户名；都没有就交给调用方回落 */
function readUsername(html: string): string | undefined {
  const fromAvatar = html.match(ALT_AFTER_UID) ?? html.match(ALT_BEFORE_UID)
  if (fromAvatar) return fromAvatar[1]
  const fromTitle = html.match(TITLE_NAME)
  return fromTitle ? fromTitle[1].trim() : undefined
}

/**
 * 草稿表单。
 *
 * `is_old` 跟着正文形态走：Markdown 正文传 0，HTML 正文传 2 —— 这是 51CTO 编辑器
 * 区分老/新正文格式的开关。其余字段本次一律留空或取 0/1 的默认值。
 */
function draftForm(article: Article, content: string, csrf: string): URLSearchParams {
  const form = new URLSearchParams()
  form.set('title', article.title)
  form.set('content', content)
  form.set('pid', '')
  form.set('cate_id', '')
  form.set('custom_id', '0')
  form.set('tag', '')
  form.set('abstract', '')
  form.set('banner_type', '0')
  form.set('blog_type', '1')
  form.set('copy_code', '1')
  form.set('is_hide', '0')
  form.set('top_time', '0')
  form.set('is_comment', '0')
  form.set('is_old', article.markdown ? '0' : '2')
  form.set('blog_id', '')
  form.set('did', '')
  form.set('work_id', '')
  form.set('class_id', '')
  form.set('subjectId', '')
  form.set('import_type', '-1')
  form.set('invite_code', '')
  form.set('raffle', '')
  form.set('orig', '')
  form.set('_csrf', csrf)
  return form
}

export class Cto51Adapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cto51',
    name: '51CTO',
    icon: 'https://blog.51cto.com/favicon.ico',
    homepage: 'https://blog.51cto.com/blogger/publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 正文以 Markdown 原样提交，平台侧不需要额外预处理开关 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 51CTO 的写接口认 Origin/Referer；读接口不受影响，但统一挂着更省心 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://blog.51cto.com/*',
      headers: {
        Origin: 'https://blog.51cto.com',
        Referer: 'https://blog.51cto.com/blogger/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 从发布页缓存下来的 csrf 令牌；为空即"还没探过登录态" */
  private csrf = ''

  async checkAuth(): Promise<AuthResult> {
    try {
      const publishPage = await this.runtime.fetch(PUBLISH_PAGE, { credentials: 'include' })
      const publishHtml = await publishPage.text()

      const author = publishHtml.match(AUTHOR_BLOCK)
      if (!author) {
        return { isAuthenticated: false, error: '发布页里找不到作者区块，应该还没登录' }
      }

      const profileUrl = author[1]
      const avatar = author[2]
      const uid = profileUrl.split('/').filter(Boolean).pop() ?? ''

      const csrf = publishHtml.match(CSRF_META)?.[1]
      if (csrf) this.csrf = csrf

      // 用户名要再读一次首页：拿不到只是"名字难看"，不影响登录判定
      let username = uid
      try {
        const profilePage = await this.runtime.fetch(PROFILE_PAGE, { credentials: 'include' })
        username = readUsername(await profilePage.text()) ?? uid
      } catch {
        username = uid
      }

      return { isAuthenticated: true, userId: uid, username, avatar }
    } catch (error) {
      return { isAuthenticated: false, error: messageOf(error) }
    }
  }

  async publish(article: Article): Promise<SyncResult> {
    // 成功与失败共用入口时刻：草稿建好之后不再重新取时间
    const timestamp = Date.now()

    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (this.csrf === '') {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) {
            throw new Error(auth.error || '没有可用的登录态，建草稿这一步不发了')
          }
        }

        const source = article.markdown || article.html || ''
        const content = await this.processImages(source, (src) => this.uploadImageByUrl(src))

        const response = await this.runtime.fetch(DRAFT_API, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': FORM_TYPE,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: DRAFT_ACCEPT,
          },
          body: draftForm(article, content, this.csrf).toString(),
        })

        const payload = (await response.json()) as DraftEnvelope
        if (payload.status !== 1 || !payload.data) {
          throw new Error(payload.msg || '草稿接口没有给出可用的稿件标识')
        }

        return {
          platform: this.meta.id,
          success: true,
          postId: String(payload.data.did),
          postUrl: `${DRAFT_API}/${payload.data.did}`,
          draftOnly: true,
          timestamp,
        }
      })
    } catch (error) {
      return { platform: this.meta.id, success: false, error: messageOf(error), timestamp }
    }
  }

  override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 这里刻意不看 response.ok：平台在图片 404 时回的是一张"错误页"，照样往下走
    const downloaded = await this.runtime.fetch(src)
    const blob = await downloaded.blob()

    const mimeType = blob.type || 'image/jpeg'
    const ext = mimeType.split('/')[1] || 'jpeg'
    const filename = `${Date.now()}.${ext}`

    const sign = await this.requestSign()
    const credentials = await this.requestCredentials(sign, mimeType, filename)
    await this.sendToCos(
      credentials.url,
      credentials.fields,
      new File([blob], filename, { type: mimeType }),
    )

    return { url: `${IMAGE_ORIGIN}${credentials.fields.key}` }
  }

  /** 第①步：换一次性上传签名 */
  private async requestSign(): Promise<string> {
    const response = await this.runtime.fetch(SIGN_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': FORM_TYPE,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: PUBLISH_PAGE,
        Origin: SITE_ORIGIN,
      },
      body: 'upload_type=image',
    })

    const payload = (await response.json()) as SignatureEnvelope
    if (payload.code !== 0) {
      throw new Error(payload.msg || '平台没有给出上传签名')
    }
    return payload.data.sign
  }

  /**
   * 第②步：用签名换 COS 直传凭证。
   *
   * `ext` 字段传的是 **MIME 类型**（`image/png` 这种）而不是扩展名 —— 这是 51CTO
   * 前端一贯的传法，照传即可（平台侧看起来只做记录）。
   */
  private async requestCredentials(
    sign: string,
    mimeType: string,
    filename: string,
  ): Promise<{ url: string; fields: Record<string, string> }> {
    const body = new URLSearchParams({
      upload_type: 'image',
      upload_sign: sign,
      ext: mimeType,
      name: filename,
    })

    const response = await this.runtime.fetch(CONFIG_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': FORM_TYPE,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    })

    const payload = (await response.json()) as ConfigEnvelope
    if (payload.code !== 0) {
      throw new Error(payload.msg || '平台没有给出对象存储凭证')
    }
    return payload.data
  }

  /** 第③步：带凭证直传 COS；文件字段必须落在最后 */
  private async sendToCos(url: string, fields: Record<string, string>, file: File): Promise<void> {
    const form = new FormData()
    for (const [name, value] of Object.entries(fields)) {
      form.append(name, value)
    }
    form.append('Content-Type', file.type)
    form.append('file', file)

    const response = await this.runtime.fetch(url, { method: 'POST', body: form })
    if (!response.ok) {
      throw new Error(`对象存储拒收该图片：HTTP ${response.status} ${response.statusText}`)
    }
  }
}
