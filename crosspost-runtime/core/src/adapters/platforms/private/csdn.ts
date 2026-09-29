/**
 * CSDN 适配器（技术社区 · 编辑器草稿通道）。
 *
 * 通道选择：CSDN 的编辑器把「保存草稿」做成 bizapi 网关上的一个接口，网关用
 * 阿里云 API 网关的 `x-ca-*` 方案做鉴权。这套方案里 `x-ca-key` / `x-ca-signature`
 * 由**编辑器前端页面自己下发的公开常量**算出，不是账号凭证；任何人都能从编辑器
 * 的 Network 面板抄到同一组值，所以它们在这里是硬编码的平台事实。
 *
 * 这里只做「存草稿」：保存接口本身带 `status:2` / `pubStatus:'draft'`，请求体里
 * 没有任何「提交审核 / 发布」字段，适配器也不去碰发布接口。
 */

import { CodeAdapter } from '../../code-adapter'
import type { ImageUploadResult } from '../../code-adapter'
import type { PlatformAdapter, PublishOptions } from '../../types'
import type { Article, AuthResult, HeaderRule, PlatformMeta, SyncResult } from '../../../types'

/** 网关下发的公开 key（编辑器前端页面常量，非个人凭证） */
const GATEWAY_KEY = '203803574'
/** 网关下发的公开 secret，用于 HMAC-SHA256 */
const GATEWAY_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'

/** 网关根域 */
const API_ORIGIN = 'https://bizapi.csdn.net'

/** 登录态 / 用户基本信息 */
const USER_INFO_PATH = '/blog-console-api/v3/editor/getBaseInfo'
/** 编辑器保存接口（草稿） */
const SAVE_ARTICLE_PATH = '/blog-console-api/v3/mdeditor/saveArticle'
/** 图片直传：取上传凭证 */
const UPLOAD_SIGN_PATH = '/resource-api/v1/image/direct/upload/signature'

/** 图床直传的落点标记（凭证回包里的 appName 用同一个值） */
const IMAGE_APP_NAME = 'direct_blog_markdown'

/** 编辑器域名：注入 Origin / Referer 时用它，回跳草稿也用它 */
const EDITOR_ORIGIN = 'https://editor.csdn.net'

/** 允许透传给图床的图片后缀；不在表里的一律按 jpg 处理 */
const KNOWN_IMAGE_SUFFIXES = ['jpg', 'jpeg', 'png', 'gif', 'webp']

/** 图片后缀 → MIME 类型（data URI 与直传分段都要用） */
const SUFFIX_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 网关签名要覆盖的请求头顺序（网关按这个字符串校验） */
const SIGNED_HEADER_NAMES = 'x-ca-key,x-ca-nonce'

/** 网关回包里的图片直传凭证 */
interface UploadTicket {
  host: string
  filePath: string
  accessId: string
  policy: string
  signature: string
  callbackUrl: string
  callbackBody: string
  callbackBodyType: string
  customParam: Record<string, unknown>
}

/**
 * 每次签名都新生成一个 nonce（网关拒重复）。
 *
 * 摆成 UUID v4 的形态：网关侧的校验只认得这个「带版本号与保留位」的形状。
 * 逐位取随机十六进制字符，再把第 13 位钉成 `4`（版本）、第 17 位按
 * `(x & 3) | 8` 收成 `8..b`（保留位）——这是 UUID v4 的定义，不是随机结果。
 */
function createNonce(): string {
  const digits: string[] = []
  for (let i = 0; i < 32; i += 1) {
    if (i === 12) {
      digits.push('4')
      continue
    }
    const nibble = Math.floor(Math.random() * 16)
    digits.push((i === 16 ? (nibble & 3) | 8 : nibble).toString(16))
  }
  const hex = digits.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** HMAC-SHA256 的 Base64 输出 */
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  )
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * 还原网关要的那串待签内容。
 *
 * 五个空/非空槽位加上尾部路径，**换行位置是协议的一部分**：GET 的 Content-MD5
 * 与 Content-Type 两槽都留空，POST 才把 `application/json` 填进 Content-Type
 * —— 摆错一个槽位网关就回 401。
 */
function buildStringToSign(method: 'GET' | 'POST', nonce: string, apiPath: string): string {
  const lines = [
    method,
    '*/*',
    '', // Content-MD5
    method === 'POST' ? 'application/json' : '', // Content-Type
    '', // Date
    `x-ca-key:${GATEWAY_KEY}`,
    `x-ca-nonce:${nonce}`,
    apiPath,
  ]
  return lines.join('\n')
}

/** 生成一次调用的签名头；POST 额外带 JSON 内容类型（小写键名） */
async function buildSignHeaders(
  method: 'GET' | 'POST',
  apiPath: string,
): Promise<Record<string, string>> {
  const nonce = createNonce()
  const signature = await hmacSha256Base64(
    GATEWAY_SECRET,
    buildStringToSign(method, nonce, apiPath),
  )
  const headers: Record<string, string> = {
    accept: '*/*',
    'x-ca-key': GATEWAY_KEY,
    'x-ca-nonce': nonce,
    'x-ca-signature': signature,
    'x-ca-signature-headers': SIGNED_HEADER_NAMES,
  }
  if (method === 'POST') headers['content-type'] = 'application/json'
  return headers
}

/** 图片 blob → data URI（宿主里以 FileReader 为准，浏览器 / Node 一致） */
function readBlobAsDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result: unknown = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('图片读出来不是 data URI'))
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 从图片地址里猜后缀：不认识的（含空串）一律回落 jpg */
function suffixOf(src: string): string {
  const tail = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
  return KNOWN_IMAGE_SUFFIXES.includes(tail) ? tail : 'jpg'
}

/** 下载正文里的图片字节；HTTP 层失败要显式失败，否则会把错误页当图传上去 */
async function downloadImage(src: string): Promise<Blob> {
  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`图片拉取失败（HTTP ${response.status}）`)
  }
  return response.blob()
}

export class CSDNAdapter extends CodeAdapter implements PlatformAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://editor.csdn.net/md/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /**
   * 三条注入规则：网关、图床服务、华为云 OBS 直传域名。
   * Origin / Referer 是浏览器保护的受限头，页面脚本改不动，只能经运行时注入。
   */
  readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        Origin: EDITOR_ORIGIN,
        Referer: `${EDITOR_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        Origin: EDITOR_ORIGIN,
        Referer: `${EDITOR_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        Origin: EDITOR_ORIGIN,
        Referer: `${EDITOR_ORIGIN}/`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /** 登录成功后记下的账号信息；发布前用它判断要不要再探一次登录态 */
  private userInfo: { csdnid: string; username: string; avatarurl?: string } | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      // 探测登录态不发在请求头规则作用域里：网关只校验签名头，浏览器保护的
      // Origin / Referer 对这条接口没有影响（规则留给发布与上传用）。
      const response = await this.runtime.fetch(`${API_ORIGIN}${USER_INFO_PATH}`, {
        method: 'GET',
        credentials: 'include',
        headers: await buildSignHeaders('GET', USER_INFO_PATH),
      })
      // 网关回包一律是 JSON；非 JSON（401 页 / 登录页）在这里抛解析错误，被外层收敛成未登录
      const payload = (await response.json()) as {
        code?: unknown
        data?: { name?: string; nickname?: string; avatar?: string }
      }
      const data = payload.data as { name?: string; nickname?: string; avatar?: string }
      if (payload.code !== 200 || !data.name) {
        return { isAuthenticated: false }
      }
      this.userInfo = {
        csdnid: data.name,
        username: data.nickname || data.name,
        avatarurl: data.avatar,
      }
      return {
        isAuthenticated: true,
        userId: data.name,
        username: data.nickname || data.name,
        avatar: data.avatar,
      }
    } catch (error) {
      return {
        isAuthenticated: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 发布 = 存草稿。
   *
   * 顺序：先确认登录（有缓存就跳过）→ 换掉正文里的外链图片 → 提交编辑器保存接口。
   * `markdowncontent` 是换过图的正文；`content` 是调用方给的原始 HTML，两者都提交
   * —— 编辑器用前者，后者只在少数回显路径上被读。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      // 登录探测与后续所有平台请求都在注入规则的作用域里：网关/图床都看 Origin，
      // 而且规则要在**探测之前**就位（探测本身也可能失败）
      return await this.withHeaderRules(this.HEADER_RULES, async (): Promise<SyncResult> => {
        if (!this.userInfo) {
          const auth = await this.checkAuth()
          if (!auth.isAuthenticated) {
            throw new Error('CSDN 未登录：请先在浏览器里登录编辑器再重试')
          }
        }

        const markdown = article.markdown || ''
        const replaced = await this.processImages(markdown, (src) => this.uploadImageByUrl(src), {
          skipPatterns: ['csdnimg.cn', 'csdn.net'],
          onProgress: options?.onImageProgress,
        })

        const response = await this.runtime.fetch(`${API_ORIGIN}${SAVE_ARTICLE_PATH}`, {
          method: 'POST',
          credentials: 'include',
          headers: await buildSignHeaders('POST', SAVE_ARTICLE_PATH),
          body: JSON.stringify({
            title: article.title,
            markdowncontent: replaced,
            content: article.html || '',
            readType: 'public',
            level: 0,
            tags: '',
            status: 2,
            categories: '',
            type: 'original',
            original_link: '',
            authorized_status: false,
            not_auto_saved: '1',
            source: 'pc_mdeditor',
            cover_images: [],
            cover_type: 1,
            is_new: 1,
            vote_id: 0,
            resource_id: '',
            pubStatus: 'draft',
            creator_activity_id: '',
          }),
        })

        const saved = (await response.json()) as {
          code?: unknown
          msg?: string
          message?: string
          data?: { id?: string | number }
        }
        const savedData = saved.data as { id?: string | number }
        if (saved.code !== 200 || !savedData.id) {
          // 文案优先用服务端原文，其次 message，最后给一句自己的兜底
          throw new Error(saved.msg || saved.message || 'CSDN 草稿未保存成功')
        }

        // 平台有时回数字 id：原样透传（只在类型层收窄，运行期不改值）
        return this.createResult(true, {
          postId: savedData.id as string,
          postUrl: `${EDITOR_ORIGIN}/md?articleId=${savedData.id}`,
          draftOnly: options?.draftOnly ?? true,
        })
      })
    } catch (error) {
      return this.createResult(false, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 按地址转存一张图片。
   *
   * 两级回退是刻意的产品行为：取凭证失败、或图床直传失败，都**不抛错**，
   * 只把原地址还回去，让正文保留外链、整篇照常发出去。
   */
  protected override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const suffix = suffixOf(src)
    const blob = await downloadImage(src)

    const ticketResponse = await this.runtime.fetch(`${API_ORIGIN}${UPLOAD_SIGN_PATH}`, {
      method: 'POST',
      credentials: 'include',
      headers: await buildSignHeaders('POST', UPLOAD_SIGN_PATH),
      body: JSON.stringify({
        imageTemplate: '',
        appName: IMAGE_APP_NAME,
        imageSuffix: suffix,
      }),
    })
    const ticketPayload = (await ticketResponse.json()) as { code?: unknown; data?: UploadTicket }
    const ticket = ticketPayload.data as UploadTicket
    if (ticketPayload.code !== 200 || !ticket) {
      return { url: src }
    }

    // customParam 是图床要求的自定义回调字段，缺了就无法拼出合法的直传表单
    const { customParam } = ticket
    const fileName = `image.${suffix}`
    const body = new FormData()
    body.append('key', ticket.filePath)
    body.append('policy', ticket.policy)
    body.append('signature', ticket.signature)
    body.append('callbackBody', ticket.callbackBody)
    body.append('callbackBodyType', ticket.callbackBodyType)
    body.append('callbackUrl', ticket.callbackUrl)
    body.append('AccessKeyId', ticket.accessId)
    body.append('x:rtype', String(customParam.rtype))
    body.append('x:filePath', String(customParam.filePath))
    body.append('x:isAudit', String(customParam.isAudit))
    body.append('x:x-image-app', String(customParam['x-image-app']))
    body.append('x:type', String(customParam.type))
    body.append('x:x-image-suffix', String(customParam['x-image-suffix']))
    body.append('x:username', String(customParam.username))
    // 直传分段里的文件名由平台读，带上它才与图床侧的落点一致
    body.append('file', new File([blob], fileName, { type: blob.type || SUFFIX_MIME[suffix] }))

    const uploadResponse = await this.runtime.fetch(ticket.host, {
      method: 'POST',
      body,
    })
    const uploaded = (await uploadResponse.json()) as {
      code?: unknown
      data?: { imageUrl?: string }
    }
    const imageUrl = uploaded.data?.imageUrl
    if (uploaded.code !== 200 || !imageUrl) {
      return { url: src }
    }
    return { url: imageUrl }
  }

  /**
   * 上传一张本地图片：先读成 data URI，再交给同一条转存链路。
   * 这样 `uploadImage` 与正文里的 `data:` 图片走的是完全相同的分支。
   */
  override async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      const dataUri = await readBlobAsDataUri(file)
      const uploaded = await this.uploadImageByUrl(dataUri)
      return uploaded.url
    })
  }
}
