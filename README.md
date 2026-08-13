# dsh-vision-opencode

> **DeepSeek 不认图怎么办？OpenCode 这套多模态平替方案了解一下。**
> **DeepSeek can't see images? Here's an OpenCode-powered multimodal drop-in alternative.**

<p align="center">
  <img src="assets/demo.png" alt="dsh-vision-opencode demo" width="860" />
</p>

DeepSeek Harness（DSH）插件：给纯文本主模型加一个**可配置的识图模型**。主模型（如 DeepSeek）不认识图片？没关系——图片先交给视觉模型（如 MiMo-V2.5）理解成文本，再把结论交给主模型，全程不用换掉你正在用的主力模型。

A plugin for DeepSeek Harness (DSH) that adds a **configurable vision model** alongside your text-only main model. Your main model (e.g. DeepSeek) can't read images? No problem — images are first understood by a vision model (e.g. MiMo-V2.5) and turned into text, which is then handed to your main model. You never have to swap out your primary model.

- 输入框右侧「识图模型」下拉选择器（自动列出所有供应商中声明了图片输入的模型）
- `vision_read_image` 工具：主模型在需要理解图片时**主动调用**（OCR / 图表 / 场景描述），带系统提示词引导
- 用户在聊天里发图片时**自动转换**：图片先用识图模型分析成文本，再交给主模型（主模型永远收不到图片）
- 异常兜底：单次调用 60s 超时、可重试失败自动重试 1 次、重试耗尽降级为占位文本（主模型照常回复并告知用户）
- 安装时自动放行图片提交闸门（`modelOverrides`），卸载时一键还原

EN:
- A "vision model" dropdown next to the input box (auto-lists every image-capable model across providers)
- A `vision_read_image` tool: the main model proactively calls it whenever it needs to understand an image (OCR / charts / scene description), with system-prompt guidance
- **Auto-conversion** when the user sends an image in chat: the image is analyzed into text by the vision model first, then given to the main model (the main model never receives the image itself)
- Fault tolerance: 60s per-call timeout, one automatic retry for retriable failures, and a graceful placeholder-text fallback when retries are exhausted (the main model still answers and tells the user)
- Auto-whitelists the image-submission gate (`modelOverrides`) on install; one-click restore on uninstall

## 系统支持 / Supported Systems

本机在 **Ubuntu 24.04** 上安装、测试通过。其他系统（macOS / 其他发行版等）理论兼容，但未验证；如果遇到问题，可以 git clone 下来让 AI 帮你修改调整：

Tested and verified on **Ubuntu 24.04**. Other systems (macOS, other distros, ...) should be compatible in theory but are unverified; if you hit issues, clone the repo and let an AI tweak it for you:

```bash
git clone https://github.com/poiuyjie/dsh-vision-opencode
```

> 兼容性：本插件基于 **DSH `0.1.0-rc.6`** 开发并验证。它依赖两个尚未文档化的运行时行为——agent-loop 请求在 `llm/stream` 瀑布中 deep-frozen、cordis waterfall 的 `next()` 重放原始参数。DSH 升级到其他 rc 版本后如果行为变化，请升级本插件或关闭 `autoConvert` 逃生阀（见下文）。
>
> Compatibility: built and verified against **DSH `0.1.0-rc.6`**. It relies on two undocumented runtime behaviors — agent-loop requests deep-frozen in the `llm/stream` waterfall, and cordis waterfall `next()` replaying original arguments. If DSH behavior changes in a later rc, upgrade this plugin or turn off the `autoConvert` escape hatch (see below).

## 一键安装 / 卸载（One-click Install / Uninstall）

```bash
# 安装（幂等，可重复执行；完成后重启 dsh 生效）
# Install (idempotent, safe to re-run; restart dsh afterwards)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash -s -- \
  --vision-provider opencode-go --vision-model mimo-v2.5 \
  --main-provider opencode-go --main-model deepseek-v4-pro --main-model deepseek-v4-flash \
  --proxy http://127.0.0.1:7897

# 卸载（dsh 运行时执行可自动还原 modelOverrides；同样幂等）
# Uninstall (running it while dsh is up auto-restores modelOverrides; also idempotent)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

- `--proxy` 仅在安装包的网络环境需要时传；不需要代理就省略。 / Only pass `--proxy` if your network needs it to reach GitHub/npm.
- `--main-provider` / `--main-model` 是主模型信息，用于自动放行图片提交闸门；不传则需手动配置（见下）。 / These describe your text main model and are used to auto-whitelist the image-submission gate; omit them and configure manually instead (see below).
- 脚本只改动：profile 的 `package.json` 依赖、`cordis.patch.yml` 注册条目、`settings.yaml` 的 `vision-opencode` 段；全程幂等，卸载时优先调用插件自带的 `/vision-opencode/uninstall` 端点还原 `modelOverrides`，dsh 未运行时降级为警告并给出手动指引。 / The scripts only touch: the profile's `package.json` dependency, the `cordis.patch.yml` registration entry, and the `vision-opencode` section in `settings.yaml`. Fully idempotent. Uninstall prefers calling the plugin's own `/vision-opencode/uninstall` endpoint to restore `modelOverrides`; if dsh isn't running it degrades to a warning plus manual instructions.

## 手动安装 / Manual Install

### 方式 A / Option A：GitHub 直接安装 / Install from GitHub

```bash
cd ~/.dsh/profiles/web
pnpm add github:poiuyjie/dsh-vision-opencode
```

### 方式 B / Option B：npm 安装（发布后）/ Install from npm (once published)

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-vision-opencode
```

## 注册进 cordis / Register in cordis

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加 / Edit it and append:

```yaml
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
```

## 配置 / Configuration

编辑 / Edit `~/.dsh/settings.yaml`:

```yaml
vision-opencode:
  provider: opencode-go      # 识图模型所在供应商路由 / provider route for the vision model
  model: mimo-v2.5          # 识图模型 id（须真正支持图片输入）/ vision model id (must really accept images)
  autoConvert: true         # 发图自动转换开关（稳定性逃生阀，出问题改 false）/ auto-convert toggle (stability escape hatch; set false if problems)
  mainProvider: opencode-go # 主模型所在供应商路由（pi-ai 适配器名下）/ provider route for the main model (under the pi-ai adapter)
  mainModels:               # 纯文本主模型 id 列表（自动放行图片提交闸门）/ text-only main model ids (auto-whitelist the image gate)
    - deepseek-v4-pro
    - deepseek-v4-flash
```

重启 `dsh`。重启后输入框右侧会出现「识图模型」下拉；首次选择会写入 settings。

Restart `dsh`. A "vision model" dropdown appears next to the input box; the first selection is written back into settings.

> `mainProvider`/`mainModels` 可留空：此时插件不会自动改任何配置，但向纯文本主模型发送图片会被 DSH 内置的提交闸门拒绝（这是 DSH 的默认安全行为），需要你手动在 `llm-pi-ai.providers.<provider>.modelOverrides` 里给主模型声明 `input: [text, image]`。
>
> `mainProvider`/`mainModels` may be left empty: the plugin then changes no config, but sending images to a text-only main model will be rejected by DSH's built-in submission gate (DSH's default safety behavior). Manually declare `input: [text, image]` for the main model under `llm-pi-ai.providers.<provider>.modelOverrides` instead.

## 卸载（先自清理，再删包）/ Uninstall (self-clean first, then remove)

```bash
# 1. 在 dsh 运行时执行一次自清理：清空本插件的 settings、移除它写入的 modelOverrides
#    With dsh running, self-clean once: clears this plugin's settings, removes its modelOverrides
curl -X POST http://127.0.0.1:3080/vision-opencode/uninstall

# 2. 停止 dsh（Ctrl+C）/ Stop dsh (Ctrl+C)

# 3. 删除依赖与注册条目 / Remove the dependency and registration entry
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    编辑 cordis.patch.yml，删除 vision-opencode 的 insert 条目
#    Edit cordis.patch.yml and remove the vision-opencode insert entry

# 4. 重启 dsh / Restart dsh
```

**如果跳过第 1 步**：settings 里残留的 `modelOverrides` 会让纯文本主模型"谎称"支持图片，之后发送图片会直接打到真实 API 报错。请手动删除 `settings.yaml` 中 `llm-pi-ai.providers.<provider>.modelOverrides` 的本插件条目，或执行 `curl -X POST .../vision-opencode/uninstall` 后再重启。

**If you skip step 1**: leftover `modelOverrides` in settings will make the text-only main model "claim" to support images, and later image messages will hit the real API and error out. Either manually remove this plugin's entries under `llm-pi-ai.providers.<provider>.modelOverrides` in `settings.yaml`, or run `curl -X POST .../vision-opencode/uninstall` and restart.

插件加载失败不会拖垮 DSH：cordis loader 按条目隔离，失败的插件在「设置 → 插件」里显示 failed，其余插件照常工作。

A plugin load failure won't take DSH down: the cordis loader isolates per entry — a failed plugin shows as failed in "Settings → Plugins" while everything else keeps working.

## 异常处理矩阵 / Error Handling Matrix

| 情况 / Situation | 行为 / Behavior |
|---|---|
| 识图调用限流/超时/5xx/传输错误 Rate-limit / timeout / 5xx / transport errors | 退避 800ms 重试 1 次（共 2 次尝试）Retry once after 800ms backoff (2 attempts total) |
| 非可重试失败（AUTH/4xx 等）Non-retriable failures (AUTH/4xx, etc.) | 不重试，立即降级 No retry; fall back immediately |
| 重试耗尽（发图自动转换路径）Retries exhausted (auto-convert path) | 降级为占位文本，主模型照常回复并告知用户 Fall back to placeholder text; the main model still answers and informs the user |
| 重试耗尽（`vision_read_image` 工具路径）Retries exhausted (tool path) | 工具结果 `isError`（良性），主模型继续工作 Tool result is `isError` (benign); the main model continues |
| 单次调用挂起 A single call hangs | 每次尝试独立 60s 超时 Independent 60s timeout per attempt |
| 用户取消回合 User cancels the turn | 直接终止，不做无意义降级 Abort immediately; no pointless fallback |
| 插件自身意外 bug Unexpected plugin bug | 最后一道保险：图片全部降级为占位文本，不杀死回合 Last resort: all images degrade to placeholder text; the turn is never killed |

## 回退 / 逃生阀 / Rollback / Escape Hatch

- 只想关掉「发图自动转换」（保留工具和选择器）：`settings.yaml` 里 `vision-opencode.autoConvert: false`，重启。
- 完全回退：执行上文卸载流程。回退后行为 = 未安装状态（图片消息被 DSH 闸门正常拒绝，不会打到 API）。
- To only disable auto-conversion (keep the tool and selector): set `vision-opencode.autoConvert: false` in `settings.yaml` and restart.
- Full rollback: run the uninstall flow above. After rollback, behavior equals the uninstalled state (image messages are normally rejected by DSH's gate and never hit the API).

## 已知限制 / Known Limitations

- 前端选择器是手写的 DSH client bundle（`window.__ModuleLoader__` 格式），client 接口在 rc 版本间可能变动；选择器不出现时打开浏览器控制台把报错发 issue。 / The frontend selector is a hand-written DSH client bundle (`window.__ModuleLoader__` format); the client interface may change between rc releases. If the selector doesn't appear, open the browser console and file the error as an issue.
- `SYNTHETIC_IMAGE_MODELS` 黑名单（index.js 顶部）是硬编码的历史遗留，正常请使用 `mainModels` 配置；两者会自动合并生效。 / The `SYNTHETIC_IMAGE_MODELS` blacklist (top of index.js) is a hardcoded legacy leftover; prefer the `mainModels` config — both merge automatically.
- 自动转换发生在请求时刻，分析文本不进持久化会话日志（会话压缩后仍可存活，因为压缩请求同样经过转换瀑布）。 / Auto-conversion happens at request time; the analyzed text is not written into the persistent session log (it can still survive session compaction, since compaction requests pass through the same conversion waterfall).
- 仅支持 pi-ai 适配器下的主模型闸门自动放行；其他适配器请手动配置。 / Auto-whitelisting of the main-model gate is only supported under the pi-ai adapter; configure manually for other adapters.

## License

MIT
