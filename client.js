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
		var Toast = null;
		try {
			var uiPrimitives = require("@deepseek-ai/dsh-client-ui-primitives");
			IconCheckOutline16 = uiPrimitives.IconCheckOutline16;
			IconChevronDownOutline14 = uiPrimitives.IconChevronDownOutline14;
			IconWarningOutline16 = uiPrimitives.IconWarningOutline16;
			Toast = uiPrimitives.Toast;
		} catch (_missing) {
			/* 平台模块缺失：走内置兜底字形 */
		}

		// ---- 注入样式：逐字复刻官方 ModelSelect.module.css（前缀 vmo-） ----
		var CSS_ID = "dsh-vision-opencode/style";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-vision-opencode";
			styleTag.dataset.pluginCss = CSS_ID;
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
				".vmo-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap}"
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
					fetch("/vision-opencode/models", { headers: { accept: "application/json" } })
						.then(function(resp) {
							if (!resp.ok) throw new Error("HTTP " + resp.status);
							return resp.json();
						})
						.then(function(data) {
							if (cancelled) return;
							if (data !== null && typeof data === "object" && Array.isArray(data.groups)) {
								setGroups(data.groups);
								setStatus("ready");
								setLoadError(null);
							} else {
								throw new Error("bad payload");
							}
						})
						.catch(function(error) {
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

		exports.inject = ["slots"];
		exports.apply = function(ctx) {
			ctx.inject(["slots"], function(scope) {
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
			});
		};

		return module.exports;
	}
});
