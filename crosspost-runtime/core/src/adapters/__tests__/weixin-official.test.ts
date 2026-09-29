import { describe, it, expect } from 'vitest'
import { wechatError } from '../platforms/private/weixin-official'

describe('wechatError mapping', () => {
  it('maps 40164 to IP whitelist guidance', () => {
    const e = wechatError({ errcode: 40164, errmsg: 'invalid ip' }, 'test')
    expect(e.message).toContain('IP 未在白名单')
    expect(e.message).toContain('IP白名单')
  })

  it('maps 40125 to invalid secret', () => {
    const e = wechatError({ errcode: 40125, errmsg: 'invalid credential' }, 'test')
    expect(e.message).toContain('AppSecret 无效')
  })

  it('maps 45110 author too long', () => {
    const e = wechatError({ errcode: 45110, errmsg: 'invalid author' }, 'test')
    expect(e.message).toContain('作者字段超长')
  })

  it('maps 45166 invalid content', () => {
    const e = wechatError({ errcode: 45166, errmsg: 'invalid content' }, 'test')
    expect(e.message).toContain('非法链接')
  })

  it('maps unknown codes with raw info', () => {
    const e = wechatError({ errcode: 99999, errmsg: 'mystery' }, 'ctx')
    expect(e.message).toContain('99999')
    expect(e.message).toContain('mystery')
    expect(e.message).toContain('[ctx]')
  })
})
