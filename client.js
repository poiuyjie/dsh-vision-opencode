// dsh-vision-opencode: DeepSeek Harness 插件（前端半边）。
//
// 在输入框右侧（conversation.input.right slot）注入"识图模型"选择器：
// 列出所有支持图片输入的供应商模型（后端 /vision-opencode/models 提供），
// 选择结果写入后端配置（PUT /vision-opencode/config），
// vision_read_image 工具随后使用该模型看图。
//
// 视觉与交互复刻官方模型选择器（packages/client/ui-model-selection 的
// ModelSelect + ModelSelect.module.css）：28px 胶囊触发器（13/20/500 次要色、
// hover 填充）、向上展开的 12px 圆角菜单卡片、粘性供应商分组标题、38px 两行
// 选项（模型名 14/20/500 + 描述 12/18）、尾部对勾选中标记、方向键导航、
// 失焦/外点/Escape 关闭、加载失败重试条、选择失败 Toast。样式声明逐字取自
// 官方 CSS（仅类名加 vmo- 前缀），主题令牌（--dsw-*）随官方深浅色自动切换；
// 对勾/箭头图标与 Toast 来自平台 seed 模块 @deepseek-ai/dsh-client-ui-primitives，
// 缺失时回退内置字形，功能不受影响。
//
// Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})，
// factory 通过 require() 获取平台共享模块（react、cordis、slots 等）。
window.__ModuleLoader__.load({
	id: "dsh-vision-opencode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- 官方 UI 原语（平台 seed 模块，可选依赖） ----
		// 对勾/箭头图标与 Toast 与官方 ModelSelect 同源；平台缺失这些导出时
		// 回退到内置字形与无 Toast 提示，选择器仍可用。
		var IconCheckOutline16 = null;
		var IconChevronDownOutline14 = null;
		var IconWarningOutline16 = null;
		var IconTrashOutline16 = null;
		var IconPlusOutline16 = null;
		var IconEditOutline16 = null;
		var Toast = null;
		var Modal = null;
		var Button = null;
		try {
			var uiPrimitives = require("@deepseek-ai/dsh-client-ui-primitives");
			IconCheckOutline16 = uiPrimitives.IconCheckOutline16;
			IconChevronDownOutline14 = uiPrimitives.IconChevronDownOutline14;
			IconWarningOutline16 = uiPrimitives.IconWarningOutline16;
			IconTrashOutline16 = uiPrimitives.IconTrashOutline16;
			IconPlusOutline16 = uiPrimitives.IconPlusOutline16;
			IconEditOutline16 = uiPrimitives.IconEditOutline16;
			Toast = uiPrimitives.Toast;
			Modal = uiPrimitives.Modal;
			Button = uiPrimitives.Button;
		} catch (_missing) {
			/* 平台模块缺失：走内置兜底字形 */
		}
		var ReactDOMClient = null;
		try { ReactDOMClient = require("react-dom/client"); } catch (_e) {}
		if (ReactDOMClient === null) { try { ReactDOMClient = require("react-dom"); } catch (_e2) {} }

		// ---- 跨 desktop/web 端 CSS Module hash 自适配（必须在注入 CSS 与构造 C map 之前）----
		// desktop 端 DSH 用 zGbnIq_*，web 端 DSH 用 N78Vuq_*（CSS Module 编译 hash 不同），
		// 且 DSH 编译会重写官方样式选择器但不改 plugin 的字面 className。
		// 不写死候选 hash：直接扫描当前页面已注入的样式规则，找出包含我们
		// 实际复用类名（modelCatalog/editor/rowCard 等）的 hash 前缀。
		// DSH 升级只要类名不变、只换 hash 前缀，就能自动适配。
		function detectCssHash() {
			var targets = ["modelCatalog", "editor", "editorHeader", "rowCard", "addCard", "title"];
			var found = {};
			try {
				for (var si = 0; si < document.styleSheets.length; si++) {
					var rules;
					try { rules = document.styleSheets[si].cssRules; } catch (err) { continue; }
					if (!rules) continue;
					for (var ri = 0; ri < rules.length; ri++) {
						var r = rules[ri];
						if (typeof r.selectorText !== "string") continue;
						// CSS Module 类名形态：`hash_原类名`（hash 为 5~10 位字母数字）
						var m = /\.([A-Za-z0-9]{5,10})_([A-Za-z0-9_]+)/.exec(r.selectorText);
						if (m === null) continue;
						var hash = m[1] + "_";
						var cls = m[2];
						if (targets.indexOf(cls) >= 0 && found[cls] === undefined) found[cls] = hash;
					}
				}
			} catch (err) { /* 样式表不可读时走下方兜底探测 */ }
			if (found.modelCatalog) return found.modelCatalog;
			if (found.editor) return found.editor;
			if (found.rowCard) return found.rowCard;
			if (found.addCard) return found.addCard;
			if (found.editorHeader) return found.editorHeader;
			if (found.title) return found.title;
			// 兜底：官方 CSS 尚未注入/不可读时，用固定候选注入测试元素探测
			var probes = ["zGbnIq_", "N78Vuq_", "GL8Viq_", "ZLY6Yq_"];
			for (var i = 0; i < probes.length; i++) {
				var cls2 = probes[i] + "vmo_hash_probe";
				var s = document.createElement("style");
				s.textContent = "." + cls2 + " { color: rgb(" + (i+1) + ",0,0) !important; }";
				document.head.appendChild(s);
				var d = document.createElement("span");
				d.className = cls2;
				document.body.appendChild(d);
				var c = window.getComputedStyle(d).color;
				document.body.removeChild(d);
				document.head.removeChild(s);
				if (c === "rgb(" + (i+1) + ", 0, 0)") return probes[i];
			}
			return "zGbnIq_";
		}
		var cssHash = detectCssHash();

		// ---- 注入样式：逐字复刻官方 ModelSelect.module.css（前缀 vmo-） ----
		// 注意：web 客户端热更新时 <head> 不会被重建，旧 <style> 标签会留存，
		// 因此这里「存在则更新内容」而非「不存在才注入」，否则改样式不生效。
		var CSS_ID = "dsh-vision-opencode/style";
		if (typeof document !== "undefined") {
			var styleTag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
			if (styleTag === null) {
				styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-vision-opencode";
				styleTag.dataset.pluginCss = CSS_ID;
				document.head.appendChild(styleTag);
			}
			styleTag.textContent = [
				/* 根：锚定向上展开的菜单 */
				".vmo-root{position:relative;min-width:0}",
				/* 触发器（Figma 313:14108 ToggleButton）：28px 胶囊、13/20/500 次要色，
				   hover 填充，与官方模型选择器同一族 chip */
				".vmo-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer}",
				".vmo-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
				".vmo-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
				".vmo-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				/* 前缀标记：caption 色的 "Vision"（官方 .triggerEffort 同款次要呈现），
				   用于与旁边的官方主模型选择器区分 */
				".vmo-trigger-tag{flex:0 0 auto;color:var(--dsw-alias-label-caption)}",
				/* 识图进度：提示语占位替换 Vision 标记（模型名保留）；
				   运行中复刻官方 TurnStatus（Deep diving...）的微光扫过动效，完成/失败沿用绿/红状态色，取消态继承 caption 色 */
				".vmo-progress-running{background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);background-position:100% 0;background-size:250% 100%;background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:vmo-shimmer 1.8s linear infinite}",
				".vmo-progress-done{color:var(--dsw-static-green-500)}",
				".vmo-progress-failed{color:var(--dsw-static-red-500)}",
				"@keyframes vmo-shimmer{to{background-position:0 0}}",
				"@media (prefers-reduced-motion: reduce){.vmo-progress-running{background-position:0 0;background-size:100% 100%;animation:none}}",
				/* 箭头：caption 色，展开旋转 180°；兜底字形按 14px 渲染 */
				".vmo-chevron{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;font-size:14px;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}",
				".vmo-chevron-open{transform:rotate(180deg)}",
				/* 菜单卡片：表面令牌与官方 Menu 原语一致；滚动条重绑 l2 高度令牌 */
				".vmo-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;display:flex;flex-direction:column;width:min(240px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
				".vmo-status,.vmo-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			/* 推理开关（放在 Vision 菜单底部，内联分段控件，无弹出层故不会与列表重叠）：
			   深浅色跟随 shell 令牌 */
			".vmo-effort{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 4px;padding:8px 8px 10px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".vmo-effort-label{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);flex:none}",
			".vmo-effort-seg{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-solid,transparent)}",
			".vmo-effort-seg-btn{min-width:54px;height:24px;padding:0 10px;border:none;border-radius:6px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:24px;cursor:pointer}",
			".vmo-effort-seg-btn:hover:not(:disabled):not(.is-on){background:var(--dsw-alias-interactive-bg-hover)}",
			".vmo-effort-seg-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".vmo-effort-seg-btn.is-on{background:var(--dsw-alias-bg-layer-2,var(--dsw-specific-menu));color:var(--dsw-alias-state-business-primary);font-weight:600;box-shadow:var(--dsw-shadow-lv1)}",
			".vmo-settings-reasoning{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-primary,transparent)}",
			".vmo-settings-reasoning-copy{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".vmo-settings-reasoning-title{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".vmo-settings-reasoning-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".vmo-settings-reason-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
			".vmo-settings-reason-label{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".vmo-settings-reason-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
				/* 加载失败条（官方 error 表面）+ 重试入口 */
				".vmo-error{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
				".vmo-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}",
				".vmo-groups{min-height:0;overflow-y:auto}",
				".vmo-group + .vmo-group{margin-top:4px}",
				/* 供应商分组标题：粘性吸顶 */
				".vmo-group-title{position:sticky;top:0;z-index:1;padding:5px 8px 3px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:500}",
				/* 选项行：38px 两行（名称+描述）；选中标记是尾部对勾而非填充 */
				".vmo-option{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 8px;border:none;border-radius:10px;outline:none;background:transparent;color:inherit;text-align:left;cursor:pointer}",
				".vmo-option:hover:not(:disabled),.vmo-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
				".vmo-option-copy{display:flex;flex:1;flex-direction:column;min-width:0}",
				".vmo-model-name{overflow:hidden;color:inherit;font-size:14px;line-height:20px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}",
				".vmo-description{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}",
				".vmo-check{display:grid;place-items:center;flex:0 0 18px;font-size:14px;color:var(--dsw-alias-label-primary)}",
				/* 视觉隐藏的常驻读屏直播区：只镜像进度文案，避免恢复 "Vision" 时被播报 */
				".vmo-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap}",
				/* 设置页 Vision 分组：复刻 zGbnIq_* 令牌，深色/浅色自动跟随 */
			/* 官方 CSS 类映射见下方 C 常量；Vision 列表与表单直接复用官方 zGbnIq_* 类 */
				".vmo-settings-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;margin-top:24px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}",
				".vmo-settings-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}",
				".vmo-settings-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}",
				".vmo-settings-rows{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}",
				".vmo-settings-group{display:flex;flex-direction:column;gap:8px}",
				".vmo-settings-groupTitle{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:18px;padding:4px 2px 0;margin:0}",
				".vmo-settings-groupHeader{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-primary,transparent);color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;cursor:pointer;text-align:left}",
				".vmo-settings-groupHeader:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-settings-groupChevron{flex:none;font-size:14px;color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease;transform:rotate(-90deg)}",
				".vmo-settings-groupOpen .vmo-settings-groupChevron{transform:rotate(0deg)}",
				".vmo-settings-groupCount{margin-left:auto;font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}",
				".vmo-settings-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;display:flex;flex-direction:column;gap:8px;padding:12px 14px;background:var(--dsw-alias-bg-primary,transparent)}",
				".vmo-settings-head{display:flex;align-items:center;gap:10px}",
				".vmo-settings-identity{display:inline-flex;align-items:center;gap:6px;min-width:0}",
				".vmo-settings-name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".vmo-settings-tag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 6px;font-size:11px;line-height:16px;flex:none}",
				".vmo-settings-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;box-sizing:border-box}",
				".vmo-settings-dot-on{background:var(--dsw-alias-state-success-primary)}",
				".vmo-settings-dot-off{background:var(--dsw-alias-state-error-primary)}",
				".vmo-settings-dot-idle{background:var(--dsw-alias-border-l3)}",
				".vmo-settings-actions{margin-left:auto;display:inline-flex;gap:4px;align-items:center}",
				".vmo-settings-btn{box-sizing:border-box;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}",
				".vmo-settings-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-settings-btn-danger{border:none;color:var(--dsw-alias-state-error-primary)}",
				".vmo-settings-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
				".vmo-settings-addBlock{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}",
				".vmo-settings-addBtn{flex:1 1 0;min-width:180px;height:44px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}",
				".vmo-settings-addBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-settings-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:8px 0}",
				".vmo-settings-error{color:var(--dsw-alias-state-error-primary);font-size:13px;padding:6px 8px;background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:8px}",
			/* 供应商分组头：大字号（参考官方 rowName 14px），箭头指示展开/收起 */
			".vmo-provider-group{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-primary)}",
			".vmo-provider-group ." + cssHash + "rowCard{background:var(--dsw-alias-bg-primary)}",
			".vmo-provider-group ." + cssHash + "modelEntry{background:var(--dsw-alias-bg-primary)}",
			".vmo-provider-head-row{display:flex;align-items:center;gap:8px;width:100%}",
			".vmo-provider-head-edit{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:13px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}",
			".vmo-provider-head-edit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".vmo-provider-head-del{color:var(--dsw-alias-state-error-primary)}",
			".vmo-provider-head-del:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}",
			".vmo-provider-head{display:flex;align-items:center;gap:8px;width:100%;padding:2px 0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;cursor:pointer;text-align:left}",
			".vmo-provider-head:hover{color:var(--dsw-alias-label-secondary)}",
			".vmo-provider-chevron{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease;transform:rotate(-90deg);display:inline-flex}",
			".vmo-provider-groupOpen .vmo-provider-chevron{transform:rotate(0deg)}",
			".vmo-provider-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".vmo-provider-custom-tag{flex:none;height:18px;padding:0 6px;margin-left:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;display:inline-flex;align-items:center}",
			".vmo-provider-count{margin-left:auto;flex:none;font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}",
				/* 弹窗表单 */
				".vmo-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}",
				".vmo-modal{width:min(520px,95vw);max-height:90vh;overflow:auto;background:var(--dsw-alias-bg-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px;box-shadow:var(--dsw-shadow-lv3);color-scheme:light dark}",
				".vmo-modal-title{font-size:15px;font-weight:600;line-height:22px;margin:0;color:var(--dsw-alias-label-primary)}",
				".vmo-field{display:flex;flex-direction:column;gap:6px}",
				".vmo-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);line-height:18px}",
".vmo-input{height:36px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);font-size:14px;outline:none;width:100%;box-sizing:border-box;color-scheme:light dark}",
".vmo-input option,.vmo-input optgroup{background:var(--dsw-specific-menu,var(--dsw-alias-bg-primary));color:var(--dsw-alias-label-primary)}",
".vmo-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}",
".vmo-input:focus{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
				".vmo-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
				".vmo-btn-primary{height:36px;padding:0 14px;border-radius:18px;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:14px;cursor:pointer}",
				".vmo-btn-primary:disabled{opacity:0.4;cursor:default}",
				".vmo-btn-secondary{height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;cursor:pointer}",
				// 模型选择弹窗：纯 vmo-picker-* 自渲染 CSS，间距值对齐官方 CSS Module 源
				// （candidateList gap:2px/max-height:320px、candidateLabel gap:8px/padding:6px 8px、
				// candidateId font-size:13px/font-family:var(--ds-font-family-code)）。
				// 零 hash 类依赖，DSH 升级换 hash 也不影响 picker 视觉。
				".vmo-picker-rows{display:flex;flex-direction:column;gap:2px;max-height:320px;margin:0;padding:0;list-style:none;overflow-y:auto}",
				".vmo-picker-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:transparent;border:none;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;width:100%}",
				".vmo-picker-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".vmo-picker-row:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
				".vmo-picker-row-id{flex:auto;font-family:var(--ds-font-family-code,var(--dsw-typography-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace));overflow-wrap:anywhere;font-size:13px;color:var(--dsw-alias-label-primary)}",
				".vmo-picker-row-box{flex:none;width:16px;height:16px;border:1.5px solid rgba(0,0,0,0.25);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;background:transparent;color:#fff;transition:background-color 120ms ease,border-color 120ms ease}",
				"[data-ds-dark-theme] .vmo-picker-row-box{border-color:rgba(255,255,255,0.25)}",
				".vmo-picker-row.vmo-picker-row-checked .vmo-picker-row-box{background:rgb(59,130,246);border-color:rgb(59,130,246)}",
				".vmo-picker-rows .vmo-picker-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:20px 0;text-align:center}"
			].join("\n");
			document.head.appendChild(styleTag);
		}

		var menuSeq = 0;

		// ---- 识图模型选择器组件 ----
		// props: { sessionId }（来自 slot inject）
		var VisionModelSelect = function(props) {
			var sessionId = props.sessionId;
			var useState = react.useState;
			var useEffect = react.useEffect;
			var useRef = react.useRef;
			var createElement = react.createElement;

			var groupsState = useState([]);
			var groups = groupsState[0];
			var setGroups = groupsState[1];
			var currentState = useState(null);
			var current = currentState[0];
			var setCurrent = currentState[1];
			var statusState = useState("loading");
			var status = statusState[0];
			var setStatus = statusState[1];
			var loadErrorState = useState(null);
			var loadError = loadErrorState[0];
			var setLoadError = loadErrorState[1];
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var toastState = useState(null);
			var toast = toastState[0];
			var setToast = toastState[1];
			var progressState = useState(null);
			var progress = progressState[0];
			var setProgress = progressState[1];
			var rootRef = useRef(null);
			var triggerRef = useRef(null);
			var itemRefs = useRef([]);
			var toastSeq = useRef(0);
			var loadRef = useRef(null);
			var menuIdRef = useRef(null);
			if (menuIdRef.current === null) {
				menuSeq += 1;
				menuIdRef.current = "vmo-menu-" + menuSeq;
			}

			useEffect(function() {
				var cancelled = false;
				var attempts = 0;
				var clearProgressTimer = null;
				var progressStream = null;
				setStatus("loading");
				fetch("/vision-opencode/config", { headers: { accept: "application/json" } })
					.then(function(resp) { return resp.json(); })
					.then(function(cfg) {
						if (!cancelled && cfg !== null && typeof cfg === "object" && typeof cfg.provider === "string" && typeof cfg.model === "string") setCurrent(cfg);
					})
					.catch(function() {});
				// 加载模型目录；后端端点可能晚于前端挂载，初次加载失败自动重试。
				// withRetry=true（挂载）：6 次退避后进入 error 态；
				// withRetry=false（每次打开菜单时静默刷新）：单次失败仅置 loadError，
				// 保留旧目录继续可用（官方 /model 弹层同款"打开即刷新"行为）。
				var messageOf = function(error) {
					return error && typeof error.message === "string" && error.message.length > 0 ? error.message : String(error);
				};
				var loadModels = function(withRetry) {
					Promise.all([
						fetch("/vision-opencode/models", { headers: { accept: "application/json" } }).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); }),
						fetch("/vision-opencode/vision-models", { headers: { accept: "application/json" } }).then(function(r){ if(!r.ok) return {models:[]}; return r.json(); }).catch(function(){ return {models:[]}; })
					]).then(function(results){
						if (cancelled) return;
						var data = results[0];
						var vmData = results[1];
						if (data === null || typeof data !== "object" || !Array.isArray(data.groups)) throw new Error("bad payload");
						var groups = data.groups.slice();
						var vmList = vmData && Array.isArray(vmData.models) ? vmData.models : [];
						if (vmList.length > 0) {
							var vmByProvider = {};
							for (var i=0;i<vmList.length;i++){
								var vm = vmList[i];
								if(!vm || typeof vm.provider!=="string" || typeof vm.model!=="string") continue;
								var p = vm.provider;
								if(!vmByProvider[p]) vmByProvider[p] = [];
								vmByProvider[p].push({ id: vm.model, name: (vm.name && vm.name.length>0 ? vm.name : vm.model), description: vm.description || "" });
							}
							for (var p in vmByProvider){
								var found = null;
								for (var gi=0; gi<groups.length; gi++) if(groups[gi].provider===p){ found=groups[gi]; break; }
								if(found){
									var existingIds = {};
									for(var mi=0; mi<found.models.length; mi++) existingIds[found.models[mi].id]=true;
									for(var vi=0; vi<vmByProvider[p].length; vi++){
										var m = vmByProvider[p][vi];
										if(!existingIds[m.id]) found.models.push(m);
									}
								} else {
									groups.push({ provider: p, name: p + " (Vision插件)", models: vmByProvider[p] });
								}
							}
						}
						setGroups(groups);
						setStatus("ready");
						setLoadError(null);
					}).catch(function(error) {
							if (cancelled) return;
							if (withRetry) {
								attempts += 1;
								if (attempts < 6) {
									setStatus("loading");
									setTimeout(function() {
										if (!cancelled) loadModels(true);
									}, 1000);
								} else {
									setStatus("error");
									setLoadError(messageOf(error));
								}
							} else {
								setLoadError(messageOf(error));
							}
						});
				};
				loadRef.current = loadModels;
				loadModels(true);

				// 自动附件转换的临时进度：只存在于输入区，不写入聊天上下文。
				if (typeof sessionId === "string" && sessionId.length > 0 && typeof EventSource === "function") {
					progressStream = new EventSource("/vision-opencode/events?sessionId=" + encodeURIComponent(sessionId));
					progressStream.onmessage = function(event) {
						if (cancelled) return;
						try {
							var next = JSON.parse(event.data);
							if (next === null || typeof next !== "object" || typeof next.state !== "string" || typeof next.text !== "string") return;
							if (clearProgressTimer !== null) clearTimeout(clearProgressTimer);
							setProgress(next);
							if (next.state !== "running") {
								clearProgressTimer = setTimeout(function() {
									if (!cancelled) setProgress(null);
								}, 4500);
							}
						} catch (_error) {}
					};
				}
				return function() {
					cancelled = true;
					if (loadRef.current === loadModels) loadRef.current = null;
					if (clearProgressTimer !== null) clearTimeout(clearProgressTimer);
					if (progressStream !== null) progressStream.close();
				};
			}, [sessionId]);

			// 打开期间：点击外部关闭（官方 ModelSelect 同款 mousedown 判定）
			useEffect(function() {
				if (!open) return;
				var onPointerDown = function(event) {
					var node = rootRef.current;
					if (node !== null && !node.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown);
				return function() {
					document.removeEventListener("mousedown", onPointerDown);
				};
			}, [open]);

			var close = function(restoreFocus) {
				setOpen(false);
				if (restoreFocus === true && triggerRef.current !== null && typeof triggerRef.current.focus === "function") {
					queueMicrotask(function() { triggerRef.current.focus(); });
				}
			};
			var show = function() {
				setOpen(true);
				if (loadRef.current !== null) loadRef.current(false);
			};
			var retryLoad = function() {
				setLoadError(null);
				// 无任何目录时回到加载态，避免重试期间闪现"暂无识图模型"
				if (groups.length === 0) setStatus("loading");
				if (loadRef.current !== null) loadRef.current(true);
			};
			var moveFocus = function(offset) {
				var items = [];
				for (var i = 0; i < itemRefs.current.length; i++) if (itemRefs.current[i] !== null && itemRefs.current[i] !== undefined) items.push(itemRefs.current[i]);
				if (items.length === 0) return;
				var active = -1;
				for (var j = 0; j < items.length; j++) if (items[j] === document.activeElement) { active = j; break; }
				var next = (Math.max(active, 0) + offset + items.length) % items.length;
				if (items[next] !== undefined) items[next].focus();
			};
			var onRootKeyDown = function(event) {
				if (event.key === "Escape" && open) {
					event.preventDefault();
					close(true);
					return;
				}
				if (!open) return;
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					moveFocus(event.key === "ArrowDown" ? 1 : -1);
				}
			};
			var onBlur = function(event) {
				if (event.relatedTarget instanceof Node && rootRef.current !== null && rootRef.current.contains(event.relatedTarget)) return;
				if (open) close(false);
			};

			// 选择失败：用官方 Toast（锚定 composer 卡片顶部居中）提示；
			// 平台缺失 Toast 原语时降级为控制台告警（不打断用户）
			var announceSelectError = function(message) {
				var text = "识图模型切换失败：" + message;
				if (Toast !== null) {
					toastSeq.current += 1;
					setToast({ seq: toastSeq.current, text: text });
				} else if (typeof console !== "undefined" && console.warn !== null) {
					console.warn("dsh-vision-opencode: " + text);
				}
			};

			var pickModel = function(provider, modelId) {
				if (busy) return;
				if (current !== null && current.provider === provider && current.model === modelId) {
					close(true);
					return;
				}
				setBusy(true);
				fetch("/vision-opencode/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: provider, model: modelId })
				})
					.then(function(resp) {
						if (!resp.ok) throw new Error("HTTP " + resp.status);
						return resp.json();
					})
					.then(function(cfg) {
						setBusy(false);
						if (cfg !== null && typeof cfg === "object" && typeof cfg.provider === "string" && typeof cfg.model === "string") {
							setCurrent(cfg);
							close(true);
						} else {
							announceSelectError("配置响应无效");
						}
					})
					.catch(function(error) {
						setBusy(false);
						announceSelectError(error && typeof error.message === "string" && error.message.length > 0 ? error.message : String(error));
					});
			};

			// 识图推理开关：true=开启（提供方默认档位）；false/缺省=关闭思考。
			// 关闭时后端按适配器实际支持的档位名转译（pi-ai 为 off），无需在此纠结各家命名。
			var reasoningOn = current !== null && typeof current === "object" && current.visionReasoning === true;
			var setEffort = function(on) {
				if (current === null || typeof current.provider !== "string" || typeof current.model !== "string") return;
				setBusy(true);
				fetch("/vision-opencode/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: current.provider, model: current.model, visionReasoning: on })
				})
					.then(function(resp) {
						if (!resp.ok) throw new Error("HTTP " + resp.status);
						return resp.json();
					})
					.then(function(cfg) {
						setBusy(false);
						if (cfg !== null && typeof cfg === "object") setCurrent(cfg);
					})
					.catch(function(error) {
						setBusy(false);
						announceSelectError(error && typeof error.message === "string" && error.message.length > 0 ? error.message : String(error));
					});
			};

			// 分节：按供应商分组列出支持图片的模型；
			// 当前配置若不在目录里（如目录加载失败），保留为可见的"当前配置"节
			var sections = [];
			var hasCurrent = false;
			if (current !== null && typeof current.provider === "string" && typeof current.model === "string") {
				for (var g = 0; g < groups.length; g++) {
					var group = groups[g];
					if (group === null || typeof group !== "object") continue;
					var models = Array.isArray(group.models) ? group.models : [];
					for (var m = 0; m < models.length; m++) {
						var model = models[m];
						if (model !== null && typeof model === "object" && model.id === current.model && group.provider === current.provider) { hasCurrent = true; break; }
					}
					if (hasCurrent) break;
				}
				if (!hasCurrent) {
					sections.push({
						provider: current.provider,
						name: "当前配置",
						models: [{ id: current.model, name: current.provider + "/" + current.model }]
					});
				}
			}
			for (var gg = 0; gg < groups.length; gg++) {
				var grp = groups[gg];
				if (grp === null || typeof grp !== "object" || typeof grp.provider !== "string") continue;
				var list = Array.isArray(grp.models) ? grp.models : [];
				if (list.length === 0) continue;
				sections.push({ provider: grp.provider, name: typeof grp.name === "string" ? grp.name : grp.provider, models: list });
			}

			// 触发器文案：当前模型的显示名；无配置时用占位文案
			var currentName = null;
			if (current !== null && typeof current.provider === "string") {
				for (var s = 0; s < sections.length; s++) {
					var sec = sections[s];
					if (sec.provider !== current.provider) continue;
					for (var mm = 0; mm < sec.models.length; mm++) {
						if (sec.models[mm].id === current.model) { currentName = typeof sec.models[mm].name === "string" ? sec.models[mm].name : current.model; break; }
					}
					if (currentName !== null) break;
				}
			}
			var triggerLabel = currentName !== null ? currentName
				: (current !== null ? current.provider + "/" + current.model
				: (status === "loading" ? "识图模型…" : "识图模型"));

			// 官方 itemRef 模式：每次渲染重建引用数组，供方向键导航
			itemRefs.current = [];
			var itemIndex = 0;
			var itemRef = function() {
				var at = itemIndex++;
				return function(node) { itemRefs.current[at] = node; };
			};

			// 图标兜底：官方原语缺失时用同尺寸字形
			var checkMark = function() {
				if (IconCheckOutline16 !== null) return createElement(IconCheckOutline16, null);
				return createElement("span", { "aria-hidden": "true" }, "✓");
			};
			var chevron = createElement(
				"span",
				{ className: "vmo-chevron" + (open ? " vmo-chevron-open" : ""), key: "chevron" },
				IconChevronDownOutline14 !== null ? createElement(IconChevronDownOutline14, null) : "▾"
			);

			// 菜单内容：错误条（含重试）→ 加载态/空态/分组列表
			var menuChildren = [];
			if (loadError !== null) {
				menuChildren.push(createElement("div", { className: "vmo-error", key: "error" },
					createElement("span", null, "模型目录加载失败：" + loadError),
					createElement("button", { type: "button", className: "vmo-retry", onClick: retryLoad }, "重试")));
			}
			if (sections.length === 0 && loadError === null && status === "loading") {
				menuChildren.push(createElement("div", { className: "vmo-status", key: "status" }, "正在加载识图模型…"));
			}
			if (sections.length === 0 && loadError === null && status !== "loading") {
				menuChildren.push(createElement("div", { className: "vmo-empty", key: "empty" }, "暂无识图模型"));
			}
			if (sections.length > 0) {
				var sectionNodes = [];
				for (var si = 0; si < sections.length; si++) {
					var section = sections[si];
					var headingId = menuIdRef.current + "-" + section.provider;
					var rowNodes = [];
					for (var ri = 0; ri < section.models.length; ri++) {
						var row = section.models[ri];
						if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
						var rowName = typeof row.name === "string" ? row.name : row.id;
						var selected = current !== null && current.provider === section.provider && current.model === row.id;
						rowNodes.push(createElement("button", {
							key: row.id,
							ref: itemRef(),
							type: "button",
							role: "menuitemradio",
							"aria-checked": selected,
							className: "vmo-option",
							title: rowName,
							disabled: busy,
							onClick: (function(provider, id) {
								return function() { pickModel(provider, id); };
							})(section.provider, row.id)
						},
							createElement("span", { className: "vmo-option-copy" },
								createElement("span", { className: "vmo-model-name" }, rowName),
								typeof row.description === "string" ? createElement("span", { className: "vmo-description" }, row.description) : null),
							createElement("span", { className: "vmo-check" }, selected ? checkMark() : null)));
					}
					if (rowNodes.length === 0) continue;
					sectionNodes.push(createElement("section", { key: section.provider, role: "group", "aria-labelledby": headingId, className: "vmo-group" },
						createElement("div", { className: "vmo-group-title", id: headingId }, section.name),
						rowNodes));
				}
				menuChildren.push(createElement("div", { className: "vmo-groups", key: "groups" }, sectionNodes));
			}

			// 底部：识图推理开关（开启=提供方默认档位；关闭=禁用思考）。
			// 内联分段控件，无弹出层，不会与上面的模型列表重叠；深浅色跟随 shell 令牌
			menuChildren.push(createElement("div", { key: "effort", className: "vmo-effort" },
				createElement("span", { className: "vmo-effort-label" }, "推理"),
				createElement("div", { className: "vmo-effort-seg", role: "radiogroup", "aria-label": "识图模型推理开关", title: reasoningOn ? "开启：识图时让模型思考（提供方默认档位）" : "关闭：识图不思考，更快更省 token" },
					createElement("button", {
						type: "button",
						role: "radio",
						"aria-checked": reasoningOn,
						disabled: busy,
						className: "vmo-effort-seg-btn" + (reasoningOn ? " is-on" : ""),
						onClick: function() { setEffort(true); }
					}, "开启"),
					createElement("button", {
						type: "button",
						role: "radio",
						"aria-checked": !reasoningOn,
						disabled: busy,
						className: "vmo-effort-seg-btn" + (!reasoningOn ? " is-on" : ""),
						onClick: function() { setEffort(false); }
					}, "关闭"))))

			// 识图进度文案：占位替换触发器的 "Vision" 标记（模型名保留）；
			// 运行中官方 TurnStatus 同款微光扫过（deepseek-500 文字 + deepseek-200 光带），
			// 完成/失败保持绿/红状态色，取消态继承 caption 色
			var progressLabel = "";
			var progressClass = "";
			if (progress !== null) {
				if (progress.state === "running") { progressLabel = "识图中..."; progressClass = "vmo-progress-running"; }
				else if (progress.state === "done") { progressLabel = "识图完成"; progressClass = "vmo-progress-done"; }
				else if (progress.state === "cancelled") { progressLabel = "已取消"; }
				else { progressLabel = "识图失败"; progressClass = "vmo-progress-failed"; }
			}

			return createElement(
				"div",
				{
					className: "vmo-root",
					title: "识图模型：vision_read_image 看图时使用的模型",
					ref: rootRef,
					onKeyDown: onRootKeyDown,
					onBlur: onBlur
				},
				createElement("button", {
					type: "button",
					ref: triggerRef,
					className: "vmo-trigger",
					"aria-label": "识图模型",
					"aria-haspopup": "menu",
					"aria-expanded": open,
					"aria-controls": open ? menuIdRef.current : undefined,
					title: progress !== null ? progress.text : "Vision · " + triggerLabel,
					onClick: function() { if (open) close(); else show(); }
				},
					// 标记槽位：常驻 span，平时显示 "Vision"，识图期间显示进度提示语
					//（模型名保持在右侧标签区不动）
					createElement("span", {
						className: "vmo-trigger-tag" + (progressClass.length > 0 ? " " + progressClass : ""),
						title: progress !== null ? progress.text : undefined
					}, progress !== null ? progressLabel : "Vision"),
					createElement("span", { className: "vmo-trigger-label" }, triggerLabel),
					chevron),
				open ? createElement("div", {
					id: menuIdRef.current,
					className: "vmo-menu",
					role: "menu",
					"aria-label": "识图模型",
					"aria-busy": status === "loading" || busy
				}, menuChildren) : null,
				// 读屏直播区：常驻且只镜像进度文案（空串时不播报），
				// 恢复 "Vision" 不进直播区，避免多余播报
				createElement("span", { className: "vmo-sr-only", "aria-live": "polite" }, progress !== null ? progressLabel : ""),
				toast !== null && Toast !== null ? createElement(Toast, {
					key: toast.seq,
					text: toast.text,
					icon: IconWarningOutline16 !== null ? createElement(IconWarningOutline16, null) : undefined,
					anchor: rootRef.current !== null && typeof rootRef.current.closest === "function" ? (rootRef.current.closest("[data-composer-card]") || null) : null,
					onDone: function() { setToast(null); }
				}) : null
			);
		};

		// ---- 官方模型设置页的 CSS 类名映射（hash 已在工厂顶部运行时探测）----
		// 直接复用官方样式类，Vision 设置页与官方「模型」页视觉完全一致。
		var C = {
			section: cssHash+"section", title: cssHash+"title", intro: cssHash+"intro",
			notice: cssHash+"notice", savedNotice: cssHash+"savedNotice",
			rows: cssHash+"rows", rowCard: cssHash+"rowCard", rowHead: cssHash+"rowHead",
			rowIdentity: cssHash+"rowIdentity", rowName: cssHash+"rowName", rowTag: cssHash+"rowTag",
			credentialDot: cssHash+"credentialDot", credentialDotConfigured: cssHash+"credentialDotConfigured",
			credentialDotMissing: cssHash+"credentialDotMissing", rowActions: cssHash+"rowActions",
			primaryButton: cssHash+"primaryButton", secondaryButton: cssHash+"secondaryButton",
			dangerButton: cssHash+"dangerButton", editor: cssHash+"editor", editorHeader: cssHash+"editorHeader",
			editorTitle: cssHash+"editorTitle", editorRoute: cssHash+"editorRoute",
			field: cssHash+"field", fieldLabel: cssHash+"fieldLabel", linkButton: cssHash+"linkButton",
			advancedHint: cssHash+"advancedHint", editorActions: cssHash+"editorActions",
			addBlock: cssHash+"addBlock", addActions: cssHash+"addActions", addButton: cssHash+"addButton",
			addCard: cssHash+"addCard", customized: cssHash+"customized", customizedSummary: cssHash+"customizedSummary",
			customizedBody: cssHash+"customizedBody", modelCatalog: cssHash+"modelCatalog",
			modelCatalogHeading: cssHash+"modelCatalogHeading", modelCatalogTitle: cssHash+"modelCatalogTitle",
			modelCatalogMeta: cssHash+"modelCatalogMeta", modelList: cssHash+"modelList",
			modelListHead: cssHash+"modelListHead", modelEntry: cssHash+"modelEntry", modelRow: cssHash+"modelRow",
			iconButton: cssHash+"iconButton", iconButtonDanger: cssHash+"iconButtonDanger",
			modelAdvanced: cssHash+"modelAdvanced", modelField: cssHash+"modelField", modelFieldLabel: cssHash+"modelFieldLabel",
			modelEmpty: cssHash+"modelEmpty", addModelButton: cssHash+"addModelButton",
			input: cssHash+"input", selectInput: cssHash+"selectInput", error: cssHash+"error",
			fetchDialog: cssHash+"fetchDialog", candidateList: cssHash+"candidateList",
			candidate: cssHash+"candidate", candidateLabel: cssHash+"candidateLabel", candidateId: cssHash+"candidateId",
		};
		// API 协议清单（后端 /providers 提供；兜底常用值）
		var protocolList = ["openai-completions", "openai-responses", "anthropic", "google-generative-ai", "bedrock-converse", "azure-openai-responses", "openrouter", "github-copilot", "cloudflare", "xai"];
		// 复用官方「获取可用模型」：走 connection.api.llm.discoverModels。
		// modal 为当前表单数据；onCandidates(fresh[]) 拿到可用模型列表后由调用方打开弹窗；
		// showToast 提示；api 为 connection.api。
		var fetchModelsFromProvider = function(modal, onCandidates, showToast, api) {
			if(!api || typeof api.llm!=="object" || typeof api.llm.discoverModels!=="function"){
				showToast("获取模型不可用（缺少 connection.api）");
				return;
			}
			var provider = modal.data.provider || "";
			var baseURL = modal.data.baseUrl || "";
			var requestFormat = modal.data.requestFormat || "";
			var keyDraft = modal.keyDraft || "";
			var probe = { settingsNs: "llm-pi-ai" };
			if(provider) probe.provider = provider;
			if(baseURL) probe.baseURL = baseURL;
			if(requestFormat) probe.api = requestFormat;
			if(keyDraft) probe.apiKey = keyDraft;
			api.llm.discoverModels(probe).then(function(response){
				if(!response || !response.result){
					showToast("获取模型响应无效");
					return;
				}
				if(!response.result.ok){
					showToast(response.result.error && response.result.error.message ? response.result.error.message : "获取模型失败");
					return;
				}
				var found = response.result.value.models;
				if(!Array.isArray(found) || found.length===0){
					showToast("该提供方没有列出任何模型，请手动添加。");
					return;
				}
				var known = Array.isArray(modal.models) ? modal.models.map(function(m){ return m.id; }) : [];
				var fresh = [];
				for(var i=0;i<found.length;i++){
					var c = found[i];
					if(!c || typeof c.id!=="string" || known.indexOf(c.id)>=0) continue;
					var entry = { id: c.id };
					if(typeof c.name==="string" && c.name.length>0) entry.name = c.name;
					fresh.push(entry);
				}
				if(typeof onCandidates==="function") onCandidates(fresh);
			}).catch(function(e){
				showToast(e && e.message ? e.message : String(e));
			});
		};
		// 官方模型页未暴露子插槽；按《AGENTS.md》插件只能注册新的 settings.section
		// 分页，左侧导航与“模型”并列。此为官方推荐做法，完全不依赖 DOM 猜测。
		var VisionSettingsSection = function(props) {
			var injected = props && props.injected ? props.injected : {};
			var api = injected.api || null;
			var protocols = Array.isArray(injected.protocols) ? injected.protocols : [];
			var useState = react.useState;
			var useEffect = react.useEffect;
			var createElement = react.createElement;
			var modelsState = useState([]);
			var models = modelsState[0];
			var setModels = modelsState[1];
			var configState = useState(null);
			var config = configState[0];
			var setConfig = configState[1];
			var loadingState = useState(true);
			var loading = loadingState[0];
			var setLoading = loadingState[1];
			var errState = useState(null);
			var err = errState[0];
			var setErr = errState[1];
			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var modalState = useState(null);
			var modal = modalState[0];
			var setModal = modalState[1];
			var delState = useState(null);
			var delTarget = delState[0];
			var setDelTarget = delState[1];
			var toast2State = useState(null);
			var toast2 = toast2State[0];
			var setToast2 = toast2State[1];
			var pickerState = useState(null);
			var picker = pickerState[0];
			var setPicker = pickerState[1];

			var systemModelsState = useState([]);
			var systemModels = systemModelsState[0];
			var setSystemModels = systemModelsState[1];
			var providersState = useState([]);
			var providers = providersState[0];
			var setProviders = providersState[1];
			var importingState = useState(null);
			var importing = importingState[0];
			var setImporting = importingState[1];
			var expandedState = useState({});
			var expanded = expandedState[0];
			var setExpanded = expandedState[1];
			var dismissedState = useState({});
			var dismissed = dismissedState[0];
			var setDismissed = dismissedState[1];
			var isExpanded = function(p){ return expanded[p] === true; };
			var toggleExpand = function(p){ var n={}; for(var k in expanded) n[k]=expanded[k]; n[p]=!n[p]; setExpanded(n); };
			var fetchAll = function(){
				setLoading(true);
				Promise.all([
					fetch("/vision-opencode/vision-models",{headers:{accept:"application/json"}}).then(function(r){return r.json();}),
					fetch("/vision-opencode/config",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).catch(function(){return null;}),
					fetch("/vision-opencode/models",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).catch(function(){return {systemGroups:[]};}),
					fetch("/vision-opencode/providers",{headers:{accept:"application/json"}}).then(function(r){return r.json();}).catch(function(){return {providers:[]};})
				]).then(function(res){
					var vm = res[0];
					var cfg = res[1];
					var sys = res[2];
					var prov = res[3];
					if(vm && Array.isArray(vm.models)) setModels(vm.models);
					else setModels([]);
					if(cfg) setConfig(cfg);
					// 恢复持久化的「忽略未导入系统模型」列表（× 掉的模型下次打开不再提示）
					if(cfg && Array.isArray(cfg.ignoredModels)){
						var dd = {};
						for(var _di=0; _di<cfg.ignoredModels.length; _di++) dd[cfg.ignoredModels[_di]] = true;
						setDismissed(dd);
					}
					if(prov && Array.isArray(prov.providers)) setProviders(prov.providers);
					else setProviders([]);
					if(prov && Array.isArray(prov.protocols) && prov.protocols.length>0) protocolList = prov.protocols.slice();
					var flat = [];
					if(sys && Array.isArray(sys.systemGroups)){
						for(var gi=0; gi<sys.systemGroups.length; gi++){
							var g=sys.systemGroups[gi];
							if(!g || typeof g.provider!=="string") continue;
							var ms=Array.isArray(g.models)?g.models:[];
							for(var mi=0; mi<ms.length; mi++){
								var m=ms[mi];
								if(!m || typeof m.id!=="string") continue;
								flat.push({provider:g.provider, model:m.id, name: typeof m.name==="string"?m.name:m.id});
							}
						}
					}
					setSystemModels(flat);
					setLoading(false);
					setErr(null);
				}).catch(function(e){
					setErr(e && e.message ? e.message : String(e));
					setLoading(false);
				});
			};
			useEffect(function(){ fetchAll(); }, []);
			useEffect(function(){
				if(toast2===null) return;
				var t=setTimeout(function(){ setToast2(null); },3000);
				return function(){ clearTimeout(t); };
			},[toast2]);

			var showToast = function(text){ setToast2(text); };

			var submitAddOrEdit = function(){
				if(!modal) return;
				var isCustom = modal.data.provider==="custom" || modal.data.providerType==="custom";
				var p = isCustom ? (modal.data.customProvider||"").trim() : (modal.data.provider||"").trim();
				if(isCustom && p.length===0){ showToast("请填写自定义提供方名称"); return; }
				var m = (modal.data.model||"").trim();
				var n = (modal.data.name||"").trim();
				if(n.length===0) n = m;
				var d = (modal.data.description||"").trim();
				// 模型目录：显式 models 数组优先，否则用单个模型字段
				var modelList = Array.isArray(modal.models) && modal.models.length>0 ? modal.models.slice() : (m.length>0 ? [{ id: m }] : []);
				if(modelList.length===0){ showToast("请至少添加一个模型"); return; }
				if(p.length===0){ showToast("提供方为必填"); return; }
				if(isCustom){
					var bu = (modal.data.baseUrl||"").trim();
					if(bu.length===0){ showToast("请填写 API 地址"); return; }
				}
				setBusy(true);
				var isEdit = modal.mode==="edit" || modal.mode==="edit-custom";
				var extra = {};
				if(isCustom){ extra.baseUrl = (modal.data.baseUrl||"").trim(); extra.requestFormat = modal.data.requestFormat||"openai"; }
				// API 密钥：复用官方 credentials 域写入（ref = PROVIDER_API_KEY）
				var keyDraft = modal.keyDraft||"";
				var keyRef = p.toUpperCase().replace(/[^A-Z0-9]+/g,"_")+"_API_KEY";
				var keyWrite = keyDraft.trim().length>0 && api && typeof api.credentials==="object" && typeof api.credentials.set==="function"
					? api.credentials.set({ ref: keyRef, value: keyDraft.trim() }).then(function(r){ return !(r && r.result && r.result.ok); })
					: Promise.resolve(false);
				keyWrite.then(function(keyFailed){
					if(keyFailed){ setBusy(false); showToast("API 密钥保存失败"); return; }
					if(isEdit){
						// 编辑模式：批量更新整个提供方及其所有模型（官方 provider 级编辑语义）。
						// models 里的条目带 _entryId 用于后端区分更新/新增/删除。
						var bodyObj = { provider: p, models: modelList.map(function(mm){ return { id: mm.id, name: mm.name||"", entryId: mm._entryId||"" }; }) };
						if(isCustom){ bodyObj.baseUrl = extra.baseUrl; bodyObj.requestFormat = extra.requestFormat; }
						fetch("/vision-opencode/vision-models",{method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify(bodyObj)})
						.then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
						.then(function(res){
							setBusy(false);
							if(!res.ok){ showToast(res.body.error || ("HTTP "+res.status)); return; }
							setModels(res.body.models || []);
							setPicker(null);
							setModal(null);
							showToast("已更新");
						}).catch(function(e){ setBusy(false); showToast(String(e)); });
					} else {
						// 新增模式：为目录中每个模型创建独立 Vision 条目
						var toCreate = modelList.slice();
						var created = 0;
						var skipped = 0;
						var failed = 0;
						var nextCreate = function(){
						if(toCreate.length===0){
							setBusy(false);
							setPicker(null);
							setModal(null);
							fetchAll();
								if(failed===0) showToast("已添加 "+created+" 个模型"+(skipped>0?"（跳过 "+skipped+" 个重复）":""));
								else showToast("添加完成：成功 "+created+" 个，失败 "+failed+" 个");
								return;
							}
							var entry = toCreate.shift();
							var modelName = typeof entry.name==="string" && entry.name.length>0 ? entry.name : entry.id;
							var bodyObj = { provider:p, model: entry.id, name:modelName, description:d };
							if(isCustom){ bodyObj.baseUrl = extra.baseUrl; bodyObj.requestFormat = extra.requestFormat; }
							fetch("/vision-opencode/vision-models",{method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(bodyObj)})
							.then(function(r){ return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; }); })
							.then(function(res){
								if(res.ok){
									created++;
								} else if(res.status===409){
									skipped++;
								} else {
									failed++;
								}
								nextCreate();
							}).catch(function(e){
								failed++;
								nextCreate();
							});
						};
						nextCreate();
					}
				});
			};

			var doDelete = function(){
				if(!delTarget) return;
				setBusy(true);
				var url = delTarget.providerLevel
					? "/vision-opencode/vision-models?provider="+encodeURIComponent(delTarget.provider)
					: "/vision-opencode/vision-models?id="+encodeURIComponent(delTarget.id);
				fetch(url,{method:"DELETE"})
				.then(function(r){ return r.json().then(function(j){ return {ok:r.ok,body:j}; }); })
				.then(function(res){
					setBusy(false);
					if(!res.ok){ showToast(res.body.error||"删除失败"); return; }
					setModels(res.body.models||[]);
					setDelTarget(null);
					showToast("已删除");
				}).catch(function(e){ setBusy(false); showToast(String(e)); });
			};

			var selectAsCurrent = function(vm){
				if(busy || !vm) return;
				setBusy(true);
				fetch("/vision-opencode/config",{method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({provider: vm.provider, model: vm.model})})
				.then(function(r){ return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; }); })
				.then(function(res){
					setBusy(false);
					if(!res.ok){ showToast(res.body.error || ("设置失败 HTTP "+res.status)); return; }
					setConfig(res.body);
					showToast("已设为当前 Vision 模型："+vm.provider+"/"+vm.model);
				}).catch(function(e){ setBusy(false); showToast(String(e)); });
			};

			var isSelected = function(vm){
				return config && config.provider===vm.provider && config.model===vm.model;
			};

			// 每模型：提供方申报的推理档位（懒加载缓存）
			// 去重依据改为「持久 ref 同步锁」而不是状态实时值：
			// 状态一写入就会引发渲染 → effect 若依赖状态就会再次触发 → 死循环刷新风暴。
			var useRef = react.useRef;
			var reasonInfoState = useState({});
			var reasonInfo = reasonInfoState[0];
			var setReasonInfo = reasonInfoState[1];
			var reasonLoadingState = useState({});
			var reasonLoading = reasonLoadingState[0];
			var setReasonLoading = reasonLoadingState[1];
			var reasonSeenState = useRef({});
			var reasonSeen = reasonSeenState.current;
			var ensureReasonInfo = function(vm){
				if(!vm) return;
				var k = vm.provider+"/"+vm.model;
				if(reasonSeen[k]) return;   // 同步持久锁：第一个请求到来前就已锁定，后续任何调用直接短路
				reasonSeen[k] = true;
				var nl = {}; for(var i in reasonLoading) nl[i]=reasonLoading[i]; nl[k]=true; setReasonLoading(nl);
				fetch("/vision-opencode/reasoning-levels?provider="+encodeURIComponent(vm.provider)+"&model="+encodeURIComponent(vm.model), {headers:{accept:"application/json"}})
					.then(function(r){ return r.json().catch(function(){ return null; }); })
					.then(function(j){
						// 用函数式更新合并，而不是从闭包快照复制：
						// 多个模型并发完成时，基于 React 保证的最新 prev 合并，互不覆盖
						setReasonInfo(function(prev){
							var n = {}; for(var x in prev) n[x]=prev[x];
							var eff = (j && Array.isArray(j.efforts)) ? j.efforts : [];
							// offSupported 三态：布尔=host 真值；其他(旧 host/未知)=按 efforts 兜底
							var os = (j && typeof j.offSupported === 'boolean')
								? j.offSupported
								: (eff.some(function(e){ var id=typeof e==="string"?e:((e&&e.id)||""); return id==="off"; }));
							n[k]={ efforts: eff, offSupported: os };
							return n;
						});
						setReasonLoading(function(prev){
							var n2 = {}; for(var y in prev) n2[y]=prev[y]; delete n2[k]; return n2;
						});
					}).catch(function(){
						setReasonInfo(function(prev){
							var n = {}; for(var x in prev) n[x]=prev[x]; n[k]={ efforts:[], offSupported:true }; return n;
						});
						setReasonLoading(function(prev){
							var n2 = {}; for(var y in prev) n2[y]=prev[y]; delete n2[k]; return n2;
						});
					});
			};
			// 每模型：保存推理策略
			var updateReasoning = function(vm, value){
				if(busy || !vm) return;
				setBusy(true);
				fetch("/vision-opencode/vision-models", {method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({id: vm.id, provider: vm.provider, model: vm.model, name: vm.name||"", description: vm.description||"", baseUrl: vm.baseUrl||"", requestFormat: vm.requestFormat||"openai", reasoning: value})})
					.then(function(r){ return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; }); })
					.then(function(res){
						setBusy(false);
						if(!res.ok){ showToast(res.body.error || ("保存失败 HTTP "+res.status)); return; }
						setModels(res.body.models || []);
						var label = value==="" ? "已设为默认（跟随提供方）" : value==="off" ? "已关闭思考（提供方支持时生效）" : "已设为强制关闭（实验，不保证成功）";
						showToast(label);
					}).catch(function(e){ setBusy(false); showToast(String(e)); });
			};

			// 每模型推理策略行：显示提供方申报的档位；有「关闭」档才提供关闭，
			// 否则提供「强制关闭」（实验，不保证成功）
			var buildReasonRow = function(vm){
				var rkey = vm.provider+"/"+vm.model;
				var rinfo = reasonInfo[rkey] || null;
				// 自 host 侧读取：offSupported 已是「真申报」后的结果（pi-ai 面值里的 off
				// 只是省略参数=厂商默认，不算能关）。旧 host 没返回该字段时按 efforts 兜底。
				var offOk = rinfo
					? (typeof rinfo.offSupported === "boolean" ? rinfo.offSupported
						: (Array.isArray(rinfo.efforts) && rinfo.efforts.some(function(e){
							var id = typeof e === "string" ? e : (e && e.id) || "";
							return id === "off";
						})))
					: true;
				var cur = vm.reasoning || "";
				var opts = offOk ? [["","默认"],["off","关闭"]] : [["","默认"],["forceOff","强制关闭"]];
				var hint;
				if(!rinfo){
					hint = "读取能力…";
				} else if(rinfo.efforts && rinfo.efforts.length > 0){
					var effStr = rinfo.efforts.map(function(e){ return typeof e==="string" ? e : String((e && e.id) || ""); }).filter(Boolean).join(", ");
					hint = "提供方档位："+effStr;
				} else {
					hint = "未申报档位";
				}
				if(hint !== "读取能力…" && !offOk) hint += " · 无「关闭」档，仅能尝试";
				if(cur === "forceOff") hint += " · 不保证成功";
				return createElement("div",{className:"vmo-settings-reason-row"},
					createElement("span",{className:"vmo-settings-reason-label"},"推理"),
					createElement("div",{className:"vmo-effort-seg", role:"radiogroup", "aria-label":"推理策略"},
						opts.map(function(o){
							var sel = cur === o[0];
							return createElement("button",{key:o[0], type:"button", role:"radio", "aria-checked":sel, disabled: busy, className:"vmo-effort-seg-btn"+(sel?" is-on":""), onClick:(function(v,val){ return function(){ updateReasoning(v, val); }; })(vm, o[0])}, o[1]);
						})
					),
					createElement("div",{className:"vmo-settings-reason-hint"}, hint)
				);
			};
			// 一次性为所有未读取能力的模型调度请求。
			// effect 只依赖 [models, loading, err] —— 绝不依赖它自己写入的
			// reasonInfo/reasonLoading，否则 setState → 渲染 → effect 重触发 → 死循环。
			// 去重交给 reasonSeen（ref 同步锁），因此这里也无需 setTimeout。
			useEffect(function(){
				if(loading || err) return;
				if(!Array.isArray(models) || models.length===0) return;
				for(var i=0;i<models.length;i++){
					var vm = models[i];
					if(!vm) continue;
					ensureReasonInfo(vm);
				}
			}, [models, loading, err]);

			var header = createElement("div",{className:"vmo-settings-head", style:{marginBottom:"0"} },
				createElement("h3",{className:"vmo-settings-title"},"Vision 模型"),
				createElement("span",{style:{marginLeft:"8px",fontSize:"12px",color:"var(--dsw-alias-label-tertiary)"}}, "插件自管 · 与上方提供方独立")
			);
			var intro = createElement("p",{className:C.intro}, "填入各提供方的 API 密钥即可使用其模型。");

			var isInPlugin = function(provider, model){
				for(var _i=0; _i<models.length; _i++) if(models[_i].provider===provider && models[_i].model===model) return true;
				return false;
			};
			var systemOnly = [];
			for(var _j=0; _j<systemModels.length; _j++){
				var _sm = systemModels[_j];
				if(dismissed[_sm.provider+"/"+_sm.model]) continue;
				if(!isInPlugin(_sm.provider, _sm.model)) systemOnly.push(_sm);
			}
			var importAll = function(){
				if(systemOnly.length===0 || busy) return;
				setBusy(true);
				var pending = systemOnly.slice();
				var okCount = 0;
				var next = function(){
					if(pending.length===0){
						setBusy(false);
						fetchAll();
						showToast("已导入 "+okCount+" 个模型");
						return;
					}
					var cur = pending.shift();
					fetch("/vision-opencode/vision-models",{method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({provider: cur.provider, model: cur.model, name: cur.name})})
					.then(function(r){ return r.json().then(function(j){ return {ok:r.ok, body:j}; }); })
					.then(function(res){
						if(res.ok) okCount++;
						next();
					}).catch(function(){ next(); });
				};
				next();
			};
			var importOne = function(entry){
				if(busy || isInPlugin(entry.provider, entry.model)) return;
				setImporting(entry.provider+"/"+entry.model);
				setBusy(true);
				fetch("/vision-opencode/vision-models",{method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({provider: entry.provider, model: entry.model, name: entry.name})})
				.then(function(r){ return r.json().then(function(j){ return {ok:r.ok, body:j}; }); })
				.then(function(res){
					setBusy(false); setImporting(null);
					if(!res.ok){ showToast(res.body.error||"导入失败"); return; }
					setModels(res.body.models||[]);
					showToast("已导入 "+entry.provider+"/"+entry.model);
				}).catch(function(e){ setBusy(false); setImporting(null); showToast(String(e)); });
			};
			var rowsEl;
			if(loading){
				rowsEl = createElement("div",{className:C.modelEmpty},"加载中…");
			} else if(err){
				rowsEl = createElement("div",{className:C.error}, "加载失败："+err+" ", createElement("button",{className:C.linkButton, onClick:fetchAll},"重试"));
			} else if(models.length===0){
				var emptyChildren = [createElement("div",{className:C.modelEmpty},"暂无 Vision 模型。已在系统模型中检测到 "+systemOnly.length+" 个可用模型，可一键导入。")];
				if(systemOnly.length>0){
					emptyChildren.push(createElement("button",{type:"button", className:C.addButton, style:{marginTop:"8px"}, disabled:busy, onClick: importAll}, "一键导入全部 ("+systemOnly.length+")"));
				}
				rowsEl = createElement.apply(null, ["div", null].concat(emptyChildren));
				} else {
					// 按供应商分组折叠（分组头大字号，点击展开/收起）
					var grouped = {};
					for(var i=0;i<models.length;i++){
						var _vm = models[i];
						var _p = _vm.provider || "unknown";
						if(!grouped[_p]) grouped[_p] = [];
						grouped[_p].push(_vm);
					}
					var groupKeys = Object.keys(grouped).sort();
					// 编辑整个提供方（及其所有模型）：官方模型页是 provider 级编辑，
					// 打开编辑器时把该提供方全部模型放进 modal.models（带 _entryId 供批量保存）。
					var openEditProvider = function(gProvider, gModels){
						var first = gModels[0] || {};
						var isCustomEdit = true;
						for(var _pp4=0; _pp4<providers.length; _pp4++){ if(providers[_pp4] && providers[_pp4].provider===gProvider){ isCustomEdit = false; break; } }
						setModal({
							mode: isCustomEdit ? "edit-custom" : "edit",
							data: {
								id: first.id||"",
								provider: isCustomEdit ? "custom" : gProvider,
								customProvider: isCustomEdit ? gProvider : "",
								model: first.model||"",
								name: first.name||"",
								description: first.description||"",
								baseUrl: first.baseUrl||"",
								requestFormat: first.requestFormat||"openai-completions",
								providerType: isCustomEdit ? "custom" : gProvider
							},
							models: gModels.map(function(mm){ return { id: mm.model, name: mm.name||"", _entryId: mm.id }; })
						});
					};
					var groupSections = [];
					for(var gi=0; gi<groupKeys.length; gi++){
						var gProvider = groupKeys[gi];
						var gModels = grouped[gProvider];
						var gItems = [];
						for(var mi=0; mi<gModels.length; mi++){
							var vm = gModels[mi];
							var dotCls = isSelected(vm) ? C.credentialDot + " " + C.credentialDotConfigured : C.credentialDot + " " + C.credentialDotMissing;
							var tag = vm.provider;
							gItems.push(createElement("li",{key:vm.id, className:C.rowCard},
							createElement("div",{className:C.rowHead},
								createElement("div",{className:C.rowIdentity},
									createElement("span",{className:dotCls, title: isSelected(vm) ? "当前选中" : "未选中"}),
									createElement("span",{className:C.rowName, title: vm.name || vm.model}, vm.name && vm.name.length>0 ? vm.name : vm.model),
									createElement("span",{className:C.rowTag}, tag)
								),
								createElement("div",{className:C.rowActions},
									isSelected(vm)
										? createElement("button",{type:"button", className:C.secondaryButton, disabled:true, style:{opacity:0.6,cursor:"default"}}, IconCheckOutline16 ? createElement(IconCheckOutline16,{size:12}) : null, "当前")
										: createElement("button",{type:"button", className:C.secondaryButton, disabled:busy, style:{borderColor:"var(--dsw-alias-state-success-primary)",color:"var(--dsw-alias-state-success-primary)"}, onClick:(function(v){return function(){ selectAsCurrent(v); };})(vm)}, "设为当前"),
									createElement("button",{type:"button", className:C.secondaryButton + " " + C.dangerButton, disabled:busy, onClick:(function(v){return function(){ setDelTarget(v); };})(vm)}, IconTrashOutline16 ? createElement(IconTrashOutline16,{size:12}) : null, "删除")
								)
							),
							createElement("div",{className:C.modelCatalogMeta},
								createElement("span",{style:{marginRight:"12px"}}, vm.provider+"/"+vm.model),
								vm.description ? createElement("span",null, vm.description) : null,
								isSelected(vm) ? createElement("span",{style:{marginLeft:"8px",color:"var(--dsw-alias-state-success-primary)"}}, "· 当前选中") : null
							),
						buildReasonRow(vm)
					));
				}
				var _open = isExpanded(gProvider);
				groupSections.push(createElement("section",{key:gProvider, className:"vmo-provider-group" + (_open ? " vmo-provider-groupOpen":""), style:{display:"flex",flexDirection:"column",gap:"8px"}},
					createElement("div",{className:"vmo-provider-head-row"},
						createElement("button",{type:"button", className:"vmo-provider-head", "aria-expanded": _open, onClick:(function(p){ return function(){ toggleExpand(p); }; })(gProvider)},
							createElement("span",{className:"vmo-provider-chevron"}, IconChevronDownOutline14 ? createElement(IconChevronDownOutline14,{size:12}) : "›"),
							createElement("span",{className:"vmo-provider-name"}, gProvider),
							// 「自定义」只标非官方渠道：official（pi-ai builtin 目录，含 opencode-go/deepseek）
							// 之外的渠道（如 winterapi）显示「自定义」。
							!providers.some(function(p){ return p && p.provider===gProvider && p.official; })
								? createElement("span",{className:"vmo-provider-custom-tag"}, "自定义")
								: null,
							createElement("span",{className:"vmo-provider-count"}, gModels.length + " 个模型")
						),
						createElement("button",{type:"button", className:"vmo-provider-head-edit", title:"编辑提供方及其所有模型", disabled:busy, onClick:(function(p, gms){ return function(){ openEditProvider(p, gms); }; })(gProvider, gModels)}, IconEditOutline16 ? createElement(IconEditOutline16,{size:12}) : null, " 编辑"),
						createElement("button",{type:"button", className:"vmo-provider-head-edit vmo-provider-head-del", title:"删除提供方及其所有模型", disabled:busy, onClick:(function(p, gms){ return function(){ setDelTarget({ provider: p, model: "", providerLevel: true, modelCount: gms.length }); }; })(gProvider, gModels)}, IconTrashOutline16 ? createElement(IconTrashOutline16,{size:12}) : null, " 删除")
					),
					_open ? createElement("ul",{className:C.rows, style:{marginTop:"0"}}, gItems) : null
				));
					}
					rowsEl = createElement("div",{style:{display:"flex",flexDirection:"column",gap:"16px"}}, groupSections);
				}

			var systemHint = null;
			if(!loading && !err && systemOnly.length>0){
				systemHint = createElement("div",{style:{display:"flex",flexDirection:"column",gap:"8px",marginBottom:"8px",padding:"10px 12px",border:"1px dashed var(--dsw-alias-border-l3)",borderRadius:"12px"}},
					createElement("div",{style:{fontSize:"13px",color:"var(--dsw-alias-label-secondary)"}}, "检测到 "+systemOnly.length+" 个未导入的系统模型"),
					createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:"6px"}},
						systemOnly.map(function(e){
							var key=e.provider+"/"+e.model;
							var isImp = importing===key;
							return createElement("span",{key:key, style:{display:"inline-flex",gap:"4px",alignItems:"center"}},
							createElement("button",{type:"button", className:C.linkButton, disabled:busy, onClick:(function(entry){ return function(){ importOne(entry); }; })(e)}, isImp?"导入中…": key),
							createElement("button",{type:"button", className:C.linkButton, disabled:busy, onClick:(function(k){ return function(){
								var d={}; for(var kk in dismissed) d[kk]=dismissed[kk]; d[k]=true; setDismissed(d);
								// 持久化忽略列表：下次打开设置页不再提示该模型未导入
								fetch("/vision-opencode/config",{method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({ ignoredModels: Object.keys(d).filter(function(_x){ return d[_x]; }) })}).catch(function(){});
							}; })(key)}, "×")
						);
						})
					),
					createElement("button",{type:"button", className:C.secondaryButton, style:{alignSelf:"flex-start"}, disabled:busy, onClick: importAll}, "一键导入全部 ("+systemOnly.length+")")
				);
			}
			var editorContent = null;
			var footer = null;
			if(modal){
				var isEdit = modal.mode==="edit" || modal.mode==="edit-custom";
				var isCustomMode = modal.data.providerType==="custom";
				var modalTitle = modal.mode==="custom" ? "自定义提供方" : (isEdit ? "编辑 Vision 模型" : "添加提供方");
				var modalDesc = modal.mode==="custom" ? "新增自定义提供方（Provider ID / API 地址 / 模型）" : (isEdit ? "更新提供方/模型" : "从官方提供方目录选择后填入模型");
				var updateField = function(key, val){
					var nd = {};
					for(var k in modal.data) nd[k]=modal.data[k];
					nd[key]=val;
					setModal({mode: modal.mode, data: nd});
				};
				// 模型目录（modal.models 顶层数组）专用更新：渲染读取的是顶层 modal.models，
				// 不能用 updateField（那只写 modal.data.models，列表不会刷新）。
				var setModelsField = function(list){
					var nd = {};
					for(var k in modal.data) nd[k]=modal.data[k];
					setModal({mode: modal.mode, data: nd, models: list});
				};
				var selProvider = isCustomMode ? "" : (modal.data.provider||"");
				var isBuiltinProvider = false;
				for(var _pi4=0; _pi4<providers.length; _pi4++){ if(providers[_pi4] && providers[_pi4].provider===selProvider && providers[_pi4].source==="builtin"){ isBuiltinProvider = true; break; } }
				// 官方卡片式表单（复用 zGbnIq_* 样式）
				var editorChildren = [];
				// 卡片标题（模态标题）：添加提供方 / 编辑 Vision 模型 / 自定义提供方
				editorChildren.unshift(createElement("div",{className:C.editorHeader},
					createElement("span",{className:C.editorTitle}, modalTitle)
				));
				// API 密钥（复用官方 credentials 域）。
				// 位置按模式区分：官方内置供应商跟在提供方 select 之后（主体），
				// 自定义提供方放在 API 协议下方（见 isCustomMode 分支）。
				// placeholder 按模式区分：custom 不支持环境认证，只提示输入密钥。
				var makeKeyField = function(placeholder){
					return createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"API 密钥"),
						createElement("input",{className:C.input, type:"password", autoComplete:"off", value: modal.keyDraft||"", placeholder: placeholder||"输入 API 密钥，或留空使用环境认证", "aria-label":"API 密钥", onChange:function(e){ updateField("keyDraft", e.target.value); }})
					);
				};
				if(!isCustomMode){
					editorChildren.push(createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"提供方"),
						createElement("select",{className:C.input + " " + C.selectInput, value: selProvider, "aria-label":"提供方", onChange:function(e){ updateField("provider", e.target.value); }},
							(function(){
								var seen={}; var opts=[];
								// 只列官方内置供应商（source==="builtin"），不含 winterapi 等自定义路由
								var all = providers.slice();
								for(var _pi5=0; _pi5<all.length; _pi5++){
									var _pp5=all[_pi5];
									if(!_pp5 || typeof _pp5.provider!=="string" || _pp5.source!=="builtin") continue;
									if(seen[_pp5.provider]) continue;
									seen[_pp5.provider]=true;
									opts.push(createElement("option",{value:_pp5.provider}, _pp5.provider));
								}
								if(!seen[selProvider] && selProvider.length>0) opts.push(createElement("option",{value:selProvider}, selProvider));
								return opts;
							})()
						)
					));
					editorChildren.push(makeKeyField());
				}
				// （API 密钥字段由 makeKeyField 生成，按模式分别 push：见两个分支）
				// 自定义提供方：Provider ID / 显示名 / API 地址 / API 协议
				// 模型目录：标题行（左）+ 获取可用模型（右）+ 列表 + 添加模型。
				// 构建先于 provider 分支：自定义提供方直接展示在主体，
				// 官方内置供应商收进「自定义设置」折叠区。
				var modelRows = Array.isArray(modal.models) ? modal.models.slice() : (modal.data.model && modal.data.model.length>0 ? [{id: modal.data.model, name: modal.data.name||""}] : []);
				var catalogChildren = [
					createElement("div",{className:C.modelListHead},
						createElement("div",{className:C.modelCatalogHeading},
							createElement("span",{className:C.modelCatalogTitle},"模型目录"),
							createElement("span",{className:C.modelCatalogMeta}, modelRows.length===0 ? "正在使用适配器默认模型" : (modelRows.length+" 个模型"))
						),
						// 新增自定义提供方：未填写 API 地址或 API 密钥时不可获取模型（不依赖环境认证）；
						// 编辑已有自定义提供方时凭据已存在，不限制
						createElement("button",{type:"button", className:C.linkButton, disabled:busy||!!picker||(modal.mode==="custom" && (!modal.data.baseUrl || !modal.keyDraft)), title:(modal.mode==="custom" && (!modal.data.baseUrl || !modal.keyDraft)) ? "请先填写 API 地址和 API 密钥" : undefined, onClick:function(){
							if(typeof fetchModelsFromProvider!=="function"){ showToast("获取模型不可用"); return; }
							setPicker({candidates:[], selected:new Set(), busy:true});
							fetchModelsFromProvider(modal, function(fresh){
								// 只勾选已在模型目录里的模型（不再默认全选）；
								// 其余候选保持未勾选，由用户主动勾选或使用下方「全选」。
								var exist = {};
								var ml = Array.isArray(modal.models) ? modal.models : [];
								for(var _li=0;_li<ml.length;_li++){ var _mm=ml[_li]; if(_mm && typeof _mm.id==="string") exist[_mm.id]=true; }
								var sel = new Set();
								for(var _fi=0;_fi<fresh.length;_fi++){ if(exist[fresh[_fi].id]) sel.add(fresh[_fi].id); }
								setPicker({candidates:fresh, selected:sel, busy:false});
							}, showToast, api);
						}}, busy||!!picker ? "获取中…" : "获取可用模型")
					)
				];
				// 模型行内编辑辅助：改/删 modal.models 第 idx 行
				var updateRow = function(idx, key, val){
					var list = Array.isArray(modal.models) ? modal.models.slice() : [];
					if(idx>=0 && idx<list.length){
						var nextRow = {};
						for(var _rk in list[idx]) nextRow[_rk] = list[idx][_rk];
						nextRow[key] = val;
						list[idx] = nextRow;
					}
					setModelsField(list);
				};
				var removeRow = function(idx){
					var list = Array.isArray(modal.models) ? modal.models.slice() : [];
					list.splice(idx, 1);
					setModelsField(list);
				};
				if(modelRows.length===0){
					catalogChildren.push(createElement("div",{className:C.modelEmpty}, "尚未添加模型；点击下方「添加模型」新增一行并填写模型 ID。"));
				} else {
					catalogChildren.push(createElement("div",{className:C.modelList},
						modelRows.map(function(mrow, mi){
							return createElement("div",{key:(mrow.id||"new-")+mi, className:C.modelEntry},
								createElement("div",{className:C.modelRow},
									createElement("input",{className:C.input, type:"text", value: mrow.id||"", placeholder:"模型 ID", "aria-label":"模型 ID "+(mi+1), onChange:(function(i){ return function(e){ updateRow(i,"id",e.target.value); }; })(mi)}),
									createElement("input",{className:C.input, type:"text", value: mrow.name||"", placeholder:"显示名称（可选）", "aria-label":"显示名称 "+(mi+1), onChange:(function(i){ return function(e){ updateRow(i,"name",e.target.value); }; })(mi)}),
									createElement("button",{type:"button", className:C.iconButton+" "+C.iconButtonDanger, "aria-label":"删除模型 "+(mi+1), title:"删除", onClick:(function(i){ return function(){ removeRow(i); }; })(mi)}, IconTrashOutline16 ? createElement(IconTrashOutline16,{size:14}) : "×")
								)
							);
						})
					));
				}
				catalogChildren.push(createElement("button",{type:"button", className:C.addModelButton, disabled:busy, onClick:function(){
					var list = Array.isArray(modal.models) ? modal.models.slice() : [];
					list.push({ id:"", name:"" });
					setModelsField(list);
				}}, IconPlusOutline16 ? createElement(IconPlusOutline16,{size:14}) : null, " 添加模型"));
				// 自定义提供方：Provider ID / 显示名 / API 地址 / API 协议 + 模型目录直接展示在主体
				if(isCustomMode){
					editorChildren.push(createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"Provider ID"),
						createElement("input",{className:C.input, type:"text", value: modal.data.customProvider||"", placeholder:"acme-gateway", "aria-label":"Provider ID", onChange:function(e){ updateField("customProvider", e.target.value); }}),
						createElement("p",{className:C.advancedHint}, "以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。")
					));
					editorChildren.push(createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"显示名称"),
						createElement("input",{className:C.input, type:"text", value: modal.data.name||"", placeholder:"显示名称", "aria-label":"显示名称", onChange:function(e){ updateField("name", e.target.value); }})
					));
					editorChildren.push(createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"API 地址"),
						createElement("input",{className:C.input, type:"text", value: modal.data.baseUrl||"", placeholder:"https://gateway.example/v1", "aria-label":"API 地址", onChange:function(e){ updateField("baseUrl", e.target.value); }})
					));
					editorChildren.push(createElement("div",{className:C.field},
						createElement("span",{className:C.fieldLabel},"API 协议"),
						// openai 系包含 completions / responses 两种；value 直接存协议名（后端归一化存储），
						// 旧配置里的 'openai' 归一化为 openai-completions 显示。
						createElement("select",{className:C.input + " " + C.selectInput, value: (function(){ var f=modal.data.requestFormat; return f==="anthropic"?"anthropic":(f==="openai-responses"?"openai-responses":"openai-completions"); })(), "aria-label":"API 协议", onChange:function(e){ updateField("requestFormat", e.target.value); }},
							(function(){
								var opts=[];
								var protos = ["openai-completions", "openai-responses", "anthropic"];
								for(var _pi6=0; _pi6<protos.length; _pi6++){
									var _pr=protos[_pi6];
									if(typeof _pr!=="string"||_pr.length===0) continue;
									opts.push(createElement("option",{value:_pr}, _pr));
								}
								return opts;
							})()
						)
					));
					editorChildren.push(makeKeyField("输入 API 密钥"));
					editorChildren.push(createElement("div",{className:C.modelCatalog}, catalogChildren));
					} else {
						// 官方内置供应商：API 地址、模型目录、获取可用模型、模型 ID
						// 全部收进「自定义设置」折叠区（默认收起，key 强制重挂载）
						editorChildren.push(createElement("details",{key:"customized-"+modal.mode, className:C.customized},
							createElement("summary",{className:C.customizedSummary},"自定义设置"),
							createElement("div",{className:C.customizedBody},
								createElement("div",{className:C.field},
									createElement("span",{className:C.fieldLabel},"API 地址"),
									createElement("input",{className:C.input, type:"text", value: modal.data.baseUrl||"", placeholder:"留空使用提供方默认", "aria-label":"API 地址", onChange:function(e){ updateField("baseUrl", e.target.value); }})
								),
								createElement("div",{className:C.modelCatalog}, catalogChildren)
							)
						));
					}

				var content = createElement("div",{className:C.editor}, editorChildren);
				// 必要字段校验（与 submitAddOrEdit 的提交校验一致）：
				// - 至少一个「模型 ID」非空的模型行；
				// - 新增自定义提供方额外要求 Provider ID、API 地址、API 密钥非空
				//   （编辑已有自定义提供方时凭据已存在，不要求重填密钥）。
				var hasValidModel = (Array.isArray(modal.models) ? modal.models : []).some(function(_mm){ return _mm && typeof _mm.id==="string" && _mm.id.trim().length>0; });
				var canSubmit = hasValidModel && (modal.mode==="custom"
					? (modal.data.customProvider||"").trim().length>0 && (modal.data.baseUrl||"").trim().length>0 && (modal.keyDraft||"").trim().length>0
					: true);
				var footer = createElement("div",{className:C.editorActions},
					createElement("button",{type:"button", className:C.secondaryButton, onClick:function(){ setPicker(null); setModal(null); }}, "取消"),
					createElement("button",{type:"button", className:C.primaryButton, disabled:busy||!canSubmit, title:!canSubmit ? (modal.mode==="custom" ? "请先填写 Provider ID、API 地址、API 密钥，并至少填写一个模型 ID" : "请至少填写一个模型 ID") : undefined, onClick:submitAddOrEdit}, busy ? "保存中…" : (isCustomMode ? "创建提供方" : "保存"))
				);
				editorContent = content;
			}
			var addBlock = modal
				? createElement("div",{className:C.addBlock},
					createElement("div",{className:C.addCard},
						editorContent,
						footer
					)
				)
				: createElement("div",{className:C.addActions},
					createElement("button",{type:"button", className:C.addButton, disabled:busy, onClick:function(){
						var firstProvider = "";
						for(var _pi3=0; _pi3<providers.length; _pi3++){
							if(providers[_pi3] && typeof providers[_pi3].provider==="string" && providers[_pi3].provider.length>0 && providers[_pi3].source!=="registered"){ firstProvider = providers[_pi3].provider; break; }
						}
						if(firstProvider.length===0) firstProvider = "opencode-go";
						setModal({mode:"add", data:{id:"",provider:firstProvider,providerType:firstProvider,customProvider:"",model:"",name:"",description:"",baseUrl:"",requestFormat:"openai"}});
					}}, IconPlusOutline16 ? createElement(IconPlusOutline16,{size:14}) : null, " 添加提供方"),
					createElement("button",{type:"button", className:C.addButton, disabled:busy, onClick:function(){ setModal({mode:"custom", data:{id:"",provider:"custom",providerType:"custom",customProvider:"",model:"",name:"",description:"",baseUrl:"",requestFormat:"openai"}}); }}, IconPlusOutline16 ? createElement(IconPlusOutline16,{size:14}) : null, " 添加自定义提供方")
				);

			var delEl = null;
			if(delTarget){
				var delContent = delTarget.providerLevel
					? createElement("div",{style:{fontSize:"14px",lineHeight:"22px",color:"var(--dsw-alias-label-secondary)"}}, "确定删除提供方 ", createElement("b",{style:{color:"var(--dsw-alias-label-primary)"}}, delTarget.provider), " 及其 ", createElement("b",{style:{color:"var(--dsw-alias-label-primary)"}}, delTarget.modelCount), " 个模型吗？此操作会从 setting.yaml 移除，无法撤销。")
					: createElement("div",{style:{fontSize:"14px",lineHeight:"22px",color:"var(--dsw-alias-label-secondary)"}}, "确定删除 ", createElement("b",{style:{color:"var(--dsw-alias-label-primary)"}}, delTarget.provider+"/"+delTarget.model), " 吗？此操作会从 setting.yaml 移除，无法撤销。");
				var delFooter = createElement("div",{className:"vmo-modal-actions"},
					createElement("button",{type:"button", className:"vmo-btn-secondary", onClick:function(){ setDelTarget(null); }}, "取消"),
					createElement("button",{type:"button", className:"vmo-btn-primary", style:{background:"var(--dsw-alias-state-error-primary)"}, disabled:busy, onClick:doDelete}, busy?"删除中…":"删除")
				);
				if(Modal){
					delEl = createElement(Modal,{open:true, onClose:function(){ setDelTarget(null); }, title:"删除 Vision 模型", closeLabel:"关闭", description:"确认删除", footer:delFooter}, delContent);
				} else {
					delEl = createElement("div",{className:"vmo-modal-overlay", onClick:function(e){ if(e.target===e.currentTarget) setDelTarget(null); }},
						createElement("div",{className:"vmo-modal"},
							createElement("h4",{className:"vmo-modal-title"},"删除 Vision 模型"),
							delContent,
							delFooter
						)
					);
				}
			}

			// 模型选择弹窗：纯 vmo-picker-* 自渲染 CSS，不依赖任何 DSH CSS Module hash 类名
				// （fetchModal 同源），视觉与官方「模型」页获取可用模型弹窗完全一致：
				// 左侧独立 checkbox、右对齐区滚动列表、底部官方按钮组。
				// 容器走 Modal 原语；不可用时回退到 vmo-modal-* 兜底，body 仍走官方类。
			var pickerEl = null;
			if(picker){
				var pickerCandidates = Array.isArray(picker.candidates) ? picker.candidates : [];
				var pickerSelected = picker.selected || new Set();
				var closePicker = function(){ setPicker(null); };
				var toggleModel = function(id){
					if(picker.busy) return;
					var next = new Set(pickerSelected);
					if(next.has(id)) next.delete(id); else next.add(id);
					setPicker({candidates:picker.candidates, selected:next, busy:false});
				};
				var addSelected = function(){
					var selectedModels = pickerCandidates.filter(function(c){ return pickerSelected.has(c.id); });
					var list = Array.isArray(modal.models) ? modal.models.slice() : [];
					var existingIds = {};
					for(var li=0; li<list.length; li++) existingIds[list[li].id] = true;
					var added = 0;
					for(var si=0; si<selectedModels.length; si++){
						if(existingIds[selectedModels[si].id]) continue;
						list.push(selectedModels[si]);
						existingIds[selectedModels[si].id] = true;
						added++;
					}
					setModelsField(list);
					setPicker(null);
					showToast("已添加 "+added+" 个模型");
				};
				// 列表 body：扁平 row + 左侧独立 checkbox + 左对齐 model id（跟官方 picker DOM 视觉一致）
				// 全部走 vmo-picker-row* 自渲染 CSS，零 hash 依赖，DSH 升级换 hash 也不影响。
				var pickerBodyChildren;
				if(picker.busy){
					pickerBodyChildren = [createElement("div",{className:"vmo-picker-rows", key:"loading"},
						createElement("div",{className:"vmo-picker-empty"}, "正在获取可用模型…")
					)];
				} else if(pickerCandidates.length===0){
					pickerBodyChildren = [createElement("div",{className:"vmo-picker-rows", key:"empty"},
						createElement("div",{className:"vmo-picker-empty"}, "没有可用的模型")
					)];
				} else {
					pickerBodyChildren = [createElement("div",{className:"vmo-picker-rows", key:"list"}, pickerCandidates.map(function(c){
						var checked = pickerSelected.has(c.id);
						var checkMark = createElement("svg",{width:11, height:11, viewBox:"0 0 12 12", fill:"none", "aria-hidden":"true", style:{display:"block"}},
							createElement("path",{d:"M2 6 L5 9 L10 3", stroke:"currentColor", strokeWidth:"2", strokeLinecap:"round", strokeLinejoin:"round"})
						);
						return createElement("button",{type:"button", key:c.id, className:"vmo-picker-row"+(checked?" vmo-picker-row-checked":""), "aria-pressed":checked, onClick:function(){ toggleModel(c.id); }},
							createElement("span",{className:"vmo-picker-row-box"}, checked ? checkMark : null),
							createElement("span",{className:"vmo-picker-row-id"}, c.id)
						);
					}))];
				}
				var pickerBody = pickerBodyChildren;
				// 全选/取消全选：全部候选已勾选 → 取消全选；否则全选。
				var allChecked = pickerCandidates.length>0 && pickerSelected.size===pickerCandidates.length;
				var toggleAll = function(){
					var next = new Set(pickerSelected);
					if(allChecked){ next.clear(); }
					else { for(var _ti=0;_ti<pickerCandidates.length;_ti++){ next.add(pickerCandidates[_ti].id); } }
					setPicker({candidates:picker.candidates, selected:next, busy:false});
				};
				// footer 按钮也走官方：editorActions + secondaryButton / primaryButton，
					// 与编辑器「添加提供方」dialog 完全一致；保持 picker 与编辑器的 footer 视觉同源。
				var pickerFooter = createElement("div",{className:"vmo-modal-actions"},
					createElement("label",{style:{display:"inline-flex",alignItems:"center",gap:"6px",fontSize:"13px",color:"var(--dsw-alias-label-secondary)",cursor:"pointer",flex:"1 1 auto",marginRight:"auto"}},
						createElement("input",{type:"checkbox", checked:allChecked, disabled:picker.busy||pickerCandidates.length===0, onChange:toggleAll, style:{margin:0,width:"14px",height:"14px",accentColor:"var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-success-primary))"}}),
						createElement("span",null, allChecked ? "取消全选" : "全选")
					),
					createElement("button",{type:"button", className:"vmo-btn-secondary", disabled:picker.busy, onClick:closePicker}, "取消"),
					createElement("button",{type:"button", className:"vmo-btn-primary", disabled:picker.busy||pickerSelected.size===0, onClick:addSelected}, "添加所选")
				);
				if(Modal){
					pickerEl = createElement(Modal,{
						open:true,
						onClose:closePicker,
						title:"选择要添加的模型",
						description:"以下是模型提供方的可用模型，勾选要添加的模型。",
						closeLabel:"关闭",
						footer:pickerFooter
					}, pickerBody);
				} else {
					// 兜底：平台缺失 Modal 时退回到自渲染 overlay（与删除 dialog 同套 vmo-modal-*）
					pickerEl = createElement("div",{className:"vmo-modal-overlay", onClick:function(e){ if(e.target===e.currentTarget) closePicker(); }},
						createElement("div",{className:"vmo-modal", onClick:function(e){ e.stopPropagation(); }},
							createElement("h4",{className:"vmo-modal-title"}, "选择要添加的模型"),
							createElement("p",{style:{margin:0,fontSize:"13px",lineHeight:"20px",color:"var(--dsw-alias-label-secondary)"}}, "以下是模型提供方的可用模型，勾选要添加的模型。"),
							pickerBody,
							pickerFooter
						)
					);
				}
			}

			var toastEl = toast2 ? createElement("div",{style:{position:"fixed",left:"50%",top:"16px",transform:"translateX(-50%)",background:"var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary,#333))",color:"var(--dsw-alias-label-primary)",border:"1px solid var(--dsw-alias-border-l2)",padding:"8px 12px",borderRadius:"8px",fontSize:"13px",zIndex:10000,boxShadow:"var(--dsw-shadow-lv3)"}}, toast2) : null;

			var sectionChildren = [header, intro];
			if (systemHint !== null) sectionChildren.push(systemHint);
			sectionChildren.push(rowsEl, addBlock);
			if (delEl !== null) sectionChildren.push(delEl);
			if (pickerEl !== null) sectionChildren.push(pickerEl);
			if (toastEl !== null) sectionChildren.push(toastEl);
			return createElement.apply(null, ["section", {className:C.section, "aria-label":"Vision 模型"}].concat(sectionChildren));
		};


			exports.inject = ["slots", "connection"];
			exports.apply = function(ctx) {
				ctx.inject(["slots"], function(scope) {
					var connection = ctx.get("connection");
					scope.slots.inject("conversation.input.right", function() {
						return scope.slots.register({
							name: "conversation.input.right",
							id: "vision-opencode",
							order: 10,
							inject: function(sessionId) {
								return { sessionId: sessionId };
							}
						}, VisionModelSelect);
					});
					scope.slots.inject("settings.section", function() {
						return scope.slots.register({
							name: "settings.section",
							id: "vision",
							order: 11,
							label: function(){ return "Vision 模型"; },
							inject: function() {
								return { injected: { api: connection ? connection.api : null, protocols: protocolList } };
							}
						}, VisionSettingsSection);
					});
				});
			};

			return module.exports;
		}
});
