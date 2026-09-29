# DSH agent preset

把 CrossPost 的发布能力挂到一个 **DSH agent** 上的预设（可选件：不用 DSH 也能用 CLI / MCP / Console）。

- `agent.cordis.yml` — 预设组合：身份与人格 + 下面那个插件行 + 内置 skill 注册表接线
- `plugins/crosspost.js` — 自写静态插件：7 个 `xp_*` 工具（发布/重推/平台状态/渲染预览/草稿读取…），
  并在需要时**自拉起本机桥**（`bridge/run-bridge.mjs`）
- `preset.yml` — 预设名与描述（DSH 的预设列表里显示的就是它）
- `runtime` — 软链到 `../../crosspost-runtime`：插件用 `../runtime/src/*.mjs` 引用引擎源码，
  这样同一份源码在"仓库布局"和"已安装预设布局"下都成立

## 它怎么被装上

DSH 会把本目录**拷一份**到 `~/.dsh/.agent-presets/crosspost/`。因此仓库里改了
`plugins/crosspost.js` 或 `preset.yml`，安装副本不会自动跟着变——`crosspost-runtime/tests`
里有一条部署一致性护栏专门盯这件事（`SYNCED_FILES`），它红了就按报错里给的 `cp` 修法同步。

## 一条写作流水线怎么用它

预设给的是**工具**（发得出去），写作规范与人格由**流水线自己**提供：流水线在自己的仓库里放一份
`dsh-profile/cordis.patch.yml`（`system-prompt` 人格 + 挂发布器 MCP），再把它软链成 DSH profile 的
`cordis.patch.yml`。这样每个流水线一个 profile，各自的人格与写作 SOP 互不干扰，
引擎侧只有这一份预设。完整接法见 [`../../docs/writing-pipelines.md`](../../docs/writing-pipelines.md) §6。

## 边界

- 插件**只消费** host 服务（`tools` / `fs` / `shell` / `subprocess` / `timer`），**不发布服务**，
  所以不需要 `isolate` realm。
- 它不是调度器：定时到点由引擎的内置定时器负责（见 [`../../docs/scheduling.md`](../../docs/scheduling.md)）。
- 它与 MCP 面共用同一套判定源（发布来源守卫、平台白名单都来自 `crosspost-runtime/src/`）。
