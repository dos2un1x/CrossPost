/**
 * 微信公众号（mp.weixin.qq.com）适配器 —— 走编辑器网页通道，**只建草稿**。
 *
 * 草稿由「新增图文素材」接口（`operate_appmsg` + `sub=create` + `type=77`）落库：
 * 请求体里 `AppMsgId` 留空、没有任何群发/发表字段，服务端回一个素材 id，编辑器里
 * 就是一篇未群发的图文。适配器不碰任何群发接口，因此产物恒为草稿。
 *
 * 三件与别的平台不同的事：
 *
 * 1. **登录态来自首页 HTML**：`mp.weixin.qq.com/` 的脚本里内联了一份 `cgiData`，
 *    `token` / `ticket` / `user_name` 等发布与上传要用的凭据全在里面，只能正则抠出来；
 * 2. **上传接口把凭据摊在查询串上**：`filetransfer` 需要 `ticket_id` + `ticket` +
 *    `svr_time` + `token` 四项齐备，缺一项不会本地报错，只会拿到平台错误码；
 * 3. **正文要自带样式**：公众号编辑器不认外部样式表，正文必须以行内 `style` 落地，
 *    所以这里包一层 `<section>` 再用 juice 把默认排版表内联进去。
 */
import juice from 'juice'

import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'
import type { PreprocessConfig, PublishOptions } from '../../types'
import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import { createLogger } from '../../../lib/logger'

const log = createLogger('WeixinAdapter')

/** 登录态页面：脚本里内联 cgiData（token 等凭据的唯一来源） */
const HOME_PAGE = 'https://mp.weixin.qq.com/'
/** 新增图文素材（= 建草稿）；`AppMsgId` 为空即新建 */
const DRAFT_API = 'https://mp.weixin.qq.com/cgi-bin/operate_appmsg'
/** 正文配图上传（素材上传通道） */
const MATERIAL_API = 'https://mp.weixin.qq.com/cgi-bin/filetransfer'
/** 建完草稿后的编辑页（回给调用方的 postUrl） */
const EDITOR_API = 'https://mp.weixin.qq.com/cgi-bin/appmsg'

/** 已在公众号图床上的图片无需重传（正文里直接沿用） */
const OWN_IMAGE_HOSTS = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn']

/** 正文外层容器的行内样式（公众号正文的左右留白与行高） */
const BODY_FRAME_STYLE = 'margin-left: 6px; margin-right: 6px; line-height: 1.75em;'

/**
 * 默认正文排版表（15 条），交给 juice 内联成元素上的 `style`。
 *
 * 规则之间的先后顺序即层叠顺序：同一元素被多条规则命中时，靠后的声明覆盖靠前的，
 * 例如 `<li>` 里的 `<p>` 先用 `p` 的字号颜色、再用 `li p` 把外边距压成 0。
 * 每条规则内部声明的顺序同样会原样出现在 `style` 属性里，不要随意重排。
 */
const BODY_STYLE_SHEET = [
  // 段落：正文的基础字色、字号、行高与外边距
  'p { color: rgb(51, 51, 51); font-size: 15px; line-height: 1.75em; margin: 0 0 1em 0; }',
  // 标题族：先统一加粗，再按层级给字号与间距
  'h1, h2, h3, h4, h5, h6 { font-weight: bold; }',
  'h1 { font-size: 1.25em; line-height: 1.4em; margin: 1em 0 0.5em 0; }',
  'h2 { font-size: 1.125em; margin: 1em 0 0.5em 0; }',
  'h3 { font-size: 1.05em; margin: 0.8em 0 0.4em 0; }',
  'h4, h5, h6 { font-size: 1em; margin: 0.8em 0 0.4em 0; }',
  // 列表：条目里的段落不再另起间距，条目之间留一点呼吸
  'li p { margin: 0; }',
  'ul, ol { margin: 1em 0; padding-left: 2em; }',
  'li { margin-bottom: 0.4em; }',
  // 代码：等宽字体；代码块保留原始换行
  'pre, tt, code, kbd, samp { font-family: monospace; }',
  'pre { white-space: pre; margin: 1em 0; }',
  // 引用与分割线：用左侧竖线与浅灰横线区分层次
  'blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666; }',
  'hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }',
  // 行内语义：斜体与更重的加粗
  'i, cite, em, var, address { font-style: italic; }',
  'b, strong { font-weight: bolder; }',
].join('\n')

/** 首页脚本里 `data: { … t: "…" }` 的 token（跨行、非贪婪） */
const TOKEN_IN_PAGE = /data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/
const TICKET_IN_PAGE = /ticket:\s*["']([^"']*)["']/
const USER_NAME_IN_PAGE = /user_name:\s*["']([^"']*)["']/
const NICK_NAME_IN_PAGE = /nick_name:\s*["']([^"']*)["']/
const SVR_TIME_IN_PAGE = /time:\s*["']([^"']*)["']/
const HEAD_IMG_IN_PAGE = /head_img:\s*["']([^"']*)["']/
/** 头像优先用编辑器右上角那张（`class` 标出来的） */
const ACCOUNT_THUMB_IN_PAGE = /class="weui-desktop-account__thumb"[^>]*?src="([^"]+)"/

/** 公式判据：命中其一才认为 `$…$` / `$$…$$` 里装的真是公式，否则原样留着 */
const FORMULA_MARK = /[\\^_{}]|[α-ωΑ-Ω]|[∑∏∫∂∇∞≠≤≥±×÷√]/
/** 块级公式 */
const BLOCK_FORMULA = /\$\$([\s\S]+?)\$\$/g
/**
 * 行内公式（块级已先处理掉）。
 *
 * 取值片段不允许跨行、也不允许跨标签：正文里常有一枚孤立的 `$`（价签、变量名等），
 * 若允许跨标签，它就会和后面真正的行内公式配成一对，把公式整段吞进"非公式"分支里。
 */
const INLINE_FORMULA = /\$([^$<\n]+?)\$/g
/** 第三方公式渲染服务（`\dpi{…}` 是 URL 的一部分，不能二次编码） */
const FORMULA_RENDERER = 'https://latex.codecogs.com/png.latex?'

/** 站内链接与外链锚点 */
const ANCHOR_TAG = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

/** 发布回包（成功时只认 `appMsgId`） */
interface DraftReply {
  appMsgId?: string
  ret?: number
  base_resp?: { ret?: number; err_msg?: string }
}

/** 素材上传回包 */
interface MaterialReply {
  cdn_url?: string
  base_resp?: { ret?: number; err_msg?: string }
}

/** 登录态缓存：checkAuth 成功后整份留下，发布与图片上传直接复用 */
interface AccountCache {
  token: string
  userName?: string
  nickName?: string
  ticket?: string
  svrTime?: number
  avatar?: string
}

/**
 * 平台错误码 → 人话。码值是平台事实，表述自撰；
 * 查不到的码走兜底文案（带上原始码，便于人工排查）。
 */
const FAILURE_HINTS: Readonly<Record<string, string>> = {
  '-6': '需要先在公众号后台输入验证码',
  '-8': '需要先在公众号后台输入验证码',
  '-1': '公众号系统错误，请备份正文后重试',
  '-2': '请求参数有误，平台拒绝受理',
  '-5': '公众号服务异常，稍后再试',
  '-99': '正文字数超出公众号上限',
  '-206': '公众号当前负荷过大，请稍后重试',
  '412': '图文里含有平台不允许的外链',
  '10806': '正文命中违规内容',
  '10807': '内容不符合公众平台协议',
  '200002': '请求参数有误，平台拒绝受理',
  '200003': '登录态已超时，需要重新登录',
  '62752': '链接可能被判定为安全风险链接',
  '64502': '填写的微信号不存在',
  '64505': '发送预览失败，请稍后重试',
  '64506': '保存失败：素材链接不合法',
  '64507': '正文不能包含外部链接',
  '64509': '正文里的视频超过 3 个',
  '64515': '素材不是最新版本，请重新打开编辑',
  '64562': '请勿插入非微信域名的链接',
  '64702': '标题超过 64 字',
  '64703': '摘要超过 120 字',
  '64705': '正文字数超出公众号上限',
  '220001': '素材存储数量已达上限',
  '220002': '图片库已达到存储上限',
}

/** 把异常收敛成可读文案 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取正则的第一个捕获组；没命中给 undefined */
function capture(page: string, pattern: RegExp): string | undefined {
  return pattern.exec(page)?.[1]
}

/** `http://` → `https://`（只做这一种替换，其余原样） */
function toHttps(url: string | undefined): string | undefined {
  if (!url || !url.startsWith('http://')) return url
  return `https://${url.slice('http://'.length)}`
}

/** 错误码取 `ret`，没有就退到 `base_resp.ret` */
function failureCode(reply: DraftReply): number | undefined {
  return reply.ret ?? reply.base_resp?.ret
}

/** 错误码 → 文案；未知码回兜底（带上码本身） */
function explainFailure(code: number | undefined): string {
  const key = String(code)
  return FAILURE_HINTS[key] ?? `同步到公众号失败（错误码 ${key}）`
}

/**
 * 建草稿的表单体：64 个字段，**顺序即插入顺序**（平台按位取值）。
 * 除了 token / 标题 / 正文，其余都是平台要求的固定字面量或空串。
 */
function draftForm(token: string, title: string, content: string): URLSearchParams {
  const rows: Array<[string, string]> = [
    ['token', token],
    ['lang', 'zh_CN'],
    ['f', 'json'],
    ['ajax', '1'],
    ['random', String(Math.random())],
    ['AppMsgId', ''],
    ['count', '1'],
    ['data_seq', '0'],
    ['operate_from', 'Chrome'],
    ['isnew', '0'],
    ['ad_video_transition0', ''],
    ['can_reward0', '0'],
    ['related_video0', ''],
    ['is_video_recommend0', '-1'],
    ['title0', title],
    ['author0', ''],
    ['writerid0', '0'],
    ['fileid0', ''],
    ['digest0', ''],
    ['auto_gen_digest0', '1'],
    ['content0', content],
    ['sourceurl0', ''],
    ['need_open_comment0', '1'],
    ['only_fans_can_comment0', '0'],
    ['cdn_url0', ''],
    ['cdn_235_1_url0', ''],
    ['cdn_1_1_url0', ''],
    ['cdn_url_back0', ''],
    ['crop_list0', ''],
    ['music_id0', ''],
    ['video_id0', ''],
    ['voteid0', ''],
    ['voteismlt0', ''],
    ['supervoteid0', ''],
    ['cardid0', ''],
    ['cardquantity0', ''],
    ['cardlimit0', ''],
    ['vid_type0', ''],
    ['show_cover_pic0', '0'],
    ['shortvideofileid0', ''],
    ['copyright_type0', '0'],
    ['releasefirst0', ''],
    ['platform0', ''],
    ['reprint_permit_type0', ''],
    ['allow_reprint0', ''],
    ['allow_reprint_modify0', ''],
    ['original_article_type0', ''],
    ['ori_white_list0', ''],
    ['free_content0', ''],
    ['fee0', '0'],
    ['ad_id0', ''],
    ['guide_words0', ''],
    ['is_share_copyright0', '0'],
    ['share_copyright_url0', ''],
    ['source_article_type0', ''],
    ['reprint_recommend_title0', ''],
    ['reprint_recommend_content0', ''],
    ['share_page_type0', '0'],
    ['share_imageinfo0', '{"list":[]}'],
    ['share_video_id0', ''],
    ['dot0', '{}'],
    ['share_voice_id0', ''],
    ['insert_ad_mode0', ''],
    ['categories_list0', '[]'],
  ]
  const form = new URLSearchParams()
  for (const [key, value] of rows) form.append(key, value)
  return form
}

export class WeixinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'weixin',
    name: '微信公众号',
    icon: 'https://mp.weixin.qq.com/favicon.ico',
    homepage: 'https://mp.weixin.qq.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://mp.weixin.qq.com/cgi-bin/*',
      headers: {
        Origin: 'https://mp.weixin.qq.com',
        Referer: 'https://mp.weixin.qq.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  readonly preprocessConfig: Partial<PreprocessConfig> = {
    outputFormat: 'html',
    removeLinks: true,
    keepLinkDomains: ['mp.weixin.qq.com', 'weixin.qq.com'],
    compactHtml: true,
  }

  /** 登录态缓存；只有 `checkAuth` 会写它 */
  private account: AccountCache | null = null

  /**
   * 读首页 HTML 判登录态。
   *
   * 这里**不判 `ok`**：凭据全在页面脚本里，401 或验证码页同样只是「抠不到 token」，
   * 结果是「未登录」而不是故障。抠不到 token 时**不建缓存**，也不带 `error` 字段。
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(HOME_PAGE, {
        method: 'GET',
        credentials: 'include',
      })
      const page = await response.text()
      const token = capture(page, TOKEN_IN_PAGE)
      if (!token) {
        log.warn('首页里没有解析出 token，按未登录处理')
        return { isAuthenticated: false }
      }

      const servedAt = capture(page, SVR_TIME_IN_PAGE)
      const account: AccountCache = {
        token,
        userName: capture(page, USER_NAME_IN_PAGE),
        nickName: capture(page, NICK_NAME_IN_PAGE),
        ticket: capture(page, TICKET_IN_PAGE),
        svrTime: servedAt ? Number(servedAt) : Date.now() / 1000,
        avatar: toHttps(
          capture(page, ACCOUNT_THUMB_IN_PAGE) || capture(page, HEAD_IMG_IN_PAGE) || '',
        ),
      }
      this.account = account
      log.info('已取得公众号登录态', account.nickName)

      return {
        isAuthenticated: true,
        userId: account.userName,
        username: account.nickName,
        avatar: account.avatar,
      }
    } catch (error) {
      log.error('公众号登录态探测失败', error)
      return { isAuthenticated: false, error: describe(error) }
    }
  }

  /** 建一篇图文草稿；任何失败都收敛成结果对象，不向调用方抛错 */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const account = await this.requireAccount()
        const content = await this.composeContent(article, options)
        return await this.createDraft(account, article, content, options)
      })
    } catch (error) {
      log.error('公众号草稿创建失败', error)
      return this.createResult(false, { error: describe(error) })
    }
  }

  /**
   * 把一张图片塞进公众号素材库，返回可直接写进正文的地址。
   *
   * 图片先经全局 `fetch` 抓成 Blob（这一步**判 `ok`**：404 页面当图片传上去没有意义），
   * 再按素材上传接口的表单形态提交。上传回包必须 `err_msg === 'ok'` **且**带 `cdn_url`，
   * 只满足一个都算失败；失败抛错，由 `processImages` 逐图吞掉、保留原地址。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const account = this.account
    if (!account) throw new Error('尚未取得公众号登录态，无法上传正文图片')

    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`下载图片未成功（HTTP ${response.status}）：${src}`)
    }
    const blob = await response.blob()

    const stamp = Date.now()
    const fileName = `${stamp}.jpg`
    const form = new FormData()
    form.append('type', blob.type || 'image/jpeg')
    form.append('id', String(stamp))
    form.append('name', fileName)
    form.append('lastModifiedDate', new Date().toString())
    form.append('size', String(blob.size))
    form.append('file', blob, fileName)

    const url =
      `${MATERIAL_API}?action=upload_material&f=json&scene=8&writetype=doublewrite` +
      `&groupid=1&ticket_id=${account.userName}&ticket=${account.ticket}` +
      `&svr_time=${account.svrTime}&token=${account.token}&lang=zh_CN` +
      `&seq=${Date.now()}&t=${Math.random()}`

    const reply = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const uploaded = (await reply.json()) as MaterialReply
    if (uploaded.base_resp?.err_msg !== 'ok' || !uploaded.cdn_url) {
      throw new Error(`上传图片未成功：${src}`)
    }
    return { url: uploaded.cdn_url }
  }

  // ───────────────────────── 内部实现 ─────────────────────────

  /** 登录态缓存为空时补一次探测；探测失败即视为不可发布 */
  private async requireAccount(): Promise<AccountCache> {
    const cached = this.account
    if (cached) return cached

    log.info('登录缓存为空，先补一次登录态探测')
    const auth = await this.checkAuth()
    if (!auth.isAuthenticated || !this.account) {
      throw new Error('公众号未登录，无法创建草稿')
    }
    return this.account
  }

  /** 正文来源分支 + 四步预处理 + 样式内联 */
  private async composeContent(article: Article, options?: PublishOptions): Promise<string> {
    const original = article as Article & { rawHtml?: string }

    // 公众号自己导出的原文（rawHtml）已经是成品：跳过公式/外链/图片/样式全部处理
    if (original.source?.platform === 'weixin' && original.rawHtml) {
      log.info('正文来自公众号自身，原样提交')
      return original.rawHtml
    }

    const stripped = this.stripForeignAnchors(this.expandFormulas(original.html || ''))
    const inlined = await this.processImages(stripped, (src) => this.uploadImageByUrl(src), {
      skipPatterns: OWN_IMAGE_HOSTS,
      onProgress: options?.onImageProgress,
    })
    const framed = `<section style="${BODY_FRAME_STYLE}">${inlined}</section>`
    return juice.inlineContent(framed, BODY_STYLE_SHEET)
  }

  /** 提交建草稿请求，并把回包翻译成结果 */
  private async createDraft(
    account: AccountCache,
    article: Article,
    content: string,
    options?: PublishOptions,
  ): Promise<SyncResult> {
    const url =
      `${DRAFT_API}?t=ajax-response&sub=create&type=77` + `&token=${account.token}&lang=zh_CN`

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: draftForm(account.token, article.title, content),
    })
    const reply = (await response.json()) as DraftReply

    // 只看素材 id：`ret` 非 0 但素材确实建出来的情况按成功算（平台的宽松语义）
    const mediaId = reply.appMsgId
    if (!mediaId) {
      throw new Error(explainFailure(failureCode(reply)))
    }

    return this.createResult(true, {
      postId: mediaId,
      postUrl:
        `${EDITOR_API}?t=media/appmsg_edit&action=edit&type=77` +
        `&appmsgid=${mediaId}&token=${account.token}&lang=zh_CN`,
      draftOnly: options?.draftOnly ?? true,
    })
  }

  /**
   * 把 `$…$` / `$$…$$` 换成第三方渲染服务的图片。
   *
   * 只有正文命中公式特征（LaTeX 控制符、希腊字母或数学符号）才替换，避免把正文里
   * 随手写的 `$` 当成公式；`latex` 先 trim 再整段 URL 编码。
   */
  private expandFormulas(html: string): string {
    if (!FORMULA_MARK.test(html)) return html

    const blocks = html.replace(BLOCK_FORMULA, (whole, latex: string) =>
      FORMULA_MARK.test(latex) ? this.renderFormula(latex, true) : whole,
    )
    return blocks.replace(INLINE_FORMULA, (whole, latex: string) =>
      FORMULA_MARK.test(latex) ? this.renderFormula(latex, false) : whole,
    )
  }

  /** 一个公式 → 一张图（块级另包一层居中段落） */
  private renderFormula(latex: string, block: boolean): string {
    const density = block ? 150 : 120
    const source = `${FORMULA_RENDERER}\\dpi{${density}}${encodeURIComponent(latex.trim())}`
    const image = `<img alt="formula" src="${source}" style="max-width: 100%; vertical-align: middle;" />`
    return block ? `<p style="text-align: center;">${image}</p>` : image
  }

  /**
   * 外链兜底：公众号不许正文带站外链接。
   * 站内域名、页内锚点与 `javascript:` 链接整段保留，其余只留文字、丢掉标签。
   */
  private stripForeignAnchors(html: string): string {
    return html.replace(ANCHOR_TAG, (whole: string, href: string, text: string) => {
      const keep =
        href.includes('mp.weixin.qq.com') ||
        href.includes('weixin.qq.com') ||
        href.startsWith('#') ||
        href.startsWith('javascript:')
      return keep ? whole : text
    })
  }
}
