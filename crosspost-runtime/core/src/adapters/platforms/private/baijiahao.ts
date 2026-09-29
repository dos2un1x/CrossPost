/**
 * 百家号（baijiahao.baidu.com）适配器 —— 只存草稿
 *
 * 三条平台侧事实决定了这个文件的形状：
 *
 * 1. **登录态探测走基类 `get()`**：`/builder/app/appinfo` 是非 2xx 就必须抛错的接口，
 *    所以未登录/凭据过期在这里表现为 `HTTP <状态码>: <状态文本>` 形态的 `Error`，
 *    而不是别处常见的"回包不是 JSON → 解析失败"。不要为了跟别的平台看齐改成裸 `fetch`。
 * 2. **写草稿要一个只存在于编辑器页面里的令牌**：先 GET `/builder/rc/edit` 拿回整页 HTML，
 *    再从内联脚本的 `window.__BJH__INIT__AUTH__` 里抠出来；抠不到即视为登录态已失效。
 *    这个令牌**每次发布都重取**，用户信息则跨次缓存。
 * 3. **保存接口回的是 JSONP 而不是 JSON**：形如 `bjhdraft({...})`。剥壳只做"整体包裹"这一种，
 *    回包多一个尾随字符就让它按 `SyntaxError` 冒出来 —— 不做更宽松的容错。
 *
 * 正文图片经全局 `fetch` 下载（**判 ok**）、再走运行时通道上传到百家号图床；
 * 单图失败由 `processImages` 逐图吞掉，正文里保留原地址，不阻断整篇草稿。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Baijiahao')

/** 登录态与作者信息接口（带缓存破坏参数调用） */
const APP_INFO_URL = 'https://baijiahao.baidu.com/builder/app/appinfo'
/** 编辑器页面：发布令牌写在这个页面的内联脚本里 */
const EDITOR_PAGE_URL = 'https://baijiahao.baidu.com/builder/rc/edit'
/** 保存草稿接口；`callback=bjhdraft` 是平台约定的 JSONP 回调名 */
const SAVE_DRAFT_URL = 'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft'
/** 图片上传代理接口 */
const IMAGE_UPLOAD_URL = 'https://baijiahao.baidu.com/pcui/picture/uploadproxy'
/** 图床请求里的固定应用标识（平台前端下发，不是本仓配置项） */
const IMAGE_APP_ID = '1589639493090963'
/** 平台自家图床域名：正文里已经是这些域名的图片不必重传 */
const SKIP_IMAGE_HOSTS = ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com']
/** 草稿归属的固定栏目号 */
const FEED_CATEGORY = '1'
/** 保存接口要求的固定话题项（来源不明，原样保留） */
const ACTIVITY_LIST = JSON.stringify([{ id: 408, is_checked: 0 }])

/** 编辑器内联脚本里的发布令牌，单双引号都认 */
const EDITOR_TOKEN = /window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/
/** JSONP 外壳前缀 */
const JSONP_CALL = 'bjhdraft('

/** 作者信息 */
interface BaijiahaoUser {
  userid?: string
  name?: string
  avatar?: string
}

/** `/builder/app/appinfo` 回包 */
interface AppInfoPayload {
  errmsg?: string
  data?: { user?: BaijiahaoUser }
}

/** 保存草稿回包（剥壳后的 JSON） */
interface DraftPayload {
  errmsg?: string
  ret?: { article_id?: string }
}

/** 图床上传回包 */
interface ImagePayload {
  errmsg?: string
  ret?: { https_url?: string }
}

/** 任意异常 → 文案 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 剥 JSONP 外壳：只认"整串被 `bjhdraft(` 与 `)` 包住"这一种形状。
 * 前后多出任何字符都原样留给 `JSON.parse`，让它抛 `SyntaxError`。
 */
function stripJsonpShell(raw: string): string {
  let text = raw
  if (text.startsWith(JSONP_CALL)) text = text.slice(JSONP_CALL.length)
  if (text.endsWith(')')) text = text.slice(0, -1)
  return text
}

export class BaijiahaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'baijiahao',
    name: '百家号',
    icon: 'https://www.baidu.com/favicon.ico',
    homepage: 'https://baijiahao.baidu.com/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 正文按 HTML 提交，平台侧没有额外的归一化开关 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://baijiahao.baidu.com/*',
      headers: {
        Origin: 'https://baijiahao.baidu.com',
        Referer: 'https://baijiahao.baidu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 作者信息缓存：为空时 `publish` 才会重新探测登录态 */
  private userInfo: BaijiahaoUser | null = null

  /** 本次发布从编辑器页面抠出的令牌；每次 `publish` 重取，不跨次复用 */
  private authToken = ''

  async checkAuth(): Promise<AuthResult> {
    try {
      // 缓存破坏参数必带：这个接口会被浏览器与网关一起缓存
      const payload = await this.get<AppInfoPayload>(`${APP_INFO_URL}?_=${Date.now()}`)
      const user = payload.data?.user
      if (payload.errmsg !== 'success' || !user) {
        return { isAuthenticated: false }
      }
      this.userInfo = user
      return {
        isAuthenticated: true,
        userId: user.userid,
        username: user.name,
        avatar: user.avatar,
      }
    } catch (error) {
      logger.debug('百家号登录态探测未通过', error)
      return { isAuthenticated: false, error: messageOf(error) }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        if (!this.userInfo) {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) {
            throw new Error('百家号登录态不可用，请先在浏览器里登录再保存草稿')
          }
        }

        const token = await this.readEditorToken()
        const content = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: SKIP_IMAGE_HOSTS,
            onProgress: options?.onImageProgress,
          },
        )

        const response = await this.runtime.fetch(SAVE_DRAFT_URL, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            token,
          },
          body: this.buildSaveForm(article.title, content),
        })
        // 这里**不判 ok**：非 JSONP 回包会在下面以 SyntaxError 的形态暴露
        const raw = await response.text()
        const payload = JSON.parse(stripJsonpShell(raw)) as DraftPayload
        const articleId = payload.ret?.article_id
        if (payload.errmsg !== 'success' || !articleId) {
          throw new Error(payload.errmsg || '百家号没有返回成功标记，草稿未保存')
        }

        return this.createResult(true, {
          postId: articleId,
          postUrl: `${EDITOR_PAGE_URL}?type=news&article_id=${articleId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      logger.warn('百家号这篇草稿没能存下去', error)
      return this.createResult(false, { error: messageOf(error) })
    }
  }

  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const download = await fetch(src)
    if (!download.ok) {
      throw new Error(`取正文配图时平台回了 HTTP ${download.status}`)
    }
    const blob = await download.blob()

    const form = new FormData()
    form.append('media', blob, 'image.jpg')
    form.append('type', 'image')
    form.append('app_id', IMAGE_APP_ID)
    form.append('is_waterlog', '1')
    form.append('save_material', '1')
    form.append('no_compress', '0')
    form.append('is_events', '')
    form.append('article_type', 'news')

    const response = await this.runtime.fetch(IMAGE_UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    // 同样不判 ok：非 JSON 回包直接以解析错误的形式冒出去
    const payload = (await response.json()) as ImagePayload
    const url = payload.ret?.https_url
    if (payload.errmsg !== 'success' || !url) {
      throw new Error(payload.errmsg || '百家号图床没有返回图片地址')
    }
    return { url }
  }

  /**
   * 取编辑器页面里的发布令牌。
   *
   * 页面请求本身**不判 ok**（登录失效时平台可能回一个 200 的登录页），
   * 判定完全取决于页面里有没有那段内联脚本。
   */
  private async readEditorToken(): Promise<string> {
    const response = await this.runtime.fetch(EDITOR_PAGE_URL, { credentials: 'include' })
    const page = await response.text()
    const matched = EDITOR_TOKEN.exec(page)
    if (!matched) {
      throw new Error('百家号编辑器页面里找不到发布令牌，登录态可能已过期')
    }
    this.authToken = matched[1]
    logger.debug('已从编辑器页面取得发布令牌')
    return this.authToken
  }

  /** 组装保存接口的表单体；`len` 取处理后正文串的长度 */
  private buildSaveForm(title: string, content: string): URLSearchParams {
    const form = new URLSearchParams()
    form.set('title', title)
    form.set('content', content)
    form.set('feed_cat', FEED_CATEGORY)
    form.set('len', String(content.length))
    form.set('activity_list', ACTIVITY_LIST)
    form.set('source_reprinted_allow', '0')
    form.set('original_status', '0')
    form.set('original_handler_status', '1')
    form.set('isBeautify', 'false')
    form.set('subtitle', '')
    form.set('bjhtopic_id', '')
    form.set('bjhtopic_info', '')
    form.set('type', 'news')
    return form
  }
}
