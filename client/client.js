/**
 * dsh-heatmap-cost — browser half (lazy-CJS 客户端 bundle)。
 *
 * 在 `conversation.composer.dock`(输入框下方、命中率/输入输出 token 统计条所在行)
 * 注册一枚读数:
 *   - 余额: 单例轮询器按服务器下发间隔读取 `/cost-heatmap`(只读缓存)。
 *   - 本会话消耗: 读取宿主推送的 `heatmapSessionCost` 投影(按模型计价)。
 *   - 热力图: 点击 📊 打开 GitHub 风格弹层 —— 近 N 天每日金额/token 网格 +
 *     今日/7天/30天/365天/总量汇总 + 余额 + 分模型成本。
 */
window.__ModuleLoader__.load({
	id: "dsh-heatmap-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region styles
		const CSS_ID = "dsh-heatmap-cost/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-heatmap-cost";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				"@keyframes dshhc-fadein{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}",
				"@keyframes dshhc-pulse{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.4);opacity:1}}",
				".dshhc_root{display:flex;align-items:center;justify-content:flex-end;box-sizing:border-box;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px;line-height:20px;overflow:visible;user-select:none}",
				".dshhc_sep{display:inline-flex;align-items:center;color:var(--dsw-alias-separator-primary,var(--dsw-alias-border-l3,rgba(128,128,128,0.25)));margin:0 8px;user-select:none}",
				".dshhc_item{display:inline-flex;align-items:center;cursor:pointer;border:none;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-family:inherit;gap:4px;border-radius:4px;transition:color .15s ease,background-color .15s ease}",
				".dshhc_item:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1))}",
				".dshhc_item svg{display:block}",
				".dshhc_dot{display:block;width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background-color .2s ease,box-shadow .2s ease,transform .2s ease}",
				".dshhc_dot_success{background-color:var(--dsw-alias-state-success-primary,#10b981);box-shadow:0 0 0 2px rgba(16,185,129,0.2)}",
				".dshhc_dot_warning{background-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b));box-shadow:0 0 0 2px rgba(245,158,11,0.2)}",
				".dshhc_dot_danger{background-color:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 0 0 2px rgba(239,68,68,0.2)}",
				".dshhc_dot_loading{animation:dshhc-pulse .7s ease-in-out infinite}",
				/* Modal */
				".dshhc_backdrop{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,0.5));backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;animation:dshhc-fadein .16s ease-out}",
				".dshhc_modal{background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.2));border-radius:14px;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,0.25));width:640px;max-width:96vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box;animation:dshhc-fadein .16s ease-out}",
				".dshhc_modal_header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.03));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.12));font-size:14px;font-weight:600}",
				".dshhc_modal_close{background:transparent;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;border-radius:6px;transition:all .15s ease}",
				".dshhc_modal_close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1))}",
				".dshhc_modal_body{padding:16px 20px 18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:16px;box-sizing:border-box}",
				/* summary cards */
				".dshhc_cards{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}",
				".dshhc_card{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.04));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.1));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}",
				".dshhc_card_label{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}",
				".dshhc_card_val{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}",
				".dshhc_card_sub{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}",
				/* balance row */
				".dshhc_balrow{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.03));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.1));border-radius:8px;padding:10px 14px}",
				".dshhc_bal_left{display:flex;align-items:center;gap:10px;min-width:0}",
				".dshhc_bal_amount{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
				".dshhc_bal_badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:14px;white-space:nowrap}",
				".dshhc_badge_success{background:rgba(16,185,129,0.12);color:var(--dsw-alias-state-success-primary,#10b981)}",
				".dshhc_badge_warning{background:rgba(245,158,11,0.12);color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#f59e0b))}",
				".dshhc_badge_danger{background:rgba(239,68,68,0.12);color:var(--dsw-alias-state-error-primary,#ef4444)}",
				".dshhc_refresh{display:inline-flex;align-items:center;gap:4px;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.2));color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;transition:all .15s ease}",
				".dshhc_refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1,rgba(128,128,128,0.4))}",
				".dshhc_refresh:disabled{opacity:.5;cursor:default}",
				/* heatmap */
				".dshhc_hmwrap{display:flex;flex-direction:column;gap:6px}",
				".dshhc_hm_title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}",
				".dshhc_hm_legend{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:auto}",
				".dshhc_hm_canvas{position:relative;overflow:visible}",
				".dshhc_hm_scroll{overflow-x:auto;overflow-y:hidden;border-radius:6px;max-width:100%;padding-bottom:2px}",
				".dshhc_hm_scroll::-webkit-scrollbar{height:8px}",
				".dshhc_hm_scroll::-webkit-scrollbar-track{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));border-radius:4px}",
				".dshhc_hm_scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(128,128,128,0.3));border-radius:4px}",
				".dshhc_hm_scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l1,rgba(128,128,128,0.5))}",
				".dshhc_filter{display:flex;gap:4px;flex-wrap:wrap;align-items:center}",
				".dshhc_filter_label{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-right:2px}",
				".dshhc_filter_btn{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:10.5px;line-height:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.2));background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;transition:all .12s ease;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis}",
				".dshhc_filter_btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1,rgba(128,128,128,0.4))}",
				".dshhc_filter_btn_active{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}",
				/* totals */
				".dshhc_totals{display:flex;align-items:center;justify-content:space-between;gap:14px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.04));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.12));border-radius:8px;padding:10px 14px;flex-wrap:wrap}",
				".dshhc_totals_main{display:flex;align-items:baseline;gap:8px;min-width:0}",
				".dshhc_totals_label{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshhc_totals_amount{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
				".dshhc_totals_sub{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;display:flex;gap:10px;flex-wrap:wrap}",
				/* agent list */
				".dshhc_agents{display:flex;flex-direction:column;gap:4px}",
				".dshhc_agent_row{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;gap:8px}",
				".dshhc_agent_name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}",
				".dshhc_agent_badge{display:inline-flex;padding:0 7px;border-radius:999px;background:rgba(59,130,246,0.12);color:var(--dsw-alias-brand-primary,#3b82f6);font-size:10px;line-height:16px;font-weight:500;flex-shrink:0}",
				".dshhc_agent_vals{display:flex;gap:12px;align-items:baseline;flex-shrink:0}",
				".dshhc_agent_amt{font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dshhc_agent_sub{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
				".dshhc_cell{position:absolute;width:10px;height:10px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.08));transition:transform .08s ease;cursor:default}",
				".dshhc_cell:hover{transform:scale(1.35);outline:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.4));outline-offset:1px}",
				".dshhc_lv1{background:rgba(22,163,74,0.28)}",
				".dshhc_lv2{background:rgba(22,163,74,0.55)}",
				".dshhc_lv3{background:rgba(22,163,74,0.78)}",
				".dshhc_lv4{background:rgba(16,185,129,1)}",
				".dshhc_lv0{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.08))}",
				".dshhc_month{position:absolute;font-size:9px;color:var(--dsw-alias-label-tertiary);pointer-events:none;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));padding:0 2px;border-radius:3px;z-index:2;white-space:nowrap}",
				".dshhc_tooltip{position:fixed;z-index:999999;pointer-events:none;background:var(--dsw-alias-bg-layer-1,var(--dsw-hovercard-bg,#1f1f1f));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.25));border-radius:6px;box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,0.25));padding:6px 9px;font-size:11px;line-height:1.5;white-space:nowrap;color:var(--dsw-alias-label-primary);max-width:320px;overflow:hidden;text-overflow:ellipsis}",
				/* model costs */
				".dshhc_models{display:flex;flex-direction:column;gap:4px}",
				".dshhc_model_row{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
				".dshhc_model_bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.1));overflow:hidden;flex:1;margin:0 8px;min-width:40px}",
				".dshhc_model_fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary,#3b82f6)}",
				".dshhc_models_empty{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:6px 0}",
				".dshhc_err{font-size:11px;color:var(--dsw-alias-state-error-primary,#ef4444);text-align:center;padding:8px 0}",
				/* dock error / hint */
				".dshhc_dockerr{color:var(--dsw-alias-state-error-primary,#ef4444);display:inline-flex;align-items:center}"
			].join("\n");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region formatting
		const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€" };
		const currencySymbol = (currency) => CURRENCY_SYMBOLS[currency] ?? currency + " ";
		function formatMoney(amount, currency) {
			if (typeof amount !== "number" || isNaN(amount)) return currencySymbol(currency) + "0.00";
			if (amount === 0) return currencySymbol(currency) + "0.00";
			const sign = amount < 0 ? "-" : "";
			const abs = Math.abs(amount);
			const fixed = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
			return sign + currencySymbol(currency) + abs.toFixed(fixed);
		}
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return scaled(n / 1e3) + "K";
			return scaled(n / 1e6) + "M";
		}
		function formatClock(ms) {
			if (ms <= 0) return "—";
			return new Date(ms).toLocaleTimeString();
		}
		function getStatusLevel(total, isAvailable, warning, danger) {
			if (!isAvailable) return "danger";
			if (total < danger) return "danger";
			if (total < warning) return "warning";
			return "success";
		}
		//#endregion

		//#region store (单例轮询 /cost-heatmap)
		const DEFAULT_POLL_MS = 30000;
		let snapshot = { status: "loading", isRefreshing: false, payload: null, message: null };
		const listeners = new Set();
		let timer = null;
		let pollMs = DEFAULT_POLL_MS;
		let inflight = null;
		let started = false;

		function notify() { for (const fn of [...listeners]) fn(); }

		async function refresh(force = false) {
			if (inflight !== null) return inflight;
			if (force && snapshot.isRefreshing !== true) {
				snapshot = { ...snapshot, isRefreshing: true };
				notify();
			}
			inflight = (async () => {
				try {
					const url = "/cost-heatmap" + (force ? "?force=1" : "");
					const res = await fetch(url, { method: force ? "POST" : "GET", headers: { Accept: "application/json" } });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const data = await res.json();
					if (typeof data?.refreshIntervalMs === "number" && data.refreshIntervalMs >= 1000) pollMs = data.refreshIntervalMs;
					snapshot = { status: "ok", isRefreshing: false, payload: data, message: null };
				} catch (err) {
					snapshot = { status: "error", isRefreshing: false, payload: snapshot.payload, message: err instanceof Error ? err.message : String(err) };
				} finally {
					inflight = null;
					notify();
				}
			})();
			return inflight;
		}

		function schedule() {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				if (!document.hidden) refresh().then(schedule, schedule);
				else schedule();
			}, pollMs);
		}

		function ensureStarted() {
			if (started) return;
			started = true;
			void refresh().then(schedule, schedule);
		}

		const balanceStore = {
			subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
			getSnapshot() { return snapshot; },
			forceRefresh() {
				ensureStarted();
				return refresh(true);
			},
		};
		//#endregion

		//#region icons
		function IconHeat() {
			return react.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, [
				react.createElement("path", { key: "p", d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" })
			]);
		}
		//#endregion

		//#region heatmap grid
		/**
		 * GitHub 风格热力图: 每格一天, 按周分列, 颜色按当日金额 5 级分级。
		 * series 为按日期升序的 {date, tokens, cost, requests, modelCosts[]} 数组,
		 * modelCosts 为 {model, cost, tokens} 列表 —— 支持按模型筛选着色。
		 * 悬停用 fixed 定位的 tooltip 显示当日详情(不受滚动容器裁剪)。
		 */
		function HeatmapGrid({ series, maxCost, currency, models }) {
			const [filter, setFilter] = react.useState("all");
			const [hovered, setHovered] = react.useState(null);
			if (!series || series.length === 0) {
				return react.createElement("div", { className: "dshhc_models_empty" }, "暂无数据");
			}
			const CELL = 13; // 10px + 3px gap
			const MONTH_H = 16; // 顶部月份标签区高度
			const COLS = Math.ceil(series.length / 7);
			const cells = [];
			const monthLabels = [];
			let prevMonth = null;

			// 按筛选计算每日金额/tokens: 'all' 用每日总计, 否则取该模型当天的 {cost,tokens}
			const dayOf = (item) => {
				if (filter === "all") return { cost: item.cost, tokens: item.tokens };
				const hit = (item.modelCosts || []).find((m) => m.model === filter);
				return hit ? { cost: hit.cost, tokens: hit.tokens } : { cost: 0, tokens: 0 };
			};
			// 筛选后的最大日金额(用于 5 级配色)
			let maxEff = 0.000001;
			for (const s of series) { const c = dayOf(s).cost; if (c > maxEff) maxEff = c; }

			for (let i = 0; i < series.length; i++) {
				const d = new Date(series[i].date + "T00:00:00");
				const wd = d.getDay(); // 0=Sun
				const col = Math.floor(i / 7);
				const month = d.toLocaleString("en-US", { month: "short" });
				if (month !== prevMonth) {
					monthLabels.push(react.createElement("span", {
						key: "m" + i,
						className: "dshhc_month",
						style: { left: col * CELL, top: 0 }
					}, month));
					prevMonth = month;
				}
				const { cost, tokens } = dayOf(series[i]);
				let level = 0;
				if (cost > 0) {
					level = cost < maxEff * 0.25 ? 1 : cost < maxEff * 0.5 ? 2 : cost < maxEff * 0.75 ? 3 : 4;
				}
				const info = {
					date: series[i].date,
					cost,
					tokens,
					requests: series[i].requests || 0,
				};
				cells.push(react.createElement("div", {
					key: series[i].date,
					className: "dshhc_cell dshhc_lv" + level,
					title: series[i].date,
					style: { left: col * CELL, top: MONTH_H + wd * CELL },
					onMouseEnter: (e) => {
						const r = e.currentTarget.getBoundingClientRect();
						setHovered({ ...info, x: r.left, y: r.top });
					},
					onMouseLeave: () => setHovered(null)
				}));
			}

			// hover 提示 (fixed 定位, 视口边界自动翻转, 不受滚动容器裁剪)
			let tooltipNode = null;
			if (hovered !== null) {
				const TIP_W = 280;
				const flipX = hovered.x + TIP_W + 16 > (window.innerWidth || 0);
				const left = flipX ? hovered.x - TIP_W - 12 : hovered.x + 14;
				tooltipNode = react.createElement("div", {
					className: "dshhc_tooltip",
					style: { left: Math.max(8, left), top: hovered.y + 14 }
				}, [
					hovered.date + " · " + formatMoney(hovered.cost, currency) + " · " + formatTokens(hovered.tokens) + " tokens" +
					(hovered.requests ? " · " + hovered.requests + " 次" : "")
				]);
			}

			// 模型筛选胶囊
			const filterBtns = [react.createElement("button", {
				type: "button",
				key: "all",
				className: "dshhc_filter_btn" + (filter === "all" ? " dshhc_filter_btn_active" : ""),
				onClick: () => setFilter("all")
			}, "全部")];
			for (const m of models || []) {
				filterBtns.push(react.createElement("button", {
					type: "button",
					key: m,
					className: "dshhc_filter_btn" + (filter === m ? " dshhc_filter_btn_active" : ""),
					onClick: () => setFilter(filter === m ? "all" : m),
					title: m
				}, m));
			}
			const filterNode = react.createElement("div", { className: "dshhc_filter", key: "f" }, [
				react.createElement("span", { className: "dshhc_filter_label", key: "l" }, "模型:"),
				...filterBtns
			]);

			return react.createElement("div", { className: "dshhc_hmwrap" }, [
				react.createElement("div", { className: "dshhc_hm_title", key: "t" }, [
					react.createElement("span", { key: "lbl" }, "每日消耗" + (filter !== "all" ? " · " + filter : "") + (series.length > 200 ? "（可左右滑动）" : "")),
					react.createElement("span", { className: "dshhc_hm_legend", key: "leg" }, ["少", ...Array.from({ length: 5 }, (_, i) =>
						react.createElement("span", { key: "l" + i, className: "dshhc_cell dshhc_lv" + i, style: { position: "static", display: "inline-block", marginLeft: 2, cursor: "default" } })
					), "多"])
				]),
				filterNode,
				react.createElement("div", { className: "dshhc_hm_scroll", key: "sc" }, [
					react.createElement("div", {
						className: "dshhc_hm_canvas",
						key: "cv",
						style: { width: COLS * CELL + 2, height: MONTH_H + 7 * CELL }
					}, [
						...monthLabels,
						...cells,
						tooltipNode
					])
				])
			]);
		}
		//#endregion

		//#region modal
		const HeatmapModal = react.memo(function HeatmapModal({ isOpen, onClose, balance, cost, t }) {
			const payload = balance.payload;
			const heat = payload?.heatmap;
			const bal = payload?.balance;
			const [refreshing, setRefreshing] = react.useState(false);
			if (!isOpen) return null;

			const handleRefresh = () => {
				setRefreshing(true);
				balanceStore.forceRefresh().finally(() => setRefreshing(false));
			};

			const primary = bal?.ok === true && Array.isArray(bal.balances) && bal.balances.length > 0
				? bal.balances.find((b) => b.currency === bal.currency) ?? bal.balances[0]
				: null;
			const cur = bal?.currency ?? heat?.currency ?? "CNY";
			const totals = payload?.totals;

			// 总消耗(全部历史会话, 从开始使用起计费)
			let totalsNode = null;
			if (totals && (totals.cost > 0 || totals.tokens > 0)) {
				totalsNode = react.createElement("div", { className: "dshhc_totals" }, [
					react.createElement("div", { className: "dshhc_totals_main", key: "m" }, [
						react.createElement("span", { className: "dshhc_totals_label", key: "l" }, "累计消耗"),
						react.createElement("span", { className: "dshhc_totals_amount", key: "a" }, formatMoney(totals.cost, cur))
					]),
					react.createElement("div", { className: "dshhc_totals_sub", key: "s" }, [
						react.createElement("span", { key: "t" }, formatTokens(totals.tokens) + " tokens"),
						react.createElement("span", { key: "r" }, totals.requests + " 次请求"),
						react.createElement("span", { key: "c" }, totals.sessions + " 个会话")
					])
				]);
			}

			// 按 agent 预设消耗
			let agentsNode = null;
			const agents = payload?.byAgent || [];
			if (agents.length > 0) {
				agentsNode = react.createElement("div", { className: "dshhc_agents" }, [
					react.createElement("div", { className: "dshhc_hm_title", key: "t" }, "按 Agent 消耗"),
					...agents.map((a) => react.createElement("div", { className: "dshhc_agent_row", key: a.agent }, [
						react.createElement("span", { className: "dshhc_agent_name", key: "n" }, [
							react.createElement("span", { className: "dshhc_agent_badge", key: "b" }, a.agent),
							react.createElement("span", { key: "s", style: { color: "var(--dsw-alias-label-tertiary)" } }, a.sessions + " 会话")
						]),
						react.createElement("span", { className: "dshhc_agent_vals", key: "v" }, [
							react.createElement("span", { className: "dshhc_agent_amt", key: "a" }, formatMoney(a.cost, cur)),
							react.createElement("span", { className: "dshhc_agent_sub", key: "t" }, formatTokens(a.tokens) + " tok")
						])
					]))
				]);
			}

			let balNode = null;
			if (primary !== null) {
				const level = getStatusLevel(primary.total, bal.isAvailable === true, bal.thresholds?.warning ?? 10, bal.thresholds?.danger ?? 5);
				const levelText = level === "success" ? "余额充足" : level === "warning" ? "余额偏低" : "余额告急";
				balNode = react.createElement("div", { className: "dshhc_balrow" }, [
					react.createElement("div", { className: "dshhc_bal_left", key: "l" }, [
						react.createElement("span", { className: "dshhc_dot dshhc_dot_" + level, key: "dot" }),
						react.createElement("span", { className: "dshhc_bal_amount", key: "amt" }, formatMoney(primary.total, primary.currency)),
						react.createElement("span", { className: "dshhc_bal_badge dshhc_badge_" + level, key: "badge" }, levelText),
						react.createElement("span", { className: "dshhc_bal_sub", key: "sub", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
							`更新于 ${formatClock(bal.fetchedAt)}${bal.stale ? "（旧数据）" : ""}`)
					]),
					react.createElement("button", {
						type: "button",
						className: "dshhc_refresh",
						onClick: handleRefresh,
						disabled: refreshing,
						key: "r"
					}, refreshing ? "刷新中…" : "刷新余额")
				]);
			} else if (bal?.error === "api-key-missing") {
				balNode = react.createElement("div", { className: "dshhc_err" }, "未配置 DEEPSEEK_API_KEY，无法查询余额");
			} else if (bal?.error) {
				balNode = react.createElement("div", { className: "dshhc_err" }, "余额查询失败: " + bal.error);
			}

			let summaryNode = null;
			if (heat) {
				const cards = [
					{ label: "今日", cost: heat.summary.today.cost, tokens: heat.summary.today.tokens },
					{ label: "近 7 天", cost: heat.summary.last7.cost, tokens: heat.summary.last7.tokens },
					{ label: "近 30 天", cost: heat.summary.last30.cost, tokens: heat.summary.last30.tokens },
					{ label: "近 365 天", cost: heat.summary.last365.cost, tokens: heat.summary.last365.tokens },
					{ label: "累计", cost: heat.summary.total.cost, tokens: heat.summary.total.tokens },
				];
				summaryNode = react.createElement("div", { className: "dshhc_cards" },
					cards.map((c) => react.createElement("div", { key: c.label, className: "dshhc_card" }, [
						react.createElement("span", { className: "dshhc_card_label", key: "l" }, c.label),
						react.createElement("span", { className: "dshhc_card_val", key: "v" }, formatMoney(c.cost, cur)),
						react.createElement("span", { className: "dshhc_card_sub", key: "s" }, formatTokens(c.tokens) + " tokens"),
					]))
				);
			}

			let sessionNode = null;
			if (cost && cost.cost > 0) {
				sessionNode = react.createElement("div", { className: "dshhc_balrow", style: { justifyContent: "space-between" } }, [
					react.createElement("span", { key: "l" }, "本会话消耗"),
					react.createElement("span", { key: "v", style: { fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, formatMoney(cost.cost, cost.currency ?? cur))
				]);
			}

			let modelsNode = null;
			if (heat && heat.modelCosts && heat.modelCosts.length > 0) {
				const max = Math.max(0.000001, ...heat.modelCosts.map((m) => m.cost));
				modelsNode = react.createElement("div", { className: "dshhc_models" }, [
					react.createElement("div", { className: "dshhc_hm_title", key: "t" }, "分模型成本"),
					...heat.modelCosts.map((m) => react.createElement("div", { className: "dshhc_model_row", key: m.model }, [
						react.createElement("span", { key: "n", style: { minWidth: 130, overflow: "hidden", textOverflow: "ellipsis" } }, m.model),
						react.createElement("div", { className: "dshhc_model_bar", key: "b" },
							react.createElement("div", { className: "dshhc_model_fill", style: { width: Math.max(2, (m.cost / max) * 100) + "%" } })
						),
						react.createElement("span", { key: "c", style: { minWidth: 56, textAlign: "right" } }, formatMoney(m.cost, cur))
					]))
				]);
			} else {
				modelsNode = react.createElement("div", { className: "dshhc_models_empty" }, "暂无分模型数据（使用后可见）");
			}

			return react.createElement("div", { className: "dshhc_backdrop", onClick: onClose }, [
				react.createElement("div", {
					className: "dshhc_modal",
					onClick: (e) => e.stopPropagation(),
					key: "m"
				}, [
					react.createElement("div", { className: "dshhc_modal_header", key: "h" }, [
						react.createElement("span", { key: "t" }, "Token / 费用消耗"),
						react.createElement("button", { type: "button", className: "dshhc_modal_close", onClick: onClose, key: "c" }, "✕")
					]),
					react.createElement("div", { className: "dshhc_modal_body", key: "b" }, [
						totalsNode,
						balNode,
						sessionNode,
						agentsNode,
						summaryNode,
						heat ? react.createElement(HeatmapGrid, { series: heat.series, maxCost: heat.maxCost, currency: cur, models: (heat.modelCosts || []).map((m) => m.model), key: "hm" }) : null,
						modelsNode
					])
				])
			]);
		});
		//#endregion

		//#region dock readout
		const DockReadout = react.memo(function DockReadout({ useProjection, t }) {
			const cost = useProjection("heatmapSessionCost");
			const balance = react.useSyncExternalStore(balanceStore.subscribe, balanceStore.getSnapshot, balanceStore.getSnapshot);
			const [isOpen, setOpen] = react.useState(false);

			react.useEffect(() => { ensureStarted(); }, []);

			const payload = balance.payload;
			const bal = payload?.balance;
			const primary = bal?.ok === true && Array.isArray(bal.balances) && bal.balances.length > 0
				? bal.balances.find((b) => b.currency === bal.currency) ?? bal.balances[0]
				: null;
			const cur = bal?.currency ?? cost?.currency ?? "CNY";

			const children = [];

			// 余额
			if (primary !== null) {
				const level = getStatusLevel(primary.total, bal.isAvailable === true, bal.thresholds?.warning ?? 10, bal.thresholds?.danger ?? 5);
				children.push(react.createElement("span", { className: "dshhc_dot dshhc_dot_" + level + (balance.isRefreshing ? " dshhc_dot_loading" : ""), key: "dot" }));
				children.push(react.createElement("span", { key: "amt" }, formatMoney(primary.total, primary.currency)));
			} else if (balance.status === "error" && !payload) {
				children.push(react.createElement("span", { className: "dshhc_dockerr", key: "err" }, "余额不可用"));
			} else if (bal?.error && bal.error !== "api-key-missing") {
				children.push(react.createElement("span", { className: "dshhc_dockerr", key: "err" }, "余额查询失败"));
			}

			// 本会话消耗
			if (cost && cost.cost > 0) {
				if (children.length > 0) children.push(react.createElement("span", { className: "dshhc_sep", key: "sep1" }, "|"));
				children.push(react.createElement("span", { key: "cost" }, "本会话 " + formatMoney(cost.cost, cur)));
			}

			// 热力图按钮
			children.push(react.createElement("span", { className: "dshhc_sep", key: "sep2" }, "|"));
			children.push(react.createElement("button", {
				type: "button",
				className: "dshhc_item",
				key: "hm",
				title: "查看消耗热力图",
				onClick: (e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }
			}, [IconHeat()]));

			if (isOpen) {
				children.push(react.createElement(HeatmapModal, {
					isOpen,
					onClose: () => setOpen(false),
					balance,
					cost,
					t,
					key: "modal"
				}));
			}

			return react.createElement("div", { className: "dshhc_root", children });
		});
		//#endregion

		//#region plugin
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("dsh-heatmap-cost", {}), "dsh-heatmap-cost: locale");
			ctx.slots.inject("conversation.composer.dock", () => {
				const dispose = ctx.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-heatmap-cost",
					order: 2,
					locale: "dsh-heatmap-cost"
				}, DockReadout);
				return () => { dispose(); };
			});
			ctx.effect(() => {
				const onVisibility = () => {
					if (!document.hidden) refresh().then(schedule, schedule);
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, "dsh-heatmap-cost: visibility resume");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
