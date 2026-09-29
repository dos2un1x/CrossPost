/**
 * 平台适配器导出
 *
 * 目录按**平台分级**分组，分级口径只有一处：crosspost-runtime/src/platform-matrix.mjs
 *   · private/ —— 本项目**默认勾选**（对外承诺支持）的平台适配器
 *   · beta/    —— 适配器存在、但未纳入默认派发的平台
 * 新增适配器时按分级放进对应目录，并在这里登记（跨目录移动只需改本文件与本行之上的两处说明）。
 */

// ===== 默认勾选的平台（private/）=====
export { ZhihuAdapter } from './private/zhihu'
export { CSDNAdapter } from './private/csdn'
export { WeixinAdapter } from './private/weixin'
export { WeixinOfficialAdapter } from './private/weixin-official'
export { BaijiahaoAdapter } from './private/baijiahao'
export { ToutiaoAdapter } from './private/toutiao'
export { XiaohongshuAdapter } from './private/xiaohongshu'
export { YidianAdapter } from './private/yidian'
export { DayuAdapter } from './private/dayu'
export { SmzdmAdapter } from './private/smzdm'
export { JuejinAdapter } from './private/juejin'
export { Cto51Adapter } from './private/cto51'
export { DouyinAdapter } from './private/douyin'

// ===== 未纳入默认派发的平台（beta/）=====
export { BilibiliAdapter } from './beta/bilibili'
export { JianshuAdapter } from './beta/jianshu'
export { DoubanAdapter } from './beta/douban'
export { XueqiuAdapter } from './beta/xueqiu'
export { SohuAdapter } from './beta/sohu'
export { WoshipmAdapter } from './beta/woshipm'
export { WeiboAdapter } from './beta/weibo'
export { YuqueAdapter } from './beta/yuque'
export { ImoocAdapter } from './beta/imooc'
export { OschinaAdapter } from './beta/oschina'
export { SegmentfaultAdapter } from './beta/segmentfault'
export { CnblogsAdapter } from './beta/cnblogs'
export { EastmoneyAdapter } from './beta/eastmoney'
export { NeteaseAdapter } from './beta/netease'
export { SohufocusAdapter } from './beta/sohufocus'
