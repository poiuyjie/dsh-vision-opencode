// dsh-vision-opencode: DeepSeek Harness 插件（后端半边）。
//
// 1. 注册 `vision_read_image` 工具：无论当前会话主模型是否支持图片输入，
//    调用该工具都会把图片转成 durable attachment，并通过 DSH 自带的
//    `llm` 服务用配置的识图模型完成一次带图分析，把文本分析结果返回给主模型。
//    带系统提示词 section 引导主模型在必要时主动调用。
// 2. 注册 settings namespace `vision-opencode`：
//      provider/model 识图模型路由
//      autoConvert      llm/stream 瀑布开关（发图自动转换的稳定性逃生阀）
//      mainProvider/mainModels  自动放行图片提交闸门的纯文本主模型 id
// 3. llm/stream 瀑布：含图请求先由识图模型分析成文本再交给主模型；
//    超时+重试+降级占位，识图不可用不影响主模型回合。
// 4. web 模式注册 HTTP 端点：
//      GET  /vision-opencode/config      当前配置
//      PUT  /vision-opencode/config      更新识图模型（校验真实 vision 能力）
//      GET  /vision-opencode/models      可识图模型列表（供应商目录）
//      POST /vision-opencode/uninstall   卸载前自清理（settings + modelOverrides）
//    前端"识图模型"选择器通过它们读写配置。
import { basename, extname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import {
  PLUGIN_IMAGE_INPUT,
  activateGateClaims,
  countImages,
  countUniqueImages,
  installImageAdmissionOverride,
  isManagedMainRoute,
  planGateOverrides,
  replaceImagesWithText,
  sameStringArray,
  visionCacheKey,
} from './core.js';

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

/** 识图模型配置 schema（settings 面板自动生成表单）。 */
const Config = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  /** llm/stream 瀑布开关：false 时停用「发图自动转换」，只保留工具与选择器（稳定性逃生阀）。 */
  autoConvert: z.boolean().default(true),
  /** 主模型所在供应商路由（pi-ai 适配器名下）。空 = 不自动管理图片提交闸门。 */
  mainProvider: z.string().default(''),
  /** 需要声明 image 输入的纯文本主模型 id 列表；插件自动写入 llm-pi-ai 的 modelOverrides。 */
  mainModels: z.array(z.string()).default([]),
  /** 插件修改 modelOverrides 前保存的 input；隐藏字段，用于卸载时精确恢复。 */
  gateState: z.string().default('').hidden(),
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
      autoConvert: raw?.autoConvert !== false,
      mainProvider: typeof raw?.mainProvider === 'string' ? raw.mainProvider.trim() : '',
      mainModels: Array.isArray(raw?.mainModels)
        ? raw.mainModels.filter((id) => typeof id === 'string' && id.length > 0)
        : [],
      gateState: typeof raw?.gateState === 'string' ? raw.gateState : '',
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
  const managedRoute = (provider, model) => isManagedMainRoute(options(), provider, model);

  // dsh-host-apiproxy checks resolveModelInfo before llm/stream runs. Some
  // providers (notably dsh-llm-deepseek) are not backed by llm-pi-ai, so their
  // catalog cannot be extended through modelOverrides. Report image admission
  // only for routes this plugin converts immediately in llm/stream.
  const llmRuntime = ctx.get('llm');
  if (llmRuntime !== void 0 && typeof llmRuntime.resolveModelInfo === 'function') {
    try {
      const restoreImageAdmission = installImageAdmissionOverride(llmRuntime, managedRoute);
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
    // 启动时确保图片提交闸门放行（幂等、尽力而为）
    void ensureGateOverrides();
  });

  // ---- 结构性拦截：执行前拒绝内置 read_image，防止真实图片进入纯文本主模型上下文 ----
  // 背景：本插件为放行图片提交闸门，把纯文本主模型在 llm-pi-ai 里声明成了
  // "支持图片输入"，副作用是内置 read_image 的自身门禁也放行了——模型一旦
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
    if (!managedRoute(provider, model)) return;
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
          if (reused === imageCount || session === void 0 || typeof session.append !== 'function') return;
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

  // ---- 图片提交闸门的自动管理（安装即生效、卸载可还原）----
  // 纯文本主模型默认会被 dsh-host-apiproxy 的提交闸门拒绝图片消息。
  // 这里按配置把主模型 id 写进 llm-pi-ai 的 modelOverrides（声明 image 输入），
  // 放行闸门；真正的图片永远不会到达主模型——llm/stream 瀑布会先替换成文本。
  // 写入走 settings 服务的深合并补丁，只动 modelOverrides 键，幂等、尽力而为。

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

  const encodeGateState = (claims) => claims.length === 0
    ? ''
    : Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
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

  /** 确保已配置文本主路由放行图片提交，并精确记录本插件拥有的 input 改动。 */
  async function ensureGateOverrides(attempt = 1) {
    const cfg = options();
    if (settingsService === void 0) return;
    try {
      const descriptor = settingsService.describe().find((item) => item.ns === 'llm-pi-ai');
      if (descriptor === void 0) throw new Error('llm-pi-ai settings namespace is unavailable');
      const claims = decodeGateState(cfg.gateState);
      const piProvider = descriptor.user?.providers?.[cfg.mainProvider]
        ?? descriptor.value?.providers?.[cfg.mainProvider];
      if (cfg.mainProvider.length > 0 && piProvider === void 0) {
        // Providers owned by another adapter (for example deepseek-official)
        // cannot be declared through llm-pi-ai.modelOverrides. Admission is
        // handled by the resolveModelInfo compatibility layer above instead.
        if (claims.length > 0) await removeGateOverrides();
        if (cfg.gateState.length > 0) await settingsScope?.update({ gateState: '' });
        ctx.logger.info(`vision-opencode: ${cfg.mainProvider} 由其他适配器提供，使用运行时图片闸门兼容层`);
        return;
      }
      const plan = planGateOverrides(cfg, claims, descriptor.user, descriptor.value);

      // 配置中已移除的路由先按原值还原；如果用户后来改过 input，则只释放所有权。
      let llmRevision = descriptor.revision;
      if (plan.restored > 0) {
        await settingsService.replace('llm-pi-ai', plan.user, llmRevision);
        llmRevision += 1;
      }
      for (const route of plan.released) {
        ctx.logger.warn(`vision-opencode: 检测到 ${route.provider}/${route.model} 的 input 已被外部修改，已停止管理该闸门`);
      }

      // 所有权必须先落盘；即使下一步进程退出，重启后也能继续写入或安全还原。
      if (encodeGateState(plan.claims) !== encodeGateState(claims)) {
        await settingsScope?.update({ gateState: encodeGateState(plan.claims) });
      }
      if (plan.desiredModels.length > 0) {
        await settingsService.update('llm-pi-ai', {
          providers: {
            [cfg.mainProvider]: {
              modelOverrides: Object.fromEntries(plan.desiredModels.map((id) => [id, { input: [...PLUGIN_IMAGE_INPUT] }])),
            },
          },
        }, llmRevision);
        const activeClaims = activateGateClaims(plan.claims, cfg.mainProvider, plan.desiredModels);
        if (encodeGateState(activeClaims) !== encodeGateState(plan.claims)) {
          await settingsScope?.update({ gateState: encodeGateState(activeClaims) });
        }
        ctx.logger.info(`vision-opencode: 已为主模型放行图片提交闸门（${cfg.mainProvider}: ${plan.desiredModels.join(', ')}）`);
      }
    } catch (error) {
      if (attempt < 2) {
        setTimeout(() => { void ensureGateOverrides(attempt + 1); }, 3000);
        return;
      }
      ctx.logger.warn(
        `vision-opencode: 自动配置 modelOverrides 失败（llm-pi-ai 未注册或版本不同）。请手动在 settings.yaml 添加 llm-pi-ai.providers.${cfg.mainProvider}.modelOverrides，否则向纯文本主模型发送图片会被提交闸门拒绝`,
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
        if (descriptor === void 0 || descriptor.user === void 0 || descriptor.user === null || typeof descriptor.user !== 'object') return 0;
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
        if (removed === 0) return 0;
        await settingsService.replace('llm-pi-ai', next, descriptor.revision);
        return removed;
      } catch (error) {
        if (error?.name === 'SettingsConflictError' && attempt < 3) continue;
        ctx.logger.warn('vision-opencode: 移除 modelOverrides 失败；请手动删除 settings.yaml 中 llm-pi-ai.providers.<provider>.modelOverrides 的本插件条目', error);
        return 0;
      }
    }
    return 0;
  }

  // ---- llm/stream 瀑布：含图片的请求自动转成识图模型的分析文本 ----
  // 背景：主模型（如 deepseek-v4-pro）是纯文本，而消息提交闸门
  // （dsh-host-apiproxy）在模型未声明 image 输入时直接拒绝图片消息。
  // 配合 settings 的 llm-pi-ai.providers.opencode-go.modelOverrides
  // （把主模型 input 声明为含 image 以放行闸门），这里在真正的模型调用
  // 之前把每个 image block 替换为识图模型的分析文本：
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

  /** 单次识图子调用：组装带图消息 → 流式请求识图模型 → 返回纯文本。 */
  async function callVisionOnce(ref, signal, question) {
    const route = options();
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
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: VISION_SYSTEM_PROMPT,
      messages: [message],
      temperature: 0.2,
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

  /**
   * 递归地把 content 里的 image block 替换为识图模型的分析文本：
   * - 顶层（user 消息）里的图片：分析文本由调用方追加到消息内容末尾
   * - tool-result 里嵌套的图片（内置 read_image 产生的）：分析文本追加进该 tool-result 的 content
   * `sink` 收集本次去掉的每张图的分析文本；无图时返回原数组元素（不产生新对象）。
   */
  async function convertContent(blocks, signal, sink, route, stats) {
    const out = [];
    for (const block of blocks) {
      if (block.type === 'image') {
        const ref = block.attachment;
        const key = visionCacheKey(route, ref);
        const requestResult = key === void 0 ? void 0 : stats.requestResults.get(key);
        let analysis = requestResult?.analysis
          ?? (key === void 0 ? void 0 : analysisCache.get(key));
        if (analysis === void 0) {
          let ok = false;
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
            if (analysisCache.size >= 128) analysisCache.clear();
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
        sink.push(analysis);
        continue;
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const nested = [];
        const content = await convertContent(block.content, signal, nested, route, stats);
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
    // 只接管用户明确列入 mainProvider/mainModels 的文本主路由。
    // 其他供应商、其他模型（尤其原生多模态主模型）完整保留 DSH 的原生图片链路。
    if (!managedRoute(llmOptions.provider, llmOptions.model)) return next();
    const messages = Array.isArray(llmOptions.messages) ? llmOptions.messages : [];
    const seenAttachmentIds = new Set();
    const imageCount = messages.reduce((total, message) => total
      + (Array.isArray(message?.content)
        ? countUniqueImages(message.content, seenAttachmentIds)
        : 0), 0);
    if (imageCount === 0) return next();
    let currentImageCount = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.source?.kind !== 'user') continue;
      currentImageCount = Array.isArray(message.content)
        ? countUniqueImages(message.content)
        : 0;
      break;
    }
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
    // 诊断日志：记录每次实际触发转换的请求（帮助定位"图片漏网"类问题）
    ctx.logger.info(`vision-opencode: 请求含图片，开始自动转换（目标 ${llmOptions.provider}/${llmOptions.model}，${messages.length} 条消息）`);
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
      const finishStatus = appendVisionStatus(llmOptions, route, imageCount, currentImageCount);
      try {
        converted = [];
        for (const message of messages) {
          if (!Array.isArray(message?.content)) {
            converted.push(message);
            continue;
          }
          const sink = [];
          const content = await convertContent(message.content, llmOptions.signal, sink, route, stats);
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
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            const model = typeof body?.model === 'string' ? body.model.trim() : '';
            if (provider.length === 0 || model.length === 0) {
              json(res, 400, { error: 'provider and model strings are required' });
              return;
            }
            // 精确排除本插件管理的文本主路由，并校验候选模型确实声明了 image 输入。
            let declaredVision = false;
            try {
              const info = await ctx.llm.resolveModelInfo(provider, model);
              declaredVision = Array.isArray(info.inputModalities) && info.inputModalities.includes('image');
            } catch {
              declaredVision = false;
            }
            if (managedRoute(provider, model) || !declaredVision) {
              json(res, 400, { error: `model "${provider}/${model}" is not a vision-capable model` });
              return;
            }
            if (settingsScope !== void 0) {
              // 只更新识图模型，保留其余配置（autoConvert/mainProvider/mainModels）。
              await settingsScope.replace({ ...options(), provider, model });
            } else {
              const next = { ...options(), provider, model };
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
          const groups = [];
          for (const provider of ctx.llm.listProviders()) {
            try {
              const models = await ctx.llm.listModels(provider.id);
              const vision = models.filter((model) =>
                Array.isArray(model.inputModalities)
                && model.inputModalities.includes('image')
                && !managedRoute(provider.id, model.id));
              if (vision.length === 0) continue;
              groups.push({
                provider: provider.id,
                name: provider.name,
                models: vision.map((model) => ({ id: model.id, name: model.name })),
              });
            } catch (error) {
              ctx.logger.warn(`vision-opencode: listModels(${provider.id}) failed`, error);
            }
          }
          json(res, 200, { groups });
        } catch (error) {
          ctx.logger.error('vision-opencode: /vision-opencode/models failed', error);
          json(res, 500, { error: error?.message ?? String(error) });
        }
      },
    }), 'vision-opencode: models route');
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
          // 并移除本插件写入的 llm-pi-ai modelOverrides（含 revision 防冲突）。
          // 必须先移除 modelOverrides 再清空本插件 settings：
          // removeGateOverrides 依赖当前配置（mainProvider/mainModels）
          // 定位条目，清空之后配置就只剩默认值了。
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
