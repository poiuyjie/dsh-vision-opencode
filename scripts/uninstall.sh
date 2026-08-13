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
#      （清空插件 settings + 还原 llm-pi-ai.modelOverrides，这是最安全的方式）
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

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile-dir) PROFILE_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

for bin in node pnpm curl; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少命令 $bin"
done

if [ -n "$PROXY" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY"
  [ "${PROXY#socks}" != "$PROXY" ] && export all_proxy="$PROXY"
fi

ENDPOINT="http://127.0.0.1:$PORT/vision-opencode"

# ---- 1. dsh 运行时：插件自清理（还原 modelOverrides，最安全）----
CLEANED_BY_ENDPOINT=0
if curl -fsS --max-time 3 "$ENDPOINT/config" >/dev/null 2>&1; then
  info "dsh 正在运行，调用插件自清理端点 POST $ENDPOINT/uninstall"
  if RESULT=$(curl -fsS --max-time 30 -X POST "$ENDPOINT/uninstall" 2>/dev/null); then
    echo "$RESULT"
    CLEANED_BY_ENDPOINT=1
  else
    echo "⚠ 自清理端点调用失败（插件可能还是旧版本，没有 /uninstall 端点）；继续本地清理，但 llm-pi-ai.modelOverrides 需要手动处理（见末尾提示）"
  fi
else
  cat <<EOF
⚠ dsh 未运行（或 web 端口不对）：跳过插件自清理。
  如果 settings.yaml 的 llm-pi-ai.providers.*.modelOverrides 里有本插件添加的条目
  （纯文本主模型声明了 input: [text, image]），请手动删除，否则卸载后发图片会打到真实 API 报错。
  更稳妥的做法：先启动 dsh 再重新执行本脚本，让插件自清理。
EOF
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
  if (!skip && /^vision-opencode:\s*$/.test(line)) { skip = true; continue; }
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
fs.writeFileSync(file, text);
console.log(`→ 已移除 cordis.patch.yml 的 vision-opencode 条目（${file}）`);
NODE
else
  info "没有 cordis.patch.yml，跳过"
fi

# ---- 4. 移除依赖（幂等：已移除时容错）----
if [ -f "$PROFILE_DIR/package.json" ]; then
  cd "$PROFILE_DIR"
  if grep -q '"dsh-vision-opencode"' package.json; then
    info "移除依赖: pnpm remove dsh-vision-opencode"
    pnpm remove dsh-vision-opencode || die "pnpm remove 失败；可手动编辑 package.json 删除依赖行"
  else
    info "依赖已不存在，跳过 pnpm remove"
  fi
fi

# ---- 5. 完成 ----
cat <<EOF

✅ 卸载完成。剩余一步：
   重启 dsh（Ctrl+C 后重新运行 dsh）。

$( [ "$CLEANED_BY_ENDPOINT" = "1" ] && echo "   已由插件自清理 modelOverrides。" || echo "   注意：确认 settings.yaml 里没有残留的 llm-pi-ai modelOverrides（见上方提示）。" )
EOF
