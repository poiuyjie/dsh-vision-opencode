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
- 用户在聊天里发图片时**自动转换**：输入区实时显示临时识图进度，结束后只用 DSH 原生 `notice` 留下一条完成或失败记录
- 自动识别当前适配器目录中的纯文本主模型并接管图片转换；原生多模态主模型保持 DSH 原生图片能力，切换供应商或模型无需同步第二份配置
- 异常兜底：单次调用 60s 超时、可重试失败自动重试 1 次、重试耗尽降级为占位文本（主模型照常回复并告知用户）
- 通过进程内能力兼容层放行图片提交闸门，支持 pi-ai、`deepseek-official` 等不同适配器，不修改用户的模型目录

## 系统支持

支持以下两套原生安装脚本：

- **Ubuntu 24.04 / Bash**：`scripts/install.sh`、`scripts/uninstall.sh`（本机实测）。
- **Windows 10/11 / PowerShell 5.1+**：`scripts/install.ps1`、`scripts/uninstall.ps1`（不要求 Git Bash 或 WSL）。

两套脚本执行相同的配置合并、Cordis 注册、幂等升级和卸载清理流程。macOS 与其他发行版尚未验证。

> 兼容性：本插件基于 **DSH `0.1.0-rc.6`** 开发并验证。它依赖两个尚未文档化的运行时行为——agent-loop 请求在 `llm/stream` 瀑布中 deep-frozen、cordis waterfall 的 `next()` 重放原始参数。DSH 升级到其他 rc 版本后如果行为变化，请升级本插件或关闭 `autoConvert` 逃生阀（见下文）。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash
```

### Windows PowerShell

```powershell
$install = Invoke-RestMethod 'https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.ps1'
& ([scriptblock]::Create($install))
```

安装后重启 `dsh`，然后刷新浏览器页面，在输入框右侧选择识图模型。

## 一键卸载

Ubuntu：

```bash
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

Windows PowerShell：

```powershell
$uninstall = Invoke-RestMethod 'https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.ps1'
& ([scriptblock]::Create($uninstall))
```

> **重要：先备份图片会话。** 卸载后，包含图片的旧对话可能无法继续发送给纯文本主模型。请在卸载前把关键结论、图片描述、代码和待办事项复制或导出为 Markdown（`.md`）文件，再执行卸载；原始图片会话不会被插件自动转换。

> 安装脚本不会选择或写入识图模型，也不要求你填写主模型。插件启动后会根据 DSH 适配器返回的输入能力自动识别纯文本路由；需要代理时再追加 `--proxy` 或 `-Proxy`。
>
> 旧版 `mainProvider/mainModels` 会继续兼容，但不再是必填项，也不需要随主模型切换手动同步。
>
> 卸载只处理非空 `gateState` 能证明属于插件的旧版闸门记录，不会扫描或修改用户及其他插件的图片模型配置。

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
  # mainProvider/mainModels: 旧版兼容字段，可省略；插件会自动识别所有纯文本路由
```

重启 `dsh`。重启后输入框右侧会出现「识图模型」下拉——它自动列出你所有供应商中声明了图片输入的模型；未选择时显示「识图模型」占位，选中即写入 settings。

聊天附件和工作区图片走两条互补路径：聊天附件必须在纯文本主模型请求发出前自动转成文字，识图期间在输入区显示临时状态，结束后只保留一条 `vision-opencode` 上下文记录；主模型后来需要读取文件路径、截图、图表或做 OCR 时，会加载 `vision-image-analysis` skill，再调用 `vision_read_image` 并显示原生工具卡片。二者都使用你在下拉中选择的任意供应商多模态模型，不绑定 OpenCode Go。

`autoConvert` 对所有被 DSH 解析为纯文本输入的主模型生效。切换到另一个供应商或模型后，插件会在首次请求时重新读取其能力；原生支持图片的模型不会被转换。

<details>
<summary>高级：手动卸载</summary>

## 手动卸载（高级）

```bash
# 1. 在 dsh 运行时执行一次自清理：清空插件 settings，并还原旧版本拥有的 modelOverrides
curl -X POST -H 'x-vision-opencode-action: uninstall' http://127.0.0.1:3080/vision-opencode/uninstall

# 2. 停止 dsh（Ctrl+C）

# 3. 删除依赖与注册条目
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    编辑 cordis.patch.yml，删除 vision-opencode 的 insert 条目（若删完后文件只剩注释，把内容替换成 []）

# 4. 重启 dsh
```

> 第 1 步执行后 `settings.yaml` 可能残留一行 `vision-opencode: {}`（插件 settings 清空后的占位），无害；第 3 步可顺手删除。用一键卸载脚本则无需关心，脚本会一并清掉。

当前版本不会新建 `modelOverrides`。若从旧版本升级且仍有非空 `gateState`，请保持 dsh 运行并先执行第 1 步；卸载脚本不会按名称猜测或删除无所有权记录的用户配置。

</details>

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
| 切换到其他供应商或模型 | 自动读取其输入能力；纯文本模型转换图片，原生多模态模型保留 DSH 原链路 |

## 回退 / 逃生阀

- 只想关掉「发图自动转换」（保留工具和选择器）：`settings.yaml` 里 `vision-opencode.autoConvert: false`，重启。
- 完全回退：执行上文卸载流程。回退后行为 = 未安装状态（图片消息被 DSH 闸门正常拒绝，不会打到 API）。

## 已知限制

- 前端选择器是手写的 DSH client bundle（`window.__ModuleLoader__` 格式），client 接口在 rc 版本间可能变动；选择器不出现时打开浏览器控制台把报错发 issue。
- 自动转换发生在请求时刻，分析文本不进持久化会话日志（会话压缩后仍可存活，因为压缩请求同样经过转换瀑布）。
- `deepseek-official` 等非 pi-ai 主路由依赖 DSH 当前的 `resolveModelInfo()` 运行时接口；若未来 DSH 改变图片提交闸门实现，需要同步升级插件。
- 0.2.x 没有闸门所有权记录；无法证明归属的历史 `modelOverrides` 需要用户按实际原值确认，插件不会按模型名猜测删除。

## License

MIT
