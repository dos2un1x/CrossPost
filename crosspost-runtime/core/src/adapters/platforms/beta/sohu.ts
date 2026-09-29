/**
 * 搜狐号（mp.sohu.com）适配器。
 *
 * 整条链路都是 HTTP，不需要标签页、也不需要页面注入：登录态探测、草稿写入、正文配图转存
 * 全部经 `runtime.fetch`（只有「把源图抓下来」这一步例外，它直接对图片地址发请求）。
 *
 * 搜狐号有三处与别家不同的规矩，都在下面逐条落地：
 *
 * 1. **登录接口的成功码是 `2000000`**。写成 0 或 200 都会让 `checkAuth` 永远返回未登录，
 *    因此它被提成具名常量，不做任何「兼容多个码」的猜测。
 * 2. **写草稿必须带 `dv-id` 与 `sp-cm` 两个自定义头**。`dv-id` 是设备指纹，实例创建时
 *    生成一次并在本实例的每次发布里复用；`sp-cm` 是客户端埋点串，优先照抄 cookie
 *    `mp-cv`，取不到就本地按 `100-<毫秒时间戳>-<32 位十六进制>` 兜底生成。两者都不进表单。
 * 3. **一个登录态下可能挂着多个子账号**，接口只按第 0 组判「有没有登录」，取用其中的第一个；
 *    子账号多于一个时，返回给上层展示的名字会附一句「共N个子账号」，否则只给昵称。
 *
 * 发布恒为草稿：只调 `news/draft/v2`（v2 草稿接口）且 `id` 固定为 0（新建），请求体里没有
 * 任何提交审核/定时的字段，因此适配器没有「发布」这条路可走。
 */
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const log = createLogger('sohu-adapter')

/** 账号列表接口：带缓存破坏参数，防止代理/浏览器回放上一次的登录态 */
const ACCOUNT_API = 'https://mp.sohu.com/mpbp/bp/account/list'

/** 图片外链转存接口 */
const IMAGE_API = 'https://mp.sohu.com/commons/front/outerUpload/image/file'

/** 草稿 v2 接口；查询串与请求体都要带 accountId */
const DRAFT_API = 'https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2'

/** 草稿写成功后回跳的编辑页（后面拼 `&id=<草稿 id>`） */
const DRAFT_EDITOR =
  'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2'

/** 登录接口唯一确证的成功码 */
const LIST_OK_CODE = 2000000

/** 搜狐号图床上的图不必再转存一次 */
const OWN_HOST = 'sohu.com'

/** 上传到图床时统一使用的文件名与表单字段名 */
const UPLOAD_FILENAME = 'image.jpg'

/** 账号列表回包里的一个子账号 */
interface SohuAccount {
  id: string
  nickName?: string
  avatar?: string
}

/** 账号列表回包（`data.data` 是账号分组，每组各挂若干子账号） */
interface SohuAccountList {
  code?: number
  data?: { data?: Array<{ accounts?: SohuAccount[] }> }
}

/** 草稿接口回包：`data` 直接就是新建草稿的 id */
interface SohuDraftReply {
  success?: unknown
  data?: unknown
  msg?: string
}

/** 图床回包 */
interface SohuImageReply {
  url?: string
  msg?: string
}

/** 随机设备指纹：32 位小写十六进制，每次抽取一个十六进制位 */
function makeDeviceId(): string {
  let id = ''
  for (let i = 0; i < 32; i += 1) {
    id += Math.floor(Math.random() * 16).toString(16)
  }
  return id
}

/** 异常 → 可读文案 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把各账号组里的子账号按出现顺序摊平；组缺失或没有 accounts 字段时跳过该组 */
function flattenAccounts(groups: Array<{ accounts?: SohuAccount[] }>): SohuAccount[] {
  const all: SohuAccount[] = []
  for (const group of groups) {
    if (group?.accounts) all.push(...group.accounts)
  }
  return all
}

/** 子账号多于一个时给昵称补一句说明，便于上层区分当前用的是哪个 */
function displayName(account: SohuAccount, total: number): string | undefined {
  return total > 1 ? `${account.nickName} (共${total}个子账号)` : account.nickName
}

export class SohuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohu',
    name: '搜狐号',
    icon: 'https://mp.sohu.com/favicon.ico',
    homepage: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
  }

  /** 浏览器不允许页面自己写 Origin/Referer，只能经请求头规则注入；仅发布期间生效 */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.sohu.com/*',
      headers: {
        Origin: 'https://mp.sohu.com',
        Referer: 'https://mp.sohu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 设备指纹：实例创建时抽一次，之后固定 */
  private readonly deviceId: string = makeDeviceId()

  /** 客户端埋点串：探测到登录态时解析一次，之后的发布复用同一个值 */
  private clientMark = ''

  /** 当前在用的子账号；为空表示还没探测到登录态 */
  private current: SohuAccount | null = null

  /**
   * 探测登录态。
   *
   * 「确实没登录」返回 `{isAuthenticated:false}`（不带 error）；只有请求/解析真的出错时
   * 才带 `error`。解析出账号后顺带把 `sp-cm` 备好，取 cookie 的失败只降级不抛出。
   */
  override async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(`${ACCOUNT_API}?_=${Date.now()}`, {
        method: 'GET',
        credentials: 'include',
      })
      const payload = (await response.json()) as SohuAccountList

      // 判定只看第 0 组：它没有子账号就当作没登录，后面的组不参与判定
      const groups = payload?.data?.data ?? []
      if (payload?.code !== LIST_OK_CODE || (groups[0]?.accounts?.length ?? 0) === 0) {
        log.debug('账号列表未给出可用账号')
        return { isAuthenticated: false }
      }

      const accounts = flattenAccounts(groups)
      const account = accounts[0]
      this.current = { id: account.id, nickName: account.nickName, avatar: account.avatar }
      this.clientMark = await this.readClientMark()
      log.debug(`当前账号 ${account.nickName}（id=${account.id}），可选 ${accounts.length} 个`)

      return {
        isAuthenticated: true,
        userId: String(account.id),
        username: displayName(account, accounts.length),
        avatar: account.avatar,
      }
    } catch (error) {
      log.warn('登录态探测失败', error)
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /**
   * 保存草稿。
   *
   * 顺序固定：先挂请求头规则 → 必要时补一次登录态探测 → 转存正文配图 → 写草稿。
   * 任何一步失败都收敛成 `success:false`，失败结果里只有 `error`。
   */
  override async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        let account = this.current
        if (account === null) {
          const auth = await this.checkAuth()
          account = this.current
          if (!auth.isAuthenticated || account === null) {
            throw new Error('搜狐号还没登录，先登录再发布')
          }
        }

        const content = await this.processImages(
          article.html || '',
          (src) => this.uploadImageByUrl(src),
          { skipPatterns: [OWN_HOST], onProgress: options?.onImageProgress },
        )

        const response = await this.runtime.fetch(`${DRAFT_API}?accountId=${account.id}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'dv-id': this.deviceId,
            'sp-cm': this.clientMark,
          },
          body: JSON.stringify({
            title: article.title,
            brief: '',
            content,
            channelId: 24,
            categoryId: -1,
            id: 0,
            userColumnId: 0,
            columnNewsIds: [],
            businessCode: 0,
            declareOriginal: false,
            cover: '',
            topicIds: [],
            isAd: 0,
            userLabels: '[]',
            reprint: false,
            customTags: '',
            infoResource: 0,
            sourceUrl: '',
            visibleToLoginedUsers: 0,
            attrIds: [],
            auto: true,
            accountId: Number(account.id),
          }),
        })

        const reply = (await response.json()) as SohuDraftReply
        if (!reply?.success) throw new Error(reply?.msg || '搜狐号草稿没保存成功')

        const postId = String(reply.data)
        log.debug(`草稿已写入，id=${postId}`)
        return this.createResult(true, {
          postId,
          postUrl: `${DRAFT_EDITOR}&id=${postId}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      log.error('保存搜狐号草稿失败', error)
      return this.createResult(false, { error: reasonOf(error) })
    }
  }

  /**
   * 把正文里的一张外链图转存到搜狐号图床。
   *
   * 下载走全局 `fetch`（不是 `runtime.fetch`）并判 `ok`；上传走 `runtime.fetch` 的
   * multipart 表单，**不带** `dv-id`/`sp-cm`（那是发布接口专用的头）。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const account = this.current
    if (account === null) throw new Error('搜狐号还没登录，无法转存图片')

    const downloaded = await fetch(src)
    if (!downloaded.ok) {
      throw new Error(`抓取原图失败（HTTP ${downloaded.status}）`)
    }
    const blob = await downloaded.blob()

    const form = new FormData()
    form.append('file', new File([blob], UPLOAD_FILENAME, { type: blob.type }))
    form.append('accountId', account.id)

    const response = await this.runtime.fetch(`${IMAGE_API}?accountId=${account.id}`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const reply = (await response.json()) as SohuImageReply
    if (!reply?.url) {
      throw new Error(`图床未返回地址：${reply?.msg ?? ''}`)
    }
    return { url: reply.url }
  }

  /**
   * 备好 `sp-cm`：cookie `mp-cv` 里有就照抄，没有（或读 cookie 本身出错）就本地生成。
   * 三条路径都只影响请求头，不影响登录判定。
   */
  private async readClientMark(): Promise<string> {
    if (this.runtime.getCookie) {
      try {
        const cached = await this.runtime.getCookie('.sohu.com', 'mp-cv')
        if (cached) {
          log.debug('sp-cm 取自 mp-cv cookie')
          return cached
        }
        log.debug('cookie 里没有 mp-cv，改为本地生成 sp-cm')
      } catch (error) {
        log.warn('读取 mp-cv cookie 失败，改为本地生成 sp-cm', error)
      }
    } else {
      log.debug('运行时没有读取 cookie 的能力，改为本地生成 sp-cm')
    }
    return `100-${Date.now()}-${makeDeviceId()}`
  }
}
