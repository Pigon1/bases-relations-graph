import { BasesView, getIcon, Menu, Platform, setIcon, type BasesAllOptions, type QueryController } from "obsidian";
import { BasesEvaluator } from "../bases/evaluator";
import { toCss } from "../model/color";
import { buildGraph, groupValues, type GGroup, type GraphModel } from "../model/build";
import { collapseGroups, GROUP_NODE_PREFIX, isGroupNode, type ViewModel } from "../model/collapse";
import { readThemeColors } from "../model/theme";
import { DEFAULT_SETTINGS, defaultTables, type GraphSettings, type GraphTables, type LayoutKind, type ThemeColors } from "../model/types";
import { GraphRenderer } from "../render/renderer";
import { formatActionHotkeys, formatModifier, GRAPH_ACTIONS, matchHotkey, type GraphActionId } from "../settings";
import { SimClient } from "../sim/client";
import type { FromWorker, SimForces } from "../sim/protocol";
import { PositionStore, type SavedPos } from "../store/positions";
import { PropertyCatalog } from "../ui/properties";
import { renderEdgesTable, renderGroupsTable, renderNodesTable, type TablesContext } from "../ui/tables";
import { TreeController } from "../tree/controller";
import { descendants, layoutTree, type Dir, type TreeInput } from "../tree/layout";
import type BasesRelationsGraphPlugin from "../main";

export const VIEW_TYPE = "bases-relations-graph";

type Mode = "graph" | "nodes" | "edges" | "groups";
const TABLES_SAVE_DELAY = 400;
const TWEEN_MS = 300;
const DIR_NAMES: [Dir, string, string][] = [[0, "Down", "arrow-down"], [1, "Right", "arrow-right"], [2, "Up", "arrow-up"], [3, "Left", "arrow-left"]];

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
	private model: ViewModel | null = null;
	/** Усі групи до згортання — для легенди й меню. */
	private allGroups: GGroup[] = [];
	/** Згорнуті групи (id) — зберігаються для подання. */
	private collapsed = new Set<string>();
	/** Розташування членів відносно центру групи на момент згортання — для розгортання й підглядання. */
	private collapseRel = new Map<string, Map<string, [number, number]>>();
	/** Остання відома позиція кожного вузла (у т. ч. схованих згортанням). */
	private lastKnown = new Map<string, [number, number]>();
	/** Група, в яку зараз «підглядаємо» (Ctrl + клік). */
	private peekGroup: string | null = null;
	/** Окрема симуляція оверлею (force/frozen) і ієрархія його членів (дерево). */
	private peekSim: SimClient | null = null;
	private peekVersion = 0;
	/** Модель до згортання груп (для ієрархії в оверлеї). */
	private fullModel: GraphModel | null = null;
	private peekRope = false;
	/** Позиції, яких вузли дерева мають триматися при наступному перерахунку (згортання/розгортання). */
	private treeStick: Map<string, [number, number]> | null = null;
	/** Ctrl на початку останнього перетягування. */
	private dragCtrl = false;
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
	private frozen = false;
	private ropeDrag = false;
	private fitBtn!: HTMLElement;
	private freezeBtn!: HTMLElement;
	private legendEl!: HTMLElement;
	private reheatBtn!: HTMLElement;
	private layoutKind: LayoutKind = "force";
	private tree: TreeController;
	private treeBar!: HTMLElement;
	private orientBtn!: HTMLElement;
	private rootBtn!: HTMLElement;
	private undoBtn!: HTMLElement;
	private redoBtn!: HTMLElement;
	private resetTreeBtn!: HTMLElement;
	/** Режим вибору кореня: наступний клік по вузлу робить його коренем. */
	private rootPick = false;
	private tweenFrame = 0;
	/** Останні позиції з симуляції (для force/frozen) і id вузлів у тому ж порядку. */
	private simPos: Float32Array | null = null;
	private simIds: string[] = [];

	constructor(private controller: QueryController, containerEl: HTMLElement, private plugin: BasesRelationsGraphPlugin) {
		super(controller);
		this.theme = readThemeColors();
		this.ev = new BasesEvaluator(controller);
		this.props = new PropertyCatalog(
			this.app,
			() => this.allPropertyIds(),
			(id) => this.config.getDisplayName(id as never),
		);

		this.rootEl = containerEl.createDiv({ cls: "bases-relations-graph" });
		this.rootEl.addEventListener("pointerdown", () => this.plugin.setActiveGraphView(this), { capture: true });
		this.rootEl.addEventListener("focusin", () => this.plugin.setActiveGraphView(this));
		const bar = this.rootEl.createDiv({ cls: "bases-relations-graph-toolbar" });
		const seg = bar.createDiv({ cls: "bases-relations-graph-segmented" });
		for (const [m, label, icon] of [["graph", "Graph", "git-fork"], ["nodes", "Nodes", "circle-dot"], ["edges", "Links", "spline"], ["groups", "Groups", "boxes"]] as [Mode, string, string][]) {
			const b = seg.createEl("button", { cls: "bases-relations-graph-seg" });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.onclick = () => this.setMode(m);
			this.modeButtons.set(m, b);
		}
		this.statusEl = bar.createDiv({ cls: "bases-relations-graph-status" });
		this.fitBtn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Fit graph" } });
		setIcon(this.fitBtn, "maximize");
		this.fitBtn.onclick = () => this.renderer.fit();
		this.freezeBtn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Freeze layout" } });
		setIcon(this.freezeBtn, "snowflake");
		this.freezeBtn.onclick = () => this.config.set("layout", this.frozen ? "force" : "frozen");
		this.reheatBtn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Restart simulation" } });
		setIcon(this.reheatBtn, "refresh-cw");
		this.reheatBtn.onclick = () => this.sim.send({ type: "reheat" });

		// Кнопки дерева — видно лише в режимі дерева.
		this.treeBar = bar.createDiv({ cls: "bases-relations-graph-treebar" });
		this.orientBtn = this.iconButton(this.treeBar, "arrow-down", "Map orientation", (e) => {
			const menu = new Menu();
			for (const [d, name, icon] of DIR_NAMES) {
				menu.addItem((it) => it.setTitle(name).setIcon(icon).setChecked(this.tree.state.orientation === d)
					.onClick(() => { this.tree.setOrientation(d); this.rebuild(); }));
			}
			menu.showAtMouseEvent(e);
		});
		this.rootBtn = this.iconButton(this.treeBar, "crown", "Choose root: click a node", () => this.setRootPick(!this.rootPick));
		this.undoBtn = this.iconButton(this.treeBar, "undo-2", "Undo", () => this.undoTree());
		this.redoBtn = this.iconButton(this.treeBar, "redo-2", "Redo", () => this.redoTree());
		this.resetTreeBtn = this.iconButton(this.treeBar, "rotate-ccw", "Reset manual layout", () => { this.tree.resetAll(); this.rebuild(); });
		if (Platform.isMobile) {
			// На сенсорному екрані немає Ctrl/Shift — окремий режим виділення.
			const sel = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Selection mode" } });
			// Назви іконок Lucide змінювалися між версіями — беремо першу наявну.
			setIcon(sel, ["square-dashed-mouse-pointer", "mouse-pointer-square-dashed", "lasso-select", "pointer"].find((n) => getIcon(n)) ?? "pointer");
			sel.onclick = () => {
				this.renderer.selectMode = !this.renderer.selectMode;
				sel.toggleClass("is-active", this.renderer.selectMode);
				if (!this.renderer.selectMode) this.renderer.clearSelection();
			};
		}

		this.graphEl = this.rootEl.createDiv({ cls: "bases-relations-graph-canvas-host" });
		this.legendEl = this.graphEl.createDiv({ cls: "bases-relations-graph-legend" });
		this.tablesEl = this.rootEl.createDiv({ cls: "bases-relations-graph-tables" });

		this.tree = new TreeController(plugin.treeStates);
		this.renderer = new GraphRenderer(this.graphEl, {
			onNodeClick: (i) => {
				if (this.rootPick) {
					this.tree.setRoot(i);
					this.setRootPick(false);
					this.rebuild();
					return;
				}
				// Згорнута група — не нотатка: одиночний клік нічого не відкриває.
				if (!isGroupNode(this.ids[i] ?? "")) this.openNode(i, false);
			},
			onNodeDoubleClick: (i) => {
				if (isGroupNode(this.ids[i] ?? "")) this.toggleCollapse(this.ids[i].slice(GROUP_NODE_PREFIX.length), null);
				else this.openNode(i, "tab");
			},
			onNodePeekClick: (i) => {
				if (this.model?.collapsed.has(i)) {
					this.togglePeek(i);
					return true;
				}
				if (this.plugin.settings.modifiers.peek !== this.plugin.settings.modifiers.select && !isGroupNode(this.ids[i] ?? "")) {
					this.openNode(i, false);
					return true;
				}
				return false;
			},
			onPeekClick: (m, double) => {
				const info = this.peekGroup ? this.collapsedInfo(this.peekGroup) : null;
				const id = info?.members[m]?.id;
				if (id) void this.app.workspace.openLinkText(id, "", double ? "tab" : false);
			},
			onPeekDragStart: (indices, rope) => this.peekDragStart(indices, rope),
			onPeekDrag: (indices, xy) => {
				if (this.peekSim && (this.layoutKind === "force" || this.peekRope)) this.peekSim.send({ type: "drag", indices, xy });
			},
			onPeekDragEnd: (indices, xy) => this.peekDragEnd(indices, xy),
			onPeekDismiss: () => this.closePeek(),
			onCanvasMenu: (x, y, e) => this.canvasMenu(x, y, e),
			onNodeMenu: (i, e) => this.nodeMenu(i, e),
			// Заморожений режим без модифікатора rope: вузли рухаються лише в рендері, воркер дізнається про результат.
			onDragStart: (indices, rope, treeSingle) => {
				this.dragCtrl = treeSingle;
				if (this.layoutKind === "tree") return;
				this.ropeDrag = this.frozen && rope;
				if (!this.frozen || this.ropeDrag) this.sim.send({ type: "dragStart", indices, rope: this.ropeDrag });
			},
			onDrag: (indices, xy) => {
				if (this.layoutKind === "tree") return;
				if (!this.frozen || this.ropeDrag) this.sim.send({ type: "drag", indices, xy });
			},
			onDragEnd: (indices, xy) => {
				if (this.layoutKind === "tree") {
					// Дерево: вузол стає там, де його відпустили; нащадки — разом із ним (модифікатор — без них).
					this.tree.drop(indices, xy, this.dragCtrl);
					this.rebuild();
					return;
				}
				if (this.frozen && !this.ropeDrag) this.sim.send({ type: "move", indices, xy });
				else this.sim.send({ type: "dragEnd", indices });
				this.ropeDrag = false;
			},
			onSelectionChange: () => this.updateStatus(),
			onKeyDown: (e) => this.handleKeyDown(e),
		});
		this.syncPluginSettings();
		this.plugin.registerGraphView(this);
		this.rendererReady = this.renderer.init(this.theme).catch((e) => {
			console.error("[bases-relations-graph] Pixi init failed", e);
			this.graphEl.setText("Could not start WebGL: " + (e as Error).message);
		});
		this.sim = new SimClient((m) => this.onSim(m));
		this.setMode("graph");
	}

	static options(): BasesAllOptions[] {
		return [
			{ type: "dropdown", key: "layout", displayName: "Layout", options: { force: "Force", frozen: "Frozen force", tree: "Tree" }, default: DEFAULT_SETTINGS.layout },
			{
				type: "group",
				displayName: "Tree",
				items: [
					{ type: "slider", key: "treeLevelGap", displayName: "Level distance", min: 40, max: 400, step: 5, default: DEFAULT_SETTINGS.treeLevelGap },
					{ type: "slider", key: "treeSiblingGap", displayName: "Sibling distance", min: 0, max: 200, step: 5, default: DEFAULT_SETTINGS.treeSiblingGap },
					{ type: "dropdown", key: "treeLinkStyle", displayName: "Link style", options: { curved: "Curved", straight: "Straight", orthogonal: "Orthogonal" }, default: DEFAULT_SETTINGS.treeLinkStyle },
					{ type: "slider", key: "groupStretch", displayName: "Group stretch (cells)", min: 1, max: 10, step: 1, default: DEFAULT_SETTINGS.groupStretch },
				],
			},
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
					{ type: "toggle", key: "fixedLabelSize", displayName: "Constant label size on screen", default: DEFAULT_SETTINGS.fixedLabelSize },
					{ type: "toggle", key: "savePositions", displayName: "Remember node positions", default: DEFAULT_SETTINGS.savePositions },
				],
			},
			{
				type: "group",
				displayName: "Groups",
				items: [
					{ type: "slider", key: "groupForce", displayName: "Group force", min: 0, max: 1, step: 0.01, default: DEFAULT_SETTINGS.groupForce },
					{ type: "slider", key: "groupSeparation", displayName: "Group separation", min: 0, max: 1, step: 0.01, default: DEFAULT_SETTINGS.groupSeparation },
					{ type: "toggle", key: "showLegend", displayName: "Show group legend", default: DEFAULT_SETTINGS.showLegend },
				],
			},
		];
	}

	private allPropertyIds(): string[] {
		if (this.allProperties?.length) return this.allProperties;
		return (this.data as unknown as { allProperties?: string[] } | undefined)?.allProperties ?? [];
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
			console.error("[bases-relations-graph] refresh failed", e);
			this.statusEl.setText("⚠ " + (e as Error).message);
		} finally {
			this.refreshing = false;
		}
	}

	private async refreshOnce(): Promise<void> {
		await this.rendererReady;
		if (this.destroyed) return;

		// Позиції для цього подання
		const q = (this.controller as unknown as { query?: { file?: { path?: string } } }).query;
		const key = PositionStore.key(q?.file?.path ?? "", this.config.name);
		if (key !== this.posKey) {
			this.posKey = key;
			this.saved = await this.plugin.positions.load(key);
			this.pinned = new Set([...this.saved].filter(([, p]) => p[2]).map(([id]) => id));
			await this.tree.load(key, true);
			const saved = await this.plugin.treeStates.load<string[] | { collapsed: string[]; rel: Record<string, Record<string, [number, number]>> }>(key + "::collapsed");
			const list = Array.isArray(saved) ? saved : saved?.collapsed ?? [];
			this.collapsed = new Set(list);
			this.collapseRel = new Map(Object.entries(Array.isArray(saved) ? {} : saved?.rel ?? {}).map(([g, m]) => [g, new Map(Object.entries(m))]));
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
		const groups = this.config.get("groups");
		const json = JSON.stringify({ nodes, edges, groups: Array.isArray(groups) ? groups : [] });
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
			this.config.set("groups", copy.groups ?? []);
		};
		if (immediate) write();
		else this.tablesTimer = window.setTimeout(write, TABLES_SAVE_DELAY);
	}

	private rebuild(): void {
		if (!this.tables || this.destroyed) return;
		const entries = this.data?.data ?? [];
		const settings = this.settings();
		this.renderer.labelZoom = settings.labelZoom;
		this.renderer.fixedLabelSize = settings.fixedLabelSize;
		const kind = settings.layout;
		this.layoutKind = kind;
		const isTree = kind === "tree";
		// У дереві фізика стоїть (як у замороженому режимі), щоб не витрачати ресурси.
		const frozen = kind !== "force";
		const frozenChanged = frozen !== this.frozen;
		this.frozen = frozen;
		this.freezeBtn.toggle(!isTree);
		this.reheatBtn.toggle(!isTree);
		this.treeBar.toggle(isTree);
		if (!isTree && this.rootPick) this.setRootPick(false);
		this.freezeBtn.toggleClass("is-active", frozen);
		this.syncPluginSettings();

		const full = buildGraph(entries, this.tables, this.ev, this.theme);
		this.allGroups = full.groups;
		this.fullModel = full;
		// Групи, яких більше немає, не лишаються «згорнутими» назавжди.
		const model = collapseGroups(full, this.collapsed, this.theme);
		const errorsChanged = !this.model || [...model.errors].join() !== [...this.model.errors].join();
		this.model = model;

		const sig = model.nodes.map((n) => n.id + ":" + Math.round(n.radius)).join("\n") + "|" + model.edges.map((e) => e.s + "-" + e.t).join(",")
			+ "|" + model.groups.map((g) => g.members.join(",")).join(";");
		const forces: SimForces = {
			centerStrength: settings.centerStrength,
			repelStrength: settings.repelStrength,
			linkStrength: settings.linkStrength,
			linkDistance: settings.linkDistance,
			groupForce: settings.groupForce,
			groupSeparation: settings.groupSeparation,
		};
		const forcesSig = JSON.stringify(forces);

		// Позиції симуляції (force і frozen спільні): останні з воркера → збережені → невідомо.
		const simAt = new Map<string, [number, number]>();
		if (this.simPos) this.simIds.forEach((id, i) => simAt.set(id, [this.simPos![i * 2], this.simPos![i * 2 + 1]]));
		const pos = new Float32Array(model.nodes.length * 2);
		let known = 0;
		const simNodes = model.nodes.map((n, i) => {
			const p = simAt.get(n.id) ?? this.lastKnown.get(n.id) ?? (settings.savePositions ? this.saved.get(n.id) : undefined)
				?? this.groupNodeStart(model, i);
			if (p) { pos[i * 2] = p[0]; pos[i * 2 + 1] = p[1]; known++; }
			return { id: n.id, r: n.radius, x: p?.[0], y: p?.[1], pinned: this.pinned.has(n.id) };
		});
		// Для плавного переходу — де вузли стоять на екрані зараз.
		const onScreen = new Map<string, [number, number]>();
		const shown = this.renderer.getPositions();
		this.ids.forEach((id, i) => onScreen.set(id, [shown[i * 2], shown[i * 2 + 1]]));
		this.ids = model.nodes.map((n) => n.id);

		if (isTree) {
			const target = this.layoutTree(model, settings);
			const start = new Float32Array(target.length);
			model.nodes.forEach((n, i) => {
				const p = onScreen.get(n.id);
				start[i * 2] = p ? p[0] : target[i * 2];
				start[i * 2 + 1] = p ? p[1] : target[i * 2 + 1];
			});
			this.renderer.setGraph(model.nodes, model.edges, model.groups, start);
			this.animateTo(target);
			if (this.fitPending) {
				this.fitPending = false;
				window.setTimeout(() => this.renderer.fit(), TWEEN_MS + 20);
			}
		} else {
			cancelAnimationFrame(this.tweenFrame);
			this.renderer.dragExpand = null;
			this.renderer.groupSplit = 0;
			this.renderer.setTreeEdges(null, null, "straight");
			this.renderer.setGraph(model.nodes, model.edges, model.groups, pos);
		}
		this.renderLegend(settings.showLegend);
		// Підглядання переживає перебудову, якщо група досі згорнута.
		if (this.peekGroup) {
			const idx = this.ids.indexOf(GROUP_NODE_PREFIX + this.peekGroup);
			if (idx >= 0 && model.collapsed.has(idx)) this.showPeek(idx, false);
			else this.closePeek();
		}

		if (sig !== this.structureSig) {
			this.structureSig = sig;
			this.forcesSig = forcesSig;
			this.simVersion++;
			this.simIds = this.ids;
			this.sim.send({ type: "graph", nodes: simNodes, links: model.edges.map((e) => [e.s, e.t]), groups: model.groups.map((g) => g.members), forces, frozen });
			if (!isTree && this.fitPending && known > model.nodes.length / 2) {
				this.fitPending = false;
				this.renderer.fit();
			}
		} else {
			if (forcesSig !== this.forcesSig) {
				this.forcesSig = forcesSig;
				this.sim.send({ type: "forces", forces });
			}
			if (frozenChanged) this.sim.send({ type: "frozen", frozen });
		}

		this.updateStatus();
		if (errorsChanged && this.mode !== "graph") this.renderTables();
	}

	private onSim(m: FromWorker): void {
		if (m.version !== this.simVersion || this.destroyed) return;
		this.simPos = m.positions;
		if (m.type === "end") this.simIds.forEach((id, i) => this.lastKnown.set(id, [m.positions[i * 2], m.positions[i * 2 + 1]]));
		// У дереві симуляція лише зберігає свої позиції — на екрані розташування дерева.
		if (this.layoutKind !== "tree") this.renderer.setPositions(m.positions);
		if (m.type === "end") {
			if (this.layoutKind !== "tree") this.renderer.setPinned(m.pinned);
			if (this.fitPending && this.layoutKind !== "tree") {
				this.fitPending = false;
				this.renderer.fit();
			}
			if (this.settings().savePositions) this.plugin.positions.update(this.posKey, this.ids, m.positions, m.pinned);
		}
	}

	// ---------- Дерево ----------

	/** Розташування дерева для моделі; налаштовує рендер (криві, нащадки при перетягуванні, острівці груп). */
	private layoutTree(model: GraphModel, settings: GraphSettings): Float32Array {
		const input: TreeInput = {
			ids: model.nodes.map((n) => n.id),
			radii: Float32Array.from(model.nodes, (n) => n.radius + n.strokeWidth / 2),
			names: model.nodes.map((n) => n.labels[0]?.text ?? n.id.split("/").pop()!.replace(/\.md$/, "")),
			edges: model.edges.map((e) => [e.s, e.t]),
		};
		const layout = this.tree.compute(input, {
			levelGap: settings.treeLevelGap,
			siblingGap: settings.treeSiblingGap,
			treeGap: Math.max(60, settings.treeSiblingGap * 3),
		}, this.treeStick);
		this.treeStick = null;
		const dir = new Int8Array(model.edges.length).fill(-1);
		const sParent = new Uint8Array(model.edges.length);
		model.edges.forEach((e, k) => {
			if (!layout.treeEdge[k]) return;
			const sIsParent = layout.parent[e.t] === e.s;
			sParent[k] = sIsParent ? 1 : 0;
			dir[k] = layout.dir[sIsParent ? e.t : e.s];
		});
		this.renderer.setTreeEdges(dir, sParent, settings.treeLinkStyle);
		this.renderer.dragExpand = (indices, ctrl) => (ctrl ? indices : [...indices, ...descendants(layout, indices)]);
		// «Клітинка» — відстань між сусідами в дереві; острівці груп рахуються в клітинках.
		let avgD = 0;
		for (const n of model.nodes) avgD += n.radius * 2;
		avgD = model.nodes.length ? avgD / model.nodes.length : 16;
		const cellSize = Math.max(settings.treeLevelGap, avgD + settings.treeSiblingGap) * 1.01;
		this.renderer.groupSplit = Math.max(1, settings.groupStretch) * cellSize;
		const icon = DIR_NAMES[this.tree.state.orientation][2];
		this.orientBtn.empty();
		setIcon(this.orientBtn, icon);
		return layout.pos.slice();
	}

	/** Плавний перехід вузлів до нових позицій. */
	private animateTo(target: Float32Array): void {
		cancelAnimationFrame(this.tweenFrame);
		const from = this.renderer.getPositions().slice();
		if (from.length !== target.length) {
			this.renderer.setPositions(target);
			return;
		}
		const t0 = performance.now();
		const step = () => {
			const t = Math.min(1, (performance.now() - t0) / TWEEN_MS);
			const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			const cur = new Float32Array(target.length);
			for (let i = 0; i < cur.length; i++) cur[i] = from[i] + (target[i] - from[i]) * k;
			this.renderer.setPositions(t < 1 ? cur : target);
			if (t < 1) this.tweenFrame = requestAnimationFrame(step);
		};
		step();
	}

	private setRootPick(on: boolean): void {
		this.rootPick = on;
		this.rootBtn.toggleClass("is-active", on);
		this.graphEl.toggleClass("is-picking-root", on);
	}

	private undoTree(): void {
		if (this.layoutKind === "tree" && this.tree.undo()) this.rebuild();
	}

	private redoTree(): void {
		if (this.layoutKind === "tree" && this.tree.redo()) this.rebuild();
	}

	/** Оновлює модифікатори рендера та підказки кнопок із налаштувань плагіна. */
	syncPluginSettings(): void {
		const { modifiers, hotkeys } = this.plugin.settings;
		this.renderer.modifiers = { ...modifiers };
		const withHotkey = (label: string, id: GraphActionId) => {
			const hk = formatActionHotkeys(hotkeys[id]);
			return hk ? `${label} (${hk})` : label;
		};
		this.fitBtn.setAttr("aria-label", withHotkey("Fit graph", "fit"));
		this.freezeBtn.setAttr("aria-label", withHotkey(this.frozen ? "Unfreeze layout" : "Freeze layout", "freeze"));
		this.reheatBtn.setAttr("aria-label", withHotkey(this.frozen ? "Recalculate layout once" : "Restart simulation", "reheat"));
		this.rootBtn.setAttr("aria-label", withHotkey("Choose root: click a node", "pickRoot"));
		this.undoBtn.setAttr("aria-label", withHotkey("Undo", "undo"));
		this.redoBtn.setAttr("aria-label", withHotkey("Redo", "redo"));
		this.resetTreeBtn.setAttr("aria-label", withHotkey("Reset manual layout", "resetTree"));
	}

	reloadSavedState(): void {
		if (!this.posKey || this.destroyed) return;
		this.posKey = "";
		void this.refresh();
	}

	isGraphVisible(): boolean {
		return !this.destroyed && this.rootEl.isShown();
	}

	hasGraphFocus(): boolean {
		const active = document.activeElement;
		return !!active && this.rootEl.contains(active);
	}

	isInContainer(el: HTMLElement): boolean {
		return el.contains(this.rootEl);
	}

	canRunAction(action: GraphActionId): boolean {
		if (this.destroyed || this.mode !== "graph" || !this.rootEl.isShown()) return false;
		switch (action) {
			case "fit":
			case "selectAll":
			case "clearSelection":
				return true;
			case "freeze":
			case "reheat":
				return this.layoutKind !== "tree";
			case "undo":
			case "redo":
			case "pickRoot":
			case "resetTree":
				return this.layoutKind === "tree";
		}
	}

	runAction(action: GraphActionId): boolean {
		if (!this.canRunAction(action)) return false;
		switch (action) {
			case "fit":
				this.renderer.fit();
				return true;
			case "freeze":
				this.config.set("layout", this.frozen ? "force" : "frozen");
				return true;
			case "reheat":
				this.sim.send({ type: "reheat" });
				return true;
			case "selectAll":
				this.renderer.selectAll();
				return true;
			case "clearSelection":
				if (this.rootPick) {
					this.setRootPick(false);
					return true;
				}
				return this.renderer.clearOrDismiss();
			case "undo":
				this.undoTree();
				return true;
			case "redo":
				this.redoTree();
				return true;
			case "pickRoot":
				this.setRootPick(!this.rootPick);
				return true;
			case "resetTree":
				this.tree.resetAll();
				this.rebuild();
				return true;
		}
	}

	private handleKeyDown(e: KeyboardEvent): boolean {
		const { hotkeys } = this.plugin.settings;
		for (const action of GRAPH_ACTIONS) {
			if (matchHotkey(e, hotkeys[action.id]) && this.canRunAction(action.id)) {
				this.runAction(action.id);
				return true;
			}
		}
		return false;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLElement {
		const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
		return b;
	}

	/** Легенда груп у кутку графа; клік по групі згортає або розгортає її. */
	private renderLegend(show: boolean): void {
		const el = this.legendEl;
		el.empty();
		const groups = this.allGroups;
		el.toggle(show && groups.length > 0);
		for (const g of groups) {
			const collapsed = this.collapsed.has(g.id);
			const item = el.createDiv({ cls: "bases-relations-graph-legend-item" + (collapsed ? " is-collapsed" : "") });
			const dot = item.createSpan({ cls: "bases-relations-graph-legend-dot" });
			dot.setCssProps({ "--bases-relations-graph-dot-color": toCss({ rgb: g.color, alpha: g.alpha }) });
			item.createSpan({ text: g.name });
			item.setAttr("aria-label", collapsed ? "Expand group" : "Collapse group");
			item.onclick = () => this.toggleCollapse(g.id, null);
		}
	}

	// ---------- Згортання груп ----------

	private collapsedInfo(groupId: string) {
		const idx = this.ids.indexOf(GROUP_NODE_PREFIX + groupId);
		return idx >= 0 ? this.model?.collapsed.get(idx) ?? null : null;
	}

	/** Де ставити вузол згорнутої групи, якщо його позиція ще невідома: центр членів. */
	private groupNodeStart(model: ViewModel, i: number): [number, number] | undefined {
		const info = model.collapsed.get(i);
		if (!info) return undefined;
		let sx = 0, sy = 0, k = 0;
		for (const m of info.members) {
			const p = this.lastKnown.get(m.id) ?? this.saved.get(m.id);
			if (p) { sx += p[0]; sy += p[1]; k++; }
		}
		return k ? [sx / k, sy / k] : undefined;
	}

	/**
	 * Позиції членів відносно вузла групи: збережені при згортанні (і змінені в оверлеї),
	 * інакше — з останніх відомих відносно їхнього центру, інакше — по колу.
	 */
	private relativePositions(groupId: string, memberIds: string[]): Float32Array {
		const out = new Float32Array(memberIds.length * 2);
		const stored = this.collapseRel.get(groupId);
		const fallback = memberIds.map((id) => this.lastKnown.get(id) ?? this.saved.get(id) ?? null);
		let cx = 0, cy = 0, k = 0;
		for (const p of fallback) if (p) { cx += p[0]; cy += p[1]; k++; }
		if (k) { cx /= k; cy /= k; }
		const ring = Math.max(60, memberIds.length * 12);
		memberIds.forEach((id, i) => {
			const s = stored?.get(id);
			const p = fallback[i];
			if (s) { out[i * 2] = s[0]; out[i * 2 + 1] = s[1]; }
			else if (p) { out[i * 2] = p[0] - cx; out[i * 2 + 1] = p[1] - cy; }
			else {
				const a = (i / memberIds.length) * Math.PI * 2;
				out[i * 2] = Math.cos(a) * ring; out[i * 2 + 1] = Math.sin(a) * ring;
			}
		});
		return out;
	}

	private saveCollapsed(): void {
		const rel: Record<string, Record<string, [number, number]>> = {};
		for (const [g, m] of this.collapseRel) if (this.collapsed.has(g)) rel[g] = Object.fromEntries(m);
		this.plugin.treeStates.save(this.posKey + "::collapsed", { collapsed: [...this.collapsed], rel });
	}

	/** Поточні позиції всіх видимих вузлів за id. */
	private screenPositions(): Map<string, [number, number]> {
		const pos = this.renderer.getPositions();
		const out = new Map<string, [number, number]>();
		this.ids.forEach((id, i) => out.set(id, [pos[i * 2], pos[i * 2 + 1]]));
		return out;
	}

	/**
	 * Згорнути або розгорнути групу.
	 * at — точка, куди згортати (позиція миші для дій мишею). null — з легенди:
	 * у дереві в позицію кореня групи (найвищого члена), у force-режимах — у центр групи.
	 */
	private toggleCollapse(groupId: string, at: [number, number] | null): void {
		const pos = this.renderer.getPositions();
		const screen = this.screenPositions();
		if (this.collapsed.has(groupId)) {
			// Розгортання: члени стають відносно вузла групи так, як стояли до згортання.
			const info = this.collapsedInfo(groupId);
			const idx = this.ids.indexOf(GROUP_NODE_PREFIX + groupId);
			if (this.peekGroup === groupId) this.closePeek();
			if (info && idx >= 0) {
				const rel = this.relativePositions(groupId, info.members.map((m) => m.id));
				const ax = pos[idx * 2], ay = pos[idx * 2 + 1];
				screen.delete(GROUP_NODE_PREFIX + groupId);
				info.members.forEach((m, i) => {
					const p: [number, number] = [ax + rel[i * 2], ay + rel[i * 2 + 1]];
					this.lastKnown.set(m.id, p);
					screen.set(m.id, p);
				});
			}
			this.collapsed.delete(groupId);
			this.collapseRel.delete(groupId);
		} else {
			const group = this.model?.groups.find((g) => g.id === groupId);
			if (group) {
				let anchor = at;
				if (!anchor) {
					const root = this.layoutKind === "tree" ? this.groupRootMember(group.members) : -1;
					if (root >= 0) anchor = [pos[root * 2], pos[root * 2 + 1]];
					else {
						let cx = 0, cy = 0;
						for (const i of group.members) { cx += pos[i * 2]; cy += pos[i * 2 + 1]; }
						anchor = [cx / group.members.length, cy / group.members.length];
					}
				}
				// Запам'ятовуємо розташування членів відносно точки згортання.
				const rel = new Map<string, [number, number]>();
				for (const i of group.members) {
					rel.set(this.ids[i], [pos[i * 2] - anchor[0], pos[i * 2 + 1] - anchor[1]]);
					screen.delete(this.ids[i]);
				}
				this.collapseRel.set(groupId, rel);
				this.lastKnown.set(GROUP_NODE_PREFIX + groupId, anchor);
				screen.set(GROUP_NODE_PREFIX + groupId, anchor);
			}
			this.collapsed.add(groupId);
		}
		// У дереві решта вузлів лишається на місцях.
		if (this.layoutKind === "tree") this.treeStick = screen;
		this.saveCollapsed();
		this.rebuild();
	}

	/** Корінь групи в дереві: член, у якого найменше предків. */
	private groupRootMember(members: number[]): number {
		const layout = this.tree.layout;
		if (!layout) return -1;
		let best = -1, bestDepth = Infinity;
		for (const i of members) {
			let d = 0;
			for (let p = layout.parent[i]; p >= 0 && d < 1e6; p = layout.parent[p]) d++;
			if (d < bestDepth) { best = i; bestDepth = d; }
		}
		return best;
	}

	// ---------- Оверлей групи ----------

	/** Ctrl + клік по згорнутій групі: показати чи сховати її вміст поверх графа. */
	private togglePeek(i: number): void {
		const info = this.model?.collapsed.get(i);
		if (!info) return;
		if (this.renderer.peekAnchor === i) {
			this.closePeek();
			return;
		}
		this.closePeek();
		this.peekGroup = info.group.id;
		this.showPeek(i, true);
	}

	/**
	 * Оверлей — окремий граф поверх основного за правилами поточного режиму:
	 * force — власна симуляція, frozen — «нитка» з Ctrl, дерево — гілки з Ctrl для окремого вузла.
	 */
	private showPeek(i: number, fresh: boolean): void {
		const info = this.model?.collapsed.get(i);
		if (!info) return;
		const rel = fresh ? this.relativePositions(info.group.id, info.members.map((m) => m.id))
			: this.renderer.getPeekPositions()?.slice() ?? this.relativePositions(info.group.id, info.members.map((m) => m.id));
		this.renderer.showPeek(i, info.members, info.internal, info.external, rel, info.group.color);
		const settings = this.settings();
		// Нащадки члена — за ієрархією повного дерева (без згортання), а не лише за зв'язками
		// всередині групи: гілка може проходити через вузли поза групою.
		const memberDesc = this.layoutKind === "tree" ? this.memberDescendants(info.members.map((m) => m.id)) : null;
		this.renderer.peekDragExpand = memberDesc
			? (list, ctrl) => (ctrl ? list : [...new Set(list.flatMap((m) => [m, ...memberDesc[m]]))])
			: (list) => list;
		if (this.layoutKind === "tree" || !fresh) return;
		this.peekSim?.destroy();
		this.peekVersion = 0;
		this.peekSim = new SimClient((msg) => {
			if (msg.version !== this.peekVersion) return;
			this.renderer.setPeekPositions(msg.positions);
			if (msg.type === "end") this.storePeekPositions();
		});
		this.peekVersion = 1;
		this.peekSim.send({
			type: "graph",
			nodes: info.members.map((m, k) => ({ id: m.id, r: m.radius, x: rel[k * 2], y: rel[k * 2 + 1] })),
			links: info.internal.map((e) => [e.s, e.t]),
			groups: [],
			forces: {
				centerStrength: settings.centerStrength, repelStrength: settings.repelStrength,
				linkStrength: settings.linkStrength, linkDistance: settings.linkDistance,
				groupForce: 0, groupSeparation: 0,
			},
			frozen: this.layoutKind !== "force",
		});
	}

	/** Для кожного члена — індекси інших членів, що є його нащадками в повному дереві. */
	private memberDescendants(memberIds: string[]): number[][] {
		const full = this.fullModel;
		if (!full) return memberIds.map(() => []);
		const settings = this.settings();
		const forest = layoutTree({
			ids: full.nodes.map((n) => n.id),
			radii: Float32Array.from(full.nodes, (n) => n.radius),
			names: full.nodes.map((n) => n.labels[0]?.text ?? n.id),
			edges: full.edges.map((e) => [e.s, e.t]),
		}, { ...this.tree.state, offset: {} }, { levelGap: settings.treeLevelGap, siblingGap: settings.treeSiblingGap, treeGap: 60 });
		const fullIndex = new Map(full.nodes.map((n, i) => [n.id, i]));
		const local = new Map(memberIds.map((id, k) => [id, k]));
		return memberIds.map((id) => {
			const i = fullIndex.get(id);
			if (i === undefined) return [];
			return descendants(forest, [i]).map((d) => local.get(full.nodes[d].id)).filter((k): k is number => k !== undefined);
		});
	}

	private peekDragStart(indices: number[], ctrl: boolean): void {
		if (!this.peekSim) return;
		if (this.layoutKind === "force") this.peekSim.send({ type: "dragStart", indices, rope: false });
		else if (ctrl) {
			this.peekRope = true;
			this.peekSim.send({ type: "dragStart", indices, rope: true });
		}
	}

	private peekDragEnd(indices: number[], xy: number[]): void {
		if (this.peekSim) {
			if (this.layoutKind === "force" || this.peekRope) this.peekSim.send({ type: "dragEnd", indices });
			else this.peekSim.send({ type: "move", indices, xy });
		}
		this.peekRope = false;
		this.storePeekPositions();
	}

	/** Зміни в оверлеї стають розташуванням групи при розгортанні. */
	private storePeekPositions(): void {
		const group = this.peekGroup;
		const rel = this.renderer.getPeekPositions();
		const info = group ? this.collapsedInfo(group) : null;
		if (!group || !rel || !info) return;
		this.collapseRel.set(group, new Map(info.members.map((m, k) => [m.id, [rel[k * 2], rel[k * 2 + 1]] as [number, number]])));
		this.saveCollapsed();
	}

	private closePeek(): void {
		if (this.peekGroup) this.storePeekPositions();
		this.peekSim?.send({ type: "stop" });
		this.peekSim?.destroy();
		this.peekSim = null;
		this.peekGroup = null;
		this.peekRope = false;
		this.renderer.hidePeek();
	}

	/** Правий клік по порожньому місцю: якщо всередині обведення групи — згорнути її сюди. */
	private canvasMenu(x: number, y: number, e: MouseEvent): void {
		const gi = this.renderer.groupAt(x, y);
		const group = gi >= 0 ? this.model?.groups[gi] : null;
		if (!group) return;
		const menu = new Menu();
		menu.addItem((it) => it.setTitle(`Collapse group “${group.name}”`).setIcon("minimize-2").onClick(() => this.toggleCollapse(group.id, [x, y])));
		menu.showAtMouseEvent(e);
	}

	private updateStatus(): void {
		const m = this.model;
		if (!m) return;
		const err = m.errors.size ? ` · ⚠ ${m.errors.size}` : "";
		const selected = this.renderer.getSelectedIndices().length;
		const sel = selected ? ` · ${selected} selected` : "";
		this.statusEl.setText(`${m.nodes.length} nodes · ${m.edges.length} links${sel}${err}`);
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
			groupValues: (property) => groupValues(this.data?.data ?? [], property),
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
		const left = this.tablesEl.querySelector(".bases-relations-graph-table-scroll")?.scrollLeft ?? 0;
		if (this.mode === "nodes") renderNodesTable(this.tablesEl, this.tables, ctx);
		else if (this.mode === "edges") renderEdgesTable(this.tablesEl, this.tables, ctx);
		else renderGroupsTable(this.tablesEl, this.tables, ctx);
		for (const [el, top] of scrolled) el.scrollTop = top;
		const scroller = this.tablesEl.querySelector(".bases-relations-graph-table-scroll");
		if (scroller) scroller.scrollLeft = left;
	}

	// ---------- Дії з вузлами ----------

	private openNode(i: number, newLeaf: boolean | "tab" | "split" | "window"): void {
		const id = this.ids[i];
		if (id && !isGroupNode(id)) void this.app.workspace.openLinkText(id, "", newLeaf);
	}

	private nodeMenu(i: number, e: MouseEvent | PointerEvent): void {
		const id = this.ids[i];
		if (!id) return;
		const info = this.model?.collapsed.get(i);
		if (info) {
			const peekMod = formatModifier(this.plugin.settings.modifiers.peek);
			const menu = new Menu();
			menu.addItem((it) => it.setTitle("Expand group").setIcon("maximize-2").onClick(() => this.toggleCollapse(info.group.id, null)));
			menu.addItem((it) => it.setTitle(this.renderer.peekAnchor === i ? "Hide preview" : `Preview group (${peekMod}+click)`).setIcon("eye").onClick(() => this.togglePeek(i)));
			if (this.layoutKind === "tree") {
				menu.addSeparator();
				menu.addItem((it) => it.setTitle("Set as root").setIcon("crown").onClick(() => { this.tree.setRoot(i); this.rebuild(); }));
				menu.addItem((it) => it.setTitle("Reset position").setIcon("rotate-ccw").onClick(() => { this.tree.resetNodes([i]); this.rebuild(); }));
			}
			menu.showAtMouseEvent(e as MouseEvent);
			return;
		}
		const isPinned = this.pinned.has(id);
		const menu = new Menu();
		menu.addItem((it) => it.setTitle("Open").setIcon("file").onClick(() => this.openNode(i, false)));
		menu.addItem((it) => it.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.openNode(i, "tab")));
		menu.addSeparator();
		// Згортання з меню — у точку, де був клік.
		const at = this.renderer.eventToWorld(e as MouseEvent);
		for (const g of this.model?.groups ?? []) {
			if (!g.members.includes(i)) continue;
			menu.addItem((it) => it.setTitle(`Collapse group “${g.name}”`).setIcon("minimize-2").onClick(() => this.toggleCollapse(g.id, at)));
		}
		// Якщо вузол у виділенні — дія стосується всього виділення.
		const targets = this.renderer.isSelected(i) ? this.renderer.getSelectedIndices() : [i];
		const suffix = targets.length > 1 ? ` (${targets.length})` : "";
		if (this.layoutKind === "tree") {
			menu.addItem((it) => it.setTitle("Set as root").setIcon("crown").onClick(() => { this.tree.setRoot(i); this.rebuild(); }));
			menu.addItem((it) => it.setTitle("Reset position" + suffix).setIcon("rotate-ccw").onClick(() => { this.tree.resetNodes(targets); this.rebuild(); }));
			menu.showAtMouseEvent(e as MouseEvent);
			return;
		}
		menu.addItem((it) => it.setTitle((isPinned ? "Unpin" : "Pin") + suffix).setIcon(isPinned ? "pin-off" : "pin").onClick(() => {
			const p = this.renderer.getPositions();
			for (const t of targets) {
				const tid = this.ids[t];
				if (isPinned) this.pinned.delete(tid);
				else this.pinned.add(tid);
				this.plugin.positions.setPinned(this.posKey, tid, p[t * 2], p[t * 2 + 1], !isPinned);
			}
			this.sim.send({ type: "pin", indices: targets, pinned: !isPinned });
		}));
		menu.showAtMouseEvent(e as MouseEvent);
	}

	onResize(): void {
		this.renderer.requestRender();
	}

	onunload(): void {
		this.destroyed = true;
		this.plugin.unregisterGraphView(this);
		if (this.tablesTimer !== null) {
			window.clearTimeout(this.tablesTimer);
			this.saveTables(true);
		}
		cancelAnimationFrame(this.tweenFrame);
		this.closePeek();
		this.sim.send({ type: "stop" });
		this.sim.destroy();
		this.renderer.destroy();
		void this.plugin.positions.flush();
	}
}
