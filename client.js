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

			var currentValue = current !== null && typeof current.provider === "string" && current.provider.length > 0 ? current.provider + "/" + current.model : "";

			var onChange = function(event) {
				var value = event.target.value;
				if (!value) return;
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
				var selectStyle = {
					width: "clamp(92px, 24vw, 170px)",
					maxWidth: "170px",
				fontSize: "12px",
				padding: "2px 6px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,.35)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer"
			};
			var children = [];
			children.push(createElement("option", { key: "__placeholder__", value: "" }, placeholder));
				for (var i = 0; i < options.length; i++) {
					children.push(createElement("option", { key: options[i].value, value: options[i].value }, options[i].label));
				}
				var progressLabel = "";
				var progressColor = "inherit";
				if (progress !== null) {
					if (progress.state === "running") progressLabel = "识图中...";
					else if (progress.state === "done") { progressLabel = "识图完成"; progressColor = "#16803a"; }
					else if (progress.state === "cancelled") progressLabel = "已取消";
					else { progressLabel = "识图失败"; progressColor = "#c43d3d"; }
				}
				return createElement(
				"span",
				{
					className: "vision-opencode-select",
					title: "识图模型：vision_read_image 看图时使用的模型",
						style: { position: "relative", display: "inline-flex", alignItems: "center", marginRight: "6px", fontSize: "12px", color: "inherit", opacity: "0.9" }
				},
					createElement("select", {
					id: "vision-opencode-model",
					value: currentValue,
					onChange: onChange,
					disabled: status === "loading" || options.length === 0,
					style: selectStyle,
					"aria-label": "识图模型"
					}, children),
					createElement("span", {
						"aria-live": "polite",
						title: progress !== null ? progress.text : "",
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
							opacity: progress === null ? "0" : "0.9"
						}
					}, progressLabel)
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
