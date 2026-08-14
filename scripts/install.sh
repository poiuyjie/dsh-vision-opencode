#!/usr/bin/env bash
# dsh-vision-opencode 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash
# 或下载后：
#   ./install.sh [选项]
#
# 选项：
#   --profile-dir <路径>        dsh profile 目录（默认 $DSH_HOME/profiles/web，DSH_HOME 默认 ~/.dsh）
#   --vision-provider <名称>    识图模型供应商路由（可选；不传则安装后在界面下拉选择）
#   --vision-model <id>         识图模型 id（可选；与 --vision-provider 成对使用）
#   --main-provider <名称>      主模型供应商路由（写入 mainProvider，自动放行图片提交闸门）
#   --main-model <id>           纯文本主模型 id（可重复；写入 mainModels）
#   --no-auto-convert           关闭「发图自动转换」瀑布（只保留工具 + 选择器）
#   --proxy <url>               网络代理（例：--proxy http://127.0.0.1:7897），安装过程下载包时使用
#   -h, --help                  帮助
#
# 脚本幂等：重复执行不会产生重复条目。执行完成后需重启 dsh 生效。
set -euo pipefail

REPO_SPEC="github:poiuyjie/dsh-vision-opencode"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_ROOT}/profiles/web"
SETTINGS_FILE="${DSH_ROOT}/settings.yaml"
# 识图模型不预设默认：用户供应商/套餐各不相同，硬编码会把别人没有的模型写进去。
# 不传则选择器显示「识图模型」，由用户从自己供应商里支持图片输入的模型中选择。
VISION_PROVIDER=""
VISION_MODEL=""
MAIN_PROVIDER=""
MAIN_MODELS=()
AUTO_CONVERT="true"
AUTO_CONVERT_OVERRIDDEN=""
GATE_STATE=""
PROXY=""
VISION_PROVIDER_SET=0
VISION_MODEL_SET=0

require_value() {
  [ "$#" -ge 2 ] && [ -n "${2:-}" ] || die "$1 需要一个非空值"
}

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }

usage() {
  cat <<'EOF'
用法：install.sh [选项]
  --profile-dir <路径>        dsh profile 目录（默认 $DSH_HOME/profiles/web）
  --vision-provider <名称>    识图模型供应商路由（需与 --vision-model 同时提供）
  --vision-model <id>         识图模型 id（需与 --vision-provider 同时提供）
  --main-provider <名称>      主模型供应商路由
  --main-model <id>           纯文本主模型 id（可重复）
  --no-auto-convert           关闭发图自动转换
  --proxy <url>               安装过程中使用的网络代理
  -h, --help                  显示帮助
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile-dir) require_value "$1" "${2:-}"; PROFILE_DIR="$2"; shift 2 ;;
    --vision-provider) require_value "$1" "${2:-}"; VISION_PROVIDER="$2"; VISION_PROVIDER_SET=1; shift 2 ;;
    --vision-model) require_value "$1" "${2:-}"; VISION_MODEL="$2"; VISION_MODEL_SET=1; shift 2 ;;
    --main-provider) require_value "$1" "${2:-}"; MAIN_PROVIDER="$2"; shift 2 ;;
    --main-model) require_value "$1" "${2:-}"; MAIN_MODELS+=("$2"); shift 2 ;;
    --no-auto-convert) AUTO_CONVERT="false"; AUTO_CONVERT_OVERRIDDEN="1"; shift ;;
    --proxy) require_value "$1" "${2:-}"; PROXY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

for bin in node pnpm; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少命令 $bin（node/pnpm 是 DSH 的依赖，请先安装）"
done

if [ -n "$PROXY" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY"
  export NO_PROXY="127.0.0.1,localhost"
  [ "${PROXY#socks}" != "$PROXY" ] && export all_proxy="$PROXY"
fi

[ -d "$PROFILE_DIR" ] || mkdir -p "$PROFILE_DIR"
[ -f "$PROFILE_DIR/package.json" ] || die "$PROFILE_DIR 不是 dsh profile 目录（缺少 package.json）"

# ---- 1. 读取并校验 settings（失败时不产生安装副作用）----
# 段已存在时：命令行参数覆盖对应键，未传的参数继承现有值，然后整段重写；
# 段不存在时直接追加。全程不会产生重复键。
extract_key() {
  # $1 = 键名；输出现有段中该键的标量值（无则空）
  awk -v k="$1" '
    $0 ~ /^vision-opencode:/ { in_sec=1; next }
    in_sec && /^[^ ]/ { exit }
    in_sec && $0 ~ "^  " k ":" {
      v = substr($0, index($0, ":") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v);
      if (v == "''" || v == "\"\"") v = "";
      if (length(v) >= 2 && ((substr(v, 1, 1) == "'" && substr(v, length(v), 1) == "'") || (substr(v, 1, 1) == "\"" && substr(v, length(v), 1) == "\""))) v = substr(v, 2, length(v) - 2);
      print v; exit
    }
  ' "$SETTINGS_FILE" 2>/dev/null || true
}
extract_list() {
  # 输出现有段 mainModels 列表（每行一个 id）
  awk '
    $0 ~ /^vision-opencode:/ { in_sec=1; next }
    in_sec && /^[^ ]/ { exit }
    in_sec && /^[ ]+mainModels:/ { in_list=1; next }
    in_list && /^[ ]+- / {
      line=$0; sub(/^[ ]+- /, "", line);
      if (length(line) >= 2 && ((substr(line, 1, 1) == "'" && substr(line, length(line), 1) == "'") || (substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\""))) line = substr(line, 2, length(line) - 2);
      print line; next
    }
    in_list && /^[ ]/ { next }
    in_list { exit }
  ' "$SETTINGS_FILE" 2>/dev/null || true
}

extract_default_model_key() {
  # 从 dsh 的默认主模型段读取 provider/model，避免安装时要求用户选择识图模型。
  awk -v k="$1" '
    /^agent-default-model:/ { inside=1; next }
    inside && /^[^ ]/ { exit }
    inside && $0 ~ "^  " k ":" {
      v = substr($0, index($0, ":") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v);
      if (v == "''" || v == "\"\"") v = "";
      if (length(v) >= 2 && ((substr(v, 1, 1) == "'" && substr(v, length(v), 1) == "'") || (substr(v, 1, 1) == "\"" && substr(v, length(v), 1) == "\""))) v = substr(v, 2, length(v) - 2);
      print v; exit
    }
  ' "$SETTINGS_FILE" 2>/dev/null || true
}

yaml_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

if [ -f "$SETTINGS_FILE" ] && grep -q '^vision-opencode:' "$SETTINGS_FILE"; then
  info "vision-opencode 段已存在：合并参数后整段重写"
  [ -n "$VISION_PROVIDER" ] || VISION_PROVIDER="$(extract_key provider)"
  [ -n "$VISION_MODEL" ] || VISION_MODEL="$(extract_key model)"
  if [ "${AUTO_CONVERT_OVERRIDDEN:-0}" != "1" ]; then
    AUTO_CONVERT="$(extract_key autoConvert)"
  fi
  [ -n "$AUTO_CONVERT" ] || AUTO_CONVERT="true"
  [ -n "$MAIN_PROVIDER" ] || MAIN_PROVIDER="$(extract_key mainProvider)"
  if [ ${#MAIN_MODELS[@]} -eq 0 ]; then
    while IFS= read -r m; do [ -n "$m" ] && MAIN_MODELS+=("$m"); done < <(extract_list)
  fi
  # 隐藏所有权记录必须跨重装保留，否则卸载时无法安全还原 modelOverrides。
  GATE_STATE="$(extract_key gateState)"
fi

if [ -z "$VISION_PROVIDER" ] || [ -z "$VISION_MODEL" ]; then
  if [ "$VISION_PROVIDER_SET" = "1" ] || [ "$VISION_MODEL_SET" = "1" ]; then
    die "--vision-provider 和 --vision-model 必须同时提供（或都不提供）"
  fi
fi
if [ -z "$MAIN_PROVIDER" ] && [ ${#MAIN_MODELS[@]} -eq 0 ] && [ -z "$GATE_STATE" ] && [ -f "$SETTINGS_FILE" ]; then
  MAIN_PROVIDER="$(extract_default_model_key provider)"
  DEFAULT_MODEL="$(extract_default_model_key model)"
  if [ -n "$MAIN_PROVIDER" ] && [ -n "$DEFAULT_MODEL" ]; then
    MAIN_MODELS=("$DEFAULT_MODEL")
    info "未指定主路由，已从 agent-default-model 自动接管 $MAIN_PROVIDER/$DEFAULT_MODEL"
  else
    MAIN_PROVIDER=""
  fi
fi
if [ ${#MAIN_MODELS[@]} -gt 0 ] && [ -z "$MAIN_PROVIDER" ]; then
  die "使用 --main-model 时必须提供 --main-provider（或让脚本从已有配置继承）"
fi

# ---- 2. 安装或升级依赖 ----
cd "$PROFILE_DIR"
PNPM_WORKSPACE_ARGS=()
if [ -f pnpm-workspace.yaml ]; then
  PNPM_WORKSPACE_ARGS=(-w)
fi
if grep -q '"dsh-vision-opencode"[[:space:]]*:' package.json; then
  # GitHub branch 依赖会被锁到具体 commit；必须显式 update 才能取得新版本。
  info "依赖已存在，升级到仓库最新版本"
  pnpm update "${PNPM_WORKSPACE_ARGS[@]}" dsh-vision-opencode
else
  # DSH 新版 profile 目录自带 pnpm-workspace.yaml（packages: [.]），是 pnpm 工作区根：
  # 直接 pnpm add 会报 ERR_PNPM_ADDING_TO_ROOT，必须 -w 显式装到根。
  info "安装依赖: pnpm add ${PNPM_WORKSPACE_ARGS[*]} $REPO_SPEC"
  pnpm add "${PNPM_WORKSPACE_ARGS[@]}" "$REPO_SPEC"
fi

# ---- 3. 注册 cordis.patch.yml 条目（幂等）----
touch cordis.patch.yml
if grep -Eq '^\s*\[\s*\]\s*$' cordis.patch.yml; then
  sed -i '/^\s*\[\s*\]\s*$/d' cordis.patch.yml
  info "已移除 cordis.patch.yml 的空数组占位"
fi
if grep -Eq '^[[:space:]]*- id: vision-opencode[[:space:]]*$' cordis.patch.yml; then
  info "cordis.patch.yml 条目已存在，跳过"
else
  info "向 cordis.patch.yml 追加注册条目"
  printf '\n- insert:\n    - id: vision-opencode\n      name: %s\n' "'dsh-vision-opencode'" >> cordis.patch.yml
fi

VISION_PROVIDER_YAML="$(yaml_quote "$VISION_PROVIDER")"
VISION_MODEL_YAML="$(yaml_quote "$VISION_MODEL")"
MAIN_PROVIDER_YAML="$(yaml_quote "$MAIN_PROVIDER")"

SETTINGS_BLOCK="vision-opencode:"
if [ -n "$VISION_PROVIDER" ] && [ -n "$VISION_MODEL" ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  provider: $VISION_PROVIDER_YAML
  model: $VISION_MODEL_YAML"
fi
SETTINGS_BLOCK="$SETTINGS_BLOCK
  autoConvert: $AUTO_CONVERT"
if [ -n "$MAIN_PROVIDER" ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  mainProvider: $MAIN_PROVIDER_YAML"
fi
if [ ${#MAIN_MODELS[@]} -gt 0 ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  mainModels:"
  for m in "${MAIN_MODELS[@]}"; do
    m_yaml="$(yaml_quote "$m")"
    SETTINGS_BLOCK="$SETTINGS_BLOCK
    - $m_yaml"
  done
fi
if [ -n "$GATE_STATE" ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  gateState: $GATE_STATE"
fi

# ---- 4. 写 settings.yaml 的 vision-opencode 段（幂等 + 合并）----
export SETTINGS_BLOCK SETTINGS_FILE
node <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS_FILE;
const block = process.env.SETTINGS_BLOCK;
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
// 先移除已有段（块形式或内联 {} 形式），再统一追加合并后的新段。
const m = text.match(/^vision-opencode:.*$/m);
if (m !== null) {
  const lines = text.split('\n');
  const start = text.slice(0, m.index).split('\n').length - 1;
  const out = [];
  let skip = false;
  for (let i = 0; i < lines.length; i++) {
    if (i === start) {
      skip = lines[i].slice('vision-opencode:'.length).trim() === '';
      continue;
    }
    if (skip) {
      if (/^\s/.test(lines[i]) || lines[i].trim() === '') continue;
      skip = false;
    }
    out.push(lines[i]);
  }
  text = out.join('\n').replace(/\n{3,}$/g, '\n\n');
  if (text.endsWith('\n\n')) text = text.slice(0, -1);
}
if (text.length > 0 && !text.endsWith('\n')) text += '\n';
text += block + '\n';
fs.writeFileSync(file, text);
console.log(`→ 已写入 settings.yaml 的 vision-opencode 段（${file}）`);
NODE

# ---- 5. 完成 ----
cat <<EOF

✅ 安装完成。剩余一步：
   重启 dsh（在运行 dsh 的终端 Ctrl+C，再重新运行 dsh）
   刷新浏览器页面，输入框右侧会出现「识图模型」下拉：如未指定识图模型，
   请在下拉里选择一个（自动列出你所有供应商中支持图片输入的模型）。

   回退/卸载：scripts/uninstall.sh（本仓库）
EOF
