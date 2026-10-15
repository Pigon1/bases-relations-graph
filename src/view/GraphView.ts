import { BasesView, Keymap, Menu, setIcon, type BasesAllOptions, type QueryController } from "obsidian";
import { BasesEvaluator } from "../bases/evaluator";
import { buildGraph, type GraphModel } from "../model/build";
import { readThemeColors } from "../model/theme";
import { DEFAULT_SETTINGS, defaultTables, type GraphSettings, type GraphTables, type ThemeColors } from "../model/types";
import { GraphRenderer } from "../render/renderer";
import { SimClient } from "../sim/client";
import type { FromWorker, SimForces } from "../sim/protocol";
import { PositionStore, type SavedPos } from "../store/positions";
import { PropertyCatalog } from "../ui/properties";
import { renderEdgesTable, renderNodesTable, type TablesContext } from "../ui/tables";
import type BasesGraphPlugin from "../main";

export const VIEW_TYPE = "bases-graph";

type Mode = "graph" | "nodes" | "edges";
const TABLES_SAVE_DELAY = 400;

export class GraphView extends BasesView {
	type = VIEW_TYPE;

	private rootEl: HTMLElement;
	private graphEl: HTMLElement;
	private tablesEl: HTMLElement;
	private statusEl: HTMLElement;
	private modeButtons = new Map<Mode, HTMLElement>();
	private mode: Mode = "graph";

	private theme: ThemeColors;
	private ev: BasesEvaluator;
	private props: PropertyCatalog;
	private renderer: GraphRenderer;
	private rendererReady: Promise<void>;
	private sim: SimClient;

	private tables: GraphTables | null = null;
	private tablesJson = "";
	/** Останній стан, записаний у конфігурацію, — щоб не прийняти власний запис за зміну ззовні. */
	private writtenJson = "";
	private tablesTimer: number | null = null;
	private model: GraphModel | null = null;
	private ids: string[] = [];
	private structureSig = "";
	private forcesSig = "";
	private simVersion = 0;
	private pinned = new Set<string>();
	private posKey = "";
	private saved: Map<string, SavedPos> = new Map();
	private fitPending = true;
	private refreshing = false;
	private refreshQueued = false;
	private destroyed = false;

	constructor(private controller: QueryController, containerEl: HTMLElement, private plugin: BasesGraphPlugin) {
		super(controller);
		this.theme = readThemeColors();
		this.ev = new BasesEvaluator(controller);
		this.props = new PropertyCatalog(
			this.app,
			() => this.allPropertyIds(),
			(id) => this.config.getDisplayName(id as never),
		);

		this.rootEl = containerEl.createDiv({ cls: "bases-graph" });
		const bar = this.rootEl.createDiv({ cls: "bases-graph-toolbar" });
		const seg = bar.createDiv({ cls: "bases-graph-segmented" });
		for (const [m, label, icon] of [["graph", "Graph", "git-fork"], ["nodes", "Nodes", "circle-dot"], ["edges", "Links", "spline"]] as [Mode, string, string][]) {
			const b = seg.createEl("button", { cls: "bases-graph-seg" });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.onclick = () => this.setMode(m);
			this.modeButtons.set(m, b);
		}
		this.statusEl = bar.createDiv({ cls: "bases-graph-status" });
		const fit = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Fit graph" } });
		setIcon(fit, "maximize");
		fit.onclick = () => this.renderer.fit();
		const reheat = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Restart simulation" } });
		setIcon(reheat, "refresh-cw");
		reheat.onclick = () => this.sim.send({ type: "reheat" });

		this.graphEl = this.rootEl.createDiv({ cls: "bases-graph-canvas-host" });
		this.tablesEl = this.rootEl.createDiv({ cls: "bases-graph-tables" });

		this.renderer = new GraphRenderer(this.graphEl, {
			onNodeClick: (i, e) => this.openNode(i, Keymap.isModEvent(e)),
			onNodeMenu: (i, e) => this.nodeMenu(i, e),
			onDrag: (i, x, y) => this.sim.send({ type: "drag", index: i, x, y }),
			onDragEnd: (i) => this.sim.send({ type: "dragEnd", index: i }),
		});
		this.rendererReady = this.renderer.init(this.theme).catch((e) => {
			console.error("[bases-graph] Pixi init failed", e);
			this.graphEl.setText("Could not start WebGL: " + (e as Error).message);
		});
		this.sim = new SimClient((m) => this.onSim(m));
		this.setMode("graph");
	}

	static options(): BasesAllOptions[] {
		return [
			{
				type: "group",
				displayName: "Forces",
				items: [
					{ type: "slider", key: "centerStrength", displayName: "Center force", min: 0, max: 1, step: 0.01, default: DEFAULT_SETTINGS.centerStrength },
					{ type: "slider", key: "repelStrength", displayName: "Repel force", min: 0, max: 20, step: 0.1, default: DEFAULT_SETTINGS.repelStrength },
					{ type: "slider", key: "linkStrength", displayName: "Link force", min: 0, max: 1, step: 0.01, default: DEFAULT_SETTINGS.linkStrength },
					{ type: "slider", key: "linkDistance", displayName: "Link distance", min: 30, max: 500, step: 1, default: DEFAULT_SETTINGS.linkDistance },
				],
			},
			{
				type: "group",
				displayName: "Display",
				items: [
					{ type: "slider", key: "labelZoom", displayName: "Show labels from zoom", min: 0.05, max: 3, step: 0.05, default: DEFAULT_SETTINGS.labelZoom },
					{ type: "toggle", key: "savePositions", displayName: "Remember node positions", default: DEFAULT_SETTINGS.savePositions },
				],
			},
		];
	}

	private allPropertyIds(): string[] {
		if (this.allProperties?.length) return this.allProperties;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return ((this.data as any)?.allProperties as string[] | undefined) ?? [];
	}

	private settings(): GraphSettings {
		const s = { ...DEFAULT_SETTINGS };
		for (const k of Object.keys(s) as (keyof GraphSettings)[]) {
			const v = this.config.get(k);
			if (typeof v === typeof s[k]) (s as Record<string, unknown>)[k] = v;
		}
		return s;
	}

	// ---------- Дані ----------

	onDataUpdated(): void {
		void this.refresh();
	}

	/** Кілька оновлень підряд зливаються в одне. */
	private async refresh(): Promise<void> {
		if (this.refreshing) { this.refreshQueued = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshQueued = false;
				await this.refreshOnce();
			} while (this.refreshQueued && !this.destroyed);
		} catch (e) {
			console.error("[bases-graph] refresh failed", e);
			this.statusEl.setText("⚠ " + (e as Error).message);
		} finally {
			this.refreshing = false;
		}
	}

	private async refreshOnce(): Promise<void> {
		await this.rendererReady;
		if (this.destroyed) return;

		// Позиції для цього подання
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const q = (this.controller as any).query;
		const key = PositionStore.key(q?.file?.path ?? "", this.config.name);
		if (key !== this.posKey) {
			this.posKey = key;
			this.saved = await this.plugin.positions.load(key);
			this.pinned = new Set([...this.saved].filter(([, p]) => p[2]).map(([id]) => id));
			this.structureSig = "";
			this.fitPending = true;
		}

		this.loadTables();
		this.rebuild();
	}

	private loadTables(): void {
		const nodes = this.config.get("nodes");
		const edges = this.config.get("edges");
		if (!Array.isArray(nodes) || !Array.isArray(edges)) {
			// Нове подання: перший рядок повторює нативний граф.
			this.tables = defaultTables(this.theme);
			this.saveTables(true);
			this.renderTables();
			return;
		}
		// Локальні правки ще не записані — вони новіші за те, що зараз у конфігурації.
		if (this.tablesTimer !== null && this.tables) return;
		const json = JSON.stringify({ nodes, edges });
		if (this.tables && (json === this.tablesJson || json === this.writtenJson)) return;
		// Зміна ззовні (інше вікно, синхронізація, ручне редагування .base).
		this.tables = JSON.parse(json) as GraphTables;
		this.tablesJson = json;
		this.renderTables();
	}

	private saveTables(immediate = false): void {
		if (!this.tables) return;
		this.tablesJson = JSON.stringify(this.tables);
		if (this.tablesTimer !== null) window.clearTimeout(this.tablesTimer);
		const write = () => {
			this.tablesTimer = null;
			this.writtenJson = this.tablesJson;
			const copy = JSON.parse(this.tablesJson) as GraphTables;
			this.config.set("nodes", copy.nodes);
			this.config.set("edges", copy.edges);
		};
		if (immediate) write();
		else this.tablesTimer = window.setTimeout(write, TABLES_SAVE_DELAY);
	}

	private rebuild(): void {
		if (!this.tables || this.destroyed) return;
		const entries = this.data?.data ?? [];
		const settings = this.settings();
		this.renderer.labelZoom = settings.labelZoom;

		const model = buildGraph(entries, this.tables, this.ev, this.theme);
		const errorsChanged = !this.model || [...model.errors].join() !== [...this.model.errors].join();
		this.model = model;

		const sig = model.nodes.map((n) => n.id + ":" + Math.round(n.radius)).join("\n") + "|" + model.edges.map((e) => e.s + "-" + e.t).join(",");
		const forces: SimForces = {
			centerStrength: settings.centerStrength,
			repelStrength: settings.repelStrength,
			linkStrength: settings.linkStrength,
			linkDistance: settings.linkDistance,
		};
		const forcesSig = JSON.stringify(forces);

		// Стартові позиції: поточні → збережені → невідомо (воркер розставить).
		const current = new Map<string, [number, number]>();
		const oldPos = this.renderer.getPositions();
		this.ids.forEach((id, i) => current.set(id, [oldPos[i * 2], oldPos[i * 2 + 1]]));
		const pos = new Float32Array(model.nodes.length * 2);
		let known = 0;
		const simNodes = model.nodes.map((n, i) => {
			const p = current.get(n.id) ?? (settings.savePositions ? this.saved.get(n.id) : undefined);
			if (p) { pos[i * 2] = p[0]; pos[i * 2 + 1] = p[1]; known++; }
			return { id: n.id, r: n.radius, x: p?.[0], y: p?.[1], pinned: this.pinned.has(n.id) };
		});
		this.ids = model.nodes.map((n) => n.id);
		this.renderer.setGraph(model.nodes, model.edges, pos);

		if (sig !== this.structureSig) {
			this.structureSig = sig;
			this.forcesSig = forcesSig;
			this.simVersion++;
			this.sim.send({ type: "graph", nodes: simNodes, links: model.edges.map((e) => [e.s, e.t]), forces });
			if (this.fitPending && known > model.nodes.length / 2) {
				this.fitPending = false;
				this.renderer.fit();
			}
		} else if (forcesSig !== this.forcesSig) {
			this.forcesSig = forcesSig;
			this.sim.send({ type: "forces", forces });
		}

		this.updateStatus();
		if (errorsChanged && this.mode !== "graph") this.renderTables();
	}

	private onSim(m: FromWorker): void {
		if (m.version !== this.simVersion || this.destroyed) return;
		this.renderer.setPositions(m.positions);
		if (m.type === "end") {
			this.renderer.setPinned(m.pinned);
			if (this.fitPending) {
				this.fitPending = false;
				this.renderer.fit();
			}
			if (this.settings().savePositions) this.plugin.positions.update(this.posKey, this.ids, m.positions, m.pinned);
		}
	}

	private updateStatus(): void {
		const m = this.model;
		if (!m) return;
		const err = m.errors.size ? ` · ⚠ ${m.errors.size}` : "";
		this.statusEl.setText(`${m.nodes.length} nodes · ${m.edges.length} links${err}`);
	}

	// ---------- Режими й таблиці ----------

	private setMode(mode: Mode): void {
		this.mode = mode;
		for (const [m, b] of this.modeButtons) b.toggleClass("is-active", m === mode);
		this.graphEl.toggle(mode === "graph");
		this.tablesEl.toggle(mode !== "graph");
		if (mode === "graph") this.renderer.requestRender();
		else this.renderTables();
	}

	private renderTables(): void {
		if (this.mode === "graph" || !this.tables) return;
		const ctx: TablesContext = {
			app: this.app,
			props: this.props,
			ev: this.ev,
			theme: this.theme,
			errors: this.model?.errors ?? new Map(),
			onChange: (structural) => {
				this.saveTables();
				this.rebuild();
				if (structural) this.renderTables();
			},
		};
		// Перемальовування не повинне скидати прокрутку.
		// Прокручуватися може як сама панель, так і контейнер Bases над нею.
		const scrolled: [HTMLElement, number][] = [];
		for (let el: HTMLElement | null = this.tablesEl; el && el !== document.body; el = el.parentElement) {
			if (el.scrollTop) scrolled.push([el, el.scrollTop]);
		}
		const left = this.tablesEl.querySelector(".bases-graph-table-scroll")?.scrollLeft ?? 0;
		if (this.mode === "nodes") renderNodesTable(this.tablesEl, this.tables, ctx);
		else renderEdgesTable(this.tablesEl, this.tables, ctx);
		for (const [el, top] of scrolled) el.scrollTop = top;
		const scroller = this.tablesEl.querySelector(".bases-graph-table-scroll");
		if (scroller) scroller.scrollLeft = left;
	}

	// ---------- Дії з вузлами ----------

	private openNode(i: number, newLeaf: boolean | "tab" | "split" | "window"): void {
		const id = this.ids[i];
		if (id) void this.app.workspace.openLinkText(id, "", newLeaf);
	}

	private nodeMenu(i: number, e: MouseEvent | PointerEvent): void {
		const id = this.ids[i];
		if (!id) return;
		const isPinned = this.pinned.has(id);
		const menu = new Menu();
		menu.addItem((it) => it.setTitle("Open").setIcon("file").onClick(() => this.openNode(i, false)));
		menu.addItem((it) => it.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.openNode(i, "tab")));
		menu.addSeparator();
		menu.addItem((it) => it.setTitle(isPinned ? "Unpin" : "Pin").setIcon(isPinned ? "pin-off" : "pin").onClick(() => {
			if (isPinned) this.pinned.delete(id);
			else this.pinned.add(id);
			this.sim.send({ type: "pin", index: i, pinned: !isPinned });
			const p = this.renderer.getPositions();
			this.plugin.positions.setPinned(this.posKey, id, p[i * 2], p[i * 2 + 1], !isPinned);
		}));
		menu.showAtMouseEvent(e as MouseEvent);
	}

	onResize(): void {
		this.renderer.requestRender();
	}

	onunload(): void {
		this.destroyed = true;
		if (this.tablesTimer !== null) {
			window.clearTimeout(this.tablesTimer);
			this.saveTables(true);
		}
		this.sim.send({ type: "stop" });
		this.sim.destroy();
		this.renderer.destroy();
		void this.plugin.positions.flush();
	}
}
