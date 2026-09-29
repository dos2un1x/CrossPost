/**
 * 雪球（xueqiu）适配器。
 *
 * 雪球写作台只提供「草稿」入口，本适配器因此永远只调草稿保存接口，
 * 不存在任何发表/定时通道。
 *
 * 两个平台个性值得先记住：
 *
 * 1. **登录态藏在写作页的脚本里**：`writeV2` 是个 HTML 页面，用户对象以
 *    `window.UOM_CURRENTUSER = {…}` 的形式内联；适配器不读 cookie，也不请求任何 JSON 接口，
 *    解析出来的用户对象会被缓存，供随后的草稿保存复用（同一轮里不会再抓一次页面）。
 * 2. **正文由本适配器自己把 Markdown 渲染成 HTML**：雪球编辑器不吃 Markdown 层级，
 *    标题必须压成固定的 `<h4>`、列表包装必须拆掉、`<hr>` 必须丢弃，图片统一挂 `ke_img` 类。
 *    这些是编辑器的兼容要求，不是渲染缺陷，改动它们等于改变最终草稿正文。
 */

import { Remarkable } from 'remarkable'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const log = createLogger('xueqiu')

/** 写作台页面：登录态从这里的内联脚本里读 */
const WRITE_PAGE_URL = 'https://mp.xueqiu.com/writeV2'

/** 草稿保存接口（雪球只有草稿通道，没有发表接口） */
const DRAFT_SAVE_URL = 'https://mp.xueqiu.com/xq/statuses/draft/save.json'

/** 图片上传接口 */
const PHOTO_UPLOAD_URL = 'https://mp.xueqiu.com/xq/photo/upload.json'

/** 上传接口固定使用的文件名（雪球不关心真实扩展名） */
const UPLOAD_FILENAME = 'image.jpg'

/** 已是雪球自家图床的地址不必重复转存 */
const OWN_IMAGE_HOSTS = ['xueqiu.com', 'imedao.com']

/**
 * 从写作页里抠出用户对象的 JSON 文本。
 *
 * 页面形如 `…window.UOM_CURRENTUSER = {"currentUser":{…}}</script>…`：取值用非贪婪匹配，
 * 由后面紧跟的 `</script>` 兜住右边界；没有这个终结符就判为「没拿到」。
 */
const CURRENT_USER_SNIPPET = /window\.UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})<\/script>/

/** 写作页内联脚本里的用户字段（其余字段本适配器不消费） */
interface XueqiuUser {
  id?: string | number
  screen_name?: string
  photo_domain?: string
  profile_image_url?: string
}

/** 转成可读文案；非 Error 抛出物也兜住 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 头像地址由两段拼成：`photo_domain`（形如 `//xqimg.imedao.com`，需要补 `https:`）
 * 与 `profile_image_url` 的第一段（该字段可能是逗号分隔的多尺寸列表）。
 * 任一段缺失就给空串，而不是拼出一个半截地址。
 */
function composeAvatar(user: XueqiuUser): string {
  if (!user.photo_domain || !user.profile_image_url) return ''
  const first = user.profile_image_url.split(',')[0]
  return `https:${user.photo_domain}${first}`
}

/** 属性值转义：正文里的地址与替代文字都会被写进双引号里 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 造一台按雪球编辑器口味改造过的 Markdown 渲染器。
 *
 * 与标准 Markdown 的差异（全部是平台兼容要求）：
 * · 各级标题一律塌成 `<h4>`，级别信息丢弃；
 * · 粗体 `<b>`、斜体 `<i>`（雪球编辑器不认 `<strong>`/`<em>`）；
 * · 列表的包装标签（`<ul>`/`<ol>`/`<li>`）整体不输出，列表项按普通段落铺开；
 * · 分隔线 `---` 直接丢弃；
 * · 图片固定写成 `<img src="…" alt="…" class="ke_img">`，不带自闭合斜杠。
 *
 * 选项 `html:true` 让正文里已有的 HTML 原样透传，`breaks:true` 让单个换行也断行。
 */
function createRenderer(): Remarkable {
  const renderer = new Remarkable({ html: true, breaks: true })
  const rules = renderer.renderer.rules

  rules.heading_open = () => '<h4>'
  rules.heading_close = () => '</h4>'

  rules.strong_open = () => '<b>'
  rules.strong_close = () => '</b>'
  rules.em_open = () => '<i>'
  rules.em_close = () => '</i>'

  rules.bullet_list_open = () => ''
  rules.bullet_list_close = () => ''
  rules.ordered_list_open = () => ''
  rules.ordered_list_close = () => ''
  rules.list_item_open = () => ''
  rules.list_item_close = () => ''

  rules.hr = () => ''

  rules.image = (tokens, idx) => {
    const token = tokens[idx]
    const src = escapeAttribute(token.src ?? '')
    const alt = escapeAttribute(token.alt ?? '')
    return `<img src="${src}" alt="${alt}" class="ke_img">`
  }

  return renderer
}

/** 模块级只造一次：规则表是就地改写的，反复造没有意义 */
const renderer = createRenderer()

/**
 * 渲染 + 收尾清理：删掉只剩空白的段落，把 3 个以上连续换行压回 2 个，最后去掉首尾空白。
 */
function renderArticle(markdown: string): string {
  const html = renderer.render(markdown)
  return html
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class XueqiuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xueqiu',
    name: '雪球',
    icon: 'https://xqdoc.imedao.com/17aebcfb84a145d33fc18679.ico',
    homepage: 'https://mp.xueqiu.com/writeV2',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'markdown' as const,
    // 以下三个键当前没有消费者，但属于对外声明的契约字段，保持原样
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
  }

  /**
   * 写作接口要求带上自家来源：只在发布期间注入，且只覆盖 `/xq/*`；
   * 登录态页面 `/writeV2` 不在过滤器内，因此探测登录时不带这两个头。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.xueqiu.com/xq/*',
      headers: {
        Origin: 'https://mp.xueqiu.com',
        Referer: 'https://mp.xueqiu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 写作页里解析出来的用户对象；置空即代表「还没确认登录」 */
  private currentUser: XueqiuUser | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(WRITE_PAGE_URL, {
        method: 'GET',
        credentials: 'include',
      })
      const page = await response.text()

      const snippet = CURRENT_USER_SNIPPET.exec(page)
      if (snippet === null) {
        log.debug('写作页里没有 window.UOM_CURRENTUSER 片段，按未登录处理')
        return { isAuthenticated: false }
      }

      let payload: { currentUser?: XueqiuUser }
      try {
        payload = JSON.parse(snippet[1]) as { currentUser?: XueqiuUser }
      } catch (error) {
        log.debug('用户片段不是合法 JSON，按未登录处理', describeError(error))
        return { isAuthenticated: false }
      }

      const user = payload.currentUser
      if (user === undefined || user === null || !user.id) {
        log.debug('用户片段缺少 id，按未登录处理')
        return { isAuthenticated: false }
      }

      this.currentUser = user
      return {
        isAuthenticated: true,
        userId: String(user.id),
        username: user.screen_name,
        avatar: composeAvatar(user),
      }
    } catch (error) {
      log.debug('登录态探测失败', describeError(error))
      return { isAuthenticated: false, error: describeError(error) }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (this.currentUser === null) {
          await this.checkAuth()
          if (this.currentUser === null) {
            throw new Error('雪球未登录，请先在浏览器里登录写作台')
          }
        }

        const markdown = article.markdown || ''
        const withImages = await this.processImages(markdown, (src) => this.uploadImageByUrl(src), {
          skipPatterns: OWN_IMAGE_HOSTS,
          onProgress: options?.onImageProgress,
        })

        const payload = new URLSearchParams()
        payload.set('text', renderArticle(withImages))
        payload.set('title', article.title)
        payload.set('cover_pic', '')
        payload.set('flags', 'false')
        payload.set('original_event', '')
        payload.set('status_id', '')
        payload.set('legal_user_visible', 'false')
        payload.set('is_private', 'false')

        const response = await this.runtime.fetch(DRAFT_SAVE_URL, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: payload,
        })
        const saved = (await response.json()) as {
          id?: string | number
          error_description?: string
        }

        if (!saved.id) {
          throw new Error(saved.error_description || '雪球草稿没有落库')
        }

        const postId = String(saved.id)
        return this.createResult(true, {
          postId,
          postUrl: `https://mp.xueqiu.com/write/draft/${postId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.error('雪球草稿保存失败', describeError(error))
      return this.createResult(false, { error: describeError(error) })
    }
  }

  /**
   * 转存一张正文图片：先按原地址下载，再交给雪球图床上传接口。
   *
   * 回包只给「目录地址」与「文件名」两段，最终地址要自己拼；两段缺任何一段都算失败。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const downloaded = await fetch(src)
    if (!downloaded.ok) {
      throw new Error(`雪球取不回这张待转存的图：HTTP ${downloaded.status}`)
    }
    const blob = await downloaded.blob()

    const form = new FormData()
    form.append('file', blob, UPLOAD_FILENAME)

    const response = await this.runtime.fetch(PHOTO_UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const uploaded = (await response.json()) as { url?: string; filename?: string }

    if (!uploaded.url || !uploaded.filename) {
      throw new Error('雪球图床回包缺少地址或文件名')
    }

    const prefix = uploaded.url.startsWith('//') ? `https:${uploaded.url}` : uploaded.url
    return { url: `${prefix}/${uploaded.filename}` }
  }
}
