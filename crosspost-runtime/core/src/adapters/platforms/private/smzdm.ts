/**
 * 什么值得买（smzdm）投稿适配器
 *
 * 这个平台有三处和别家不同，文件结构基本由它们决定：
 *
 * 1. 投稿站外面罩着 WAF：被拦下时返回的是一张"空壳"页（页面变量 buid 被填成全 f，body 为空）。
 *    因此每条平台请求都走同一个封装：先识别挑战页，命中就按次数退避重试；同时统一叠一份
 *    固定的客户端指纹头（平台按它判客户端，不能跟着运行环境漂）。
 * 2. 平台没有"新建文章"接口。草稿 id 的来源是 GET 一次投稿页，从页面上那条 release-new
 *    新建链接里把 id 抠出来；后面的保存全部落在这个 id 上（覆盖式自动保存）。
 * 3. CSRF token 只在页面上下文里拿得到（扩展侧的页面通道），所以发布前必须先有 tab；
 *    正文插图同样是"往当前这篇草稿里插图"，强依赖第 2 步的 id。
 */
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('SmzdmAdapter')

/** 投稿页：登录态判定、"新建文章"取 id、开 tab 都落在它上面 */
const TOUGAO_PAGE = 'https://post.smzdm.com/tougao/'
/** 编辑器保存接口；submit_type=auto_save 就是"只存草稿" */
const SUBMIT_ENDPOINT = 'https://post.smzdm.com/api/editor/article/submit'
/** 正文插图接口 */
const IMAGE_ENDPOINT = 'https://post.smzdm.com/api/images/upload/local'
/** 复用既有 tab 时的匹配模式 */
const TAB_PATTERN = 'https://post.smzdm.com/*'
/** 请求头规则的匹配范围（只看站点，不限定 scheme） */
const HEADER_FILTER = '*://post.smzdm.com/*'
/** 投稿站源 */
const SITE_ORIGIN = 'https://post.smzdm.com'

/** 挑战页特征一：页面变量 buid 被写成全 f */
const WAF_BUID_MARKER = 'var buid = "fffffffffffffffffff"'
/** 挑战页特征二：body 是空的 */
const WAF_EMPTY_BODY_MARKER = '<body></body>'
/** 挑战页最多尝试的次数 */
const WAF_ATTEMPTS = 5

/**
 * 会话级归属记忆：**我们开过的投稿页 tab**（键名带平台前缀，避免与其它用途撞车）。
 *
 * 为什么需要它：投稿页 tab 只在发布成功时关闭（复用用户的 tab 不许关）。而发布**失败**时会留下
 * 一个由我们开的 tab，下一次发布把它当"既有 tab"复用 → 于是永远不再关闭（实测：一次失败之后
 * 每次成功推送都留着那个 tab）。把 tabId 记进会话（Node 侧是进程内 Map、扩展侧是
 * `chrome.storage.session`），下次就能认出"这其实是我们的页面"，收尾照常关掉。
 */
const SESSION_OWNED_TABS = 'crosspost.smzdm.ownedTabs'

/**
 * 平台请求统一附加的客户端头。
 * sec-ch-ua 是写死的 Chrome / macOS 组合，属于伪造客户端指纹的必要部分，保持原样。
 */
const CLIENT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

/** 页面通道 smzdmGetToken 的回包形状 */
interface SmzdmTokenReply {
  success?: boolean
  token?: string | null
  error?: string
}

/** 编辑器保存接口的回包形状（只确证 error_code === 0 为成功） */
interface SmzdmSubmitReply {
  error_code?: number
  error_msg?: string
}

/** 插图接口的回包形状（只确证 error_code === 0 且 data.url 才算成功） */
interface SmzdmImageReply {
  error_code?: number
  error_msg?: string
  data?: { url?: string }
}

/** 把任意抛出物收敛成一行文案 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SmzdmAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'smzdm',
    name: '什么值得买',
    icon: 'https://www.smzdm.com/favicon.ico',
    homepage: TOUGAO_PAGE,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
    removeLinks: true,
  }

  /** 平台接口要求带上站点来源头，按请求周期临时注入 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: HEADER_FILTER,
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 当前正在写入的草稿 id：插图与保存都要用它 */
  private articleId: string | null = null

  /** 发布用的 tab 是不是"我们的"（本次自建，或会话记忆里由我们开过的） */
  private tabOpenedByUs = false

  // ============ 登录态 ============

  async checkAuth(): Promise<AuthResult> {
    try {
      const html = await this.loadTougaoPage()
      if (!html.includes('release-new')) {
        return { isAuthenticated: false, error: '投稿页没有登录痕迹，请先登录什么值得买' }
      }
      return {
        isAuthenticated: true,
        username: this.pickAuthorName(html),
        avatar: this.pickAuthorAvatar(html),
      }
    } catch (error) {
      logger.warn('什么值得买登录态检查失败', error)
      return { isAuthenticated: false, error: describeError(error) }
    }
  }

  // ============ 发布（只存草稿） ============

  async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const startedAt = Date.now()
    let tabId: number | null = null
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        tabId = await this.ensureSmzdmTab()
        await this.pauseBeforeNextStep(1500)

        // 第 1 步：拿"当前文章"id（平台侧只是渲染了一个新建链接，这里照现状复用）
        const articleId = await this.createNewArticle()
        await this.pauseBeforeNextStep(800)

        // 第 2 步：正文换成平台图床地址（插图必须带上面这个文章 id）
        const editorValue = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          { skipPatterns: ['zdmimg.com', 'smzdm.com'] },
        )

        // 第 3 步：CSRF token 只能从页面上下文取，取不到就不能提交
        const csrfToken = await this.getCsrfToken(tabId)
        if (!csrfToken) {
          throw new Error('没有从编辑器页面取到 CSRF token')
        }

        const form = this.buildSubmitForm(article.title, articleId, editorValue)
        const response = await this.fetchWithRetry(SUBMIT_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            _csrf_token: csrfToken,
          },
          body: form,
        })
        const reply = (await response.json()) as SmzdmSubmitReply

        if (reply.error_code !== 0) {
          const reason = reply.error_msg || JSON.stringify(reply)
          return this.createResult(false, {
            error: `编辑器没有接受这次保存：${reason}`,
            timestamp: startedAt,
          })
        }

        logger.info(`什么值得买草稿已保存：${articleId}`)
        return this.createResult(true, {
          postId: articleId,
          postUrl: `${SITE_ORIGIN}/edit/${articleId}`,
          draftOnly: true,
          timestamp: startedAt,
        })
      })
    } catch (error) {
      logger.error('什么值得买发布失败', error)
      return this.createResult(false, { error: describeError(error), timestamp: startedAt })
    } finally {
      // 收尾一律走这里（对齐 toutiao / xiaohongshu 的 finally 收尾）：**只关"我们的"tab**。
      // 失败也关 —— 否则失败的发布会把投稿页 tab 留在浏览器里，之后每次发布都"复用"它而不再关闭。
      if (tabId !== null) await this.releaseTab(tabId)
      // 不论成败都清掉，避免下一次发布误用上一篇的 id
      this.articleId = null
    }
  }

  // ============ 图片 ============

  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const blob = await this.downloadImage(src)

    const articleId = this.articleId
    if (!articleId) {
      throw new Error('插图前必须先拿到当前文章，请先走一次发布创建草稿')
    }

    const form = new FormData()
    form.append('imgFile', blob, 'WU_FILE_0')
    form.append('type', blob.type || 'image/png')
    form.append('article_id', articleId)
    form.append('insert', '1')
    form.append('storage', '1')
    form.append('size', String(blob.size))

    const response = await this.fetchWithRetry(IMAGE_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const reply = (await response.json()) as SmzdmImageReply

    if (reply.error_code !== 0 || !reply.data?.url) {
      const reason = reply.error_msg || JSON.stringify(reply)
      throw new Error(`插图没有成功：${reason}`)
    }
    return { url: reply.data.url }
  }

  /** 下载原图（平台图床要的是二进制本体） */
  private async downloadImage(src: string): Promise<Blob> {
    const response = await this.runtime.fetch(src)
    return response.blob()
  }

  // ============ 平台请求封装 ============

  /**
   * 平台请求的唯一入口：叠统一客户端头 → 发请求 → 识别 WAF 挑战页。
   * 非挑战页会把读出来的正文重新包成 Response 交回调用方（内容、状态、头都不变）；
   * 重试到上限仍被拦则直接抛出，让上层按失败收敛。
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    maxAttempts = WAF_ATTEMPTS,
  ): Promise<Response> {
    const headers = {
      ...CLIENT_HEADERS,
      ...((options.headers as Record<string, string> | undefined) || {}),
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.runtime.fetch(url, { ...options, headers })
      const text = await response.clone().text()

      if (!this.isWafChallenge(text)) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      logger.warn(`什么值得买第 ${attempt}/${maxAttempts} 次请求撞上 WAF 挑战页：${url}`)
      if (attempt < maxAttempts) {
        await this.delay(attempt * 1500 + Math.floor(Math.random() * 500))
      }
    }

    throw new Error('请求反复被什么值得买的 WAF 挑战页拦下，请稍后再试')
  }

  /** 挑战页判定：两个特征必须同时成立，缺一不算 */
  private isWafChallenge(text: string): boolean {
    return text.includes(WAF_BUID_MARKER) && text.includes(WAF_EMPTY_BODY_MARKER)
  }

  /** GET 投稿页并返回原文（两条路径共用：登录态判定、"新建文章"取 id） */
  private async loadTougaoPage(): Promise<string> {
    const response = await this.fetchWithRetry(TOUGAO_PAGE, { credentials: 'include' })
    return response.text()
  }

  // ============ tab 与页面通道 ============

  /** 会话记忆：我们开过、还没关掉的 tab id */
  private async rememberedTabs(): Promise<number[]> {
    try {
      const raw = await this.runtime.session?.get(SESSION_OWNED_TABS)
      return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : []
    } catch {
      return []
    }
  }

  private async rememberTab(tabId: number): Promise<void> {
    try {
      if (!this.runtime.session) return
      const ids = await this.rememberedTabs()
      if (!ids.includes(tabId)) await this.runtime.session.set(SESSION_OWNED_TABS, [...ids, tabId])
    } catch {
      /* 记不住不影响发布（只是少了"跨发布认领孤儿 tab"的能力） */
    }
  }

  private async forgetTab(tabId: number): Promise<void> {
    try {
      if (!this.runtime.session) return
      const ids = await this.rememberedTabs()
      if (ids.includes(tabId)) {
        await this.runtime.session.set(
          SESSION_OWNED_TABS,
          ids.filter((n) => n !== tabId),
        )
      }
    } catch {
      /* 同上 */
    }
  }

  /**
   * 复用已打开的投稿站 tab；没有就自己开一个并记下归属。
   *
   * 复用到的页面只有在**会话记忆里是我们开的**时才算"我们的"（上次发布失败/进程被杀留下的
   * 孤儿 tab 就属于这种）；用户自己开着的投稿页一律不认领 —— 收尾不得关别人的页面。
   */
  private async ensureSmzdmTab(): Promise<number> {
    const tabs = this.runtime.tabs
    if (!tabs) {
      throw new Error('什么值得买发布需要浏览器 tabs API 支持')
    }

    const opened = await tabs.query(TAB_PATTERN)
    if (opened.length > 0) {
      const reused = opened[0].id
      this.tabOpenedByUs = (await this.rememberedTabs()).includes(reused)
      return reused
    }

    const created = await tabs.create(TOUGAO_PAGE, false)
    this.tabOpenedByUs = true
    await this.rememberTab(created.id)
    try {
      await tabs.waitForLoad(created.id, 30000)
    } catch (error) {
      // 页面没在超时内 load 完也可能已经可交互，不阻断后续步骤
      logger.warn('什么值得买发布页等待加载超时，继续尝试', error)
    }
    return created.id
  }

  /** 收尾：只关"我们的"tab（用户自己的投稿页必须留着）；关闭失败不影响发布结果 */
  private async releaseTab(tabId: number): Promise<void> {
    if (!this.tabOpenedByUs) return
    this.tabOpenedByUs = false
    await this.forgetTab(tabId)
    if (!this.runtime.tabs) return
    try {
      await this.runtime.tabs.close(tabId)
    } catch (error) {
      logger.warn('关闭什么值得买发布页失败（不影响发布结果）', error)
    }
  }

  /** CSRF token 得在页面上下文里取，取不到就不能提交 */
  private async getCsrfToken(tabId: number): Promise<string> {
    if (!this.runtime.pageOp) {
      throw new TypeError('当前运行时没有浏览器页面通道，取不到什么值得买的 CSRF token')
    }

    const reply = await this.runtime.pageOp<SmzdmTokenReply>(tabId, 'smzdmGetToken', [])
    return reply?.token || ''
  }

  // ============ 文章 id ============

  /**
   * 【照现状实现】平台没有"新建文章"接口：GET 投稿页，从 release-new 那条新建链接里
   * 抓出文章 id 作为本次草稿的目标 id。是否真的"新建"了一篇由平台页面逻辑决定，
   * 适配器不做任何 POST，幂等性未经证实。
   */
  private async createNewArticle(): Promise<string> {
    const html = await this.loadTougaoPage()
    const articleId = this.extractReleaseNewId(html)
    if (!articleId) {
      throw new Error('无法创建新文章，请确认已登录什么值得买')
    }
    this.articleId = articleId
    return articleId
  }

  /** 两种书写顺序都试一遍：href 在前 / class 在前 */
  private extractReleaseNewId(html: string): string | null {
    const patterns = [
      /href="\/edit\/([^"]+)"\s+class="release-new"/,
      /class="release-new"[^>]*href="\/edit\/([^"]+)"/,
    ]
    for (const pattern of patterns) {
      const matched = pattern.exec(html)
      if (matched) return matched[1]
    }
    return null
  }

  // ============ 页面信息提取 ============

  /** 作者名：新版标记 → 旧版标记 → 内联 JSON */
  private pickAuthorName(html: string): string | undefined {
    const patterns = [
      /class="author-title"[^>]*>([^<]+)</,
      /class="user-name[^"]*"[^>]*>([^<]+)</,
      /nickname['"]\s*:\s*['"]([^'"]+)/,
    ]
    for (const pattern of patterns) {
      const matched = pattern.exec(html)
      if (matched) return matched[1]
    }
    return undefined
  }

  /** 头像：新版标记 → 旧版标记 → 内联 JSON */
  private pickAuthorAvatar(html: string): string | undefined {
    const patterns = [
      /class="avatar-img"[^>]*src="([^"]+)"/,
      /class="user-avatar[^"]*"[^>]*src="([^"]+)"/,
      /avatar['"]\s*:\s*['"]([^'"]+)/,
    ]
    for (const pattern of patterns) {
      const matched = pattern.exec(html)
      if (matched) return matched[1]
    }
    return undefined
  }

  // ============ 表单与节奏 ============

  /** 编辑器保存表单：submit_type=auto_save 是"只存草稿"的关键位 */
  private buildSubmitForm(title: string, articleId: string, editorValue: string): string {
    const fields: Record<string, string> = {
      article_id: articleId,
      submit_type: 'auto_save',
      title,
      editorValue,
      series_title: '',
      focus_image: '',
      remark: '',
      square_pic_url: '',
      cover_image_rectangle: '',
      custom_topics: '',
      group_id: '',
      series_order_id: '0',
      series_id: '0',
      anonymous: '0',
      first_publish: '0',
      create_state_type: '3',
      ai_state_type: '3',
    }
    return new URLSearchParams(fields).toString()
  }

  /** 平台页面要一点时间落状态，等一等再走下一步（带点抖动，避免固定节奏） */
  private async pauseBeforeNextStep(baseMs: number): Promise<void> {
    await this.delay(baseMs + Math.floor(Math.random() * 300))
  }
}
