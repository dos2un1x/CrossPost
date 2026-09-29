/**
 * 搜狐焦点（搜狐号 · 焦点开放平台）适配器
 *
 * 平台特性：
 * - 登录态与稿件接口同在 `mp-fe-pc.focus.cn`，全部走同源 credentials 请求，
 *   因此不需要任何 Header 规则注入（本适配器刻意不声明 HEADER_RULES）。
 * - 正文以 HTML 提交；接口只认「压缩过标签间空白」的字符串。
 * - 图片接口回传的是**相对路径**，必须自行拼上 CDN 前缀才是可用的图片地址。
 * - 草稿语义由 `newsBasic.status = 4` 承载：请求体里没有任何发布动作，
 *   适配器也不调用任何提交/发布接口，产出的始终是草稿。
 */
import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'

/** 开放平台接口根地址 */
const OPEN_API = 'https://mp-fe-pc.focus.cn'
/** 登录态探测 */
const AUTH_API = `${OPEN_API}/user/status`
/** 稿件保存（新建草稿） */
const PUBLISH_API = `${OPEN_API}/news/info/publishNewsInfo`
/** 正文图片上传（type=2 为正文图） */
const IMAGE_API = `${OPEN_API}/common/image/upload?type=2`
/** 图片 CDN 前缀：接口只回相对路径，如 `/p-1.png` */
const IMAGE_CDN = 'https://t-img.51f.com/sh740wsh'
/** 稿件详情页（回跳地址） */
const NEWS_DETAIL_PAGE = 'https://mp.focus.cn/fe/index.html#/info/subinfo/'
/** 未登录的统一文案：平台侧异常一律收敛为它，不向调用方暴露底层错误 */
const NOT_LOGGED_IN = '未登录'
/** 草稿标记位（取值枚举平台侧未公开，原样沿用） */
const DRAFT_STATUS = 4

/** `/user/status` 回包 */
interface UserStatusResponse {
  data?: {
    uid?: string
    accountName?: string
  }
}

/** `/news/info/publishNewsInfo` 回包 */
interface NewsSaveResponse {
  data?: {
    id?: string
  }
}

/** `/common/image/upload` 回包 */
interface ImageUploadResponse {
  code?: number
  data?: string
}

export class SohufocusAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohufocus',
    name: '搜狐焦点',
    icon: 'https://mp.focus.cn/favicon.ico',
    homepage: 'https://mp.focus.cn/fe/index.html#/info/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
  }

  /**
   * 登录态判定：`data.uid` 有值即视为已登录。
   *
   * 平台只要求带 cookie，因此这里是同源裸请求（不加 method/header），
   * 也不做 `response.ok` 判定：状态码与业务未登录一律由同一文案收敛。
   * 无论是业务上未登录还是网络/解析故障，都不向调用方区分。
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(AUTH_API, { credentials: 'include' })
      const payload = (await response.json()) as UserStatusResponse
      const uid = payload?.data?.uid
      if (!uid) return { isAuthenticated: false, error: NOT_LOGGED_IN }
      return {
        isAuthenticated: true,
        userId: uid,
        username: payload.data?.accountName,
      }
    } catch {
      return { isAuthenticated: false, error: NOT_LOGGED_IN }
    }
  }

  /**
   * 保存为草稿。
   * 正文优先取 `html`；本平台是少数同时容忍 markdown 兜底的平台之一。
   */
  async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const startedAt = Date.now()
    try {
      const raw = article.html || article.markdown || ''
      const content = await this.compressForEditor(raw)

      const response = await this.runtime.fetch(PUBLISH_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildDraft(article.title, content)),
      })

      const payload = (await response.json()) as NewsSaveResponse
      const newsId = payload?.data?.id
      if (!newsId) throw new Error('发布失败')

      return this.createResult(true, {
        postId: newsId,
        postUrl: `${NEWS_DETAIL_PAGE}${newsId}`,
        draftOnly: true,
        timestamp: startedAt,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
        timestamp: startedAt,
      })
    }
  }

  /**
   * 上传正文图片，返回带 CDN 前缀的完整地址。
   *
   * 原图同样走运行时通道下载（同源，无需附加头，也不判定 `ok`——下载失败由
   * 基类 `processImages` 逐图兜住）。回包 `code !== 200` 与 `data` 缺失都视为失败并抛出。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const download = await this.runtime.fetch(src)
    const blob = await download.blob()

    const formData = new FormData()
    formData.append('image', blob, `${Date.now()}.jpg`)

    const response = await this.runtime.fetch(IMAGE_API, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const payload = (await response.json()) as ImageUploadResponse
    if (payload?.code !== 200) throw new Error('上传图片未成功')

    return { url: `${IMAGE_CDN}${payload.data}` }
  }

  /**
   * 编辑器只接受「标签之间没有空白」的 HTML：上传图片后统一压缩一次。
   */
  private async compressForEditor(markup: string): Promise<string> {
    const uploaded = await this.processImages(markup, (src) => this.uploadImageByUrl(src))
    return uploaded.replace(/>\s+</g, '><')
  }

  /**
   * 稿件请求体。
   *
   * `cityId`/`category` 为平台固定取值，`headImg`/`newsAbstract` 留空表示不设头图与摘要；
   * `projectIds`/`videoIds` 留空表示不关联楼盘与视频。
   * 唯一带业务含义的是 `status`：草稿位，不带任何发布动作。
   */
  private buildDraft(title: string, content: string) {
    return {
      projectIds: [],
      newsBasic: {
        id: '',
        cityId: 0,
        title,
        category: 1,
        headImg: '',
        newsAbstract: '',
        isGuide: 0,
        status: DRAFT_STATUS,
      },
      newsContent: { content },
      videoIds: [],
    }
  }
}
