#!/usr/bin/env bash
# dsh-vision-opencode 一键卸载脚本
#
# 用法：
#   ./uninstall.sh [选项]
#
# 选项：
#   --profile-dir <路径>  dsh profile 目录（默认 $DSH_HOME/profiles/web，DSH_HOME 默认 ~/.dsh）
#   --port <端口>          dsh web 端口（默认 3080，用于调用插件自清理端点）
#   --proxy <url>          网络代理（例：--proxy http://127.0.0.1:7897）
#   -h, --help             帮助
#
# 流程：
#   1. dsh 正在运行时：调用 POST /vision-opencode/uninstall 自清理
#      （清空插件 settings + 还原旧版本拥有的 llm-pi-ai.modelOverrides）
#   2. 移除 settings.yaml 的 vision-opencode 段（best-effort；该段在插件卸载后本身无害）
#   3. 移除 cordis.patch.yml 的注册条目
#   4. pnpm remove 依赖
#   5. 提示重启 dsh
#
# 幂等：重复执行安全。
set -euo pipefail

DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_ROOT}/profiles/web"
SETTINGS_FILE="${DSH_ROOT}/settings.yaml"
PORT="${DSH_WEB_PORT:-3080}"
PROXY=""

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }

has_gate_state() {
  [ -f "$1" ] || return 1
  awk '
    /^vision-opencode:/ { inside=1; next }
    inside && /^[^ ]/ { inside=0 }
    inside && /^  gateState:[[:space:]]*[^[:space:]]/ { found=1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

is_plugin_config() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);process.exit(v&&typeof v==="object"&&Object.hasOwn(v,"autoConvert")&&Array.isArray(v.mainModels)?0:1)}catch{process.exit(1)}})'
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "${2:-}" ] || die "$1 需要一个非空值"
}

usage() {
  cat <<'EOF'
用法：uninstall.sh [选项]
  --profile-dir <路径>  dsh profile 目录（默认 $DSH_HOME/profiles/web）
  --port <端口>         dsh web 端口（默认 3080）
  --proxy <url>         调用清理端点时使用的网络代理
  -h, --help            显示帮助
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile-dir) require_value "$1" "${2:-}"; PROFILE_DIR="$2"; shift 2 ;;
    --port) require_value "$1" "${2:-}"; PORT="$2"; shift 2 ;;
    --proxy) require_value "$1" "${2:-}"; PROXY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "缺少命令 node"

if [ -n "$PROXY" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY"
  export NO_PROXY="127.0.0.1,localhost"
  [ "${PROXY#socks}" != "$PROXY" ] && export all_proxy="$PROXY"
fi

ENDPOINT="http://127.0.0.1:$PORT/vision-opencode"

# ---- 1. dsh 运行时：插件自清理（还原 modelOverrides，最安全）----
CLEANED_BY_ENDPOINT=0
CONFIG_RESULT=""
if command -v curl >/dev/null 2>&1; then
  CONFIG_RESULT=$(curl -fsS --max-time 3 "$ENDPOINT/config" 2>/dev/null || true)
fi
if [ -n "$CONFIG_RESULT" ] && printf '%s' "$CONFIG_RESULT" | is_plugin_config; then
  info "dsh 正在运行，调用插件自清理端点 POST $ENDPOINT/uninstall"
  if RESULT=$(curl -fsS --max-time 30 -X POST -H 'x-vision-opencode-action: uninstall' "$ENDPOINT/uninstall" 2>/dev/null); then
    echo "$RESULT"
    CLEANED_BY_ENDPOINT=1
    GATE_REMOVED=$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const n=JSON.parse(s).gateOverridesRemoved;process.stdout.write(typeof n==="number"?String(n):"")}catch{}})')
  else
    echo "⚠ 自清理端点调用失败（插件可能还是旧版本，没有 /uninstall 端点）；将检查是否存在 gateState 所有权记录"
  fi
else
  if ! command -v curl >/dev/null 2>&1; then
    info "未找到 curl，跳过运行时自清理端点"
  fi
  cat <<EOF
⚠ dsh 未运行（或 web 端口不对）：跳过插件自清理。
  若 settings.yaml 中仍有非空 gateState，脚本会中止并要求先启动 dsh 完成精确还原。
  没有所有权记录时，脚本不会猜测或修改任何用户/第三方 modelOverrides。
EOF
fi

if has_gate_state "$SETTINGS_FILE"; then
  die "settings.yaml 仍包含本插件的 gateState 所有权记录，已中止卸载。请启动 dsh 并确认端口后重试，让插件先精确还原旧版 modelOverrides。"
fi

# ---- 2. 移除 settings.yaml 的 vision-opencode 段（幂等；该段本身无害）----
export SETTINGS_FILE
node <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS_FILE;
if (!fs.existsSync(file)) process.exit(0);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const out = [];
let skip = false;
for (const line of lines) {
  if (!skip && /^vision-opencode:/.test(line)) {
    // 块形式（vision-opencode: + 缩进行）或内联形式（如 vision-opencode: {}）都删：
    // 块形式后续缩进行一并跳过；内联形式只删本行。
    skip = line.slice('vision-opencode:'.length).trim() === '';
    continue;
  }
  if (skip) {
    if (/^\s/.test(line) || line.trim() === '') continue; // 段内（缩进）或空行：跳过
    skip = false; // 下一个顶层 token：段结束
  }
  out.push(line);
}
let text = out.join('\n').replace(/\n{3,}$/g, '\n\n');
if (text.endsWith('\n\n')) text = text.slice(0, -1);
fs.writeFileSync(file, text);
console.log(`→ 已移除 settings.yaml 的 vision-opencode 段（${file}）`);
NODE

# ---- 3. 移除 cordis.patch.yml 注册条目（幂等）----
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH_FILE" ]; then
  export PATCH_FILE
  node <<'NODE'
const fs = require('fs');
const file = process.env.PATCH_FILE;
const lines = fs.readFileSync(file, 'utf8').split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (/^- insert:\s*$/.test(line)) {
    // 收集整个 insert 块：表头 + 后续缩进行
    const block = [line];
    i += 1;
    while (i < lines.length && /^\s/.test(lines[i])) { block.push(lines[i]); i += 1; }
    // 从块中剔除 vision-opencode 条目（- id: vision-opencode 及其续行，如 name:）
    const kept = [];
    let j = 0;
    while (j < block.length) {
      const l = block[j];
      if (/^\s*- id:\s*vision-opencode\s*$/.test(l)) {
        j += 1;
        while (j < block.length && /^\s/.test(block[j]) && !/^\s*- /.test(block[j])) j += 1;
        continue;
      }
      kept.push(l);
      j += 1;
    }
    // 条目全被剔除时，连 insert 表头一起删掉
    if (kept.length > 1) out.push(...kept);
    continue;
  }
  out.push(line);
  i += 1;
}
let text = out.join('\n').replace(/\n{3,}$/g, '\n\n');
if (text.endsWith('\n\n')) text = text.slice(0, -1);
// 条目清空后若只剩注释/空行，YAML 会解析成 null 而不是数组，
// dsh 启动会直接报错——补一个空数组，保证文件始终合法。
if (!out.some((line) => line.trim() !== '' && !line.trim().startsWith('#'))) {
  text = text.trimEnd() === '' ? '[]' : `${text.trimEnd()}\n\n[]`;
}
fs.writeFileSync(file, text);
console.log(`→ 已移除 cordis.patch.yml 的 vision-opencode 条目（${file}）`);
NODE
else
  info "没有 cordis.patch.yml，跳过"
fi

# ---- 4. 移除依赖（幂等：已移除时容错）----
if [ -f "$PROFILE_DIR/package.json" ]; then
  cd "$PROFILE_DIR"
  if grep -q '"dsh-vision-opencode"[[:space:]]*:' package.json; then
    command -v pnpm >/dev/null 2>&1 || die "缺少命令 pnpm（package.json 仍包含 dsh-vision-opencode）"
    PNPM_WORKSPACE_ARGS=()
    [ -f pnpm-workspace.yaml ] && PNPM_WORKSPACE_ARGS=(-w)
    info "移除依赖: pnpm remove ${PNPM_WORKSPACE_ARGS[*]} dsh-vision-opencode"
    pnpm remove "${PNPM_WORKSPACE_ARGS[@]}" dsh-vision-opencode || die "pnpm remove 失败；可手动编辑 package.json 删除依赖行"
  else
    info "依赖已不存在，跳过 pnpm remove"
  fi
fi

# ---- 5. 完成 ----
if [ "$CLEANED_BY_ENDPOINT" = "1" ]; then
  FINAL_NOTE="   插件端点已自清理（还原 ${GATE_REMOVED:-0} 条旧版 modelOverrides）。用户及其他插件的图片配置保持不变。"
else
  FINAL_NOTE="   未发现插件所有权记录；卸载器未修改任何 llm-pi-ai modelOverrides。"
fi

cat <<EOF

✅ 卸载完成。剩余一步：
   重启 dsh（Ctrl+C 后重新运行 dsh）。

$FINAL_NOTE
EOF
