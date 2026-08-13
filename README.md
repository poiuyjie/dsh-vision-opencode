<div align="center">

# dsh-vision-opencode

[**中文**](https://github.com/poiuyjie/dsh-vision-opencode) ｜ [English](README.en.md)

*点击上方链接切换语言 · Click the links above to switch languages*

</div>

> **DeepSeek 不认图怎么办？OpenCode 这套多模态平替方案了解一下。**

<p align="center">
  <img src="assets/demo.png" alt="dsh-vision-opencode 演示" width="860" />
</p>

DeepSeek Harness（DSH）插件：给纯文本主模型加一个**可配置的识图模型**。主模型（如 DeepSeek）不认识图片？没关系——图片先交给视觉模型（如 MiMo-V2.5）理解成文本，再把结论交给主模型，全程不用换掉你正在用的主力模型。

- 输入框右侧「识图模型」下拉选择器（自动列出所有供应商中声明了图片输入的模型）
- `vision_read_image` 工具：主模型在需要理解图片时**主动调用**（OCR / 图表 / 场景描述），带系统提示词引导
- 用户在聊天里发图片时**自动转换**：图片先用识图模型分析成文本，再交给主模型（主模型永远收不到图片）
- 异常兜底：单次调用 60s 超时、可重试失败自动重试 1 次、重试耗尽降级为占位文本（主模型照常回复并告知用户）
- 安装时自动放行图片提交闸门（`modelOverrides`），卸载时一键还原

## 系统支持

本机在 **Ubuntu 24.04** 上安装、测试通过。其他系统（macOS / 其他发行版等）理论兼容，但未验证；如果遇到问题，可以 git clone 下来让 AI 帮你修改调整：

```bash
git clone https://github.com/poiuyjie/dsh-vision-opencode
```

> 兼容性：本插件基于 **DSH `0.1.0-rc.6`** 开发并验证。它依赖两个尚未文档化的运行时行为——agent-loop 请求在 `llm/stream` 瀑布中 deep-frozen、cordis waterfall 的 `next()` 重放原始参数。DSH 升级到其他 rc 版本后如果行为变化，请升级本插件或关闭 `autoConvert` 逃生阀（见下文）。

## 一键安装 / 卸载

```bash
# 安装（幂等，可重复执行；完成后重启 dsh 生效）
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash -s -- \
  --vision-provider opencode-go --vision-model mimo-v2.5 \
  --main-provider opencode-go --main-model deepseek-v4-pro --main-model deepseek-v4-flash \
  --proxy http://127.0.0.1:7897

# 卸载（dsh 运行时执行可自动还原 modelOverrides；同样幂等）
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

- `--proxy` 仅在安装包的网络环境需要时传；不需要代理就省略。
- `--main-provider` / `--main-model` 是主模型信息，用于自动放行图片提交闸门；不传则需手动配置（见下）。
- 脚本只改动：profile 的 `package.json` 依赖、`cordis.patch.yml` 注册条目、`settings.yaml` 的 `vision-opencode` 段；全程幂等，卸载时优先调用插件自带的 `/vision-opencode/uninstall` 端点还原 `modelOverrides`，dsh 未运行时降级为警告并给出手动指引。

## 手动安装

### 方式 A：GitHub 直接安装

```bash
cd ~/.dsh/profiles/web
pnpm add -w github:poiuyjie/dsh-vision-opencode
# 新版 DSH 的 profile 目录是 pnpm 工作区根（有 pnpm-workspace.yaml），必须加 -w；
# 老版本没有该文件的话去掉 -w 即可。
```

### 方式 B：npm 安装

> ⚠️ 暂未发布到 npm（registry 上还不存在这个包）。发布后即可使用更短的命令：

```bash
cd ~/.dsh/profiles/web
pnpm add -w dsh-vision-opencode   # 目前不可用，请先用方式 A；-w 同上
```

## 注册进 cordis

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
```

## 配置

编辑 `~/.dsh/settings.yaml`：

```yaml
vision-opencode:
  provider: opencode-go      # 识图模型所在供应商路由
  model: mimo-v2.5          # 识图模型 id（须真正支持图片输入）
  autoConvert: true         # 发图自动转换开关（稳定性逃生阀，出问题改 false）
  mainProvider: opencode-go # 主模型所在供应商路由（pi-ai 适配器名下）
  mainModels:               # 纯文本主模型 id 列表（自动放行图片提交闸门）
    - deepseek-v4-pro
    - deepseek-v4-flash
```

重启 `dsh`。重启后输入框右侧会出现「识图模型」下拉；首次选择会写入 settings。

> `mainProvider`/`mainModels` 可留空：此时插件不会自动改任何配置，但向纯文本主模型发送图片会被 DSH 内置的提交闸门拒绝（这是 DSH 的默认安全行为），需要你手动在 `llm-pi-ai.providers.<provider>.modelOverrides` 里给主模型声明 `input: [text, image]`。

## 卸载（先自清理，再删包）

```bash
# 1. 在 dsh 运行时执行一次自清理：清空本插件的 settings、移除它写入的 modelOverrides
curl -X POST http://127.0.0.1:3080/vision-opencode/uninstall

# 2. 停止 dsh（Ctrl+C）

# 3. 删除依赖与注册条目
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    编辑 cordis.patch.yml，删除 vision-opencode 的 insert 条目（若删完后文件只剩注释，把内容替换成 []）

# 4. 重启 dsh
```

> 第 1 步执行后 `settings.yaml` 可能残留一行 `vision-opencode: {}`（插件 settings 清空后的占位），无害；第 3 步可顺手删除。用一键卸载脚本则无需关心，脚本会一并清掉。

**如果跳过第 1 步**：settings 里残留的 `modelOverrides` 会让纯文本主模型"谎称"支持图片，之后发送图片会直接打到真实 API 报错。请手动删除 `settings.yaml` 中 `llm-pi-ai.providers.<provider>.modelOverrides` 的本插件条目，或执行 `curl -X POST .../vision-opencode/uninstall` 后再重启。

插件加载失败不会拖垮 DSH：cordis loader 按条目隔离，失败的插件在「设置 → 插件」里显示 failed，其余插件照常工作。

## 异常处理矩阵

| 情况 | 行为 |
|---|---|
| 识图调用限流/超时/5xx/传输错误 | 退避 800ms 重试 1 次（共 2 次尝试） |
| 非可重试失败（AUTH/4xx 等） | 不重试，立即降级 |
| 重试耗尽（发图自动转换路径） | 降级为占位文本，主模型照常回复并告知用户 |
| 重试耗尽（`vision_read_image` 工具路径） | 工具结果 `isError`（良性），主模型继续工作 |
| 单次调用挂起 | 每次尝试独立 60s 超时 |
| 用户取消回合 | 直接终止，不做无意义降级 |
| 插件自身意外 bug | 最后一道保险：图片全部降级为占位文本，不杀死回合 |

## 回退 / 逃生阀

- 只想关掉「发图自动转换」（保留工具和选择器）：`settings.yaml` 里 `vision-opencode.autoConvert: false`，重启。
- 完全回退：执行上文卸载流程。回退后行为 = 未安装状态（图片消息被 DSH 闸门正常拒绝，不会打到 API）。

## 已知限制

- 前端选择器是手写的 DSH client bundle（`window.__ModuleLoader__` 格式），client 接口在 rc 版本间可能变动；选择器不出现时打开浏览器控制台把报错发 issue。
- `SYNTHETIC_IMAGE_MODELS` 黑名单（index.js 顶部）是硬编码的历史遗留，正常请使用 `mainModels` 配置；两者会自动合并生效。
- 自动转换发生在请求时刻，分析文本不进持久化会话日志（会话压缩后仍可存活，因为压缩请求同样经过转换瀑布）。
- 仅支持 pi-ai 适配器下的主模型闸门自动放行；其他适配器请手动配置。

## License

MIT
