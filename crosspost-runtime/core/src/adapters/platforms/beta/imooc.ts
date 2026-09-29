/**
 * 慕课手记（imooc）适配器。
 *
 * 这个平台的接口有两个鲜明的性格：
 * · 会话凭证完全交给浏览器 cookie，适配器自己一个 token 都不取；
 * · 服务端不给靠谱的 HTTP 状态语义 —— 全链路只看业务码与回包字段，
 *   四零几/五零几 的响应体会被当成正常回包继续解析。
 *
 * 手记的"保存"接口本身就是存草稿，配合 `draft_id=0` 即"新建一篇"，
 * 因此这里不存在"发布"这个动作，也没有任何发表接口可调。
 */
import { CodeAdapter, ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'

/** 存草稿接口 */
const DRAFT_URL = 'https://www.imooc.com/article/savedraft'
/** 正文配图的上传接口 */
const UPLOAD_URL = 'https://www.imooc.com/article/ajaxuploadimg'
/** 登录态探测接口 */
const PROFILE_URL = 'https://www.imooc.com/u/card'

/**
 * 图片表单里 `id` 字段的固定取值。
 *
 * 这是 webuploader 风格的**平台表单约定名**：平台前端按这个名字取文件域，
 * 必须逐字保留 —— 换成自选串平台侧就收不到图。
 */
const IMAGE_FORM_ID = 'WU_FILE_0'

export class ImoocAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'imooc',
    name: '慕课手记',
    icon: 'https://www.imooc.com/favicon.ico',
    homepage: 'https://www.imooc.com/article',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 正文按 Markdown 形态进出，图片替换也落在 Markdown 上 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** 发往 `/article/*` 的请求需要浏览器页面身份，Origin/Referer 只能靠规则注入 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.imooc.com/article/*',
      headers: {
        Origin: 'https://www.imooc.com',
        Referer: 'https://www.imooc.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 探测登录态。
   *
   * 回包是 JSONP（`回调名({...})`），所以先按文本取回、剥壳再解析；
   * 业务码 `result === 0` 才算已登录，其余一律收敛成结构，绝不向调用方抛错。
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const response = await this.runtime.fetch(PROFILE_URL, { credentials: 'include' })
        const payload = unwrapJsonp(await response.text())
        if (payload.result !== 0) {
          return { isAuthenticated: false, error: messageOf(payload) }
        }
        const data = payload.data as Record<string, unknown>
        return {
          isAuthenticated: true,
          userId: data.uid as string,
          username: data.nickname as string,
          avatar: data.img as string,
        }
      })
    } catch (error) {
      return { isAuthenticated: false, error: reasonOf(error) }
    }
  }

  /**
   * 存一篇新草稿。
   *
   * 时间戳在**进入规则作用域之前**取一次，成功与失败两条路径共用它；
   * 结果对象是手写字面量而不过 `createResult`，为的是让这个入口时刻可控。
   * 单参发布：本平台不消费 `onImageProgress`，也不读 `draftOnly`。
   */
  async publish(article: Article): Promise<SyncResult> {
    const startedAt = Date.now()
    try {
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        const body = await this.processImages(article.markdown || article.html || '', (src) =>
          this.uploadImageByUrl(src),
        )
        const form = new URLSearchParams()
        form.set('editor', '0')
        form.set('draft_id', '0')
        form.set('title', article.title)
        form.set('content', body)

        const response = await this.runtime.fetch(DRAFT_URL, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        })
        const payload = (await response.json()) as { data?: unknown }
        const draftId = payload.data
        if (!draftId) throw new Error('平台没有返回草稿编号，这篇手记没能存下来')

        return {
          platform: this.meta.id,
          success: true,
          postId: draftId as string,
          postUrl: `https://www.imooc.com/article/draft/id/${String(draftId)}`,
          draftOnly: true,
          timestamp: startedAt,
        }
      })
    } catch (error) {
      return {
        platform: this.meta.id,
        success: false,
        error: reasonOf(error),
        timestamp: startedAt,
      }
    }
  }

  /**
   * 把正文里的一张图转存到平台图床。
   *
   * 下载与上传都走 `runtime.fetch`（同一把浏览器凭据），下载结果**不看状态码**：
   * 服务端返回什么都当图片字节用。上传按业务码 `result === 0` 判定；
   * 拿到的地址若是协议相对形式（`//…`）就补上 `https:`。
   * 覆写面保持公开，与同类平台的可见性一致。
   */
  override async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const downloaded = await this.runtime.fetch(src)
    const blob = await downloaded.blob()
    const filename = `${Date.now()}.jpg`
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' })

    const form = new FormData()
    form.append('photo', file)
    form.append('type', file.type)
    form.append('id', IMAGE_FORM_ID)
    form.append('name', filename)
    form.append('lastModifiedDate', new Date().toString())
    form.append('size', String(file.size))

    const response = await this.runtime.fetch(UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const payload = (await response.json()) as {
      result?: number
      msg?: string
      data?: { imgpath?: string }
    }
    if (payload.result !== 0) throw new Error(payload.msg || '图床没有接收这张图片')

    const path = (payload.data as { imgpath: string }).imgpath
    return { url: path.startsWith('//') ? `https:${path}` : path }
  }
}

/** 业务码非 0 时的失败文案：优先用服务端自己给的 `msg` */
function messageOf(payload: { msg?: string }): string {
  return payload.msg || '这个浏览器会话还没登录慕课手记'
}

/** 把任意异常收敛成可读文案 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 剥掉 JSONP 外壳。
 *
 * 两种形态都吃掉：`名字({...})` / `名字({...});`。
 * 回调名限定为「点分标识符」（真实回调名形如 `jsonpcallback`），
 * 因此正文里偶然出现的圆括号不会被误当成外壳。
 * 已经是纯 JSON 时两步替换都是空操作，直接解析。
 */
function unwrapJsonp(raw: string): { result?: number; msg?: string; data?: unknown } {
  const outer = /^[\w$]+(?:\.[\w$]+)*\s*\(/.exec(raw)
  const inner = outer ? raw.slice(outer[0].length).replace(/\)\s*;?\s*$/, '') : raw
  return JSON.parse(inner) as { result?: number; msg?: string; data?: unknown }
}
