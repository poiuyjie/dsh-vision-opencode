// dsh-vision-opencode: DeepSeek Harness 插件（前端半边）。
//
// 在输入框右侧（conversation.input.right slot）注入"识图模型"选择器：
// 列出所有支持图片输入的供应商模型（后端 /vision-opencode/models 提供），
// 选择结果写入后端配置（PUT /vision-opencode/config），
// vision_read_image 工具随后使用该模型看图。
//
// Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})，
// factory 通过 require() 获取平台共享模块（react、cordis、slots 等）。
window.__ModuleLoader__.load({
	id: "dsh-vision-opencode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

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
				var progressState = useState(null);
				var progress = progressState[0];
				var setProgress = progressState[1];
				var openState = useState(false);
				var open = openState[0];
				var setOpen = openState[1];
				var containerRef = useRef(null);

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
				// 加载模型目录；后端端点可能晚于前端挂载，失败后自动重试
				var loadModels = function() {
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
							} else {
								throw new Error("bad payload");
							}
						})
						.catch(function() {
							if (cancelled) return;
							attempts += 1;
							if (attempts < 6) {
								setStatus("loading");
								setTimeout(loadModels, 1000);
							} else {
								setStatus("error");
							}
						});
					};
					loadModels();

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
						if (clearProgressTimer !== null) clearTimeout(clearProgressTimer);
						if (progressStream !== null) progressStream.close();
					};
				}, [sessionId]);

				// 自定义下拉：点击外部或按 Escape 关闭
				useEffect(function() {
					if (!open) return;
					var onPointerDown = function(event) {
						var node = containerRef.current;
						if (node !== null && !node.contains(event.target)) setOpen(false);
					};
					var onKeyDown = function(event) {
						if (event.key === "Escape") setOpen(false);
					};
					document.addEventListener("mousedown", onPointerDown);
					document.addEventListener("keydown", onKeyDown);
					return function() {
						document.removeEventListener("mousedown", onPointerDown);
						document.removeEventListener("keydown", onKeyDown);
					};
				}, [open]);

			var currentValue = current !== null && typeof current.provider === "string" && current.provider.length > 0 ? current.provider + "/" + current.model : "";

			var pickModel = function(value) {
				setOpen(false);
				var slash = value.indexOf("/");
				if (slash <= 0) return;
				var provider = value.slice(0, slash);
				var model = value.slice(slash + 1);
				fetch("/vision-opencode/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: provider, model: model })
				})
					.then(function(resp) { return resp.json(); })
					.then(function(cfg) {
						if (cfg !== null && typeof cfg === "object" && typeof cfg.provider === "string") setCurrent(cfg);
					})
					.catch(function() {});
			};

			// 选项：按供应商分组列出支持图片的模型
			var options = [];
			for (var g = 0; g < groups.length; g++) {
				var group = groups[g];
				if (group === null || typeof group !== "object") continue;
				var models = Array.isArray(group.models) ? group.models : [];
				for (var m = 0; m < models.length; m++) {
					var model = models[m];
					if (model === null || typeof model !== "object" || typeof model.id !== "string") continue;
					var value = group.provider + "/" + model.id;
					options.push({
						value: value,
						label: (typeof group.name === "string" ? group.name : group.provider) + " / " + (typeof model.name === "string" ? model.name : model.id)
					});
				}
			}
			// 当前配置若不在目录里（如目录加载失败），保留为可见选项
			var hasCurrent = false;
			for (var o = 0; o < options.length; o++) if (options[o].value === currentValue) { hasCurrent = true; break; }
			if (currentValue && !hasCurrent) options.unshift({ value: currentValue, label: currentValue });

			var placeholder = status === "loading" ? "识图模型…" : (options.length === 0 ? "无识图模型" : "识图模型");
			var disabled = status === "loading" || options.length === 0;
			var label = currentValue.length > 0 ? currentValue : placeholder;

			// 触发器：视觉上与原生 select 一致（透明背景 + 继承前景色），
			// 但下拉列表是自定义面板，跟随 dsh 主题令牌（深色/浅色自动切换）。
			var triggerStyle = {
				width: "clamp(92px, 24vw, 170px)",
				maxWidth: "170px",
				fontSize: "12px",
				padding: "2px 6px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,.35)",
				background: "transparent",
				color: "inherit",
				cursor: disabled ? "default" : "pointer",
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				fontFamily: "inherit",
				lineHeight: "1.4",
				opacity: disabled ? 0.7 : 1
			};
			var triggerLabelStyle = {
				flex: "1 1 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				textAlign: "left"
			};
			var popupStyle = {
				position: "absolute",
				right: "0",
				bottom: "calc(100% + 6px)",
				zIndex: 1000,
				minWidth: "220px",
				maxWidth: "min(320px, 90vw)",
				maxHeight: "min(300px, 45vh)",
				overflowY: "auto",
				padding: "4px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-inverted)",
				background: "var(--dsw-specific-menu)",
				boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.3))",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "12px"
			};
			var rowBaseStyle = {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				padding: "5px 8px",
				borderRadius: "6px",
				cursor: "pointer",
				whiteSpace: "nowrap"
			};
			var rowLabelStyle = {
				flex: "1 1 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis"
			};

			var optionNodes = [];
			for (var i = 0; i < options.length; i++) {
				var option = options[i];
				if (option === null || typeof option !== "object" || typeof option.value !== "string") continue;
				var selected = option.value === currentValue;
				optionNodes.push(createElement("div", {
					key: option.value,
					role: "option",
					"aria-selected": selected,
					title: option.label,
					onClick: (function(value) {
						return function() { pickModel(value); };
					})(option.value),
					style: Object.assign({}, rowBaseStyle, selected ? { background: "var(--dsw-alias-interactive-bg-hover)" } : {})
				},
					createElement("span", { style: { flex: "none", width: "14px", color: "var(--dsw-alias-label-primary)" } }, selected ? "✓" : ""),
					createElement("span", { style: rowLabelStyle }, option.label)));
			}

			var progressLabel = "";
			var progressColor = "inherit";
			if (progress !== null) {
				if (progress.state === "running") progressLabel = "识图中...";
				else if (progress.state === "done") { progressLabel = "识图完成"; progressColor = "var(--dsw-static-green-500)"; }
				else if (progress.state === "cancelled") progressLabel = "已取消";
				else { progressLabel = "识图失败"; progressColor = "var(--dsw-static-red-500)"; }
			}

			return createElement(
				"span",
				{
					className: "vision-opencode-select",
					title: "识图模型：vision_read_image 看图时使用的模型",
					ref: containerRef,
					style: { position: "relative", display: "inline-flex", alignItems: "center", marginRight: "6px", fontSize: "12px", color: "inherit", opacity: "0.9" }
				},
				createElement("style", null, ".vision-opencode-select [role=\"option\"]:hover { background: var(--dsw-alias-interactive-bg-hover); }"),
				createElement("button", {
					type: "button",
					"aria-label": "识图模型",
					"aria-haspopup": "listbox",
					"aria-expanded": open,
					title: label,
					disabled: disabled,
					onClick: function() { setOpen(!open); },
					style: triggerStyle
				},
					createElement("span", { style: triggerLabelStyle }, label),
					createElement("span", { style: { flex: "none", fontSize: "9px", opacity: "0.6" } }, "▾")),
				open && !disabled ? createElement("div", { role: "listbox", "aria-label": "识图模型", style: popupStyle }, optionNodes) : null,
				progress !== null && !open ? createElement("span", {
					"aria-live": "polite",
					title: progress.text,
					style: {
						display: "inline-block",
						position: "absolute",
						right: "0",
						bottom: "calc(100% + 6px)",
						width: "clamp(92px, 24vw, 170px)",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						textAlign: "right",
						pointerEvents: "none",
						color: progressColor,
						opacity: "0.9"
					}
				}, progressLabel) : null
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
