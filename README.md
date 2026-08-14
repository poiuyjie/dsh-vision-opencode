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
- 运行时 skill `vision-image-analysis`：按需指导主模型调用 `vision_read_image` 做 OCR / 图表 / 场景理解；未启用 DSH skill 服务时自动退化为工具与系统提示词
- 用户在聊天里发图片时**自动转换**，并以 DSH 原生 `notice` 上下文注入展示“正在识图 / 完成 / 失败 / 缓存复用”过程
- 只接管 `mainProvider/mainModels` 明确配置的完整路由；其他供应商和原生多模态主模型保持 DSH 原生图片能力
- 异常兜底：单次调用 60s 超时、可重试失败自动重试 1 次、重试耗尽降级为占位文本（主模型照常回复并告知用户）
- 自动放行图片提交闸门（`modelOverrides`），隐藏记录修改前的值，卸载时只还原插件拥有且未被用户改写的字段

## 系统支持

本机在 **Ubuntu 24.04** 上安装、测试通过。其他系统（macOS / 其他发行版等）理论兼容，但未验证；如果遇到问题，可以 git clone 下来让 AI 帮你修改调整：

```bash
git clone https://github.com/poiuyjie/dsh-vision-opencode
```

> 兼容性：本插件基于 **DSH `0.1.0-rc.6`** 开发并验证。它依赖两个尚未文档化的运行时行为——agent-loop 请求在 `llm/stream` 瀑布中 deep-frozen、cordis waterfall 的 `next()` 重放原始参数。DSH 升级到其他 rc 版本后如果行为变化，请升级本插件或关闭 `autoConvert` 逃生阀（见下文）。

## 一键安装 / 卸载

```bash
# 安装（幂等，可重复执行；完成后重启 dsh 生效）
# 识图模型不预设默认：不传 --vision-*，装好后在输入框右侧「识图模型」下拉里选
#（下拉自动列出你所有供应商中支持图片输入的模型；--vision-* 可选，用于固定识图模型）
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash -s -- \
  --main-provider opencode-go --main-model deepseek-v4-pro --main-model deepseek-v4-flash \
  --proxy http://127.0.0.1:7897

# 卸载（dsh 运行时执行可自动还原 modelOverrides；同样幂等）
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

- `--vision-provider` / `--vision-model` 可选：想固定识图模型才传；不传则装好后在输入框右侧「识图模型」下拉里选择（自动列出你所有供应商中支持图片输入的模型）。
- `--proxy` 仅在安装包的网络环境需要时传；不需要代理就省略。
- `--main-provider` / `--main-model` 是主模型信息，用于自动放行图片提交闸门；不传则需手动配置（见下）。
- 脚本只改动：profile 的 `package.json` 依赖、`cordis.patch.yml` 注册条目、`settings.yaml` 的 `vision-opencode` 段；重复运行时会升级 GitHub 依赖并保持配置幂等，卸载时优先调用插件自带的 `/vision-opencode/uninstall` 端点还原 `modelOverrides`，dsh 未运行时降级为警告并给出手动指引。

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

> 若文件里有一行空数组占位 `[]`（一键卸载脚本收尾会留），先删掉那一行再追加——`[]` 与条目共存会被 YAML 当成两个文档，dsh 启动会报错。

## 配置

编辑 `~/.dsh/settings.yaml`：

```yaml
vision-opencode:
  provider: ''              # 识图模型所在供应商路由；留空 = 未选择（选择器显示「识图模型」）
  model: ''                 # 识图模型 id；留空 = 未选择（在下拉里选中后自动写入）
  autoConvert: true         # 发图自动转换开关（稳定性逃生阀，出问题改 false）
  mainProvider: opencode-go # 主模型所在供应商路由（pi-ai 适配器名下）
  mainModels:               # 纯文本主模型 id 列表（自动放行图片提交闸门）
    - deepseek-v4-pro
    - deepseek-v4-flash
```

重启 `dsh`。重启后输入框右侧会出现「识图模型」下拉——它自动列出你所有供应商中声明了图片输入的模型；未选择时显示「识图模型」占位，选中即写入 settings。

聊天附件和工作区图片走两条互补路径：聊天附件必须在纯文本主模型请求发出前自动转成文字，因此显示为可见的 `vision-opencode` 上下文注入；主模型后来需要读取文件路径、截图、图表或做 OCR 时，会加载 `vision-image-analysis` skill，再调用 `vision_read_image`。二者都使用你在下拉中选择的任意供应商多模态模型，不绑定 OpenCode Go。

`autoConvert` 只对 `mainProvider` 与 `mainModels` 同时匹配的路由生效。例如只配置 `opencode-go/deepseek-v4-flash` 时，其他供应商下同名模型不会被拦截，切换到原生多模态主模型也会继续使用 DSH 自带的图片链路。

> `mainProvider`/`mainModels` 可留空：此时插件不会自动改任何配置，但向纯文本主模型发送图片会被 DSH 内置的提交闸门拒绝（这是 DSH 的默认安全行为），需要你手动在 `llm-pi-ai.providers.<provider>.modelOverrides` 里给主模型声明 `input: [text, image]`。

## 卸载（先自清理，再删包）

```bash
# 1. 在 dsh 运行时执行一次自清理：清空本插件的 settings、移除它写入的 modelOverrides
curl -X POST -H 'x-vision-opencode-action: uninstall' http://127.0.0.1:3080/vision-opencode/uninstall

# 2. 停止 dsh（Ctrl+C）

# 3. 删除依赖与注册条目
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    编辑 cordis.patch.yml，删除 vision-opencode 的 insert 条目（若删完后文件只剩注释，把内容替换成 []）

# 4. 重启 dsh
```

> 第 1 步执行后 `settings.yaml` 可能残留一行 `vision-opencode: {}`（插件 settings 清空后的占位），无害；第 3 步可顺手删除。用一键卸载脚本则无需关心，脚本会一并清掉。

**如果跳过第 1 步**：settings 里残留的 `modelOverrides` 会让纯文本主模型"谎称"支持图片，之后发送图片会直接打到真实 API 报错。请手动还原 `settings.yaml` 中对应的 `input` 字段，或带上方请求头调用 `/vision-opencode/uninstall` 后再重启。由 0.2.x 升级而来且尚无隐藏 `gateState` 的旧条目无法证明所有权，0.3.x 不会冒险删除，请按实际原值手动清理一次。

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
| 切换到未列入 `mainModels` 的模型 | 插件不拦截，完整保留该模型的原生图片处理 |

## 回退 / 逃生阀

- 只想关掉「发图自动转换」（保留工具和选择器）：`settings.yaml` 里 `vision-opencode.autoConvert: false`，重启。
- 完全回退：执行上文卸载流程。回退后行为 = 未安装状态（图片消息被 DSH 闸门正常拒绝，不会打到 API）。

## 已知限制

- 前端选择器是手写的 DSH client bundle（`window.__ModuleLoader__` 格式），client 接口在 rc 版本间可能变动；选择器不出现时打开浏览器控制台把报错发 issue。
- 自动转换发生在请求时刻，分析文本不进持久化会话日志（会话压缩后仍可存活，因为压缩请求同样经过转换瀑布）。
- 仅支持 pi-ai 适配器下的主模型闸门自动放行；其他适配器请手动配置。
- 0.2.x 没有闸门所有权记录；首次升级时若存在旧 `modelOverrides`，需要用户确认后手动清理，插件不会按模型名猜测删除。

## License

MIT
