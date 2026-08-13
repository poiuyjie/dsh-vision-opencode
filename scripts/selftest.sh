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

# fake pnpm：add 往 package.json 追加一行，remove 删除该行
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "add" ]; then printf '  "dsh-vision-opencode": "%s",\n' "$2" >> package.json; fi
if [ "$1" = "remove" ]; then sed -i '/dsh-vision-opencode/d' package.json; fi
EOF
chmod +x "$TMP/bin/pnpm"

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
          input: [ text, image ]
        deepseek-v4-pro:
          input: [ text, image ]
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
grep -q '"dsh-vision-opencode"' "$PROFILE/package.json" && ok "依赖已写入" || bad "依赖缺失"

echo "== 2. install 幂等 =="
PATH="$TMP/bin:$PATH" DSH_HOME="$TMP" bash "$HERE/install.sh" --profile-dir "$PROFILE" >/dev/null
[ "$(grep -c 'id: vision-opencode' "$PROFILE/cordis.patch.yml")" = "1" ] && ok "cordis 条目唯一" || bad "cordis 条目重复"
[ "$(grep -c '^vision-opencode:' "$SETTINGS")" = "1" ] && ok "settings 段唯一" || bad "settings 段重复"

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

echo
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" = "0" ]
