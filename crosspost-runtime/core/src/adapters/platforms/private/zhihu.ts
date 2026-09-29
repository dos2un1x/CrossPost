/**
 * 知乎（zhihu）适配器。
 *
 * 这条通道只写草稿，且固定三步：**先建空草稿 → 再换正文图片 → 最后回填正文**。
 * 顺序不能换：回填接口的地址里带草稿 id，草稿不存在时它只会回 404。
 *
 * 两处平台侧的既定事实，改了就发不出去：
 *
 * 1. 正文里的外链图**不落本机**：把原始 URL 交给转存接口，由知乎自己去抓。
 *    只有 `data:` 形式的图片与本地 Blob 才走「MD5 探活 → 取直传凭证 → OSS 直传」这条链。
 * 2. 直传签名是手写的 OSS V1：签名里的 bucket 叫 `zhihu-pics`，而请求落在
 *    `zhihu-pics-upload.zhimg.com` 上，两者**故意不一致**，不要"顺手对齐"。
 */

import jsMd5 from 'js-md5'
import { createLogger } from '../../../lib/logger'
import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import type { PublishOptions } from '../../types'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'

const log = createLogger('zhihu')

/**
 * `js-md5` 的类型声明把导出写成一个带同名成员的对象，可它的 CJS 主体本身就是那个函数
 * （`module.exports = md5`）。这里按运行时形态取一个可调用别名。
 */
const md5 = jsMd5 as unknown as (input: ArrayBuffer) => string

/** 知乎的写接口都要求这个头，缺了会被当成 CSRF 风险请求挡下 */
const XHR_HEADER: Record<string, string> = { 'x-requested-with': 'fetch' }
/** 请求头规则只对扩展自己发出的 XHR 生效 */
const XHR_RESOURCES: string[] = ['xmlhttprequest']

/**
 * 图片已经躺在知乎自家图床上时不必重传。后四条是第一条的子串，
 * 属于平台约定的冗余写法，保留原样以免改变匹配面。
 */
const OWN_IMAGE_HOSTS: string[] = [
  'zhimg.com',
  'pic1.zhimg.com',
  'pic2.zhimg.com',
  'pic3.zhimg.com',
  'pic4.zhimg.com',
]

const PROFILE_API = 'https://www.zhihu.com/api/v4/me'
/** 新建草稿的入口 */
const DRAFT_API = 'https://zhuanlan.zhihu.com/api/articles/drafts'
/** 按 URL 转存外链图 */
const REPOST_API = 'https://zhuanlan.zhihu.com/api/uploaded_images'
/** 图床探活与直传凭证 */
const IMAGE_API = 'https://api.zhihu.com/images'
/** 直传落点：域名与签名用的 bucket 不同（见文件头说明） */
const OSS_UPLOAD_HOST = 'https://zhihu-pics-upload.zhimg.com'
const OSS_BUCKET = 'zhihu-pics'
const OSS_RULE_FILTER = '*://zhihu-pics-upload.zhimg.com/*'
/** OSS SDK 的固定标识，平台按它放行；不要跟着真实依赖版本改 */
const OSS_USER_AGENT = 'aliyun-sdk-js/6.8.0'
const ZHIHU_ORIGIN = 'https://zhuanlan.zhihu.com'
/** 成品图 CDN 前缀 */
const CDN_PREFIX = 'https://pic4.zhimg.com/'
/** 图片探活：轮询间隔与轮次上限 */
const POLL_INTERVAL_MS = 1000
const POLL_LIMIT = 10

const draftBodyUrl = (id: string): string => `https://zhuanlan.zhihu.com/api/articles/${id}/draft`
const draftEditUrl = (id: string): string => `https://zhuanlan.zhihu.com/p/${id}/edit`
const imageStateUrl = (id: string): string => `${IMAGE_API}/${id}`

/**
 * 知乎表格模板的两个结构属性。它们挂在 `data-draft-` 前缀上，因此天然活过正文清理那一步；
 * 非 draft 前缀的表格属性（例如 `data-size` / `data-row-style`）会被那一步清掉。
 */
const TABLE_TEMPLATE_ATTRS = `data-draft-node="block" data-draft-type="table"`

/** 一段 `<table>…</table>`（不跨表匹配） */
const TABLE_BLOCK = /<table[\s\S]*?<\/table>/gi
/** 包住整张表的 `<figure>`，知乎不需要它 */
const FIGURED_TABLE = /<figure[^>]*>\s*(<table[\s\S]*?<\/table>)\s*<\/figure>/gi
/** 正文图片：只认双引号写的**非空** `src`；空 `src` 连平台自己都不认，不套 figure */
const IMAGE_TAG = /<img[^>]*src="[^"]+"[^>]*>/gi
/** 代码块开标签：语言必须是 class 里**唯一**的一段（带额外 class 的不动） */
const CODE_OPEN_TAG = /<pre><code class="language-(\w+)">/gi
/** 行内样式：知乎草稿不吃 `style`（只认双引号、等号两侧不能有空格） */
const STYLE_ATTR = /\s*style="[^"]*"/gi
/** `data-*` 里只有 `data-draft*` 一族是保留的，其余整段（含前导空白）删掉 */
const DATA_ATTR = /\s*data-(?!draft)[\w-]+="[^"]*"/gi
const THEAD_BLOCK = /<thead[^>]*>([\s\S]*?)<\/thead>/i
const TBODY_BLOCK = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i
const TABLE_SHELL = /^<table[^>]*>|<\/table>$/gi
const TABLE_ROW = /<tr[\s\S]*?<\/tr>/i
const BODY_TAGS = /<\/?tbody[^>]*>/gi
const HEAD_CELL = /<td([\s>])/gi
const HEAD_CELL_END = /<\/td>/gi

/** 图床探活回包 */
interface ImageTicket {
  upload_file: { state: number; image_id: string; object_key: string }
  upload_token: { access_id: string; access_key: string; access_token: string }
}

/** 探活轮询回包 */
interface ImageState {
  status?: string
  original_hash?: string
}

/** 任何异常都要收敛成一句话：结果对象的 `error` 只接受字符串 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 回包正文只进日志，先截断免得把整页 HTML 灌进去 */
function brief(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** HMAC-SHA1 → Base64。Web Crypto 给的是 ArrayBuffer，`btoa` 只吃二进制串 */
async function hmacSha1(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const raw = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  let binary = ''
  for (const byte of new Uint8Array(raw)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 规范化 OSS 头：三个头按名排序、逐行 `键:值`，**末尾不留换行**
 * —— 分隔符由待签串负责补，写重了签名就对不上。
 */
function canonicalOssHeaders(date: string, securityToken: string): string {
  return [
    `x-oss-date:${date}`,
    `x-oss-security-token:${securityToken}`,
    `x-oss-user-agent:${OSS_USER_AGENT}`,
  ].join('\n')
}

/**
 * 把任意来源的 `<table>` 重排成知乎草稿认得的形状：表头段 + 表体段，
 * 外面套固定模板属性。
 *
 * 取值规则：表头取 `<thead>` 的内容（里面的 `td` 一律改写成 `th`）；
 * 表体有 `<tbody>` 就只取它，否则取「整张表去掉表头块、去掉表壳」的剩余部分
 * —— 也就是说表头块不会在表体里重复出现，而 `<tfoot>` 之类会原样留在表体里。
 * 没有 `<thead>` 时，若表体第一行只有 `th` 没有 `td`，把它提为表头行。
 */
function rebuildTable(table: string): string {
  const headBlock = THEAD_BLOCK.exec(table)
  const bodyBlock = TBODY_BLOCK.exec(table)

  let head = headBlock ? headBlock[1] : ''
  let rows = bodyBlock
    ? bodyBlock[1]
    : table.replace(THEAD_BLOCK, '').replace(BODY_TAGS, '').replace(TABLE_SHELL, '')

  // 稿子里在 thead 内写 td 的很多，知乎只认 th
  head = head.replace(HEAD_CELL, '<th$1').replace(HEAD_CELL_END, '</th>')

  if (!headBlock) {
    const first = TABLE_ROW.exec(rows)
    if (first && /<th[\s>]/i.test(first[0]) && !/<td[\s>]/i.test(first[0])) {
      head = first[0]
      rows = rows.replace(first[0], '')
    }
  }

  return `<table ${TABLE_TEMPLATE_ATTRS}><tbody>${head}${rows}</tbody></table>`
}

export class ZhihuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'zhihu',
    name: '知乎',
    icon: 'https://static.zhihu.com/static/favicon.ico',
    homepage: 'https://www.zhihu.com',
    capabilities: ['article', 'draft', 'image_upload', 'tags', 'cover'],
  }

  /**
   * 知乎的正文全部走 HTML 通道；下列开关由发布链路的 HTML 预处理器消费，
   * 适配器只负责声明（含知乎特有的 section/代码块/嵌套 figure 那几项）。
   */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
    convertSectionToDiv: true,
    removeTrailingBr: true,
    unwrapSingleChildContainers: true,
    unwrapNestedFigures: true,
    compactHtml: true,
    removeEmptyLines: true,
    removeEmptyDivs: true,
    removeNestedEmptyContainers: true,
  }

  /** 三条静态规则：覆盖主站、专栏与图床 API 三个域；第四条直传规则是临时挂的 */
  readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    { urlFilter: '*://www.zhihu.com/api/*', headers: XHR_HEADER, resourceTypes: XHR_RESOURCES },
    {
      urlFilter: '*://zhuanlan.zhihu.com/api/*',
      headers: XHR_HEADER,
      resourceTypes: XHR_RESOURCES,
    },
    { urlFilter: '*://api.zhihu.com/*', headers: XHR_HEADER, resourceTypes: XHR_RESOURCES },
  ]

  /** 登录态：主站 `me` 接口回包里有 `id` 就算登录 */
  override async checkAuth(): Promise<AuthResult> {
    return this.checkAuthWithRules(
      PROFILE_API,
      (payload) => {
        const user = payload as { id?: string; name?: string; avatar_url?: string } | null
        if (!user || !user.id) return null
        return {
          isAuthenticated: true,
          userId: user.id,
          username: user.name,
          avatar: user.avatar_url,
        }
      },
      { headerRules: this.HEADER_RULES, headers: XHR_HEADER },
    )
  }

  override async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, () => this.saveDraft(article, options))
    } catch (error) {
      log.error('知乎草稿未能存下', reasonOf(error))
      return this.createResult(false, { error: reasonOf(error) })
    }
  }

  /** 建草稿 → 换图 → 回填正文；任一步失败都由 `publish` 兜成失败结果 */
  private async saveDraft(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const draftId = await this.openDraft(article.title)
    const content = await this.rehostImages(article.html || '', options?.onImageProgress)
    await this.fillBody(draftId, article.title, content)
    return this.createResult(true, {
      postId: draftId,
      postUrl: draftEditUrl(draftId),
      draftOnly: options?.draftOnly ?? true,
    })
  }

  /**
   * 第 1 步：建一篇只有标题的空草稿，拿回草稿 id。
   * 回包先取文本再判状态码 —— 失败时正文要能进错误文案，成功时它应当是可解析的 JSON。
   */
  private async openDraft(title: string): Promise<string> {
    const response = await this.runtime.fetch(DRAFT_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...XHR_HEADER },
      body: JSON.stringify({ title, content: '', delta_time: 0 }),
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`建草稿失败：HTTP ${response.status}，回包 ${brief(raw)}`)
    }

    let created: { id?: string }
    try {
      created = JSON.parse(raw) as { id?: string }
    } catch {
      throw new Error(`建草稿回包解析失败：${brief(raw)}`)
    }
    if (!created.id) throw new Error('建草稿回包没有草稿 id')
    return created.id
  }

  /** 第 3 步：把整形好的正文写回草稿。成功路径不解析回包（PATCH 可能是空响应） */
  private async fillBody(draftId: string, title: string, content: string): Promise<void> {
    const response = await this.runtime.fetch(draftBodyUrl(draftId), {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...XHR_HEADER },
      body: JSON.stringify({ title, content }),
    })
    if (!response.ok) {
      log.warn('回填正文被拒', response.status, brief(await response.text()))
      throw new Error(`回填正文失败：HTTP ${response.status}`)
    }
  }

  /** 第 2 步 + 正文整形：先把正文里的图换掉，再按知乎的正文结构过一遍 */
  private async rehostImages(
    html: string,
    onProgress?: PublishOptions['onImageProgress'],
  ): Promise<string> {
    const rehosted = await this.processImages(html, (src) => this.uploadImageByUrl(src), {
      skipPatterns: OWN_IMAGE_HOSTS,
      onProgress,
    })
    return this.toZhihuBody(rehosted)
  }

  /**
   * 正文整形（顺序固定，且必须在换图之后）：
   * 表格重排 → 图片套 figure → 代码块改写成 `lang` → 清 `data-*` → 清 `style`。
   * `DATA_ATTR` 自带 `data-draft` 的负向断言，表格模板与草稿节点因此原样留下。
   */
  private toZhihuBody(html: string): string {
    return html
      .replace(FIGURED_TABLE, '$1')
      .replace(TABLE_BLOCK, (table: string) => rebuildTable(table))
      .replace(IMAGE_TAG, (tag: string) => `<figure>${tag}</figure>`)
      .replace(CODE_OPEN_TAG, '<pre lang="$1"><code>')
      .replace(DATA_ATTR, '')
      .replace(STYLE_ATTR, '')
  }

  /**
   * 按地址转存一张图。
   * · http(s)：不下载字节，交给知乎的转存接口；
   * · `data:`：本机取字节，走图床直传链路。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (src.startsWith('data:')) {
      const fetched = await fetch(src)
      return this.pushBinary(await fetched.blob())
    }

    const response = await this.runtime.fetch(REPOST_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...XHR_HEADER },
      body: new URLSearchParams({ url: src, source: 'article' }),
    })
    const reposted = (await response.json()) as { src?: string }
    if (!reposted.src) throw new Error('转存接口没有回图片地址')
    return { url: reposted.src }
  }

  /** CLI 的「上传本地图片」命令直接调它：本地字节不走 data URI，直接进直传链路 */
  override async uploadImage(file: Blob, _filename?: string): Promise<string> {
    const uploaded = await this.pushBinary(file)
    return uploaded.url
  }

  /**
   * 本地字节 → 图床。先用整段字节的 MD5 探活：
   * · 命中（`state === 1`）说明图已存在，轮询到处理完成取哈希；
   * · 未命中则拿凭证直传 OSS，用 object_key 拼成品地址。
   */
  private async pushBinary(blob: Blob): Promise<ImageUploadResult> {
    const ticket = await this.requestTicket(md5(await blob.arrayBuffer()))
    const file = ticket.upload_file

    if (file.state === 1) {
      const hash = await this.awaitImage(file.image_id)
      return { url: `${CDN_PREFIX}${hash}` }
    }

    // 直传的对象名就是平台下发的 object_key（动图也不例外）；
    // `image/gif` 只在拼**成品地址**时补后缀，让 CDN 按动图回源
    await this.directUpload(file.object_key, blob, ticket.upload_token)
    const suffix = blob.type === 'image/gif' ? '.gif' : ''
    return { url: `${CDN_PREFIX}${file.object_key}${suffix}` }
  }

  /** 探活：回包给出直传所需的一切（是否已存在、object_key、临时凭证） */
  private async requestTicket(imageHash: string): Promise<ImageTicket> {
    const response = await this.runtime.fetch(IMAGE_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_hash: imageHash, source: 'article' }),
    })
    return (await response.json()) as ImageTicket
  }

  /** 图片已存在时等平台处理完；超时不重试，交给上层按单图失败吞掉 */
  private async awaitImage(imageId: string): Promise<string> {
    for (let round = 0; round < POLL_LIMIT; round += 1) {
      const response = await this.runtime.fetch(imageStateUrl(imageId), {
        credentials: 'include',
      })
      const state = (await response.json()) as ImageState
      if (state.status === 'completed' || state.original_hash) {
        return state.original_hash ?? ''
      }
      await this.delay(POLL_INTERVAL_MS)
    }
    throw new Error('知乎图床处理超时')
  }

  /** OSS V1 直传：手写待签串 → HMAC-SHA1 → `Authorization: OSS <id>:<签名>` */
  private async directUpload(
    objectKey: string,
    blob: Blob,
    token: ImageTicket['upload_token'],
  ): Promise<void> {
    const contentType = blob.type || 'application/octet-stream'
    const date = new Date().toUTCString()
    const signature = await hmacSha1(
      token.access_key,
      [
        'PUT',
        '',
        contentType,
        date,
        canonicalOssHeaders(date, token.access_token),
        `/${OSS_BUCKET}/${objectKey}`,
      ].join('\n'),
    )

    // Origin / Referer 只能经请求头规则注入，规则的作用域就是这一次 PUT
    const ruleId = await this.openDirectRule()
    try {
      const response = await this.runtime.fetch(`${OSS_UPLOAD_HOST}/${objectKey}`, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          Authorization: `OSS ${token.access_id}:${signature}`,
          'x-oss-date': date,
          'x-oss-security-token': token.access_token,
          'x-oss-user-agent': OSS_USER_AGENT,
        },
        body: blob,
      })
      if (!response.ok) {
        log.warn('图床直传被拒', response.status, brief(await response.text()))
        throw new Error(`图床直传失败：HTTP ${response.status}`)
      }
    } finally {
      await this.closeDirectRule(ruleId)
    }
  }

  /**
   * 临时挂一条直传域名的规则，并**绕开基类的句柄栈**：
   * 它的生命周期只有一次 PUT，由 `finally` 就地撤销，不参与外层的作用域收尾。
   */
  private async openDirectRule(): Promise<string | null> {
    const injector = this.runtime.headerRules
    if (!injector) return null
    return injector.add({
      urlFilter: OSS_RULE_FILTER,
      headers: { Origin: ZHIHU_ORIGIN, Referer: `${ZHIHU_ORIGIN}/` },
      resourceTypes: XHR_RESOURCES,
    })
  }

  /** 撤销直传规则；没挂上（运行时无此能力）时是 no-op */
  private async closeDirectRule(ruleId: string | null): Promise<void> {
    if (ruleId === null) return
    const injector = this.runtime.headerRules
    if (!injector) return
    await injector.remove(ruleId)
  }
}
