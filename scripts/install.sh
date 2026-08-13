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
PROXY=""

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile-dir) PROFILE_DIR="$2"; shift 2 ;;
    --vision-provider) VISION_PROVIDER="$2"; shift 2 ;;
    --vision-model) VISION_MODEL="$2"; shift 2 ;;
    --main-provider) MAIN_PROVIDER="$2"; shift 2 ;;
    --main-model) MAIN_MODELS+=("$2"); shift 2 ;;
    --no-auto-convert) AUTO_CONVERT="false"; shift ;;
    --proxy) PROXY="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

for bin in node pnpm curl; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少命令 $bin（node/pnpm 是 DSH 的依赖，请先安装）"
done

if [ -n "$PROXY" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY"
  [ "${PROXY#socks}" != "$PROXY" ] && export all_proxy="$PROXY"
fi

[ -d "$PROFILE_DIR" ] || mkdir -p "$PROFILE_DIR"
[ -f "$PROFILE_DIR/package.json" ] || die "$PROFILE_DIR 不是 dsh profile 目录（缺少 package.json）"
cd "$PROFILE_DIR"

# ---- 1. 安装依赖（幂等：package.json 里已有则跳过）----
if grep -q '"dsh-vision-opencode"' package.json; then
  info "依赖已存在，跳过 pnpm add"
else
  # DSH 新版 profile 目录自带 pnpm-workspace.yaml（packages: [.]），是 pnpm 工作区根：
  # 直接 pnpm add 会报 ERR_PNPM_ADDING_TO_ROOT，必须 -w 显式装到根。
  if [ -f pnpm-workspace.yaml ]; then
    info "安装依赖: pnpm add -w $REPO_SPEC"
    pnpm add -w "$REPO_SPEC"
  else
    info "安装依赖: pnpm add $REPO_SPEC"
    pnpm add "$REPO_SPEC"
  fi
fi

# ---- 2. 注册 cordis.patch.yml 条目（幂等：已有 id: vision-opencode 则跳过）----
touch cordis.patch.yml
# 空数组占位（卸载脚本收尾产物或历史遗留）不能与条目共存：
# "[]" 之后跟 "- insert:" 会被 YAML 当成两个文档，dsh 启动直接报错。
# 无论是否已有本插件条目，先清掉占位行（同时自愈旧的坏文件）。
if grep -Eq '^\s*\[\s*\]\s*$' cordis.patch.yml; then
  sed -i '/^\s*\[\s*\]\s*$/d' cordis.patch.yml
  info "已移除 cordis.patch.yml 的空数组占位"
fi
if grep -q 'id: vision-opencode' cordis.patch.yml; then
  info "cordis.patch.yml 条目已存在，跳过"
else
  info "向 cordis.patch.yml 追加注册条目"
  {
    printf '\n- insert:\n    - id: vision-opencode\n      name: %s\n' "'dsh-vision-opencode'"
  } >> cordis.patch.yml
fi

# ---- 3. 写 settings.yaml 的 vision-opencode 段（幂等：已存在则跳过）----
SETTINGS_BLOCK="vision-opencode:"
if [ -n "$VISION_PROVIDER" ] && [ -n "$VISION_MODEL" ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  provider: $VISION_PROVIDER
  model: $VISION_MODEL"
fi
SETTINGS_BLOCK="$SETTINGS_BLOCK
  autoConvert: $AUTO_CONVERT"
if [ -n "$MAIN_PROVIDER" ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  mainProvider: $MAIN_PROVIDER"
fi
if [ ${#MAIN_MODELS[@]} -gt 0 ]; then
  SETTINGS_BLOCK="$SETTINGS_BLOCK
  mainModels:"
  for m in "${MAIN_MODELS[@]}"; do
    SETTINGS_BLOCK="$SETTINGS_BLOCK
    - $m"
  done
fi

export SETTINGS_BLOCK SETTINGS_FILE
node <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS_FILE;
const block = process.env.SETTINGS_BLOCK;
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
if (/^vision-opencode:\s*$/m.test(text)) {
  console.log('→ settings.yaml 的 vision-opencode 段已存在，跳过');
  process.exit(0);
}
// 卸载端点自清理后可能残留内联空对象（vision-opencode: {}）；
// 原位替换成完整配置段，避免追加后出现重复键。
const emptyInline = text.match(/^vision-opencode:\s*\{\s*\}\s*\n?/m);
if (emptyInline !== null) {
  text = text.replace(emptyInline[0], block + '\n');
  fs.writeFileSync(file, text);
  console.log('→ 已将 settings.yaml 的 vision-opencode: {} 替换为完整配置段');
  process.exit(0);
}
if (text.length > 0 && !text.endsWith('\n')) text += '\n';
text += block + '\n';
fs.writeFileSync(file, text);
console.log(`→ 已写入 settings.yaml 的 vision-opencode 段（${file}）`);
NODE

# ---- 4. 完成 ----
cat <<EOF

✅ 安装完成。剩余一步：
   重启 dsh（在运行 dsh 的终端 Ctrl+C，再重新运行 dsh）
   重启后输入框右侧出现「识图模型」下拉：如未指定识图模型，
   请在下拉里选择一个（自动列出你所有供应商中支持图片输入的模型）。

   回退/卸载：scripts/uninstall.sh（本仓库）
EOF
