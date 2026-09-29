/**
 * 网易号（mp.163.com）适配器
 *
 * 通道特征（与其它平台不同，改代码前先读这三条）：
 *  1. 正文只走 HTTP 表单，不需要页面上下文；但 `ursToken` 只能从页面里拿，
 *     所以发布前要先借一次 tab + `neteaseGetToken`，拿不到就留空继续。
 *  2. 草稿 id 藏在 `data` 里，而 `data` 是一段 **URL 编码的查询串文本**（不是对象），
 *     必须二次解析；解不出来时整体当 id 用。
 *  3. 图片复用「封面上传」接口；表格由 `convertTablesToText` 在预处理阶段压成纯文本。
 */
import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

/** 网易号把登录态、wemediaId、realUserId 都挂在 navinfo 回包的 data 上 */
interface WemediaProfile {
  tid?: string
  tname?: string
  icon?: string
  realUserId?: string
}

/** publishV2 的固定表单骨架（提交类型＝存草稿、新建稿件） */
const PUBLISH_BLUEPRINT = {
  articleId: '-1',
  cover: 'threeImg',
  operation: 'saveDraft',
  scheduled: '0',
  onlineState: '1',
  picUrl: '',
  original: '0',
  subjectId: '',
}

const log = createLogger('NeteaseAdapter')

export class NeteaseAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease',
    name: '网易号',
    icon: 'https://static.ws.126.net/163/f2e/news/yxybd_pc/resource/static/share-icon.png',
    homepage: 'https://mp.163.com/#/article-publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    convertTablesToText: true,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        Origin: 'https://mp.163.com',
        Referer: 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** navinfo 回包里的 data 原文，后续请求要复用 tid / realUserId */
  private wemedia: WemediaProfile | null = null

  // ── 通道小工具 ───────────────────────────────────────────────────────────

  /**
   * 带 cookie 的 GET
   *
   * 非 2xx 立即抛 `HTTP <status>: <statusText>`（异常原文要进 checkAuth 的结果）；
   * 2xx 但回包不是 JSON 时按空对象处理 —— 平台改版或未登录都可能返回 HTML 页，
   * 那种情形属于「没登录」，不是「请求出错」。
   */
  private async pullJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const res = await this.runtime.fetch(url, { method: 'GET', credentials: 'include', headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    const raw = await res.text()
    try {
      return JSON.parse(raw) as T
    } catch {
      return {} as T
    }
  }

  /** 带 cookie 的 POST 表单（网易要求带 charset 的 Content-Type） */
  private async pushForm<T>(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<T> {
    const res = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
    })
    const raw = await res.text()
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as unknown as T
    }
  }

  /** 表单请求头：网易的写接口要求这两项同时在 */
  private formHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    }
  }

  // ── 登录态 ──────────────────────────────────────────────────────────────

  async checkAuth(): Promise<AuthResult> {
    const probe = `https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`
    try {
      const rep = await this.pullJson<{ code?: number; data?: WemediaProfile }>(probe)
      if (rep.code !== 1 || !rep.data?.tid) return { isAuthenticated: false }
      this.wemedia = rep.data
      return {
        isAuthenticated: true,
        userId: rep.data.tid,
        username: rep.data.tname,
        avatar: rep.data.icon,
      }
    } catch (error) {
      log.debug('登录态探测未通过', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /** 账号缓存校验：只有拿到过 tid 才允许继续，空缓存一律判为未登录 */
  private requireProfile(): WemediaProfile {
    if (!this.wemedia?.tid) throw new Error('未登录网易号，请先在浏览器里登录后重试')
    return this.wemedia
  }

  // ── 页面通道：ursToken ──────────────────────────────────────────────────

  /**
   * 借一个 mp.163.com 的 tab（判据按名调用，别改名）
   *
   * 复用时原样还回去；自建的 tab 也**不关**——后面用户可能要点进草稿继续编辑。
   * `tabs.query` / `create` 的异常不在这里吞，交给 publish 的兜底分支处理。
   */
  private async ensureNeteaseTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('网易号需要浏览器 tabs API 才能准备发布页')
    const hit = await this.runtime.tabs.query('https://mp.163.com/*')
    if (hit.length > 0) return hit[0].id
    const created = await this.runtime.tabs.create(
      'https://mp.163.com/subscribe_v4/index.html#/article-publish',
      false,
    )
    await this.runtime.tabs.waitForLoad(created.id, 30000)
    return created.id
  }

  /**
   * 取 ursToken（判据按名调用，别改名）
   *
   * 页面侧的 `window.neg.getToken()` 只能借页面上下文调。三种情形要分开对待：
   * ① 没有 tabs 通道 / 没有 pageOp 通道 → 记告警，token 留空继续（空 token 也能存草稿）；
   * ② 页面回包 ok 但不是 `{success:true, token}` → 同样留空继续；
   * ③ 通道在、调用真的抛了（查询/建 tab/waitForLoad/pageOp 异常）→ 异常上抛，
   *    由 publish 的兜底分支收进 SyncResult，不把「发布链路断了」伪装成「token 为空」。
   */
  private async fetchUrsToken(tabId?: number | null): Promise<string> {
    if (!this.runtime.tabs) {
      log.warn('运行时没有 tabs 通道，ursToken 留空')
      return ''
    }
    // 完全没有 tabs 通道 → 降级成空 token；通道在、但调用失败 → 异常照常上抛
    let target: number
    if (typeof tabId === 'number') {
      target = tabId
    } else {
      try {
        target = await this.ensureNeteaseTab()
      } catch (error) {
        if (!this.runtime.tabs) {
          log.warn('运行时没有 tabs 通道，ursToken 留空', error)
          return ''
        }
        throw error
      }
    }
    if (!this.runtime.pageOp) {
      log.warn('运行时没有 pageOp 通道，ursToken 留空')
      return ''
    }
    const rep = await this.runtime.pageOp<{ success?: boolean; token?: string; error?: string }>(
      target,
      'neteaseGetToken',
      [],
    )
    if (!rep?.success || !rep.token) {
      log.warn('页面未返回可用的 ursToken，留空继续', rep?.error)
      return ''
    }
    return rep.token
  }

  // ── 图片 ────────────────────────────────────────────────────────────────

  /**
   * 正文图片走「封面上传」接口（平台侧复用，端点名不必改）
   *
   * 失败一律抛出，由 processImages 逐张吞掉；该图保留原始外链，不影响其余图片。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const profile = this.requireProfile()
    const blob = await this.downloadImage(src)
    return this.postImage(profile.tid as string, blob)
  }

  /**
   * 取原图字节
   *
   * 走全局 fetch 而不是 runtime.fetch：三种入参（http(s) 外链、`data:` URI、
   * 本地相对路径）都能被同一条通道吃下，不必为每种形态各自开分支。
   */
  private async downloadImage(src: string): Promise<Blob> {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`原图下载失败（HTTP ${res.status}），该图保留外链`)
    return res.blob()
  }

  /** 上传一张图，返回正文可用的地址 */
  private async postImage(tid: string, blob: Blob): Promise<ImageUploadResult> {
    const form = new FormData()
    form.append('file', blob, 'image.jpg')
    const url = `https://mp.163.com/wemedia/article/api/uploadCoverImage.do?wemediaId=${tid}`
    const res = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const rep = (await res.json()) as {
      code?: number
      data?: { url?: string; picUrl?: string }
      msg?: string
    }
    if (rep.code !== 1 || !rep.data) {
      throw new Error(`图片上传被网易号拒绝：${rep.msg || '平台未给出原因'}`)
    }
    const remote = rep.data.url || rep.data.picUrl
    if (!remote) throw new Error('图片上传回包缺少可用地址')
    return { url: remote }
  }

  // ── 发布（恒为存草稿） ──────────────────────────────────────────────────

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        if (!this.wemedia?.tid) await this.checkAuth()
        const profile = this.requireProfile()
        const token = await this.fetchUrsToken()
        const content = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['126.net', '163.com', 'netease.com'],
            onProgress: options?.onImageProgress,
          },
        )
        const form = new URLSearchParams({
          wemediaId: String(profile.tid),
          articleId: PUBLISH_BLUEPRINT.articleId,
          title: article.title,
          content,
          cover: PUBLISH_BLUEPRINT.cover,
          operation: PUBLISH_BLUEPRINT.operation,
          scheduled: PUBLISH_BLUEPRINT.scheduled,
          ursToken: token,
          onlineState: PUBLISH_BLUEPRINT.onlineState,
          picUrl: PUBLISH_BLUEPRINT.picUrl,
          original: PUBLISH_BLUEPRINT.original,
          subjectId: PUBLISH_BLUEPRINT.subjectId,
        })
        return await this.submitDraft(profile, form.toString(), options)
      } catch (error) {
        log.error('网易号存草稿失败', error)
        return this.createResult(false, { error: (error as Error).message })
      }
    })
  }

  /** 真正落草稿：id 从 `data` 查询串里二次解析 */
  private async submitDraft(
    profile: WemediaProfile,
    body: string,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    const stamp = Date.now()
    const url =
      `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${stamp}` +
      `&wemediaId=${profile.tid}` +
      `&realUserId=${encodeURIComponent(String(profile.realUserId ?? ''))}`
    const rep = await this.pushForm<{ code?: number; data?: unknown; msg?: string }>(
      url,
      body,
      this.formHeaders(),
    )
    if (rep.code !== 1) throw new Error(`网易号未接收这次存草稿：${rep.msg || '平台未给出原因'}`)
    const raw = typeof rep.data === 'string' ? rep.data : String(rep.data ?? '')
    const draftId = new URLSearchParams(raw).get('docId') || raw
    return this.createResult(true, {
      postId: draftId,
      postUrl: `https://mp.163.com/subscribe_v4/index.html#/article-publish/${draftId}?option=editDraft`,
      draftOnly: options?.draftOnly ?? true,
    })
  }
}
