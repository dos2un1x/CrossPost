/**
 * 博客园（cnblogs.com）适配器。
 *
 * 这个平台有三处与其它站点不一样的通道习惯，读代码时先看这三条：
 *
 * · **先读正文、后判 `ok`**：草稿接口与图床上传都把回包整段读成文本，再按 HTTP 状态分流，
 *   所以错误信息里永远能带上平台原话（截断到 100 字符）；
 * · **正文图片不走代理**：下载用全局 `fetch`，只有上传才回到 `runtime.fetch`
 *   （因此 `Origin`/`Referer` 注入只对上传那一步有意义）；
 * · **令牌是三域探测的**：`XSRF-TOKEN` 可能落在 `i.cnblogs.com`、`.cnblogs.com`、
 *   `cnblogs.com` 任一处，逐域试到第一个非空值；命中后记在实例上，本次实例不再探测。
 *
 * 只产出草稿：请求体里 `isPublished:false` 与 `isDraft:true` 两个常量位把它挡在发布流之外。
 */
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const log = createLogger('cnblogs')

/** 后台与图床分属两台主机，各要一条注入规则；两条规则的头内容完全相同 */
const RULE_HOSTS = ['*://i.cnblogs.com/*', '*://upload.cnblogs.com/*']
const SITE_HEADERS: Record<string, string> = {
  Origin: 'https://i.cnblogs.com',
  Referer: 'https://i.cnblogs.com/',
}

/** 探测 XSRF 令牌时按序尝试的 cookie 域 */
const XSRF_DOMAINS = ['i.cnblogs.com', '.cnblogs.com', 'cnblogs.com']
const XSRF_NAME = 'XSRF-TOKEN'

/** 平台自己的图床域名：正文里已经是这些地址时不必再转存 */
const OWN_IMAGE_HOSTS = ['cnblogs.com', 'img2024.cnblogs.com', 'img2023.cnblogs.com']

const URL_USER_INFO = 'https://home.cnblogs.com/user/CurrentUserInfo'
const URL_EDITOR_PAGE = 'https://i.cnblogs.com/posts/edit'
const URL_DRAFT_API = 'https://i.cnblogs.com/api/posts'
const URL_IMAGE_API = 'https://upload.cnblogs.com/v2/images/cors-upload'

/** 用户信息页里的用户主页链接，捕获组就是登录名 */
const USER_LINK = /href="\/u\/([^"/]+)\//

/**
 * 草稿请求体里恒定不变的 39 项（另 3 项由调用点补：`title` / `postBody` / `datePublished`）。
 * 字段名与取值都是平台契约，一项都不能省 —— 服务端对必填项的边界没有公开文档。
 */
const DRAFT_CONSTANTS: Record<string, unknown> = {
  id: null,
  url: null,
  categoryIds: null,
  categories: null,
  blogTeamIds: null,
  siteCategoryId: null,
  publishAt: null,
  dateUpdated: null,
  entryName: null,
  description: null,
  featuredImage: null,
  tags: null,
  password: null,
  autoDesc: null,
  author: null,
  clientInfo: null,
  sourceUrl: null,
  collectionIds: [],
  postType: 2,
  accessPermission: 0,
  usingEditorId: 5,
  blogId: 0,
  inSiteCandidate: false,
  inSiteHome: false,
  changePostType: false,
  canChangeCreatedTime: false,
  isPublished: false,
  displayOnHomePage: false,
  includeInMainSyndication: false,
  isPinned: false,
  showBodyWhenPinned: false,
  isOnlyForRegisterUser: false,
  isUpdateDateAdded: false,
  removeScript: false,
  changeCreatedTime: false,
  isContributeToImpressiveBugActivity: false,
  isAllowComments: true,
  isMarkdown: true,
  isDraft: true,
}

/** 异常 → 可读文案 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 用户信息页里那个带 `pfs` 类名的头像；页面没有就交回 undefined */
function readAvatar(html: string): string | undefined {
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\bclass="[^"]*\bpfs\b/.test(tag)) continue
    const src = /\bsrc="([^"]+)"/.exec(tag)
    if (src) return src[1]
  }
  return undefined
}

/** 图床回包里挑图片地址：四个候选键按序取第一个非空字符串 */
function readUploadedUrl(payload: Record<string, unknown>): string | undefined {
  for (const key of ['data', 'url', 'imageUrl', 'src']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export class CnblogsAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cnblogs',
    name: '博客园',
    icon: 'https://www.cnblogs.com/favicon.ico',
    homepage: 'https://www.cnblogs.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 正文只送 markdown，图片替换也发生在 markdown 上 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 已探测到的 XSRF 令牌；一旦拿到就复用，直到实例销毁 */
  private xsrfToken: string | null = null

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = RULE_HOSTS.map((urlFilter) => ({
    urlFilter,
    headers: SITE_HEADERS,
    resourceTypes: ['xmlhttprequest'],
  }))

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(URL_USER_INFO, { credentials: 'include' })
      // 这个接口回的是 HTML 片段，状态码不看：不是登录名缺失就是没登录
      const html = await response.text()
      const login = USER_LINK.exec(html)?.[1]
      if (!login) return { isAuthenticated: false }
      return {
        isAuthenticated: true,
        userId: login,
        username: login,
        avatar: readAvatar(html),
      }
    } catch (error) {
      log.debug('读取博客园用户信息失败', textOf(error))
      return { isAuthenticated: false, error: textOf(error) }
    }
  }

  /**
   * 取 XSRF 令牌：先访问一次编辑页让服务端把 cookie 发下来，再按三个域找它。
   *
   * 三条「拿不到」的出口都收敛成 `null`（不抛错）：没有 cookie 读取能力、三域都为空、
   * 以及整个过程里任何一次请求或读取抛错 —— 调用方只看得到「没拿到令牌」这一个结论。
   */
  private async getXsrfToken(): Promise<string | null> {
    if (this.xsrfToken) return this.xsrfToken

    try {
      // 只要服务端把 cookie 下发下来，回包本身不读
      await this.runtime.fetch(URL_EDITOR_PAGE, { credentials: 'include' })

      if (!this.runtime.getCookie) {
        log.warn('当前运行时读不了 cookie，XSRF 令牌无从取得')
        return null
      }

      for (const domain of XSRF_DOMAINS) {
        const value = await this.runtime.getCookie(domain, XSRF_NAME)
        if (value) {
          this.xsrfToken = value
          return value
        }
      }
      log.warn('三个 cookie 域里都没有 XSRF 令牌')
      return null
    } catch (error) {
      log.error('探测 XSRF 令牌的过程中出错', textOf(error))
      return null
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const token = await this.getXsrfToken()
        if (!token) throw new Error('博客园草稿发布前没能拿到 XSRF 令牌，请确认已登录')

        const postBody = await this.processImages(
          article.markdown || '',
          (src) => this.uploadImageByUrl(src),
          { skipPatterns: OWN_IMAGE_HOSTS, onProgress: options?.onImageProgress },
        )

        const response = await this.runtime.fetch(URL_DRAFT_API, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'x-xsrf-token': token },
          body: JSON.stringify({
            ...DRAFT_CONSTANTS,
            title: article.title,
            postBody,
            datePublished: new Date().toISOString(),
          }),
        })

        // 顺序要紧：先取文本，再判状态 —— 否则错误分支就拿不到平台原话了
        const raw = await response.text()
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error('博客园登录态已失效，请重新登录后再发布')
          }
          throw new Error(`博客园草稿接口返回 HTTP ${response.status}：${raw}`)
        }

        let payload: { id?: unknown; error?: unknown }
        try {
          payload = JSON.parse(raw) as { id?: unknown; error?: unknown }
        } catch {
          throw new Error(`博客园草稿接口回包不是 JSON：${raw.slice(0, 100)}`)
        }

        if (!payload?.id) {
          const platform = typeof payload?.error === 'string' ? payload.error : ''
          throw new Error(platform || '博客园草稿接口回包结构无法识别')
        }

        const postId = String(payload.id)
        return this.createResult(true, {
          postId,
          postUrl: `https://i.cnblogs.com/articles/edit;postId=${postId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.error('博客园草稿发布没有完成', textOf(error))
      return this.createResult(false, { error: textOf(error) })
    }
  }

  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const token = this.xsrfToken
    if (!token) throw new Error('博客园图床上传缺少 XSRF 令牌')

    const downloaded = await fetch(src)
    if (!downloaded.ok)
      throw new Error(`博客园正文配图抓不下来（HTTP ${downloaded.status}）：${src}`)
    const blob = await downloaded.blob()

    const form = new FormData()
    form.append('image', blob, 'image.png')
    form.append('app', 'blog')
    form.append('uploadType', 'Select')

    const response = await this.runtime.fetch(URL_IMAGE_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-xsrf-token': token },
      body: form,
    })

    const raw = await response.text()
    if (!response.ok) throw new Error(`博客园图床返回 HTTP ${response.status}：${raw}`)

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(`博客园图床回包不是 JSON：${raw.slice(0, 100)}`)
    }

    const url = readUploadedUrl(payload)
    if (!url) throw new Error(`博客园图床回包里没有图片地址：${JSON.stringify(payload)}`)
    return { url }
  }
}
