#!/usr/bin/env bash
# 自检：在临时 fake profile 里跑 install/uninstall 脚本，断言关键不变量。
# 不碰真实 ~/.dsh；pnpm 用假桩。用法：bash scripts/selftest.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

PROFILE="$TMP/profile"
SETTINGS="$TMP/settings.yaml"
mkdir -p "$PROFILE"

# fake pnpm：记录调用，add 往 package.json 追加一行，remove 删除该行；接受 -w
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
command="$1"; shift
if [ "${1:-}" = "-w" ]; then shift; fi
if [ "$command" = "add" ]; then printf '  "dsh-vision-opencode": "%s",\n' "$1" >> package.json; fi
if [ "$command" = "remove" ]; then sed -i '/dsh-vision-opencode/d' package.json; fi
EOF
chmod +x "$TMP/bin/pnpm"
export PNPM_LOG="$TMP/pnpm.log"

cat > "$SETTINGS" <<'EOF'
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-pro
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      modelOverrides:
        deepseek-v4-flash:
          input: [ text ]
        deepseek-v4-pro:
          input: [ text ]
EOF
cat > "$PROFILE/cordis.patch.yml" <<'EOF'
# Your patch layer for this dsh profile.
- insert:
    - id: other-plugin
      name: 'other-plugin'
EOF
printf '{ "dependencies": { "other-plugin": "1.0.0" } }\n' > "$PROFILE/package.json"

echo "== 1. install（全新）=="
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
grep -q 'id: vision-opencode' "$PROFILE/cordis.patch.yml" && ok "cordis 条目已写入" || bad "cordis 条目缺失"
grep -q '^vision-opencode:' "$SETTINGS" && ok "settings 段已写入" || bad "settings 段缺失"
grep -Eq 'mainProvider: (opencode-go|"opencode-go")' "$SETTINGS" && grep -Eq '    - (deepseek-v4-pro|"deepseek-v4-pro")' "$SETTINGS" && ok "自动继承默认主路由" || bad "未自动继承默认主路由"
! grep -q 'mimo-v2.5' "$SETTINGS" && ok "默认不写入硬编码识图模型" || bad "默认写入了硬编码识图模型"
grep -q '"dsh-vision-opencode"' "$PROFILE/package.json" && ok "依赖已写入" || bad "依赖缺失"

echo "== 2. install 幂等 =="
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
[ "$(grep -c 'id: vision-opencode' "$PROFILE/cordis.patch.yml")" = "1" ] && ok "cordis 条目唯一" || bad "cordis 条目重复"
[ "$(grep -c '^vision-opencode:' "$SETTINGS")" = "1" ] && ok "settings 段唯一" || bad "settings 段重复"
grep -q '^update dsh-vision-opencode$' "$PNPM_LOG" && ok "重复安装会拉取仓库最新版本" || bad "已有依赖时跳过了升级"

echo "== 3. 端点残留 vision-opencode: {} 应被 install 原位替换 =="
sed -i 's/^vision-opencode:.*/vision-opencode: {}/' "$SETTINGS"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
[ "$(grep -c '^vision-opencode:' "$SETTINGS")" = "1" ] && ! grep -q 'vision-opencode: {}' "$SETTINGS" && ok "{} 被替换为完整段" || bad "{} 未替换"

echo "== 4. uninstall（离线路径，--port 1 保证连不上）=="
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/uninstall.sh" --profile-dir "$PROFILE" --port 1 >/dev/null
! grep -q 'vision-opencode' "$PROFILE/cordis.patch.yml" && ok "cordis 条目已移除" || bad "cordis 条目残留"
grep -q 'id: other-plugin' "$PROFILE/cordis.patch.yml" && ok "其他插件条目保留" || bad "其他插件条目被误删"
! grep -q 'vision-opencode' "$SETTINGS" && ok "settings 段已移除" || bad "settings 段残留"
grep -q 'deepseek-v4-pro' "$SETTINGS" && ok "modelOverrides 保留（离线路径只警告不动）" || bad "modelOverrides 被误动"
! grep -q 'dsh-vision-opencode' "$PROFILE/package.json" && ok "依赖已移除" || bad "依赖残留"

echo "== 5. 只剩注释的 cordis 必须退化为合法数组；内联 {} 必须删干净 =="
printf '# 只剩注释\n\n' > "$PROFILE/cordis.patch.yml"
printf 'vision-opencode: {}\nagent-default-model:\n  provider: opencode-go\n' > "$SETTINGS"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/uninstall.sh" --profile-dir "$PROFILE" --port 1 >/dev/null
grep -q '^\[]$' "$PROFILE/cordis.patch.yml" && ok "cordis 退化为 []（dsh 可启动）" || bad "cordis 仍是注释-only（dsh 启动会崩）"
! grep -q 'vision-opencode' "$SETTINGS" && ok "内联 {} 残留已移除" || bad "{} 残留未移除"
grep -q 'agent-default-model' "$SETTINGS" && ok "其他配置保留" || bad "其他配置被误删"

echo "== 6. uninstall 幂等 =="
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/uninstall.sh" --profile-dir "$PROFILE" --port 1 >/dev/null && ok "重复执行不报错" || bad "重复执行失败"

echo "== 7. profile 是 pnpm 工作区根时，install 用 -w 也能装上 =="
printf 'packages:\n  - .\n' > "$PROFILE/pnpm-workspace.yaml"
printf '{ "name": "dsh-profile-web", "private": true, "dependencies": {} }\n' > "$PROFILE/package.json"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
grep -q '"dsh-vision-opencode"' "$PROFILE/package.json" && ok "工作区根下依赖已写入" || bad "工作区根下依赖缺失"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/uninstall.sh" --profile-dir "$PROFILE" --port 1 >/dev/null
! grep -q 'dsh-vision-opencode' "$PROFILE/package.json" && ok "工作区根下依赖可卸载" || bad "工作区根下依赖残留"

echo "== 8. 卸载留下的 [] 占位上重装：不得与条目共存（双文档崩溃回归）=="
printf '# 只剩注释\n\n[]\n' > "$PROFILE/cordis.patch.yml"
printf '{ "name": "dsh-profile-web", "private": true, "dependencies": {} }\n' > "$PROFILE/package.json"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
grep -q 'id: vision-opencode' "$PROFILE/cordis.patch.yml" && ok "条目已写入" || bad "条目缺失"
! grep -Eq '^\s*\[\s*\]\s*$' "$PROFILE/cordis.patch.yml" && ok "[] 占位已移除（不再双文档）" || bad "[] 占位仍与条目共存"
[ "$(grep -Ev '^\s*(#|$)' "$PROFILE/cordis.patch.yml" | head -1)" = "- insert:" ] && ok "首个非注释条目是 - insert:" || bad "文件结构异常"
grep -q '^#' "$PROFILE/cordis.patch.yml" && ok "头部注释保留" || bad "头部注释丢失"

echo "== 9. 坏文件（[] + 条目共存）能被 install 自愈 =="
printf '# 注释\n\n[]\n\n- insert:\n    - id: vision-opencode\n      name: '"'"'dsh-vision-opencode'"'"'\n' > "$PROFILE/cordis.patch.yml"
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
! grep -Eq '^\s*\[\s*\]\s*$' "$PROFILE/cordis.patch.yml" && grep -q 'id: vision-opencode' "$PROFILE/cordis.patch.yml" && ok "坏文件已自愈（占位删除、条目保留）" || bad "坏文件未自愈"

echo "== 10. 显式指定识图模型时写入对应配置（可选参数）=="
FRESH="$TMP/fresh"; mkdir -p "$FRESH/profile"
printf '{ "name": "dsh-profile-web", "private": true, "dependencies": {} }\n' > "$FRESH/profile/package.json"
PATH="$TMP/bin:$PATH" DSH_HOME="$FRESH" bash "$HERE/install.sh" --profile-dir "$FRESH/profile" --vision-provider acme --vision-model eagle-eye >/dev/null
grep -Eq 'provider: (acme|"acme")' "$FRESH/settings.yaml" && grep -Eq 'model: (eagle-eye|"eagle-eye")' "$FRESH/settings.yaml" && ok "指定识图模型已写入" || bad "指定识图模型未写入"

echo "== 11. settings 段已存在时参数合并重写（覆盖 + 补写 + 继承）=="
PATH="$TMP/bin:$PATH" DSH_HOME="$FRESH" bash "$HERE/install.sh" --profile-dir "$FRESH/profile" \
  --vision-provider new-p --vision-model new-m --main-provider mp --main-model mm1 --main-model mm2 >/dev/null
grep -Eq 'provider: (new-p|"new-p")' "$FRESH/settings.yaml" && grep -Eq 'model: (new-m|"new-m")' "$FRESH/settings.yaml" && ok "新参数覆盖旧值" || bad "参数未覆盖"
grep -Eq 'mainProvider: (mp|"mp")' "$FRESH/settings.yaml" && grep -Eq '    - (mm1|"mm1")' "$FRESH/settings.yaml" && grep -Eq '    - (mm2|"mm2")' "$FRESH/settings.yaml" && ok "mainProvider/mainModels 已补写" || bad "main 参数未写入"
grep -q 'autoConvert: true' "$FRESH/settings.yaml" && ok "未传参数继承现有值" || bad "继承失败"
[ "$(grep -c '^vision-opencode:' "$FRESH/settings.yaml")" = "1" ] && ok "段唯一（无重复键）" || bad "段重复"

echo "== 12. 合并后再跑（不带参数）保持既有值 =="
sed -i '/^  autoConvert:/a\  gateState: eyJvd25lZCI6dHJ1ZX0' "$FRESH/settings.yaml"
PATH="$TMP/bin:$PATH" DSH_HOME="$FRESH" bash "$HERE/install.sh" --profile-dir "$FRESH/profile" >/dev/null
grep -Eq 'provider: (new-p|"new-p")' "$FRESH/settings.yaml" && grep -Eq 'mainProvider: (mp|"mp")' "$FRESH/settings.yaml" && grep -Eq '    - (mm1|"mm1")' "$FRESH/settings.yaml" && ok "无参数重跑保留既有配置" || bad "无参数重跑丢失配置"
grep -q 'gateState: eyJvd25lZCI6dHJ1ZX0' "$FRESH/settings.yaml" && ok "重装保留隐藏 gateState" || bad "重装丢失 gateState"

echo "== 13. 无 gateState 的用户图片 override 不得阻止卸载 =="
LEGACY="$TMP/legacy"; mkdir -p "$LEGACY/profile"
cat > "$LEGACY/settings.yaml" <<'EOF'
llm-pi-ai:
  providers:
    opencode-go:
      modelOverrides:
        deepseek-v4-pro:
          input: [ text, image ]
vision-opencode:
  provider: opencode-go
  model: vision-model
EOF
cat > "$LEGACY/profile/cordis.patch.yml" <<'EOF'
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
EOF
printf '{ "dependencies": { "dsh-vision-opencode": "github:poiuyjie/dsh-vision-opencode" } }\n' > "$LEGACY/profile/package.json"
cp "$LEGACY/settings.yaml" "$LEGACY/settings.before"
PATH="$TMP/bin:$PATH" DSH_HOME="$LEGACY" bash "$HERE/uninstall.sh" --profile-dir "$LEGACY/profile" --port 1 >/dev/null
grep -q 'input: \[ text, image \]' "$LEGACY/settings.yaml" && ok "用户图片 override 保留" || bad "用户图片 override 被修改"
! grep -q '^vision-opencode:' "$LEGACY/settings.yaml" && ok "插件 settings 已移除" || bad "插件 settings 残留"
! grep -q 'vision-opencode' "$LEGACY/profile/cordis.patch.yml" && ok "插件 Cordis 条目已移除" || bad "插件 Cordis 条目残留"

echo "== 14. 有 gateState 时离线卸载必须原样中止 =="
CLAIMED="$TMP/claimed"; mkdir -p "$CLAIMED/profile"
cp "$LEGACY/settings.before" "$CLAIMED/settings.yaml"
sed -i '/^  model:/a\  gateState: owned-claim' "$CLAIMED/settings.yaml"
cat > "$CLAIMED/profile/cordis.patch.yml" <<'EOF'
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
EOF
printf '{ "dependencies": { "dsh-vision-opencode": "github:poiuyjie/dsh-vision-opencode" } }\n' > "$CLAIMED/profile/package.json"
cp "$CLAIMED/settings.yaml" "$CLAIMED/settings.before"
cp "$CLAIMED/profile/cordis.patch.yml" "$CLAIMED/cordis.before"
cp "$CLAIMED/profile/package.json" "$CLAIMED/package.before"
if PATH="$TMP/bin:$PATH" DSH_HOME="$CLAIMED" bash "$HERE/uninstall.sh" --profile-dir "$CLAIMED/profile" --port 1 >/dev/null 2>&1; then
  bad "有所有权记录时未阻止离线卸载"
else
  ok "有所有权记录时阻止离线卸载"
fi
cmp -s "$CLAIMED/settings.before" "$CLAIMED/settings.yaml" && ok "中止后 settings 原样保留" || bad "中止后 settings 被修改"
cmp -s "$CLAIMED/cordis.before" "$CLAIMED/profile/cordis.patch.yml" && ok "中止后 Cordis 原样保留" || bad "中止后 Cordis 被修改"
cmp -s "$CLAIMED/package.before" "$CLAIMED/profile/package.json" && ok "中止后依赖原样保留" || bad "中止后依赖被修改"

echo "== 15. 参数错误必须在安装副作用前失败 =="
INVALID="$TMP/invalid"; mkdir -p "$INVALID/profile"
printf 'agent-default-model:\n  provider: p\n  model: m\n' > "$INVALID/settings.yaml"
printf '# untouched\n\n[]\n' > "$INVALID/profile/cordis.patch.yml"
printf '{ "dependencies": {} }\n' > "$INVALID/profile/package.json"
cp "$INVALID/settings.yaml" "$INVALID/settings.before"
cp "$INVALID/profile/cordis.patch.yml" "$INVALID/cordis.before"
cp "$INVALID/profile/package.json" "$INVALID/package.before"
if PATH="$TMP/bin:$PATH" DSH_HOME="$INVALID" bash "$HERE/install.sh" --profile-dir "$INVALID/profile" --vision-provider only >/dev/null 2>&1; then
  bad "不完整识图参数未报错"
else
  ok "不完整识图参数会报错"
fi
cmp -s "$INVALID/settings.before" "$INVALID/settings.yaml" && cmp -s "$INVALID/cordis.before" "$INVALID/profile/cordis.patch.yml" && cmp -s "$INVALID/package.before" "$INVALID/profile/package.json" && ok "参数错误零副作用" || bad "参数错误产生了安装副作用"

echo
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" = "0" ]
