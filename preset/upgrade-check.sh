#!/bin/bash
# DSH 升级后自检（2026-09-12 建立）
#
# 背景：2026-09-10 的 DSH 升级连续打坏了三处依赖，每处都只有"用户反馈"才被发现：
#   ① 人设配置键改名（dsh-persona: text→prefix/suffix；dsh-system-prompt: persona→personaPrefix/personaSuffix）
#   ② 插件按仓库布局写死相对深度（../../../crosspost-runtime），从 ~/.dsh/.agent-presets 挂载时解析错
#   ③ 预设 package.json 有 name 无 version → dsh-plugin-package-inventory-deepseek 抛错 →
#      该预设下每个请求都失败：DeepSeek request extension preparation failed / REQUEST_EXTENSION
# 本脚本把这些检查固化成一条命令，升级后跑一次即可。
#
# 用法:
#   bash ~/.dsh/upgrade-check.sh
#   DSH_HOME=... REPO_PRESETS=... bash preset/upgrade-check.sh
# 退出码: 0 = 无失败项；1 = 有 ✖
#
# ⚠ 2026-09-19（v2.49）**本脚本不是"零写入"的检查**——跑之前请知道它的写入足迹：
#
#   第 5 节对每个 profile 跑 `dsh --profile <名> --dump-config`，而 **DSH 自己会重写**
#   各 profile 的 `cordis.yml` 样板文件（内容是固定的 3 行注释 + `[]`，逐字不变），
#   另外每次 dsh 调用都会更新 `~/.dsh/storages/workspace.json`。
#   实测跑一次的足迹：
#     ~/.dsh/profiles/<各 profile>/cordis.yml  ← 内容不变，mtime 变
#     ~/.dsh/storages/workspace.json                                    ← DSH 自己的登记表
#
#   为什么必须写在明处：不写清就会被它误导——检查完发现某个 profile 里的
#   `cordis.yml` 成了"今天刚改过"，一度以为有人动了那个 profile。
#   真正决定 profile 行为的是 `cordis.patch.yml` 与 `package.json`，那两个**不会被碰**；
#   launchd 的 6 个槽位 plist 也不会被碰。但"跑一次检查，几个 profile 文件 mtime 全变"
#   这件事若不说清，任何"文件有没有被改动"的核对都会误判。
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_BIN="${DSH_BIN:-$HOME/.local/bin/dsh}"
REPO_PRESETS="${REPO_PRESETS:-$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)}"
UNZSTD="$(command -v unzstd || true)"
TMP="$(mktemp -d /tmp/dsh-upgrade-check.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# node 路径（2026-09-19 v2.38）：此前写死 /usr/local/bin/node，与本仓库
# bridge/install-launchd.sh 是同一处缺陷——Apple Silicon 的 Homebrew 在
# /opt/homebrew/bin，nvm/asdf/fnm 在用户目录下。第 3 节要 spawn node 做
# "fresh 进程导入 preset 插件"，路径错了会报成"插件导入失败"，误导排查方向。
# 现在：CROSSPOST_NODE > PATH 上的 node > 常见绝对路径兜底。
resolve_node() {
  if [ -n "${CROSSPOST_NODE:-}" ]; then
    printf '%s' "$CROSSPOST_NODE"
    return 0
  fi
  local found
  found="$(command -v node 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s' "$found"
    return 0
  fi
  local p
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  printf ''
}
NODE="$(resolve_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  printf '\033[31m✖\033[0m 找不到可执行的 node（第 3 节需要它做 fresh 进程导入）\n' >&2
  printf '      用 CROSSPOST_NODE 显式指定：CROSSPOST_NODE=$(command -v node) bash %s\n' "$0" >&2
  exit 1
fi

# REPO_PRESETS 默认从**脚本自身的真实路径**推导（它常被软链到 ~/.dsh/upgrade-check.sh），
# 不再假设仓库一定在固定位置（例如 ~/crosspost）—— 软链会经 realpath 解析回仓库里的 preset/ 目录。
if [ ! -d "$REPO_PRESETS" ]; then
  printf '\033[33m⚠\033[0m REPO_PRESETS 不存在: %s（可用 REPO_PRESETS=... 覆盖）\n' "$REPO_PRESETS" >&2
fi

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; WARN=$((WARN+1)); }
sec()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
hint() { printf '      ↳ %s\n' "$*"; }
realpath_py() { python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$1"; }

# ── 0. 部署与启动链 ──────────────────────────────────────────────────────
sec "0. 部署与启动链"
LIVE_BIN="$(realpath_py "$DSH_BIN" 2>/dev/null || echo '')"
DEPLOY=""
if [ -n "$LIVE_BIN" ] && [ -f "$LIVE_BIN" ]; then
  DEPLOY="$(printf '%s' "$LIVE_BIN" | sed 's|/node_modules/@deepseek-ai/dsh/lib/bin.js$||')"
  ok "dsh 启动器 → $LIVE_BIN"
  if [ -n "$DEPLOY" ] && [ -d "$DEPLOY" ]; then
    ok "当前部署目录 ${DEPLOY}（$("$DSH_BIN" --version 2>/dev/null | head -1)）"
  else
    bad "无法从启动器推断部署目录（预期 …/node_modules/@deepseek-ai/dsh/lib/bin.js）"
  fi
else
  bad "$DSH_BIN 无法解析（realpath 失败）"
fi
NPX_DIRS="$(ls -d "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh 2>/dev/null | wc -l | tr -d ' ')"
if [ "${NPX_DIRS:-0}" -gt 1 ]; then
  warn "本机有 $NPX_DIRS 份 dsh 安装；启动器只指向其中一份，升级后确认软链是否需重指"
else
  ok "只有 1 份 dsh 安装（无多版本混用）"
fi

# ── 1. 指向部署的软链是否仍一致 ─────────────────────────────────────────
#
# 断链**不等于**无害，要分三类（2026-09-25 实测踩到）：
#   ① 部署内有同名包 → 链指错了，导入会失败；
#   ② 该包名被某个 profile/preset 的插件行 `name:` 引用 → DSH 按**包名**解析它，链一断
#      那一行插件**静默消失**（DSH 照常启动，只是少一个能力）。仓库目录改名后最常见：
#      软链的目标还写着**旧仓库路径**，而它与 $DEPLOY 毫无关系 —— 实测
#      `profiles/node_modules/crosspost-client` → `~/<旧目录>/preset/...` 正是如此，
#      历史上被归成 ③「无害，可清理」，于是这条提示本身成了误导；
#   ③ 其余 → 真是旧版本残留（npm 换了版本），Node 解析会跳过，可清理。
#
# 把 ② 单独判出来是这条护栏的关键：若一律报失败，本机上百条 npx 版本残留会让它天天红，
# 使用者就学会忽略它 —— 而它是升级后唯一的安全网。
ROW_NAMES="$(
  grep -h -E '^[[:space:]]*name:[[:space:]]' \
    "$DSH_HOME"/profiles/*/cordis.patch.yml \
    "$DSH_HOME"/.agent-presets/*/agent.cordis.yml 2>/dev/null \
    | sed -E 's/^[[:space:]]*name:[[:space:]]*//' \
    | tr -d "'\"" \
    | grep -vE '^\.|:' || true
)"
sec "1. 软链一致性（profiles/node_modules 与预设 node_modules）"
check_links() {
  local root="$1" total=0 stale=0 off=0 broken=0 leftover=0 t pkg
  if [ ! -d "$root" ]; then warn "$root 不存在（跳过）"; return; fi
  while IFS= read -r -d '' l; do
    total=$((total+1))
    t="$(readlink "$l")"
    case "$t" in /*) ;; *) t="$(cd "$(dirname "$l")" && pwd)/$t" ;; esac
    if [ -e "$l" ]; then
      if [ -n "$DEPLOY" ] && printf '%s' "$t" | grep -q '_npx/' && ! printf '%s' "$t" | grep -q "^$DEPLOY/"; then
        off=$((off+1)); if [ "$off" -le 3 ]; then hint "指向非当前部署: $l → $t"; fi
      fi
      continue
    fi
    # 断链：① 部署内有同名包 ② 被插件行 `name:` 引用 ③ 旧版本残留
    pkg="${l#"$root"/}"
    if [ -n "$DEPLOY" ] && [ -e "$DEPLOY/node_modules/$pkg" ]; then
      broken=$((broken+1)); if [ "$broken" -le 3 ]; then hint "断链且部署内有同名包（导入会失败）: $l"; fi
    elif [ -n "$ROW_NAMES" ] && printf '%s\n' "$ROW_NAMES" | grep -qxF "$pkg"; then
      broken=$((broken+1))
      if [ "$broken" -le 3 ]; then
        hint "断链且被插件行引用（那一行会静默消失，不是无害残留）: $l → $t"
        hint "  修法: ln -sfn <仓库>/preset/crosspost/plugins/$pkg $l"
      fi
    else
      leftover=$((leftover+1)); if [ "$leftover" -le 3 ]; then hint "旧版本残留（部署内已无此包，Node 解析会跳过）: $l"; fi
    fi
  done < <(find "$root" -type l -print0 2>/dev/null)
  if [ "$broken" -gt 0 ]; then
    bad "$root: 共 $total 条软链，$broken 条断链需修（部署内有同名包，或被插件行引用）"
  elif [ "$off" -gt 0 ]; then
    warn "$root: 共 $total 条软链，$off 条指向旧部署（升级后建议重指）"
  elif [ "$leftover" -gt 0 ]; then
    warn "$root: 共 $total 条软链，$leftover 条为旧版本残留断链（无害，可清理）"
    hint "清理（可逆：先移走再观察）: mkdir -p ~/.dsh/backups && find $root -type l ! -exec test -e {} \\; -print0 | xargs -0 -I{} sh -c 'mkdir -p ~/.dsh/backups/broken-symlinks && mv \"{}\" ~/.dsh/backups/broken-symlinks/'"
  else
    ok "$root: 共 $total 条软链，全部有效且指向当前部署"
  fi
}
check_links "$DSH_HOME/profiles/node_modules"

PRESET_DIRS=()
for d in "$DSH_HOME"/.agent-presets/* "$REPO_PRESETS"/*; do
  if [ -d "$d" ]; then PRESET_DIRS+=("$d"); [ -d "$d/node_modules" ] && check_links "$d/node_modules"; fi
done

# ── 2. 预设 manifest（name+version）与相对行名 ──────────────────────────
sec "2. 预设 manifest 与相对行名"
for d in "${PRESET_DIRS[@]}"; do
  name="$(basename "$d")"
  yml="$d/agent.cordis.yml"
  if [ ! -f "$yml" ]; then warn "$name: 无 agent.cordis.yml（跳过）"; continue; fi
  pj="$d/package.json"
  if [ -f "$pj" ]; then
    msg="$(python3 - "$pj" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1],encoding='utf-8'))
except Exception as e: print('PARSE:'+str(e)); raise SystemExit
n,v=d.get('name'),d.get('version')
if not (isinstance(n,str) and n) or not (isinstance(v,str) and v):
    print('MISSING:name=%r version=%r' % (n,v))
else: print('OK:%s@%s' % (n,v))
PY
)"
    case "$msg" in
      OK:*) ok "$name manifest → ${msg#OK:}" ;;
      MISSING:*)
        bad "$name/package.json 必须同时声明非空 name 与 version（${msg#MISSING:}）"
        hint "否则该预设下每个请求都会 REQUEST_EXTENSION 失败（dsh-plugin-package-inventory-deepseek）"
        hint '修法：加 "version": "1.0.0"' ;;
      *) bad "$name/package.json 解析失败（${msg#PARSE:}）" ;;
    esac
  else
    ok "$name 无 package.json（与发行版预设同形，不触发 manifest 检查）"
  fi
  while read -r rel; do
    if [ -z "$rel" ]; then continue; fi
    if [ -e "$d/${rel#./}" ]; then ok "$name 行 $rel 存在"
    else bad "$name 行 $rel 指向的文件不存在"; hint "路径: $d/${rel#./}"; fi
  done < <(grep -oE "name: *'\.\.?/[^']+'" "$yml" 2>/dev/null | sed -E "s/name: *'//; s/'$//")
done

# ── 3. 预设本地插件：fresh 进程导入 + 请求扩展兼容性 ────────────────────
sec "3. 预设本地插件（fresh-process 导入 + 请求扩展 manifest 解析）"
PLUGINS=()
for d in "${PRESET_DIRS[@]}"; do
  yml="$d/agent.cordis.yml"
  if [ ! -f "$yml" ]; then continue; fi
  while read -r rel; do
    if [ -z "$rel" ]; then continue; fi
    f="$d/${rel#./}"
    if [ -f "$f" ]; then PLUGINS+=("$f"); fi
  done < <(grep -oE "name: *'\.\.?/[^']+'" "$yml" 2>/dev/null | sed -E "s/name: *'//; s/'$//")
done
if [ "${#PLUGINS[@]}" -eq 0 ]; then
  warn "未发现预设本地插件（跳过）"
else
  for f in "${PLUGINS[@]}"; do
    if out="$("$NODE" --input-type=module -e "import(process.argv[1]).then(m=>console.log(m.name||'-')).catch(e=>{console.log('ERR '+e.message);process.exit(1)})" "$f" 2>&1)"; then
      ok "导入成功 $f → $out"
    else
      bad "导入失败 $f"; hint "$out"
      hint "常见原因：相对深度按仓库布局写死（应改为预设目录内 ../runtime/… 软链或绝对路径）"
    fi
  done
  if "$NODE" --input-type=module - "${PLUGINS[@]}" <<'JS'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
// 与 @deepseek-ai/dsh-plugin-package-inventory-deepseek 同逻辑：相对条目取最近 manifest，
// allowAnonymous 只容忍"完全无 name"；有 name 无 version 会抛错 → REQUEST_EXTENSION
function nearestManifest(modulePath) {
  let c = dirname(modulePath)
  const root = parse(c).root
  for (;;) {
    const m = join(c, 'package.json')
    if (existsSync(m)) return m
    if (c === root) return undefined
    c = dirname(c)
  }
}
function identity(path, allowAnonymous) {
  const man = JSON.parse(readFileSync(path, 'utf8'))
  if (allowAnonymous && man.name === undefined) return undefined
  if (typeof man.name !== 'string' || !man.name.length || typeof man.version !== 'string' || !man.version.length)
    throw new Error('must declare non-empty name and version (' + path + ')')
  return { name: man.name, version: man.version }
}
let fail = 0
for (const p of process.argv.slice(2)) {
  const man = nearestManifest(p)
  if (man === undefined) { console.log('  \x1b[32m✔\x1b[0m 松模块（无最近 manifest） ' + p); continue }
  try {
    const id = identity(man, true)
    console.log('  \x1b[32m✔\x1b[0m 请求扩展兼容 ' + (id ? id.name + '@' + id.version : '(松模块)') + ' ← ' + man)
  } catch (e) {
    console.log('  \x1b[31m✖\x1b[0m 请求扩展会抛错：' + e.message)
    fail = 1
  }
}
process.exit(fail)
JS
  then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    hint '修法：给该 manifest 补 "version": "1.0.0"（否则该预设下所有 LLM 请求失败）'
  fi
fi

# ── 4. persona 配置键 ───────────────────────────────────────────────────
sec "4. persona 配置键"
for d in "${PRESET_DIRS[@]}"; do
  yml="$d/agent.cordis.yml"
  if [ ! -f "$yml" ]; then continue; fi
  name="$(basename "$d")"
  if grep -q '@deepseek-ai/dsh-persona' "$yml"; then
    blk="$(awk '
      /@deepseek-ai\/dsh-persona/ { f=1 }
      f && /^- id:/ && !/@deepseek-ai\/dsh-persona/ { if (seen) exit }
      f { print; seen=1 }
    ' "$yml")"
    if printf '%s' "$blk" | grep -qE '^[[:space:]]+prefix:'; then
      ok "$name: persona 行使用 prefix"
    else
      bad "$name: persona 行缺少 prefix（新版 dsh-persona 必填）"
      hint '旧键 text 已失效 → 报 invalid config: $.prefix missing required value'
    fi
    if printf '%s' "$blk" | grep -qE '^[[:space:]]+text:'; then
      bad "$name: persona 行仍残留旧键 text"
      hint '把 text 改成 prefix（“工作目录”那句可拆到 suffix）'
    fi
  fi
done
for pf in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
  if [ ! -f "$pf" ]; then continue; fi
  name="$(basename "$(dirname "$pf")")"
  if grep -qE '^[[:space:]]+personaPrefix:' "$pf"; then
    ok "$name profile: system-prompt 使用 personaPrefix"
  elif grep -qE '^[[:space:]]+persona:' "$pf"; then
    bad "$name profile: 仍用旧键 persona（新版为 personaPrefix/personaSuffix，会被静默丢弃）"
    hint '注意 patch 是整体替换 config：改名时要一并补 personaSuffix，否则连 headless 的 cwd 后缀也丢'
  else
    ok "$name profile: 未覆盖 system-prompt（无需检查）"
  fi
done

# ── 5. profile 组合与 bundle 可用性 ────────────────────────────────────
sec "5. profile 组合（dsh --dump-config）与 bundle"
for prof in "$DSH_HOME"/profiles/*/; do
  name="$(basename "$prof")"
  if [ ! -f "$prof/package.json" ]; then continue; fi
  if "$DSH_BIN" --profile "$name" --dump-config >"$TMP/$name.out" 2>"$TMP/$name.err"; then
    ok "profile $name 组合成功"
  else
    bad "profile $name 组合失败"; hint "$(head -3 "$TMP/$name.err" | tr '\n' ' ')"
  fi
  if [ -n "$DEPLOY" ]; then
    while read -r b; do
      if [ -z "$b" ]; then continue; fi
      # bundle 按 Node 的解析顺序找（2026-09-19 v2.38 修正）：
      #   ① profile 自己的 node_modules —— **本地 bundle**（file: 装的 tgz、打过补丁的
      #      自研 bundle）就在这里，它们本来就不该出现在 DSH 部署目录里
      #   ② ~/.dsh/profiles/node_modules —— 共享依赖
      #   ③ DSH 部署目录
      # 旧版只查 ③，于是任何自带本地 bundle 的 profile 都会被判 ✖ 失败。
      # 只要某个 profile 的 bundle 是从本地 tgz 装的，就会中招 ——
      # 它明明在 ① 里，却报"在当前部署缺失"。**假失败比不检查更糟**——
      # 它会训练使用者忽略这个工具，而它恰恰是 DSH 升级后唯一的安全网。
      # $prof 来自 `*/` 通配，带尾斜杠——去掉，否则拼出 `<profile>//node_modules` 这种双斜杠
      pdir="${prof%/}"
      where=""
      for cand in "$pdir/node_modules/$b" "$DSH_HOME/profiles/node_modules/$b" "$DEPLOY/node_modules/$b"; do
        if [ -d "$cand" ]; then where="$cand"; break; fi
      done
      if [ -n "$where" ]; then
        case "$where" in
          "$DEPLOY"/*) ok "profile $name bundle $b 存在（部署）" ;;
          *) ok "profile $name bundle $b 存在（${where#"$DSH_HOME"/}，非部署内 bundle）" ;;
        esac
      else
        bad "profile $name bundle $b 找不到（profile 与部署里都没有）"
        hint "查过：$pdir/node_modules/${b}、$DSH_HOME/profiles/node_modules/${b}、$DEPLOY/node_modules/$b"
        hint "本地 bundle 需 npm install；发布的 bundle 需 DSH 升级后再看"
      fi
    done < <(python3 - "$prof/package.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for b in ((d.get('dsh') or {}).get('profile') or {}).get('bundles') or []: print(b)
PY
)
  fi
done

# ── 6. MCP 行配置键白名单 ──────────────────────────────────────────────
sec "6. profile 里 dsh-mcp-client 行的 config 键"
ALLOW=" serverName transport command args env cwd toolCallTimeoutMs failOnStartupError reconnect url headers "
for pf in "$DSH_HOME"/profiles/*/cordis.patch.yml; do
  if [ ! -f "$pf" ]; then continue; fi
  name="$(basename "$(dirname "$pf")")"
  badkeys=""
  while read -r k; do
    if [ -z "$k" ]; then continue; fi
    case "$ALLOW" in *" $k "*) ;; *) badkeys="$badkeys $k" ;; esac
  done < <(awk '
    # 只取 config: 的直接子键（缩进 = config 缩进 + 2），避免把行级 name/disabled 与嵌套 env 子键算进来
    /@deepseek-ai\/dsh-mcp-client/ { inblk=1; incfg=0; cfgind=-1; next }
    inblk && /^- / { inblk=0; next }
    inblk && /^[[:space:]]*config:[[:space:]]*$/ {
      match($0, /^[[:space:]]*/); cfgind=RLENGTH; incfg=1; next
    }
    inblk && incfg {
      match($0, /^[[:space:]]*/); ind=RLENGTH
      if ($0 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9_]*:/ && ind == cfgind + 2) {
        line=$0; sub(/^[[:space:]]+/, "", line); sub(/:.*/, "", line); print line
      }
    }
  ' "$pf" | sort -u)
  if [ -z "$badkeys" ]; then ok "$name: MCP 行 config 键均在白名单内"
  else warn "$name: MCP 行 config 出现非白名单键:${badkeys}（可能已改名，未知键会被静默丢弃）"; fi
done

# ── 7. settings.yaml 命名空间 ──────────────────────────────────────────
sec "7. settings.yaml 命名空间（存在性检查）"
S="$DSH_HOME/settings.yaml"
if [ -f "$S" ]; then
  for ns in agent-default-model agent-presets ui-onboarding; do
    if grep -q "^$ns:" "$S"; then ok "settings.yaml 有 $ns"; else warn "settings.yaml 缺少 ${ns}（若你有意没配可忽略）"; fi
  done
else
  warn "$S 不存在（全部走默认值）"
fi

# ── 8. 会话日志格式（费用报表依赖）────────────────────────────────────
sec "8. 会话日志格式（费用报表依赖）"
newest="$(find "$DSH_HOME/sessions" -name 'session*.jsonl*' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  warn "未找到会话日志（跳过）"
else
  base="$(basename "$newest")"
  if printf '%s' "$base" | grep -qE '^session(\.v[0-9]+)?\.jsonl(\.zstd)?$'; then
    gen="$(printf '%s' "$base" | sed -nE 's/^session\.v([0-9]+)\.jsonl.*/\1/p')"; gen="${gen:-0}"
    ok "最新会话文件命名合规: ${base}（代际 v${gen}）"
    if [ "$gen" -gt 3 ]; then
      warn "出现新代际 v${gen}：token-cost.mjs 只识别 v0/v3 形态，费用报表可能漏计"
      hint "检查 crosspost-runtime/src/token-cost.mjs 的代际解析与 usage 位置"
    fi
  else
    bad "最新会话文件命名不符合规范: $base"
    hint "token-cost 的 GENERATION_RE 可能需适配"
  fi
  if [ -n "$UNZSTD" ] && printf '%s' "$base" | grep -q '\.zstd$'; then
    if "$UNZSTD" -f "$newest" -o "$TMP/s.jsonl" -q 2>/dev/null; then
      n_msg="$(grep -c '"assistant/message"' "$TMP/s.jsonl" 2>/dev/null || echo 0)"
      n_use="$(grep -c '"usage":' "$TMP/s.jsonl" 2>/dev/null || echo 0)"
      if [ "${n_use:-0}" -gt 0 ]; then
        ok "解压可读：assistant/message=${n_msg}，含 usage 事件=${n_use}（token-cost 可解析）"
      else
        warn "解压可读但未发现 usage 事件：token-cost 的 usage 位置可能已变"
      fi
    else
      warn "unzstd 解压失败（跳过内容检查）"
    fi
  fi
fi

# ── 汇总 ────────────────────────────────────────────────────────────────
sec "汇总"
printf '  ✔ %d 项通过   ⚠ %d 项提醒   ✖ %d 项失败\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n\033[31m存在失败项：按上面 ↳ 提示修复后重跑。\033[0m\n'
  # REPO_PRESETS 可能是 preset/（默认）也可能是 preset/crosspost/（--repo 覆盖），两种都要能推出仓库根
  case "$(basename "$REPO_PRESETS")" in
    crosspost) REPO_ROOT="$(cd "$REPO_PRESETS/../.." 2>/dev/null && pwd || echo "$REPO_PRESETS/../..")" ;;
    *) REPO_ROOT="$(cd "$REPO_PRESETS/.." 2>/dev/null && pwd || echo "$REPO_PRESETS/..")" ;;
  esac
  printf '备份/回退约定见 %s/md-backup/backups/ 下最新目录的 README.md\n' "$REPO_ROOT"
  exit 1
fi
printf '\n\033[32m全部通过（⚠ 项建议人工确认）。\033[0m\n'
exit 0
