// dsh-vision-opencode: DeepSeek Harness 插件（后端半边）。
//
// 1. 注册 `vision_read_image` 工具：无论当前会话主模型是否支持图片输入，
//    调用该工具都会把图片转成 durable attachment，并通过 DSH 自带的
//    `llm` 服务用配置的识图模型完成一次带图分析，把文本分析结果返回给主模型。
//    带系统提示词 section 引导主模型在必要时主动调用。
// 2. 注册 settings namespace `vision-opencode`：
//      provider/model 识图模型路由
//      autoConvert      llm/stream 瀑布开关（发图自动转换的稳定性逃生阀）
//      mainProvider/mainModels  旧版/手动指定的兼容路由（现在也会自动识别所有纯文本路由）
// 3. llm/stream 瀑布：含图请求先由识图模型分析成文本再交给主模型；
//    超时+重试+降级占位，识图不可用不影响主模型回合。
// 4. web 模式注册 HTTP 端点：
//      GET  /vision-opencode/config      当前配置
//      PUT  /vision-opencode/config      更新识图模型（校验真实 vision 能力）
//      GET  /vision-opencode/models      可识图模型列表（供应商目录）
//      POST /vision-opencode/uninstall   卸载前自清理（settings + 旧版 modelOverrides）
//    前端"识图模型"选择器通过它们读写配置。
import { basename, extname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import {
  PLUGIN_IMAGE_INPUT,
  countImages,
  countUniqueImages,
  gateClaimKey,
  installImageAdmissionOverride,
  isManagedMainRoute,
  replaceImagesWithText,
  sameStringArray,
  visionCacheKey,
} from './core.js';

/**
 * pi-ai 的官方内置供应商目录（37 个，含 amazon-bedrock/anthropic/google/
 * deepseek/minimax/opencode-go 等）。dsh-llm-pi-ai 只在用户配置过的路由上
 * 暴露 listProviders()，未配置的官方目录在这里读取，供设置页"提供方"下拉
 * 复用完整列表。动态 import：宿主未装 pi-ai 时不影响插件加载。
 */
const piAiCatalog = import('@earendil-works/pi-ai/providers/all')
  .then((mod) => mod)
  .catch(() => void 0);
/** pi-ai 适配器的 API 协议清单（openai-completions/anthropic/…），用于自定义提供方表单。 */
const piAiProtocols = import('@deepseek-ai/dsh-llm-pi-ai')
  .then((mod) => typeof mod?.supportedProtocols === 'function' ? mod.supportedProtocols() : [])
  .catch(() => []);

/** `vision_read_image` 接受的扩展名与媒体类型（与内置 read_image 一致）。 */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * 识图模型不预设默认值：不同用户的供应商/套餐各不相同，硬编码默认
 * 会把别人没有的模型写进配置。未配置时选择器显示「识图模型」占位，
 * 由用户从自己供应商中声明了图片输入的模型里选择。
 */

/** 本插件持有的 settings namespace。 */
const NS = settingsNamespace('vision-opencode');

/** 单条 Vision 模型（插件自管，不依赖宿主 provider 目录）。 */
const VisionModelEntry = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  name: z.string().default(''),
  description: z.string().default(''),
  baseUrl: z.string().default(''),
  requestFormat: z.union([z.const('openai'), z.const('openai-completions'), z.const('openai-responses'), z.const('anthropic')]).default('openai-completions'),
  /** 该模型的推理策略：''=默认(跟随提供方)；'off'=关闭(提供方支持时生效)；
   *  'forceOff'=强制关闭(实验：提供方未申报关闭档时，尝试直连网关发禁用参数，不保证成功) */
  reasoning: z.string().default(''),
});

/** 识图模型配置 schema（settings 面板自动生成表单）。 */
const Config = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  /** 插件自管的 Vision 模型列表：与 llm 宿主目录解耦，供设置页增删改查。 */
  visionModels: z.array(VisionModelEntry).default([]),
  /** llm/stream 瀑布开关：false 时停用「发图自动转换」，只保留工具与选择器（稳定性逃生阀）。 */
  autoConvert: z.boolean().default(true),
  /** 识图推理开关：false/缺省=关闭思考（默认）；true=开启（走提供方默认档位）。 */
  visionReasoning: z.boolean().default(false),
  /** 可选：强制关闭（forceOff）直连网关时用的 API key；留空则尝试读进程环境 OPENCODE_GO_API_KEY。 */
  apiKey: z.string().default('').hidden(),
  /** 旧版/手动兼容路由；当前版本通常由适配器能力自动识别。 */
  mainProvider: z.string().default(''),
  /** 旧版/手动兼容模型列表；无需随当前主模型切换同步。 */
  mainModels: z.array(z.string()).default([]),
  /** 旧版本修改 modelOverrides 前保存的 input；仅用于升级/卸载时精确恢复。 */
  gateState: z.string().default('').hidden(),
  /** 设置页「检测到未导入的系统模型」里被用户 × 掉的模型（"provider/model" 数组），持久化避免每次重开又提示。 */
  ignoredModels: z.array(z.string()).default([]),
});

const VISION_SYSTEM_PROMPT = [
  '你是一个图像理解专家，运行在视觉模型上。',
  '你的唯一任务是理解用户提供的图片内容。',
  '要求：',
  '- 忠实、详细地描述图片内容：场景、物体、文字（含 OCR 结果）、图表数据、界面元素等',
  '- 对图片中的文字做准确转录，不猜测、不编造；看不清就明确说"看不清"',
  '- 如果是截图/图表/论文图/示意图，说明图中呈现的结构与要点',
  '- 不要编造图片中不存在的内容，不确定的部分标注"无法确认"',
  '- 默认使用中文回答（除非调用者用其他语言提问）',
].join('\n');

export const name = 'vision-opencode';
export const inject = ['tools', 'llm', 'fs', 'attachments', 'sessions', 'systemPrompt'];

/** 序列化 JSON 响应。 */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** 读取请求体并解析为 JSON（空体返回 {}）。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

export function apply(ctx, entry) {
  const attachments = ctx.get('attachments');
  if (attachments === void 0) {
    ctx.logger.warn('vision-opencode: attachments service unavailable; vision_read_image tool not registered');
    return;
  }

  // ---- 识图模型配置：settings section（可选挂载）+ 内存镜像 ----
  let current = () => entry;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    const next = {
      provider: typeof raw?.provider === 'string' ? raw.provider.trim() : '',
      model: typeof raw?.model === 'string' ? raw.model.trim() : '',
      visionModels: Array.isArray(raw?.visionModels)
        ? raw.visionModels.filter((e) => e !== null && typeof e === 'object'
          && typeof e.id === 'string' && e.id.length > 0
          && typeof e.provider === 'string' && e.provider.length > 0
          && typeof e.model === 'string' && e.model.length > 0)
          .map((e) => ({
            id: e.id,
            provider: String(e.provider).trim(),
            model: String(e.model).trim(),
            name: typeof e.name === 'string' ? e.name.trim() : '',
            description: typeof e.description === 'string' ? e.description.trim() : '',
            baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl.trim() : '',
            requestFormat: e.requestFormat === 'anthropic' ? 'anthropic' : (e.requestFormat === 'openai-responses' ? 'openai-responses' : 'openai-completions'),
            reasoning: e.reasoning === 'off' ? 'off' : e.reasoning === 'forceOff' ? 'forceOff' : '',
          }))
        : [],
      autoConvert: raw?.autoConvert !== false,
      visionReasoning: raw?.visionReasoning === true,
      apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '',
      mainProvider: typeof raw?.mainProvider === 'string' ? raw.mainProvider.trim() : '',
      mainModels: Array.isArray(raw?.mainModels)
        ? raw.mainModels.filter((id) => typeof id === 'string' && id.length > 0)
        : [],
      gateState: typeof raw?.gateState === 'string' ? raw.gateState : '',
      ignoredModels: Array.isArray(raw?.ignoredModels)
        ? raw.ignoredModels.filter((s) => typeof s === 'string' && s.length > 0)
        : [],
    };
    lastRaw = raw;
    lastGood = next;
    return next;
  };
  /** 是否已配置可用的识图模型（任一为空即视为未配置）。 */
  const hasVisionModel = (route) => typeof route?.provider === 'string' && route.provider.length > 0
    && typeof route?.model === 'string' && route.model.length > 0;
  const publicOptions = () => {
    const { gateState: _gateState, ...value } = options();
    return value;
  };
  const nativeVisionRoutes = new Set();
  const resolvedTextRoutes = new Set();
  // A route is learned from the adapter catalog on the same resolve call that
  // DSH uses for its image-admission gate. This lets users switch providers or
  // models without keeping a second, stale mainProvider/mainModels list in sync.
  const managedRoute = (provider, model) => {
    if (options().autoConvert !== true) return false;
    const key = gateClaimKey(provider, model);
    return resolvedTextRoutes.has(key) || isManagedMainRoute(options(), provider, model);
  };
  const managedTextRoute = (provider, model) => managedRoute(provider, model)
    && !nativeVisionRoutes.has(gateClaimKey(provider, model));

  // dsh-host-apiproxy checks resolveModelInfo before llm/stream runs. Some
  // providers (notably dsh-llm-deepseek) are not backed by llm-pi-ai, so their
  // catalog cannot be extended through modelOverrides. Report image admission
  // for every resolved text-only route this plugin converts immediately in
  // llm/stream; native multimodal routes keep their original capability.
  const llmRuntime = ctx.get('llm');
  if (llmRuntime !== void 0 && typeof llmRuntime.resolveModelInfo === 'function') {
    try {
      const restoreImageAdmission = installImageAdmissionOverride(
        llmRuntime,
        managedRoute,
        (provider, model, info) => {
          const key = gateClaimKey(provider, model);
          if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) {
            nativeVisionRoutes.add(key);
            resolvedTextRoutes.delete(key);
          } else if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('text')) {
            nativeVisionRoutes.delete(key);
            resolvedTextRoutes.add(key);
          } else {
            nativeVisionRoutes.delete(key);
            resolvedTextRoutes.delete(key);
          }
        },
      );
      ctx.effect(() => restoreImageAdmission);
    } catch (error) {
      ctx.logger.warn('vision-opencode: 无法安装图片提交闸门兼容层；非 llm-pi-ai 主模型可能仍会被 DSH 拒绝', error);
    }
  }
  let settingsScope;
  let settingsService;
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings;
    settingsScope = settingsService.register(NS, Config, { base: entry });
    current = () => settingsScope.get();
    sctx.effect(() => () => {
      current = () => entry;
    });
    // 启动时迁移并还原旧版本的持久化图片闸门（幂等、尽力而为）
    void ensureGateOverrides();
  });

  // ---- 结构性拦截：执行前拒绝内置 read_image，防止真实图片进入纯文本主模型上下文 ----
  // 背景：运行时兼容层会让配置的纯文本主模型临时声明“支持图片输入”，
  // 副作用是内置 read_image 的自身门禁也会放行——模型一旦
  // 调用它，工具结果会把真实 image 块注入上下文，上游纯文本 API 直接
  // 400 INVALID_REQUEST。用 tools.guard 在"执行前"拒绝（结构上图片永不
  // 进入上下文），拒绝原因会作为工具结果交给模型，引导它改用 vision_read_image。
  ctx.tools.guard((exec) => {
    if (exec?.name !== 'read_image') return;
    let provider;
    let model;
    try {
      const config = exec.agent?.session?.requestHeader?.()?.config;
      provider = config?.provider;
      model = config?.model;
    } catch {
      provider = void 0;
      model = void 0;
    }
    if (!managedTextRoute(provider, model)) return;
    return `read_image is blocked for the configured text-only main model (${provider}/${model}): a real image block would make the provider reject the request. Load the vision-image-analysis skill when available, then use vision_read_image to receive a text analysis.`;
  });

  // ---- 混合进度展示：临时 SSE 状态 + 最终原生 notice ----
  // “正在识图”只通过前端临时状态展示，不写入 session；结束后追加一条简短
  // notice 作为结果记录。这样等待过程可见，但不会留下永久的 running 消息。
  const progressClients = new Map();
  function emitVisionProgress(sessionId, payload) {
    if (sessionId === void 0) return;
    const clients = progressClients.get(sessionId);
    if (clients === void 0) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of [...clients]) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
    if (clients.size === 0) progressClients.delete(sessionId);
  }
  const visionStatusMessage = (text, summary) => createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'vision-opencode',
      form: 'notice',
      summary,
    },
  });
  /**
   * 向请求所属会话发送临时进度，返回一个结束函数；结束时向 session
   * 追加最终 notice。纯缓存命中只更新临时状态，不重复污染会话历史。
   * 任何一步失败都不影响主流程（展示只是辅助）。
   */
  function appendVisionStatus(llmOptions, route, imageCount, currentImageCount) {
    try {
      const sessionId = typeof llmOptions?.sessionId === 'string' ? llmOptions.sessionId : void 0;
      if (sessionId === void 0) return void 0;
      const session = ctx.get('sessions')?.get(sessionId);
      const started = Date.now();
      const historicalImageCount = Math.max(0, imageCount - currentImageCount);
      const runningText = currentImageCount > 0
        ? `正在调用 ${route.provider}/${route.model} 分析本轮 ${currentImageCount} 张图片${historicalImageCount > 0 ? `，并整理 ${historicalImageCount} 张历史图片上下文` : ''}...`
        : `正在调用 ${route.provider}/${route.model} 恢复 ${historicalImageCount} 张历史图片上下文...`;
      emitVisionProgress(sessionId, {
        state: 'running',
        text: runningText,
      });
      return ({ failures = 0, reused = 0, unexpectedError, cancelled = false } = {}) => {
        try {
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          let text;
          let summary;
          let state;
          if (cancelled) {
            text = `已取消图片分析（${seconds}s，${route.provider}/${route.model}）`;
            summary = '图片分析已取消';
            state = 'cancelled';
          } else if (unexpectedError !== void 0) {
            text = `⚠️ 图片分析异常（${seconds}s，${route.provider}/${route.model}）：${unexpectedError}`;
            summary = '图片分析异常';
            state = 'failed';
          } else if (failures > 0) {
            text = `⚠️ 图片分析完成但有 ${failures} 张失败（${seconds}s，${route.provider}/${route.model}）`;
            summary = '图片分析部分失败';
            state = 'failed';
          } else if (reused === imageCount) {
            text = `↩ 已复用 ${imageCount} 张图片的识别缓存（${seconds}s，${route.provider}/${route.model}）`;
            summary = '已复用图片分析';
            state = 'done';
          } else {
            const reusedText = reused > 0 ? `，其中 ${reused} 张复用缓存` : '';
            const contextText = historicalImageCount > 0
              ? `，同时处理 ${historicalImageCount} 张历史图片上下文`
              : '';
            text = currentImageCount > 0
              ? `✅ 本轮 ${currentImageCount} 张图片分析完成（${seconds}s，${route.provider}/${route.model}${contextText}${reusedText}）`
              : `✅ 已恢复 ${historicalImageCount} 张历史图片上下文（${seconds}s，${route.provider}/${route.model}${reusedText}）`;
            summary = '图片分析完成';
            state = 'done';
          }
          emitVisionProgress(sessionId, { state, text });
          // 成功路径（done）不再追加会话通知：每张新图的完整分析文本已作为
          // 沉淀消息写进会话历史（见 persistAnalysis），避免重复记录；
          // 失败/取消/部分失败仍需要错误通知。
          if (state === 'done' || reused === imageCount || session === void 0 || typeof session.append !== 'function') return;
          session.append('user/message', visionStatusMessage(text, summary), { surfaceOp: 'append' });
        } catch {
          // 状态展示失败不影响主流程
        }
      };
    } catch {
      return void 0;
    }
  }

  // ---- 系统提示词：让主模型「知道」识图模型存在，并在必要时主动调用 ----
  // 工具 schema 会自动出现在每个 step 的请求里，这一节提示词负责强化调用时机：
  // 用户提到/工具结果指向图片文件路径、需要 OCR/图表/场景理解时主动调用。
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== void 0) {
    systemPrompt.section({
      name: 'tool:vision_read_image',
      order: 112,
      text: () => {
        const route = options();
        const routing = 'For a configured text-only main route, load the vision-image-analysis skill when it is available and use vision_read_image instead of built-in read_image. If the current main model natively supports images and read_image is not blocked, keep using its native image path.';
        if (!hasVisionModel(route)) {
          return `No helper vision model has been configured yet. vision_read_image will fail until the user picks one from the 「识图模型」 selector. ${routing}`;
        }
        return `A helper vision model (${route.provider}/${route.model}) is available. ${routing} Images attached to a configured text-only main route are analyzed before reaching it; a block starting with "[图片内容分析" is the attached image's content, so treat it as the image and do not ask which image was sent. If the helper fails, report that limitation and continue without inventing image details.`;
      },
    });
  }

  // DSH skill 服务是可选能力。存在时注册一个真正可由模型或用户调用的运行时 skill；
  // 不存在时仍保留工具描述和系统提示词，不影响插件的基础功能。
  ctx.inject(['skills'], (sctx) => {
    sctx.effect(() => sctx.skills.register({
      name: 'vision-image-analysis',
      description: 'Use the configured helper vision model to inspect workspace images, perform OCR, read charts, and answer questions about screenshots.',
      whenToUse: 'Use when the task depends on an image file or image-producing tool result and the current main model cannot safely inspect it directly.',
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
      content: [
        '# Vision image analysis',
        '',
        'Use `vision_read_image` for PNG, JPEG, WebP, or GIF files when image contents are needed.',
        '',
        '1. Pass the exact workspace path in `file_path`.',
        '2. Put the user\'s specific OCR, chart, UI, or scene question in `question` when one exists.',
        '3. Treat the returned analysis as model-generated evidence: preserve uncertainty and never invent unreadable details.',
        '4. If the tool says no helper model is configured or the call fails, report that limitation and continue with non-image work.',
        '5. On a natively multimodal main route where built-in `read_image` is available, the native path remains valid.',
        '',
        'Chat attachments on configured text-only main routes are converted automatically before the main model runs. Their injected `[图片内容分析` block is the attachment content and does not require calling this tool again.',
      ].join('\n'),
    }), 'vision-opencode: runtime skill');
  });

  // ---- 旧版持久化闸门迁移 ----
  // 0.3.2 及更早版本曾写入 llm-pi-ai.modelOverrides。当前版本统一使用
  // resolveModelInfo 运行时兼容层；这里仅精确还原 gateState 证明属于插件的旧值。

  function decodeGateState(raw) {
    if (raw.length === 0) return [];
    try {
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (!Array.isArray(value)) return [];
      return value.filter((claim) => claim !== null && typeof claim === 'object'
        && typeof claim.provider === 'string' && claim.provider.length > 0
        && typeof claim.model === 'string' && claim.model.length > 0
        && (claim.state === void 0 || claim.state === 'pending' || claim.state === 'active')
        && (claim.previousInput === null
          || (Array.isArray(claim.previousInput) && claim.previousInput.every((item) => typeof item === 'string'))))
        .map((claim) => ({ ...claim, state: claim.state ?? 'active' }));
    } catch {
      ctx.logger.warn('vision-opencode: gateState 无法解析；为避免误删用户配置，将不接管历史 modelOverrides');
      return [];
    }
  }

  function modelOverride(root, providerName, modelId) {
    if (root === null || typeof root !== 'object') return void 0;
    return root.providers?.[providerName]?.modelOverrides?.[modelId];
  }

  function pruneEmptyOverride(root, providerName, modelId) {
    const provider = root.providers?.[providerName];
    if (provider?.modelOverrides?.[modelId] !== void 0
      && Object.keys(provider.modelOverrides[modelId]).length === 0) {
      delete provider.modelOverrides[modelId];
    }
    if (provider?.modelOverrides !== void 0 && Object.keys(provider.modelOverrides).length === 0) {
      delete provider.modelOverrides;
    }
  }

  /** 升级清理：还原旧版本写入的 modelOverrides；新版本只使用运行时兼容层。 */
  async function ensureGateOverrides(attempt = 1) {
    const cfg = options();
    if (settingsService === void 0) return;
    const claims = decodeGateState(cfg.gateState);
    if (claims.length === 0) return;
    try {
      const restored = await removeGateOverrides();
      await settingsScope?.update({ gateState: '' });
      ctx.logger.info(`vision-opencode: 已迁移旧版图片闸门配置（还原 ${restored} 条 modelOverrides）`);
    } catch (error) {
      if (attempt < 2) {
        setTimeout(() => { void ensureGateOverrides(attempt + 1); }, 3000);
        return;
      }
      ctx.logger.warn(
        'vision-opencode: 旧版 modelOverrides 自动还原失败；保留 gateState，卸载前请重启后重试',
        error,
      );
    }
  }

  /** 只还原 gateState 证明由本插件拥有、且当前值仍未被用户改写的 input 字段。 */
  async function removeGateOverrides() {
    const cfg = options();
    if (settingsService === void 0) return 0;
    const claims = decodeGateState(cfg.gateState);
    if (claims.length === 0) return 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const descriptor = settingsService.describe().find((entry) => entry.ns === 'llm-pi-ai');
        if (descriptor === void 0) throw new Error('llm-pi-ai settings namespace is unavailable');
        if (descriptor.user === void 0 || descriptor.user === null || typeof descriptor.user !== 'object') return 0;
        const next = structuredClone(descriptor.user);
        let removed = 0;
        for (const claim of claims) {
          const override = modelOverride(next, claim.provider, claim.model);
          if (!sameStringArray(override?.input, PLUGIN_IMAGE_INPUT)) continue;
          if (claim.previousInput === null) delete override.input;
          else override.input = [...claim.previousInput];
          pruneEmptyOverride(next, claim.provider, claim.model);
          removed += 1;
        }
        if (removed > 0) await settingsService.replace('llm-pi-ai', next, descriptor.revision);
        return removed;
      } catch (error) {
        if (error?.name === 'SettingsConflictError' && attempt < 3) continue;
        throw error;
      }
    }
    return 0;
  }

  // ---- llm/stream 瀑布：含图片的请求自动转成识图模型的分析文本 ----
  // 背景：主模型（如 deepseek-v4-pro）是纯文本，而消息提交闸门
  // （dsh-host-apiproxy）在模型未声明 image 输入时直接拒绝图片消息。
  // 运行时兼容层先通过 DSH 的图片提交闸门；这里在真正的模型调用之前
  // 把每个 image block 替换为识图模型的分析文本：
  //   - 用户发送的图片永远不会进入主模型上下文
  //   - 会话历史仍保留原始图片（UI 可见），模型侧只见文本
  //   - 同一张图（attachmentId = sha256）只在进程内分析一次
  const BYPASS = Symbol('vision-bypass');
  const analysisCache = new Map();

  /** 单次识图子调用的独立时限（毫秒）：识图模型必须在该时限内完成流式输出。 */
  const VISION_TIMEOUT_MS = 60_000;
  /** 识图子调用最大尝试次数（1 次原始 + 1 次重试）。 */
  const VISION_MAX_ATTEMPTS = 2;
  /** 重试前的退避基数（毫秒），随尝试次数线性增长。 */
  const VISION_RETRY_DELAY_MS = 800;

  /** 可重试的失败码：限流/超时/服务端/传输错误/HTTP 5xx。 */
  function isRetryableVisionCode(code) {
    return code === 'RATE_LIMIT' || code === 'TIMEOUT' || code === 'SERVER'
      || code === 'TRANSPORT' || /^HTTP_5\d\d$/.test(code ?? '');
  }

  /** 调用方主动取消（用户取消回合/工具预算用尽）：不重试、不降级，直接向上抛。 */
  class VisionCallerAborted extends Error {
    constructor() {
      super('vision-opencode: caller aborted');
      this.name = 'VisionCallerAborted';
    }
  }

  /** 
   * 真 off 判别：pi-ai 的 getSupportedThinkingLevels 对「thinkingLevelMap 缺失」的模型会
   * 乐观地把 `off/minimal/low/medium/high` 全部算作支持（只有显式 null 和 xhigh/max 才排除），
   * 那只是「省略 reasoning 参数」= 厂商默认，不代表能真正关掉思考。
   * 我们以厂商目录（pi-ai provider models）里 `thinkingLevelMap.off` 的真实声明为准：
   *   - 有真实 wire 值（如 off:"none"）→ 真申报 off
   *   - 显式 null / 缺失 / 整表缺失 → 未申报 → 应提供「强制关闭」而非「关闭」
   * 读不到目录（非 pi-ai、版本变化）时回退适配器面值，绝不误报「能关」。
   */
  let offCatalogCache = { provider: null, byId: null };
  /** 尽力定位 pi-ai 的 provider 模型数据文件（JSON）；读不到返回 null。 */
  async function readPiAiCatalogFile(provider) {
    const fs = await import('node:fs').catch(() => null);
    const pathMod = fs ? await import('node:path').catch(() => null) : null;
    if (!fs || !pathMod) return null;
    const os = await import('node:os').catch(() => null);
    const home = (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE))
      || (os && typeof os.homedir === 'function' ? os.homedir() : null) || null;
    const dshRoots = [];
    if (home) {
      dshRoots.push((process.env.DSH_HOME || pathMod.join(home, '.dsh')));
      dshRoots.push(pathMod.join(home, '.dsh', 'profiles'));
    }
    dshRoots.push(pathMod.join(process.cwd === void 0 ? '' : process.cwd(), 'node_modules'));
    const fileName = provider.replace(/[^a-zA-Z0-9_.-]/g, '') + '.json';
    const candidates = [];
    for (const root of dshRoots) {
      if (!root) continue;
      candidates.push(pathMod.join(root, 'profiles', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', fileName));
      candidates.push(pathMod.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', fileName));
    }
    for (const file of candidates) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { /* continue */ }
    }
    return null;
  }
  async function offCatalog(provider) {
    if (offCatalogCache.provider === provider) return offCatalogCache.byId;
    let byId = null;
    // 优先读 pi-ai 数据 JSON（跨安装位置最稳），失败再动态 import 其 module
    let raw = await readPiAiCatalogFile(provider);
    if (raw === null) {
      try {
        const mod = await import('@earendil-works/pi-ai/providers/' + provider + '.models');
        raw = mod && (mod.OPENCODE_GO_MODELS ?? mod.default);
      } catch { raw = null; }
    }
    if (raw && typeof raw === 'object') {
      // pi-ai 数据有两种形态：扁平 `{ id: entry }`/数组（module 导出），或按 api 分组
      // `{ 'openai-completions': { id: entry, ... }, ... }`（dist/providers/data/*.json）。
      // 必须逐层展开到「带字符串 id 的模型条目」——直接把分组对象当条目会使 byId 为空，
      // 真 off 判别静默失效（每个模型都回退为 offSupported=true，赝品 off 全部复活）。
      const items = [];
      const pushEntry = (entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return;
        items.push(entry);
      };
      const top = Array.isArray(raw) ? raw : Object.values(raw);
      for (const layer of top) {
        if (!layer || typeof layer !== 'object') continue;
        if (typeof layer.id === 'string') { pushEntry(layer); continue; }
        for (const entry of Object.values(layer)) pushEntry(entry);
      }
      if (items.length === 0) {
        ctx.logger?.warn?.(`vision-opencode: 未能从 ${provider} 目录解析出任何模型条目（形态未知），真 off 判别回退` );
      }
      byId = {};
      for (const entry of items) {
        byId[entry.id] = {
          reasoning: entry.reasoning === true || entry.reasoning === false ? entry.reasoning : undefined,
          tlm: entry.thinkingLevelMap && typeof entry.thinkingLevelMap === 'object' ? entry.thinkingLevelMap : undefined,
        };
      }
    }
    offCatalogCache = { provider, byId };
    return byId;
  }
  /** 该模型是否「真正申报 off」：true=可用 harness 关闭；false=未申报（应走强制关闭）；null=未知。 */
  async function trueOffSupported(route) {
    const byId = await offCatalog(route.provider);
    if (byId === null) return null;
    const entry = byId[route.model];
    if (!entry) return null;
    // 非思考模型：off 是唯一档（本来就不思考），视为真 off
    if (entry.reasoning === false) return true;
    if (entry.reasoning === undefined && !entry.tlm) return null; // 目录没描述 overview → 不臆断
    const tlm = entry.tlm;
    if (!tlm) return false;                       // 思考模型但没有任何档位声明 → 未申报 off
    return tlm.off !== undefined && tlm.off !== null && tlm.off !== ''; // 有真实 wire 值才叫申报
  }
  /** 缓存每个 provider/model 由适配器申报的推理档位集合（null=元数据不可用）。 */
  let reasoningLevelsCache = null;
  async function supportedLevels(route) {
    const key = route.provider + '\0' + route.model;
    if (reasoningLevelsCache !== null && reasoningLevelsCache.key === key) return reasoningLevelsCache.levels;
    let levels = null;
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
      const efforts = info?.reasoning?.efforts;
      // efforts 是 {id,name} 对象数组；只取字符串 id，使 Set.has('off')/排序/JSON 都正确
      if (Array.isArray(efforts)) {
        const ids = efforts
          .map((e) => (typeof e === 'string' ? e : (e && typeof e.id === 'string' ? e.id : '')))
          .filter((s) => s.length > 0);
        levels = new Set(ids);
      }
    } catch { /* 元数据不可用：levels=null */ }
    reasoningLevelsCache = { key, levels };
    return levels;
  }
  /** 活动模型条目的推理策略：''=默认(跟随)；'off'=关闭；'forceOff'=强制关闭(实验)。
   *  不在自管列表里则回退全局 visionReasoning（true=''，否则='off'，保持旧默认=关闭）。 */
  function activeStrategy(route) {
    const entry = (route.visionModels || []).find((e) => e.provider === route.provider && e.model === route.model);
    if (entry && (entry.reasoning === 'off' || entry.reasoning === 'forceOff')) return entry.reasoning;
    return route.visionReasoning === true ? '' : 'off';
  }
  /** 经 harness 通道能表达的关闭档位：仅当**真申报**了 'off'（厂商目录 thinkingLevelMap.off 有
   *  真实 wire 值）才传 'off'；否则不传（尽力而为；pi-ai 面值里的 off 只是省略参数=厂商默认，无效）。 */
  async function visionReasoningParam(route, strategy) {
    if (strategy !== 'off' && strategy !== 'forceOff') return void 0;
    const off = await trueOffSupported(route);
    // 真 off / 未知（读不到目录）→ 按适配器面值判断 fallback
    if (off === false) return void 0;
    if (off === true) return 'off';
    const levels = await supportedLevels(route);
    return levels !== null && levels.has('off') ? 'off' : void 0;
  }
  /** 直连网关时「关闭思考」的候选 wire 参数（各家命名混乱，无统一标准）：
   *  1) thinking:{type:disabled}   —— 大多数 OpenAI 兼容厂商都认
   *  2) reasoning_effort:"none"     —— 一部分厂商（已实测 MiMo 生效）
   *  3) enable_thinking:false       —— Qwen3 系原生
   *  按顺序试，并用响应里的 reasoning_tokens 反馈：0=真关了（记住该参数，后续直连复用）；
   *  >0=没关掉换下一个；厂商拒绝该参数（4xx/5xx）也换下一个。全部不理想就返回第一个有结果的文本
   *  （尽力而为，UI 已标注「不保证成功」）。 */
  const FORCE_OFF_CANDIDATES = [
    { key: 'THINKING_DISABLED', patch: { thinking: { type: 'disabled' } } },
    { key: 'REASONING_EFFORT_NONE', patch: { reasoning_effort: 'none' } },
    { key: 'ENABLE_THINKING_FALSE', patch: { enable_thinking: false } },
  ];
  let forceOffWinning = null; // { route, candKey }
  async function callVisionForceOffDirect(ref, signal, question, route) {
    try {
      if (route.provider !== 'opencode-go') return void 0;
      const apiKey = (typeof route.apiKey === 'string' && route.apiKey.length > 0)
        ? route.apiKey
        : (typeof process !== 'undefined' && process.env && process.env.OPENCODE_GO_API_KEY);
      const bytes = ref && ref.bytes;
      if (!apiKey || !bytes || (typeof bytes.byteLength === 'number' && bytes.byteLength === 0)) return void 0;
      const mediaType = (ref && typeof ref.mediaType === 'string' && ref.mediaType) || 'image/png';
      const b64 = Buffer.from(bytes).toString('base64');
      const baseMessage = {
        role: 'user',
        content: [
          { type: 'text', text: question !== void 0 && typeof question === 'string' && question.trim().length > 0
            ? `请分析这张图片：${question.trim()}`
            : '请详细分析这张图片的内容（中文）。' },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        ],
      };
      const routeKey = route.provider + '\0' + route.model;
      // 已为这个模型实测出生效的关闭参数 → 快路径，直接复用
      let order = FORCE_OFF_CANDIDATES;
      if (forceOffWinning !== null && forceOffWinning.route === routeKey) {
        const winCand = FORCE_OFF_CANDIDATES.find((c) => c.key === forceOffWinning.candKey);
        if (winCand !== void 0) order = [winCand];
      }
      let bestText = void 0;
      for (const cand of order) {
        const body = Object.assign({ model: route.model, max_tokens: 1024, messages: [baseMessage] }, cand.patch);
        let resp;
        try {
          resp = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal,
          });
        } catch { continue; }
        if (!resp.ok) continue; // 该参数厂商不认 → 换一个
        let data;
        try { data = await resp.json(); } catch { continue; }
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const text = Array.isArray(content)
          ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
          : (typeof content === 'string' ? content : '');
        if (text.trim().length === 0) continue;
        const usage = data && data.usage || {};
        const rt = (typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens
          : (usage.completion_tokens_details && typeof usage.completion_tokens_details.reasoning_tokens === 'number'
            ? usage.completion_tokens_details.reasoning_tokens : void 0));
        if (typeof bestText !== 'string') bestText = text.trim();
        if (rt === 0) {
          forceOffWinning = { route: routeKey, candKey: cand.key }; // 真关了 → 记忆
          return text.trim();
        }
        if (rt === void 0) {
          // 厂商没报 reasoning_tokens：无法确认但更可能已关 → 采用并记忆
          forceOffWinning = { route: routeKey, candKey: cand.key };
          return text.trim();
        }
        // rt>0：这参数没关掉思考 → 试下一个
      }
      return bestText; // 全试过：至少一个成功拿到文本 → 尽力而为；全失败 → undefined
    } catch { return void 0; }
  }

  /** 单次识图子调用：组装带图消息 → 流式请求识图模型 → 返回纯文本。 */
  async function callVisionOnce(ref, signal, question) {
    const route = options();
    // 强制关闭 + 未真申报 off → 尝试直连网关（自适应多参数试出该厂商的关闭方式，不保证成功）
    if (activeStrategy(route) === 'forceOff') {
      const off = await trueOffSupported(route);
      // 读不到目录时按适配器面值是否有 off 兜底判定
      const hasOff = off === true || (off === null && (await supportedLevels(route))?.has('off'));
      if (!hasOff) {
        const directText = await callVisionForceOffDirect(ref, signal, question, route);
        if (directText !== void 0) return directText;
      }
    }
    const message = createUserMessage({
      content: [
        {
          type: 'text',
          text: question !== void 0 && question.trim().length > 0
            ? `请分析这张图片：${question.trim()}`
            : '请详细分析这张图片的内容（中文）。',
        },
        { type: 'image', attachment: { ...ref } },
      ],
      source: { kind: 'plugin', plugin: 'vision-opencode' },
    });
    const assembler = new BlockAssembler();
    const reasoningEffort = await visionReasoningParam(route, activeStrategy(route));
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: VISION_SYSTEM_PROMPT,
      messages: [message],
      temperature: 0.2,
      ...(reasoningEffort !== void 0 ? { reasoningEffort } : {}),
      signal,
      [BYPASS]: true,
    })) {
      assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const detail = finish.failure?.message ?? (finish.kind === 'aborted' ? 'request aborted' : 'unknown error');
      const error = new Error(`识图模型 ${route.provider}/${route.model} 分析图片失败: ${detail}`);
      error.code = finish.failure?.code;
      throw error;
    }
    const text = assembler.blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text.trim().length === 0) {
      const error = new Error(`识图模型 ${route.provider}/${route.model} 未返回分析文本`);
      error.code = 'EMPTY_RESPONSE';
      throw error;
    }
    return text;
  }

  /**
   * 带超时与重试的识图子调用：
   * - 每次尝试受 VISION_TIMEOUT_MS 独立限时（与调用方信号叠加，任一中止即中止）
   * - 失败码可重试（限流/超时/服务端/传输/5xx）或本次尝试超时时，退避后重试
   * - 调用方信号中止时抛 VisionCallerAborted：不重试，由上层决定是否降级
   * - 重试耗尽后抛出最后一次错误；是否降级为占位文本由调用方决定
   */
  async function analyzeImage(ref, outerSignal, question) {
    let lastError;
    for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt++) {
      if (outerSignal?.aborted) throw new VisionCallerAborted();
      const timer = AbortSignal.timeout(VISION_TIMEOUT_MS);
      const signal = outerSignal === void 0 ? timer : AbortSignal.any([outerSignal, timer]);
      try {
        return await callVisionOnce(ref, signal, question);
      } catch (error) {
        lastError = error;
        if (outerSignal?.aborted) throw new VisionCallerAborted();
        if (attempt >= VISION_MAX_ATTEMPTS) break;
        if (!(timer.aborted || isRetryableVisionCode(error?.code))) break;
        ctx.logger.warn(`vision-opencode: 识图子调用失败（第 ${attempt}/${VISION_MAX_ATTEMPTS} 次），将退避重试: ${error?.message ?? String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, VISION_RETRY_DELAY_MS * attempt));
      }
    }
    throw lastError ?? new Error('识图模型分析失败：未知错误');
  }

  /**
   * 识图不可用时的占位文本：让主模型照常完成回合，并如实向用户说明。
   * 注意这个占位只在「发送图片的自动转换」路径使用；工具路径仍然抛错
   * （工具失败本身是良性的：isError 结果会交给主模型继续处理）。
   */
  function fallbackAnalysisText(route, error) {
    const reason = error?.message ?? String(error);
    return `[识图模型 ${route.provider}/${route.model} 不可用，这张图片未能自动分析（原因：${reason}）]\n请在回复中如实告知用户：识图模型暂时不可用，这张图片未能自动识别；用户可以稍后重试，或把主模型切换为支持图片输入的模型直接查看。`;
  }
  /** 把分析文本打包成追加到消息里的文字块。 */
  function formatAnalyses(analyses, route) {
    return {
      type: 'text',
      text: `[图片内容分析（识图模型 ${route.provider}/${route.model} 自动生成）——以下就是本条消息中用户发送图片的内容]\n${analyses.join('\n\n')}`,
    };
  }

  /** 沉淀消息的标记前缀：文本首行带 attachmentId，供后续请求识别"已分析过"。 */
  const PERSISTED_PREFIX = '[vision-opencode 图片分析 · ';
  const persistedMarker = (attachmentId) => `${PERSISTED_PREFIX}${attachmentId}]`;
  /** 已沉淀图片的占位符：模型对应历史里的分析文本，不再重复注入。 */
  const persistedPlaceholder = (attachmentId) => `[图片：内容分析见历史消息（图 ${attachmentId.slice(0, 8)}）]`;
  /** 历史图片的占位文本：模型侧不再重复注入旧图分析，上下文由其自身回答承载。 */
  const HISTORICAL_IMAGE_PLACEHOLDER = '[图片：历史消息中的图片，本回合不再重复分析]';

  /** 构造沉淀消息：完整分析文本 + attachmentId 标记，UI 上渲染为插件通知。 */
  function persistedAnalysisMessage(attachmentId, analysis) {
    return createUserMessage({
      content: [{ type: 'text', text: `${persistedMarker(attachmentId)}\n${analysis}` }],
      source: {
        kind: 'plugin',
        plugin: 'vision-opencode',
        form: 'notice',
        summary: '图片内容分析',
      },
    });
  }

  /**
   * 扫描会话历史，收集已沉淀过分析的 attachmentId 集合。
   * 历史即缓存：重启后仍能识别，不会重复分析。
   */
  function collectPersistedIds(session) {
    const ids = new Set();
    if (session === void 0 || typeof session.deriveMessages !== 'function') return ids;
    for (const message of session.deriveMessages()) {
      if (message?.source?.kind !== 'plugin' || message.source.plugin !== 'vision-opencode') continue;
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        const match = new RegExp(`${PERSISTED_PREFIX.replace('[', '\\[')}([^\\]]+)\\]`).exec(block.text);
        if (match !== null) ids.add(match[1]);
      }
    }
    return ids;
  }

  /** 尽力把分析文本沉淀进会话历史（失败不影响主流程）；返回是否已沉淀。 */
  function persistAnalysis(session, attachmentId, analysis) {
    if (session === void 0 || typeof session.append !== 'function') return false;
    try {
      session.append('user/message', persistedAnalysisMessage(attachmentId, analysis), { surfaceOp: 'append' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 替换历史消息里的图片 block（含 tool-result 嵌套）：已沉淀的分析文本
   * 已在会话历史里，图片只替换为极简占位符，绝不重复注入；未沉淀的历史
   * 图片（升级前的旧会话）尽力补一次沉淀——缓存命中直接用，否则静默分析，
   * 本轮仍只放占位符（沉淀文本下一轮起对模型可见）。
   * 无图或全部命中原数组时返回原数组（不产生新对象）。
   */
  async function replaceHistoricalImages(blocks, route, session, persistedIds, signal) {
    const out = [];
    let changed = false;
    for (const block of blocks) {
      if (block.type === 'image') {
        const key = visionCacheKey(route, block.attachment);
        const attachmentId = typeof block.attachment?.attachmentId === 'string' ? block.attachment.attachmentId : '';
        if (attachmentId.length > 0 && persistedIds.has(attachmentId)) {
          out.push({ type: 'text', text: persistedPlaceholder(attachmentId) });
          changed = true;
          continue;
        }
        // 未沉淀：缓存命中直接用，否则静默分析一次（升级前旧会话的补沉淀）
        let analysis = key === void 0 ? void 0 : analysisCache.get(key);
        if (analysis === void 0 && key !== void 0) {
          try {
            analysis = await analyzeImage(block.attachment, signal);
            if (analysisCache.size >= 128) {
              const oldest = analysisCache.keys().next().value;
              analysisCache.delete(oldest);
            }
            analysisCache.set(key, analysis);
          } catch (error) {
            // 历史图片的静默分析失败不影响本轮：占位即可，不沉淀、不弹错误
            analysis = void 0;
          }
        }
        if (analysis !== void 0 && attachmentId.length > 0 && !persistedIds.has(attachmentId)) {
          if (persistAnalysis(session, attachmentId, analysis)) persistedIds.add(attachmentId);
        }
        out.push({ type: 'text', text: analysis !== void 0
          ? persistedPlaceholder(attachmentId)
          : HISTORICAL_IMAGE_PLACEHOLDER });
        changed = true;
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const nested = await replaceHistoricalImages(block.content, route, session, persistedIds, signal);
        if (nested === block.content) {
          out.push(block);
        } else {
          out.push({ ...block, content: nested });
          changed = true;
        }
      } else {
        out.push(block);
      }
    }
    return changed ? out : blocks;
  }

  /**
   * 递归地把 content 里的 image block 替换为识图模型的分析文本：
   * - 顶层（user 消息）里的图片：分析文本由调用方追加到消息内容末尾
   * - tool-result 里嵌套的图片（内置 read_image 产生的）：分析文本追加进该 tool-result 的 content
   * - 首次分析成功的图片会把完整分析文本沉淀进会话历史（带 attachmentId 标记），
   *   后续请求直接复用历史，不再重复分析、不再重复注入
   * `sink` 收集本次去掉的每张图的分析文本；无图时返回原数组元素（不产生新对象）。
   */
  async function convertContent(blocks, signal, sink, route, stats, session, persistedIds) {
    const out = [];
    for (const block of blocks) {
      if (block.type === 'image') {
        const ref = block.attachment;
        const key = visionCacheKey(route, ref);
        const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : '';
        const requestResult = key === void 0 ? void 0 : stats.requestResults.get(key);
        let ok = false;
        let analysis = requestResult?.analysis
          ?? (key === void 0 ? void 0 : analysisCache.get(key));
        if (analysis === void 0) {
          try {
            analysis = await analyzeImage(ref, signal);
            ok = true;
          } catch (error) {
            // 调用方取消：向上抛（回合正在结束，降级没有意义）
            if (error instanceof VisionCallerAborted || signal?.aborted) throw error;
            // 识图模型不可用：降级为占位文本，主模型照常工作并向用户说明
            analysis = fallbackAnalysisText(route, error);
            stats.failures += 1;
          }
          if (ok && key !== void 0) {
            // 只缓存成功结果：失败占位不落缓存，避免进程内持续"中毒"
            if (analysisCache.size >= 128) {
              const oldest = analysisCache.keys().next().value;
              analysisCache.delete(oldest);
            }
            analysisCache.set(key, analysis);
          }
          if (key !== void 0) stats.requestResults.set(key, { analysis });
        } else {
          // 缓存命中：同一张图重复出现时直接复用结论，并明确标注
          // 未重复调用识图模型，避免用户误以为"识别了两次"
          analysis = `${analysis}\n（注：该图片与之前的图片相同，分析结论复用缓存，未重复调用识图模型）`;
          if (requestResult === void 0) stats.reused += 1;
          if (key !== void 0 && requestResult === void 0) {
            stats.requestResults.set(key, { analysis: analysisCache.get(key) });
          }
        }
        // 首次分析成功（或缓存复用）且尚未沉淀：把干净的分析文本写进会话历史。
        // 失败占位不沉淀——后续请求仍可重新尝试分析。
        const cacheHit = requestResult !== void 0 || (key !== void 0 && analysisCache.has(key));
        if (key !== void 0 && attachmentId.length > 0 && !persistedIds.has(attachmentId) && (ok || cacheHit)) {
          const clean = analysisCache.get(key);
          if (persistAnalysis(session, attachmentId, clean ?? analysis)) {
            persistedIds.add(attachmentId);
          }
        }
        sink.push(analysis);
        continue;
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const nested = [];
        const content = await convertContent(block.content, signal, nested, route, stats, session, persistedIds);
        out.push(nested.length > 0
          ? { ...block, content: [...content, formatAnalyses(nested, route)] }
          : block);
        continue;
      }
      out.push(block);
    }
    return out;
  }

  ctx.on('llm/stream', (llmOptions, next) => {
    if (llmOptions?.[BYPASS] === true) return next();
    if (!options().autoConvert) return next();
    const route = options();
    // 自动接管已解析的纯文本路由；原生多模态主模型完整保留 DSH 的原生图片链路。
    if (!managedTextRoute(llmOptions.provider, llmOptions.model)) return next();
    const messages = Array.isArray(llmOptions.messages) ? llmOptions.messages : [];
    const seenAttachmentIds = new Set();
    const imageCount = messages.reduce((total, message) => total
      + (Array.isArray(message?.content)
        ? countUniqueImages(message.content, seenAttachmentIds)
        : 0), 0);
    if (imageCount === 0) return next();
    if (!hasVisionModel(route)) {
      // 未配置识图模型：不能替用户假定任何模型。图片降级为指引文本，
      // 主模型照常完成回合并提示用户先去选择器里选一个识图模型。
      return (async function* unconfiguredStream() {
        const converted = messages.map((message) => {
          if (!Array.isArray(message?.content)) return message;
          const replacement = replaceImagesWithText(message.content,
            '[识图模型未配置] 这张图片未能自动分析：请先点击输入框右侧的「识图模型」下拉，从自己供应商中支持图片输入的模型里选择一个，然后重发图片。');
          if (replacement.replaced === 0) return message;
          return freezeMessage({
            ...message,
            content: replacement.content,
          });
        });
        yield* ctx.llm.stream({ ...llmOptions, messages: converted, [BYPASS]: true });
      })();
    }
    // 只处理「当前回合」的图片——最新一条 user 消息（用户刚发的输入）和
    // 最新一条 tool-result（工具刚返回的截图等）：只有这两处的未沉淀图片会
    // 调用识图模型分析并展示进度。其余历史图片的分析文本已沉淀在会话历史里
    //（或由本请求静默补沉淀），一律只替换为占位符，绝不重复分析、绝不弹提示。
    const session = typeof llmOptions.sessionId === 'string'
      ? ctx.get('sessions')?.get(llmOptions.sessionId)
      : void 0;
    const persistedIds = collectPersistedIds(session);
    const lastUserIndex = (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.source?.kind === 'user') return index;
      }
      return -1;
    })();
    const lastToolIndex = messages.at(-1)?.source?.kind === 'tool' ? messages.length - 1 : -1;
    const currentIndexes = new Set([lastUserIndex, lastToolIndex].filter((index) => index >= 0));
    let newImageCount = 0;
    const countNewImages = (blocks) => {
      for (const block of blocks) {
        if (block?.type === 'image') {
          const key = visionCacheKey(route, block.attachment);
          if (key === void 0 || !analysisCache.has(key)) {
            const attachmentId = typeof block.attachment?.attachmentId === 'string' ? block.attachment.attachmentId : '';
            if (attachmentId.length === 0 || !persistedIds.has(attachmentId)) newImageCount += 1;
          }
        } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
          countNewImages(block.content);
        }
      }
    };
    for (const index of currentIndexes) {
      const message = messages[index];
      if (Array.isArray(message?.content)) countNewImages(message.content);
    }
    // 诊断日志：记录每次实际触发转换的请求（帮助定位"图片漏网"类问题）
    if (newImageCount > 0) {
      ctx.logger.info(`vision-opencode: 请求含图片，开始自动转换（目标 ${llmOptions.provider}/${llmOptions.model}，${messages.length} 条消息）`);
    }
    // 不能就地改 llmOptions.messages：agent-loop 拼出的请求是 deep-frozen 的
    // （冻结正是为了强制"监听器只读不写"，直接赋值会抛
    //  "Cannot assign to read only property 'messages'"）。
    // 传新对象给 next() 也没用：cordis waterfall 的 next() 闭包重放的是「原始参数」，
    // 下游监听器和适配器永远看到最初那个对象。
    // 因此这里短路：不调用 next()，改由嵌套的 ctx.llm.stream() 把去图后的请求
    // 发出去，再把它的 chunk 转交给外层消费者。BYPASS 防止嵌套调用再次触发本监听器。
    return (async function* visionTextStream() {
      let converted;
      const stats = { failures: 0, reused: 0, requestResults: new Map() };
      const finishStatus = newImageCount > 0
        ? appendVisionStatus(llmOptions, route, imageCount, newImageCount)
        : void 0;
      try {
        converted = [];
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (!Array.isArray(message?.content)) {
            converted.push(message);
            continue;
          }
          if (!currentIndexes.has(index)) {
            // 历史消息：已沉淀的分析文本在会话历史里，图片只替换为占位符；
            // 未沉淀的旧图尽力静默补沉淀（缓存命中直接用，否则静默分析一次）
            const replaced = await replaceHistoricalImages(message.content, route, session, persistedIds, llmOptions.signal);
            if (replaced === message.content) {
              converted.push(message);
              continue;
            }
            converted.push(freezeMessage({ ...message, content: replaced }));
            continue;
          }
          const sink = [];
          const content = await convertContent(message.content, llmOptions.signal, sink, route, stats, session, persistedIds);
          if (sink.length === 0) {
            converted.push(message);
            continue;
          }
          converted.push(freezeMessage({
            ...message,
            content: [...content, formatAnalyses(sink, route)],
          }));
        }
        finishStatus?.(stats);
      } catch (error) {
        // 调用方取消：结束可见状态后向上抛，避免留下永久“正在分析”的状态行。
        if (error instanceof VisionCallerAborted || llmOptions.signal?.aborted) {
          finishStatus?.({ ...stats, cancelled: true });
          throw error;
        }
        finishStatus?.({ ...stats, unexpectedError: error?.message ?? String(error) });
        // 插件自身的意外错误也不能杀死回合：全部图片降级为占位文本，
        // 主模型照常工作并向用户说明（这是发布版的最后一道保险）。
        ctx.logger.error('vision-opencode: 图片自动转换出现意外错误，降级为占位文本', error);
        converted = messages.map((message) => {
          if (!Array.isArray(message?.content)) return message;
          const replacement = replaceImagesWithText(message.content, fallbackAnalysisText(route, error));
          if (replacement.replaced === 0) return message;
          return freezeMessage({
            ...message,
            content: replacement.content,
          });
        });
      }
      // 最后一道结构校验：任何嵌套 image 都不能进入已声明为纯文本的主模型。
      converted = converted.map((message) => {
        if (!Array.isArray(message?.content) || countImages(message.content) === 0) return message;
        const replacement = replaceImagesWithText(message.content,
          '[图片自动转换未完成：为保护纯文本主模型，本图片已移除。请重试或切换到原生多模态模型。]');
        return freezeMessage({ ...message, content: replacement.content });
      });
      const rewritten = {
        ...llmOptions,
        messages: converted,
        [BYPASS]: true,
      };
      yield* ctx.llm.stream(rewritten);
    })();
  });

  // ---- web 模式：HTTP 端点（前端识图模型选择器使用）----
  // 用 ctx.inject 条件挂载：webServer 服务就绪后才注册路由
  //（apply 时 webServer 可能尚未激活，ctx.get 会拿到 undefined）。
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const dispose = wctx.webServer.register({
        kind: 'exact',
        path: '/vision-opencode/events',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          const url = new URL(req.url ?? '/vision-opencode/events', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
          if (sessionId.length === 0 || sessionId.length > 256) {
            json(res, 400, { error: 'a valid sessionId query parameter is required' });
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write('retry: 2000\n\n');
          const clients = progressClients.get(sessionId) ?? new Set();
          clients.add(res);
          progressClients.set(sessionId, clients);
          const heartbeat = setInterval(() => {
            try {
              res.write(': keepalive\n\n');
            } catch {
              clearInterval(heartbeat);
            }
          }, 15_000);
          const close = () => {
            clearInterval(heartbeat);
            clients.delete(res);
            if (clients.size === 0) progressClients.delete(sessionId);
          };
          req.once('close', close);
          res.once('close', close);
        },
      });
      return () => {
        dispose();
        for (const clients of progressClients.values()) {
          for (const res of clients) res.end();
        }
        progressClients.clear();
      };
    }, 'vision-opencode: progress events route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, publicOptions());
            return;
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req);
            // 忽略列表持久化：设置页把未导入系统模型「×」掉后写入，下次打开不再提示。
            if (Array.isArray(body?.ignoredModels)) {
              const clean = body.ignoredModels.filter((s) => typeof s === 'string');
              if (settingsScope !== void 0) {
                await settingsScope.replace({ ...options(), ignoredModels: clean });
              } else {
                const next = { ...options(), ignoredModels: clean };
                current = () => next;
              }
              json(res, 200, publicOptions());
              return;
            }
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            const model = typeof body?.model === 'string' ? body.model.trim() : '';
            if (provider.length === 0 || model.length === 0) {
              json(res, 400, { error: 'provider and model strings are required' });
              return;
            }
            // 识图推理开关：true=开启（提供方默认档位）；false/缺省=关闭思考
            const visionReasoning = body?.visionReasoning === true;
            // 精确排除本插件管理的文本主路由，并校验候选模型确实声明了 image 输入。
            // 允许插件自管 visionModels 中的自定义模型（即使宿主 catalog 未标记 image）。
            let declaredVision = false;
            try {
              const info = await ctx.llm.resolveModelInfo(provider, model);
              declaredVision = Array.isArray(info.inputModalities) && info.inputModalities.includes('image');
            } catch {
              declaredVision = false;
            }
            const customAllowed = options().visionModels.some((e) => e.provider === provider && e.model === model);
            if (managedTextRoute(provider, model) || (!declaredVision && !customAllowed)) {
              json(res, 400, { error: `model "${provider}/${model}" is not a vision-capable model` });
              return;
            }
            if (settingsScope !== void 0) {
              // 更新识图模型（及可选推理开关），保留其余配置（autoConvert/mainProvider/mainModels）。
              await settingsScope.replace({ ...options(), provider, model, visionReasoning });
            } else {
              const next = { ...options(), provider, model, visionReasoning };
              current = () => next;
            }
            json(res, 200, publicOptions());
            return;
          }
          res.writeHead(405);
          res.end();
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/config failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: config route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/models',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          // 已导入识图模型（聊天框选择器只用这份：未导入的模型不应出现在选择器里）。
          const configured = options().visionModels || [];
          const groups = [];
          const byProvider = {};
          for (const entry of configured) {
            if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string' || entry.model.length === 0) continue;
            if (!byProvider[entry.provider]) byProvider[entry.provider] = [];
            byProvider[entry.provider].push({ id: entry.model, name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.model });
          }
          const nameOf = {};
          try {
            for (const provider of ctx.llm.listProviders()) nameOf[provider.id] = provider.name || provider.id;
          } catch (error) {
            /* 显示名缺失时退回 provider id */
          }
          for (const providerId of Object.keys(byProvider).sort()) {
            groups.push({ provider: providerId, name: nameOf[providerId] || providerId, models: byProvider[providerId] });
          }
          // 系统全部图片模型（设置页「一键导入」用）。
          const systemGroups = [];
          for (const provider of ctx.llm.listProviders()) {
            try {
              const models = await ctx.llm.listModels(provider.id);
              const vision = models.filter((model) =>
                Array.isArray(model.inputModalities)
                && model.inputModalities.includes('image'));
              if (vision.length === 0) continue;
              systemGroups.push({
                provider: provider.id,
                name: provider.name,
                models: vision.map((model) => ({ id: model.id, name: model.name })),
              });
            } catch (error) {
              ctx.logger.warn(`vision-opencode: listModels(${provider.id}) failed`, error);
            }
          }
          json(res, 200, { groups, systemGroups });
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/models failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: models route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/providers',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          const providers = [];
          const seen = new Set();
          // 官方判定「自定义」用的是 LlmConfigurableProvider.declared === true：
          // 适配器只因为配置声明才认识该渠道（网关/自托管），区别于它自带的（内置）。
          const configurableByProvider = new Map();
          try {
            for (const cp of ctx.llm.listConfigurableProviders()) {
              if (cp && typeof cp.provider === 'string') configurableByProvider.set(cp.provider, cp);
            }
          } catch (error) {
            /* 旧 host 无此 API：declared 全为 false */
          }
          // pi-ai 官方内置目录（先取一遍 id 集合，用于给 registered 条目打 official 标记；
          // opencode-go/deepseek 等在 listProviders 里也会出现，不能只靠 source 判断）。
          const officialIds = new Set();
          const builtin = await piAiCatalog;
          if (builtin !== void 0 && typeof builtin.getBuiltinProviders === 'function') {
            for (const pid of builtin.getBuiltinProviders()) officialIds.add(pid);
          }
          for (const provider of ctx.llm.listProviders()) {
            let visionModels = [];
            try {
              const models = await ctx.llm.listModels(provider.id);
              visionModels = models
                .filter((model) => Array.isArray(model.inputModalities)
                  && model.inputModalities.includes('image'))
                .map((model) => model.id);
            } catch (error) {
              ctx.logger.warn(`vision-opencode: listModels(${provider.id}) failed for provider list`, error);
            }
            seen.add(provider.id);
            providers.push({
              provider: provider.id,
              name: typeof provider.name === 'string' ? provider.name : provider.id,
              visionModels,
              source: 'registered',
              official: officialIds.has(provider.id),
              declared: configurableByProvider.get(provider.id)?.declared === true,
            });
          }
          // 官方内置供应商目录（pi-ai）：即使未配置路由也列出，供"添加模型"
          // 弹窗复用官方完整提供方列表。
          if (builtin !== void 0 && typeof builtin.getBuiltinModels === 'function') {
            for (const providerId of builtin.getBuiltinProviders()) {
              if (seen.has(providerId)) continue;
              seen.add(providerId);
              let visionModels = [];
              try {
                visionModels = builtin.getBuiltinModels(providerId)
                  .filter((model) => Array.isArray(model?.input) && model.input.includes('image'))
                  .map((model) => model.id);
              } catch (error) {
                ctx.logger.warn(`vision-opencode: builtin models(${providerId}) failed`, error);
              }
              providers.push({
                provider: providerId,
                name: providerId,
                visionModels,
                source: 'builtin',
                official: true,
                declared: false,
              });
            }
          }
          json(res, 200, {
            providers,
            protocols: await piAiProtocols,
          });
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/providers failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: providers route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/vision-models',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, { models: options().visionModels });
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            const model = typeof body?.model === 'string' ? body.model.trim() : '';
            const name = typeof body?.name === 'string' ? body.name.trim() : '';
            const description = typeof body?.description === 'string' ? body.description.trim() : '';
            const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
            const requestFormat = body?.requestFormat === 'anthropic' ? 'anthropic' : (body?.requestFormat === 'openai-responses' ? 'openai-responses' : 'openai-completions');
            const reasoning = body?.reasoning === 'off' ? 'off' : body?.reasoning === 'forceOff' ? 'forceOff' : '';
            let id = typeof body?.id === 'string' ? body.id.trim() : '';
            if (provider.length === 0 || model.length === 0) {
              json(res, 400, { error: 'provider and model are required' });
              return;
            }
            if (id.length === 0) id = `${provider}__${model}__${Date.now().toString(36)}`;
            const models = [...options().visionModels];
            if (models.some((e) => e.id === id)) {
              json(res, 409, { error: `vision model id "${id}" already exists` });
              return;
            }
            if (models.some((e) => e.provider === provider && e.model === model)) {
              json(res, 409, { error: `vision model "${provider}/${model}" already exists` });
              return;
            }
            const entry = { id, provider, model, name, description, baseUrl, requestFormat, reasoning };
            models.push(entry);
            if (settingsScope !== void 0) {
              await settingsScope.replace({ ...options(), visionModels: models });
            } else {
              const next = { ...options(), visionModels: models };
              current = () => next;
            }
            json(res, 201, { models: options().visionModels, created: entry });
            return;
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req);
            // 提供方级批量更新：编辑整个提供方及其所有模型（body 带 models 数组）。
            // 按 entryId 匹配现有条目做更新；无 entryId 的按 (provider, model) 匹配；
            // 都不匹配的创建新条目；提供方下未出现在 want 里的条目被移除（视为删除）。
            if (Array.isArray(body?.models)) {
              const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
              if (provider.length === 0) {
                json(res, 400, { error: 'provider is required' });
                return;
              }
              const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
              const requestFormat = body?.requestFormat === 'anthropic' ? 'anthropic' : (body?.requestFormat === 'openai-responses' ? 'openai-responses' : 'openai-completions');
              const want = body.models
                .filter((m) => m !== null && typeof m === 'object' && typeof m?.id === 'string' && m.id.trim().length > 0)
                .map((m) => ({
                  entryId: typeof m?.entryId === 'string' && m.entryId.length > 0 ? m.entryId : '',
                  model: m.id.trim(),
                  name: typeof m?.name === 'string' ? m.name.trim() : '',
                }));
              if (want.length === 0) {
                json(res, 400, { error: 'at least one model is required' });
                return;
              }
              const current = [...options().visionModels];
              const keep = current.filter((e) => e.provider !== provider);
              const next = [];
              const used = new Set();
              for (const m of want) {
                let existing = null;
                if (m.entryId.length > 0) {
                  existing = current.find((e) => e.id === m.entryId && e.provider === provider) ?? null;
                }
                if (existing === null) {
                  existing = current.find((e) => e.provider === provider && e.model === m.model) ?? null;
                }
                if (existing !== null && !used.has(existing.id)) {
                  used.add(existing.id);
                  next.push({ ...existing, model: m.model, name: m.name, baseUrl, requestFormat });
                } else if (existing === null) {
                  const freshId = `${provider}__${m.model}__${Date.now().toString(36)}_${next.length}`;
                  next.push({ id: freshId, provider, model: m.model, name: m.name, description: '', baseUrl, requestFormat, reasoning: '' });
                }
                // existing 已被占用（同一模型重复出现）：跳过以保持唯一
              }
              const all = [...keep, ...next];
              if (settingsScope !== void 0) {
                await settingsScope.replace({ ...options(), visionModels: all });
              } else {
                const nextCfg = { ...options(), visionModels: all };
                current = () => nextCfg;
              }
              json(res, 200, { models: options().visionModels, updated: next });
              return;
            }
            const id = typeof body?.id === 'string' ? body.id.trim() : '';
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            const model = typeof body?.model === 'string' ? body.model.trim() : '';
            const name = typeof body?.name === 'string' ? body.name.trim() : '';
            const description = typeof body?.description === 'string' ? body.description.trim() : '';
            const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
            const requestFormat = body?.requestFormat === 'anthropic' ? 'anthropic' : (body?.requestFormat === 'openai-responses' ? 'openai-responses' : 'openai-completions');
            const reasoning = body?.reasoning === 'off' ? 'off' : body?.reasoning === 'forceOff' ? 'forceOff' : '';
            if (id.length === 0 || provider.length === 0 || model.length === 0) {
              json(res, 400, { error: 'id, provider and model are required' });
              return;
            }
            const models = [...options().visionModels];
            const idx = models.findIndex((e) => e.id === id);
            if (idx === -1) {
              json(res, 404, { error: `vision model "${id}" not found` });
              return;
            }
            if (models.some((e, i) => i !== idx && e.provider === provider && e.model === model)) {
              json(res, 409, { error: `vision model "${provider}/${model}" already exists` });
              return;
            }
            models[idx] = { id, provider, model, name, description, baseUrl, requestFormat, reasoning };
            if (settingsScope !== void 0) {
              await settingsScope.replace({ ...options(), visionModels: models });
            } else {
              const next = { ...options(), visionModels: models };
              current = () => next;
            }
            json(res, 200, { models: options().visionModels, updated: models[idx] });
            return;
          }
          if (req.method === 'DELETE') {
            const url = new URL(req.url ?? '/vision-opencode/vision-models', 'http://127.0.0.1');
            let id = url.searchParams.get('id')?.trim() ?? '';
            const providerParam = url.searchParams.get('provider')?.trim() ?? '';
            if (id.length === 0) {
              const body = await readJsonBody(req);
              id = typeof body?.id === 'string' ? body.id.trim() : '';
            }
            const models = [...options().visionModels];
            if (providerParam.length > 0) {
              // 提供方级删除：移除该提供方下所有模型
              const before = models.length;
              const nextModels = models.filter((e) => e.provider !== providerParam);
              if (nextModels.length === before) {
                json(res, 404, { error: `provider "${providerParam}" has no vision models` });
                return;
              }
              const nextCfg = { ...options(), visionModels: nextModels };
              if (settingsScope !== void 0) {
                await settingsScope.replace(nextCfg);
              } else {
                current = () => nextCfg;
              }
              json(res, 200, { models: options().visionModels, removed: before - nextModels.length });
              return;
            }
            if (id.length === 0) {
              json(res, 400, { error: 'id is required' });
              return;
            }
            const idx = models.findIndex((e) => e.id === id);
            if (idx === -1) {
              json(res, 404, { error: `vision model "${id}" not found` });
              return;
            }
            models.splice(idx, 1);
            // 若删除的是当前选中模型，清空选中
            const cfg = options();
            let nextCfg = { ...cfg, visionModels: models };
            if (cfg.provider !== '' && cfg.model !== '' && !models.some((e) => e.provider === cfg.provider && e.model === cfg.model)) {
              // 保留选中但不再强制清空，仅提示；此处不自动清空以免误操作
            }
            if (settingsScope !== void 0) {
              await settingsScope.replace(nextCfg);
            } else {
              current = () => nextCfg;
            }
            json(res, 200, { models: options().visionModels });
            return;
          }
          res.writeHead(405);
          res.end();
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/vision-models failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: vision-models route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/reasoning-levels',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
          const url = new URL(req.url ?? '/vision-opencode/reasoning-levels', 'http://127.0.0.1');
          const provider = (url.searchParams.get('provider') ?? '').trim().slice(0, 256);
          const model = (url.searchParams.get('model') ?? '').trim().slice(0, 256);
          if (provider.length === 0 || model.length === 0) {
            json(res, 400, { error: 'provider and model are required' });
            return;
          }
          const levels = await supportedLevels({ provider, model });
          const off = await trueOffSupported({ provider, model });
          // offSupported：真申报（true）/未申报（false）/未知（null）→按面值兜底
          const offSupported = off === null
            ? (levels === null ? true : levels.has('off'))
            : off;
          // 展示档位：未真申报 off 时把赝品 off 从列表剔除，避免「档位里有 off 却不给关闭」的自相矛盾
          let efforts = levels === null ? [] : [...levels].sort();
          if (offSupported === false) efforts = efforts.filter((id) => id !== 'off');
          json(res, 200, { provider, model, efforts, offSupported });
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/reasoning-levels failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: reasoning-levels route');
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/uninstall',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          // 自定义请求头阻止第三方网页用简单跨站 POST 触发破坏性清理。
          if (req.headers['x-vision-opencode-action'] !== 'uninstall') {
            json(res, 403, { error: 'missing x-vision-opencode-action: uninstall header' });
            return;
          }
          // 卸载前自清理：清空本插件自己的 settings 用户层，
          // 并还原旧版本写入的 llm-pi-ai modelOverrides（含 revision 防冲突）。
          // 必须先移除 modelOverrides 再清空本插件 settings：
          // removeGateOverrides 依赖 gateState 中的所有权记录；清空之后
          // 就无法再精确定位和还原旧版本写入的条目。
          const overridesRemoved = await removeGateOverrides();
          let ownCleared = false;
          if (settingsScope !== void 0) {
            await settingsScope.replace({});
            ownCleared = true;
          }
          json(res, 200, {
            ok: true,
            ownSettingsCleared: ownCleared,
            gateOverridesRemoved: overridesRemoved,
            remainingSteps: [
              'Stop dsh',
              'cd ~/.dsh/profiles/web && pnpm remove dsh-vision-opencode',
              'Remove the vision-opencode `insert` entry from cordis.patch.yml',
              'Start dsh again',
            ],
          });
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/uninstall failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: uninstall route');
  });

  // ---- 工具：vision_read_image ----
  ctx.tools.register(defineTool({
    name: 'vision_read_image',
    description: `Use the configured helper vision model (selected via the 「识图模型」 dropdown, across any provider) to analyze a PNG/JPEG/WebP/GIF workspace file and return OCR, layout, chart, or scene details as text. Use this tool on configured text-only main routes, where built-in read_image is blocked because it would inject a real image. A natively multimodal main model may keep using its native image path. If no helper vision model is configured, this tool fails with guidance.`,
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the image file, resolved by the filesystem backend.',
      },
      question: {
        type: 'string',
        description: 'Optional: a specific question about the image to answer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          analysis: { type: 'string', required: true },
          durationMs: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<vision model analysis>\n${value.analysis}\n</vision model analysis>`,
      }],
    },
    isConcurrencySafe: () => true,
    // UI 展示：调用时显示一张"看图"卡片（read 图标 + 图片路径，支持编辑器跟随）。
    presentCall(args) {
      const rawPath = typeof args?.file_path === 'string' ? args.file_path : '';
      const question = typeof args?.question === 'string' && args.question.trim().length > 0 ? args.question.trim() : void 0;
      return {
        card: 'generic',
        kind: 'read',
        title: `识图模型看图${question !== void 0 ? `：${question}` : ''}`,
        rawInput: rawPath,
        locations: rawPath.length > 0 ? [{ path: rawPath }] : void 0,
      };
    },
    // UI 展示：完成后在卡片内显示分析文本与耗时。
    presentResult(_args, result) {
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const durationMs = typeof result.value?.durationMs === 'number' ? result.value.durationMs : void 0;
      return {
        card: 'generic',
        title: durationMs !== void 0 ? `识图模型分析（用时 ${(durationMs / 1000).toFixed(1)}s）` : '识图模型分析',
        content: [{
          type: 'text',
          text: text.length > 0 ? text : (result.isError ? '（分析失败）' : '（无文本输出）'),
        }],
      };
    },
    async execute(args, exec) {
      const rawPath = args.file_path.trim();
      if (rawPath.length === 0) throw new Error('file_path must be a non-empty string');
      const mediaType = IMAGE_EXTENSIONS[extname(rawPath).toLowerCase()];
      if (mediaType === void 0) {
        throw new Error(`cannot read "${rawPath}": vision_read_image only accepts PNG/JPEG/WebP/GIF paths`);
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot read "${rawPath}": ${mediaType} images are not accepted by this deployment`);
      }
      // 与内置 read_image 相同的路径解析：优先使用会话 cwd。
      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(rawPath, {
        ...cwd !== void 0 ? { cwd } : {},
        signal: exec.signal,
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === void 0) throw new Error(`cannot read "${target.displayPath}": not found`);
      if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`);
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
      let ref;
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) });
      } catch (error) {
        throw new Error(`cannot read "${target.displayPath}" as an image: ${error?.message ?? String(error)}`);
      }
      const question = (args.question ?? '').trim();
      const route = options();
      if (!hasVisionModel(route)) {
        throw new Error('未配置识图模型：请在输入框右侧的「识图模型」下拉中选择一个支持图片输入的模型，然后再试。');
      }
      const startedAt = Date.now();
      let analysis;
      try {
        // 与瀑布路径共用同一个带超时+重试的识图子调用；
        // 最终失败抛错 → 工具结果 isError → 主模型继续工作并可告知用户。
        analysis = await analyzeImage({
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name !== void 0 ? { name: ref.name } : {},
        }, exec.signal, question.length > 0 ? question : void 0);
      } catch (error) {
        if (error instanceof VisionCallerAborted) throw error;
        throw new Error(`vision_read_image: ${route.provider}/${route.model} 识图失败（已重试）: ${error?.message ?? String(error)}`);
      }
      return { path: target.displayPath, analysis, durationMs: Date.now() - startedAt };
    },
  }));
}
