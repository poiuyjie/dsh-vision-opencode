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
import { BlockAssembler, contentHasImage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

/** `vision_read_image` 接受的扩展名与媒体类型（与内置 read_image 一致）。 */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 默认识图模型：opencode Go 套餐的 MiMo V2.5。 */
const DEFAULT_PROVIDER = 'opencode-go';
const DEFAULT_MODEL = 'mimo-v2.5';

/**
 * 伪识图模型黑名单：settings.yaml 里 llm-pi-ai.providers.opencode-go.modelOverrides
 * 为了放行图片提交闸门，把纯文本主模型的 input 声明成了 [text, image]。
 * 副作用是这些模型会出现在"支持图片输入"的目录里，所以本插件必须把它们
 * 从识图模型候选（/models 端点与 PUT /config 校验）中排除，否则选中后
 * 识图子调用会把图片发给真正的纯文本 API 报错。
 * 与 settings.yaml 的 modelOverrides 键保持一致。
 */
const SYNTHETIC_IMAGE_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);

/** 本插件持有的 settings namespace。 */
const NS = settingsNamespace('vision-opencode');

/** 识图模型配置 schema（settings 面板自动生成表单）。 */
const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  model: z.string().default(DEFAULT_MODEL),
  /** llm/stream 瀑布开关：false 时停用「发图自动转换」，只保留工具与选择器（稳定性逃生阀）。 */
  autoConvert: z.boolean().default(true),
  /** 主模型所在供应商路由（pi-ai 适配器名下）。空 = 不自动管理图片提交闸门。 */
  mainProvider: z.string().default(''),
  /** 需要声明 image 输入的纯文本主模型 id 列表；插件自动写入 llm-pi-ai 的 modelOverrides。 */
  mainModels: z.array(z.string()).default([]),
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
export const inject = ['tools', 'llm', 'fs', 'attachments', 'systemPrompt'];

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
      provider: typeof raw?.provider === 'string' && raw.provider.length > 0 ? raw.provider : DEFAULT_PROVIDER,
      model: typeof raw?.model === 'string' && raw.model.length > 0 ? raw.model : DEFAULT_MODEL,
      autoConvert: raw?.autoConvert !== false,
      mainProvider: typeof raw?.mainProvider === 'string' ? raw.mainProvider.trim() : '',
      mainModels: Array.isArray(raw?.mainModels)
        ? raw.mainModels.filter((id) => typeof id === 'string' && id.length > 0)
        : [],
    };
    lastRaw = raw;
    lastGood = next;
    return next;
  };
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
        return `A dedicated vision model (${route.provider}/${route.model}) is available through the vision_read_image tool. Use it proactively whenever image content must be understood: the user references an image file in the workspace, a tool result points at an image path, or you need OCR, chart reading, or scene description. Images the user attaches in chat are already analyzed automatically before reaching you — do not re-describe them. If the tool reports the vision model unavailable, say so to the user and continue the task without the image.`;
      },
    });
  }

  // ---- 图片提交闸门的自动管理（安装即生效、卸载可还原）----
  // 纯文本主模型默认会被 dsh-host-apiproxy 的提交闸门拒绝图片消息。
  // 这里按配置把主模型 id 写进 llm-pi-ai 的 modelOverrides（声明 image 输入），
  // 放行闸门；真正的图片永远不会到达主模型——llm/stream 瀑布会先替换成文本。
  // 写入走 settings 服务的深合并补丁，只动 modelOverrides 键，幂等、尽力而为。

  /**
   * 确保主模型 id 的 modelOverrides 存在。settings 服务缺失或 llm-pi-ai
   * 未注册（例如主模型走的是其他适配器）时只告警，绝不崩溃或改动其他配置。
   * @param attempt - 插件加载顺序可能让 llm-pi-ai 晚于本插件注册：首次失败后 3 秒重试一次。
   */
  async function ensureGateOverrides(attempt = 1) {
    const cfg = options();
    if (settingsService === void 0 || cfg.mainProvider.length === 0 || cfg.mainModels.length === 0) return;
    try {
      await settingsService.update('llm-pi-ai', {
        providers: {
          [cfg.mainProvider]: {
            modelOverrides: Object.fromEntries(cfg.mainModels.map((id) => [id, { input: ['text', 'image'] }])),
          },
        },
      });
      ctx.logger.info(`vision-opencode: 已为主模型放行图片提交闸门（${cfg.mainProvider}: ${cfg.mainModels.join(', ')}）`);
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

  /**
   * 移除本插件写入的 modelOverrides（卸载前调用）。只改 user 层、
   * 读-改-写带 revision 防冲突，最多重试 3 次；失败时告警并给出手动指引。
   * @returns 实际移除的条目数（0 = 没有本插件写入的条目）。
   */
  async function removeGateOverrides() {
    const cfg = options();
    if (settingsService === void 0 || cfg.mainProvider.length === 0 || cfg.mainModels.length === 0) return 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const descriptor = settingsService.describe().find((entry) => entry.ns === 'llm-pi-ai');
        if (descriptor === void 0 || descriptor.user === void 0 || descriptor.user === null || typeof descriptor.user !== 'object') return 0;
        const next = structuredClone(descriptor.user);
        const provider = next.providers?.[cfg.mainProvider];
        let removed = 0;
        if (provider !== void 0 && provider !== null && typeof provider === 'object') {
          for (const id of cfg.mainModels) {
            if (provider.modelOverrides !== void 0 && provider.modelOverrides[id] !== void 0) {
              delete provider.modelOverrides[id];
              removed += 1;
            }
          }
          if (provider.modelOverrides !== void 0 && Object.keys(provider.modelOverrides).length === 0) delete provider.modelOverrides;
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
      text: `[图片内容分析（识图模型 ${route.provider}/${route.model} 自动生成）]\n${analyses.join('\n\n')}`,
    };
  }

  /**
   * 递归地把 content 里的 image block 替换为识图模型的分析文本：
   * - 顶层（user 消息）里的图片：分析文本由调用方追加到消息内容末尾
   * - tool-result 里嵌套的图片（内置 read_image 产生的）：分析文本追加进该 tool-result 的 content
   * `sink` 收集本次去掉的每张图的分析文本；无图时返回原数组元素（不产生新对象）。
   */
  async function convertContent(blocks, signal, sink, route) {
    const out = [];
    for (const block of blocks) {
      if (block.type === 'image') {
        const ref = block.attachment;
        const key = typeof ref?.attachmentId === 'string' ? ref.attachmentId : 'unknown';
        let analysis = analysisCache.get(key);
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
          }
          if (ok) {
            // 只缓存成功结果：失败占位不落缓存，避免进程内持续"中毒"
            if (analysisCache.size >= 128) analysisCache.clear();
            analysisCache.set(key, analysis);
          }
        }
        sink.push(analysis);
        continue;
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const nested = [];
        const content = await convertContent(block.content, signal, nested, route);
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
    const isVisionRoute = llmOptions.provider === route.provider && llmOptions.model === route.model;
    const messages = Array.isArray(llmOptions.messages) ? llmOptions.messages : [];
    const hasImage = messages.some((message) => contentHasImage(message.content ?? []));
    if (!hasImage || isVisionRoute) return next();
    // 不能就地改 llmOptions.messages：agent-loop 拼出的请求是 deep-frozen 的
    // （冻结正是为了强制"监听器只读不写"，直接赋值会抛
    //  "Cannot assign to read only property 'messages'"）。
    // 传新对象给 next() 也没用：cordis waterfall 的 next() 闭包重放的是「原始参数」，
    // 下游监听器和适配器永远看到最初那个对象。
    // 因此这里短路：不调用 next()，改由嵌套的 ctx.llm.stream() 把去图后的请求
    // 发出去，再把它的 chunk 转交给外层消费者。BYPASS 防止嵌套调用再次触发本监听器。
    return (async function* visionTextStream() {
      let converted;
      try {
        converted = [];
        for (const message of messages) {
          const sink = [];
          const content = await convertContent(message.content ?? [], llmOptions.signal, sink, route);
          if (sink.length === 0) {
            converted.push(message);
            continue;
          }
          converted.push(freezeMessage({
            ...message,
            content: [...content, formatAnalyses(sink, route)],
          }));
        }
      } catch (error) {
        // 调用方取消：向上抛（回合正在结束，降级没有意义）
        if (error instanceof VisionCallerAborted || llmOptions.signal?.aborted) throw error;
        // 插件自身的意外错误也不能杀死回合：全部图片降级为占位文本，
        // 主模型照常工作并向用户说明（这是发布版的最后一道保险）。
        ctx.logger.error('vision-opencode: 图片自动转换出现意外错误，降级为占位文本', error);
        converted = messages.map((message) => freezeMessage({
          ...message,
          content: [
            ...(message.content ?? []).filter((block) => block.type !== 'image'),
            { type: 'text', text: fallbackAnalysisText(route, error) },
          ],
        }));
      }
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
    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: '/vision-opencode/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, options());
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
            // 拒绝伪识图模型（见 SYNTHETIC_IMAGE_MODELS 注释），并双重校验
            // 模型确实声明了 image 输入，防止手工 PUT 把纯文本模型设进来。
            let declaredVision = false;
            try {
              const info = await ctx.llm.resolveModelInfo(provider, model);
              declaredVision = Array.isArray(info.inputModalities) && info.inputModalities.includes('image');
            } catch {
              declaredVision = false;
            }
            if (SYNTHETIC_IMAGE_MODELS.has(model) || options().mainModels.includes(model) || !declaredVision) {
              json(res, 400, { error: `model "${provider}/${model}" is not a vision-capable model` });
              return;
            }
            if (settingsScope !== void 0) {
              await settingsScope.replace({ provider, model });
            } else {
              current = () => ({ provider, model });
            }
            json(res, 200, options());
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
          const synthetic = new Set([...SYNTHETIC_IMAGE_MODELS, ...options().mainModels]);
          for (const provider of ctx.llm.listProviders()) {
            try {
              const models = await ctx.llm.listModels(provider.id);
              const vision = models.filter((model) =>
                Array.isArray(model.inputModalities)
                && model.inputModalities.includes('image')
                && !synthetic.has(model.id));
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
          // 卸载前自清理：清空本插件自己的 settings 用户层，
          // 并移除本插件写入的 llm-pi-ai modelOverrides（含 revision 防冲突）。
          let ownCleared = false;
          if (settingsScope !== void 0) {
            await settingsScope.replace({});
            ownCleared = true;
          }
          const overridesRemoved = await removeGateOverrides();
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
    description: `Use the configured vision model (default ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}) to read and analyze an image file (PNG/JPEG/WebP/GIF) and return a detailed text description: OCR transcription, layout, chart values, scene. Use this tool whenever image content must be understood — including when the current main model does not support image input.`,
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
    // UI 展示：完成后在卡片内显示分析文本。
    presentResult(_args, result) {
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return {
        card: 'generic',
        title: '识图模型分析',
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
      return { path: target.displayPath, analysis };
    },
  }));
}
