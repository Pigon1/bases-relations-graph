import { Application, Container, Graphics, Text } from "pixi.js";
import type { GEdge, GGroup, GNode, LabelData } from "../model/build";
import { parseColor } from "../model/color";
import type { ThemeColors } from "../model/types";
import { SpatialGrid } from "./spatial";

/** Відступ підпису від краю вузла і між підписами в стопці (одиниці світу). */
const LABEL_NODE_GAP = 3;
const LABEL_STACK_GAP = 1;

/** Підпис: необов'язковий заокруглений фон + текст. Координати — від лівого верхнього кута. */
class LabelSprite extends Container {
	readonly w: number;
	readonly h: number;

	constructor(d: LabelData, fontFamily: string) {
		super();
		const text = new Text({
			text: d.text,
			style: { fontFamily, fontSize: d.size, fill: d.color },
			resolution: 2,
		});
		text.alpha = d.alpha;
		const hasBg = d.backgroundAlpha > 0;
		const px = hasBg ? d.size * 0.35 : 0, py = hasBg ? d.size * 0.12 : 0;
		this.w = text.width + px * 2;
		this.h = text.height + py * 2;
		if (hasBg) {
			const bg = new Graphics()
				.roundRect(0, 0, this.w, this.h, Math.min(this.h / 2, d.size * 0.4))
				.fill({ color: d.background, alpha: d.backgroundAlpha });
			this.addChild(bg);
		}
		text.position.set(px, py);
		this.addChild(text);
	}
}

export interface RendererCallbacks {
	onNodeClick(index: number, ev: PointerEvent): void;
	onNodeDoubleClick(index: number, ev: PointerEvent): void;
	onNodeMenu(index: number, ev: MouseEvent | PointerEvent): void;
	/** rope — перетягування з утриманим Ctrl/Cmd (у замороженому режимі — «мотузка»). */
	onDragStart(indices: number[], rope: boolean): void;
	/** xy: [x0, y0, x1, y1, …] — нові позиції для indices. */
	onDrag(indices: number[], xy: number[]): void;
	onDragEnd(indices: number[], xy: number[]): void;
	onSelectionChange(count: number): void;
}

interface Press {
	id: number;
	node: number;
	x: number;
	y: number;
	moved: boolean;
	menu: boolean;
	timer: number;
	/** Модифікатори на момент натискання: Shift — виділення, Ctrl/Cmd — «мотузка». */
	toggle: boolean;
	rope: boolean;
	/** Що робить рух: перетягування вузлів, рамка виділення чи панорамування. */
	action: "drag" | "band" | "pan";
	/** Перетягувані вузли та їхні зміщення від курсора. */
	drag: { indices: number[]; offsets: number[] } | null;
}

const LONG_PRESS_MS = 550;
/** Вікно для подвійного кліку; одиночний клік чекає стільки ж, щоб не відкрити нотатку двічі. */
const DOUBLE_CLICK_MS = 300;
const CLICK_SLOP = 6;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** Скільки граф має стояти, щоб будувати просторовий індекс. */
const GRID_SETTLE_MS = 300;

/** Рендер графа на Pixi. Позиції приходять із воркера, рендер — лише за потреби. */
export class GraphRenderer {
	private app = new Application();
	private ready = false;
	private world = new Container();
	private edgeGfx = new Graphics();
	private hullGfx = new Graphics();
	private groupLabelLayer = new Container();
	private groups: GGroup[] = [];
	private groupLabels: (LabelSprite | null)[] = [];
	private nodeLayer = new Container();
	private labelLayer = new Container();
	private edgeLabelLayer = new Container();

	private nodes: GNode[] = [];
	private edges: GEdge[] = [];
	private adjacency: number[][] = [];
	private nodeGfx: Graphics[] = [];
	/** Підписи вузлів у порядку node.labels (за зростанням індексу). */
	private labels: LabelSprite[][] = [];
	private edgeLabels: (LabelSprite | null)[] = [];
	private grid = new SpatialGrid();
	private gridDirty = true;
	private lastMove = 0;
	private candidates: number[] = [];
	/** Радіус влучання: вузол + половина обведення. */
	private hitRadii = new Float32Array(0);
	private pos: Float32Array = new Float32Array(0);
	private pinned: Uint8Array = new Uint8Array(0);

	private scale = 1;
	private tx = 0;
	private ty = 0;
	private hover = -1;
	private dirty = false;
	private frame = 0;
	private fontFamily = "sans-serif";
	private colors = { text: 0x222222, textAlpha: 1, hl: 0x9873f7, hlLine: 0x9873f7 };
	private resizeObserver: ResizeObserver | null = null;

	// Вказівники для панорамування, перетягування й масштабування.
	private pointers = new Map<number, { x: number; y: number }>();
	private press: Press | null = null;
	private lastClick: { node: number; time: number } | null = null;
	private clickTimer = 0;
	/** Виділення — за id вузлів, щоб пережити перебудову графа. */
	private selected = new Set<string>();
	private selGfx = new Graphics();
	private bandGfx = new Graphics();
	private band: { x0: number; y0: number; x1: number; y1: number } | null = null;
	/** Режим виділення для сенсорних екранів: дотик виділяє, а не відкриває. */
	selectMode = false;
	private pinch: { dist: number; scale: number; mx: number; my: number } | null = null;

	labelZoom = 0.6;
	/** Підписи сталого розміру на екрані: масштаб підпису компенсує зум. */
	fixedLabelSize = false;

	constructor(private host: HTMLElement, private cb: RendererCallbacks) {}

	async init(theme: ThemeColors): Promise<void> {
		const { clientWidth: w, clientHeight: h } = this.host;
		await this.app.init({
			width: Math.max(1, w),
			height: Math.max(1, h),
			backgroundAlpha: 0,
			antialias: true,
			autoDensity: true,
			resolution: window.devicePixelRatio || 1,
			autoStart: false,
			preference: "webgl",
		});
		this.host.appendChild(this.app.canvas);
		this.app.canvas.addClass("bases-graph-canvas");
		this.fontFamily = getComputedStyle(this.host).fontFamily || "sans-serif";
		this.setTheme(theme);

		this.world.addChild(this.hullGfx, this.edgeGfx, this.nodeLayer, this.selGfx, this.edgeLabelLayer, this.labelLayer, this.groupLabelLayer);
		this.app.stage.addChild(this.world, this.bandGfx);
		this.tx = w / 2;
		this.ty = h / 2;
		this.bindInput();
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.host);
		this.ready = true;
		this.requestRender();
	}

	setTheme(theme: ThemeColors): void {
		const t = parseColor(theme.text), hl = parseColor(theme.fillHighlight), hlLine = parseColor(theme.lineHighlight);
		this.colors = { text: t.rgb, textAlpha: t.alpha, hl: hl.rgb, hlLine: hlLine.rgb };
	}

	private resize(): void {
		if (!this.ready) return;
		const { clientWidth: w, clientHeight: h } = this.host;
		if (w > 0 && h > 0) {
			this.app.renderer.resize(w, h);
			this.requestRender();
		}
	}

	/** Нова структура графа. `pos` — стартові позиції в порядку вузлів. */
	setGraph(nodes: GNode[], edges: GEdge[], groups: GGroup[], pos: Float32Array): void {
		this.groups = groups;
		this.nodes = nodes;
		this.edges = edges;
		this.pos = pos;
		this.pinned = new Uint8Array(nodes.length);
		this.hover = -1;
		this.gridDirty = true;
		// Виділення лишається для вузлів, що є в новому графі.
		const ids = new Set(nodes.map((n) => n.id));
		for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
		this.hitRadii = Float32Array.from(nodes, (n) => n.radius + n.strokeWidth / 2);
		this.adjacency = nodes.map(() => []);
		for (const e of edges) {
			this.adjacency[e.s].push(e.t);
			this.adjacency[e.t].push(e.s);
		}

		for (const g of this.nodeGfx) g.destroy();
		for (const list of this.labels) for (const l of list) l.destroy({ children: true });
		for (const l of this.edgeLabels) l?.destroy({ children: true });
		for (const l of this.groupLabels) l?.destroy({ children: true });
		this.groupLabelLayer.removeChildren();
		this.nodeLayer.removeChildren();
		this.labelLayer.removeChildren();
		this.edgeLabelLayer.removeChildren();

		this.nodeGfx = nodes.map((n) => {
			const g = new Graphics();
			drawShape(g, n);
			this.nodeLayer.addChild(g);
			return g;
		});
		this.labels = nodes.map((n) => n.labels.map((d) => this.makeLabel(d, this.labelLayer)));
		this.edgeLabels = edges.map((e) => (e.label ? this.makeLabel(e.label, this.edgeLabelLayer) : null));
		this.groupLabels = groups.map((g) => (g.label ? this.makeLabel(g.label, this.groupLabelLayer) : null));
		this.requestRender();
	}

	private makeLabel(d: LabelData, layer: Container): LabelSprite {
		const l = new LabelSprite(d, this.fontFamily);
		layer.addChild(l);
		return l;
	}

	setPositions(pos: Float32Array): void {
		if (pos.length !== this.nodes.length * 2) return;
		this.pos = pos;
		this.gridDirty = true;
		this.lastMove = performance.now();
		this.requestRender();
	}

	setPinned(pinned: Uint8Array): void {
		if (pinned.length === this.nodes.length) this.pinned = pinned;
	}

	getPositions(): Float32Array {
		return this.pos;
	}

	requestRender(): void {
		if (this.dirty) return;
		this.dirty = true;
		this.frame = requestAnimationFrame(() => {
			this.dirty = false;
			this.draw();
		});
	}

	fit(): void {
		const n = this.nodes.length;
		if (!n || !this.ready) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let i = 0; i < n; i++) {
			const x = this.pos[i * 2], y = this.pos[i * 2 + 1], r = this.nodes[i].radius;
			x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
			x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
		}
		const { width: w, height: h } = this.app.screen;
		const s = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)) * 0.9;
		this.scale = clamp(s, MIN_SCALE, 2);
		this.tx = w / 2 - ((x0 + x1) / 2) * this.scale;
		this.ty = h / 2 - ((y0 + y1) / 2) * this.scale;
		this.requestRender();
	}

	private draw(): void {
		if (!this.ready) return;
		const { nodes, edges, pos, scale } = this;
		this.world.position.set(this.tx, this.ty);
		this.world.scale.set(scale);

		const hover = this.hover;
		const related = hover >= 0 ? new Set([hover, ...this.adjacency[hover]]) : null;
		const showAllLabels = scale >= this.labelZoom;
		// Множник розміру підписів: 1 — у світі графа, 1/scale — сталий на екрані.
		const k = this.fixedLabelSize ? 1 / scale : 1;

		// Зв'язки
		const g = this.edgeGfx;
		g.clear();
		for (let i = 0; i < edges.length; i++) {
			const e = edges[i];
			const sx = pos[e.s * 2], sy = pos[e.s * 2 + 1], tx = pos[e.t * 2], ty = pos[e.t * 2 + 1];
			const dx = tx - sx, dy = ty - sy;
			const len = Math.hypot(dx, dy) || 1;
			const ux = dx / len, uy = dy / len;
			const rs = nodes[e.s].radius, rt = nodes[e.t].radius;
			const lbl = this.edgeLabels[i];
			if (len <= rs + rt) {
				if (lbl) lbl.visible = false;
				continue;
			}
			const x1 = sx + ux * rs, y1 = sy + uy * rs, x2 = tx - ux * rt, y2 = ty - uy * rt;
			const incident = hover >= 0 && (e.s === hover || e.t === hover);
			const color = incident ? this.colors.hlLine : e.color;
			const alpha = hover >= 0 && !incident ? e.alpha * 0.2 : e.alpha;
			// Товщина стала на екрані, як у нативному графі.
			const w = e.width / scale;
			g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: w, color, alpha });
			const head = (5 + 2 * e.width) / scale;
			if (e.arrowToTarget) arrow(g, x2, y2, ux, uy, head, color, alpha);
			if (e.arrowToSource) arrow(g, x1, y1, -ux, -uy, head, color, alpha);

			if (lbl) {
				lbl.visible = showAllLabels || incident;
				if (lbl.visible) {
					lbl.scale.set(k);
					this.placeEdgeLabel(lbl, e, sx, sy, ux, uy, len, head, k);
					lbl.alpha = hover >= 0 && !incident ? 0.2 : 1;
				}
			}
		}

		// Вузли й підписи
		for (let i = 0; i < nodes.length; i++) {
			const x = pos[i * 2], y = pos[i * 2 + 1];
			const gfx = this.nodeGfx[i];
			gfx.position.set(x, y);
			const dim = related !== null && !related.has(i);
			gfx.alpha = dim ? 0.2 : 1;
			gfx.tint = i === hover ? this.colors.hl : 0xffffff;
			const list = this.labels[i];
			if (list.length) {
				const visible = showAllLabels || (related !== null && related.has(i));
				for (const l of list) {
					l.visible = visible;
					l.alpha = dim ? 0.2 : 1;
				}
				if (visible) this.placeNodeLabels(i, x, y, k);
			}
		}

		this.drawGroups(k);

		// Виділені вузли — кільце кольором підсвічування.
		const sel = this.selGfx;
		sel.clear();
		if (this.selected.size) {
			for (let i = 0; i < nodes.length; i++) {
				if (!this.selected.has(nodes[i].id)) continue;
				sel.circle(pos[i * 2], pos[i * 2 + 1], this.hitRadii[i] + 4 / scale).stroke({ width: 2 / scale, color: this.colors.hl, alpha: 0.9 });
			}
		}
		// Рамка виділення — у координатах екрана.
		const bg = this.bandGfx;
		bg.clear();
		if (this.band) {
			const { x0, y0, x1, y1 } = this.band;
			bg.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
				.fill({ color: this.colors.hl, alpha: 0.08 })
				.stroke({ width: 1, color: this.colors.hl, alpha: 0.8 });
		}
		this.app.render();
	}

	/**
	 * Стопки підписів вузла: 0 — по центру; 1, 2… — над вузлом, кожен вище попереднього;
	 * −1, −2… — під вузлом. Пропущені індекси не залишають порожнього місця.
	 */
	private placeNodeLabels(i: number, x: number, y: number, k: number): void {
		const n = this.nodes[i];
		const list = this.labels[i];
		const r = n.radius + n.strokeWidth / 2;
		// Розміри й відступи підпису в одиницях світу з урахуванням множника k.
		const nodeGap = LABEL_NODE_GAP * k, stackGap = LABEL_STACK_GAP * k;
		// Над вузлом: індекси за зростанням (1, 2, …).
		let up = y - r - nodeGap;
		for (let j = 0; j < list.length; j++) {
			const idx = n.labels[j].index;
			const l = list[j];
			l.scale.set(k);
			const w = l.w * k, h = l.h * k;
			if (idx === 0) l.position.set(x - w / 2, y - h / 2);
			else if (idx > 0) {
				up -= h;
				l.position.set(x - w / 2, up);
				up -= stackGap;
			}
		}
		// Під вузлом: індекси за спаданням (−1, −2, …), тобто з кінця від'ємної частини.
		let down = y + r + nodeGap;
		for (let j = list.length - 1; j >= 0; j--) {
			if (n.labels[j].index >= 0) continue;
			const l = list[j];
			l.position.set(x - (l.w * k) / 2, down);
			down += l.h * k + stackGap;
		}
	}

	/**
	 * Підпис зв'язку. Прилеглість рахується для всього прямокутника підпису:
	 * при 0% його край торкається вузла-джерела (або стрілки), при 100% — вузла-призначення.
	 * Нахилений підпис іде вздовж лінії над нею і ніколи не перевертається догори дриґом.
	 */
	private placeEdgeLabel(l: LabelSprite, e: GEdge, sx: number, sy: number, ux: number, uy: number, len: number, head: number, k: number): void {
		const d = e.label!;
		const ns = this.nodes[e.s], nt = this.nodes[e.t];
		const tilted = d.mode === "tilted";
		// Протяжність підпису вздовж лінії (для горизонтального — проєкція прямокутника).
		const half = (tilted ? l.w / 2 : (Math.abs(ux) * l.w + Math.abs(uy) * l.h) / 2) * k;
		const a = ns.radius + ns.strokeWidth / 2 + (e.arrowToSource ? head : 0);
		const b = len - nt.radius - nt.strokeWidth / 2 - (e.arrowToTarget ? head : 0);
		const c = b - a <= half * 2 ? (a + b) / 2 : a + half + d.position * (b - a - half * 2);
		const px = sx + ux * c, py = sy + uy * c;

		if (tilted) {
			let ang = Math.atan2(uy, ux);
			if (ang > Math.PI / 2) ang -= Math.PI;
			else if (ang < -Math.PI / 2) ang += Math.PI;
			l.rotation = ang;
			// Низ підпису — трохи над лінією.
			// pivot — у власних одиницях підпису, тому відступ (у світі) ділимо на k.
			l.pivot.set(l.w / 2, l.h + (e.width / this.scale / 2 + 1) / k);
		} else {
			l.rotation = 0;
			// З фоном підпис стоїть на лінії, без фону — над нею, щоб лінія не перекреслювала текст.
			l.pivot.set(l.w / 2, d.backgroundAlpha > 0 ? l.h / 2 : l.h + 1 / k);
		}
		l.position.set(px, py);
	}

	// ---------- Введення ----------

	private toWorld(sx: number, sy: number): [number, number] {
		return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale];
	}

	private local(e: PointerEvent | WheelEvent | MouseEvent): [number, number] {
		const r = this.app.canvas.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	/** Найближчий вузол під точкою екрана або -1. */
	pick(sx: number, sy: number): number {
		const [x, y] = this.toWorld(sx, sy);
		const slop = 4 / this.scale;
		let best = -1, bestD = Infinity;
		const test = (i: number) => {
			const d = Math.hypot(this.pos[i * 2] - x, this.pos[i * 2 + 1] - y);
			if (d <= this.hitRadii[i] + slop && d < bestD) { best = i; bestD = d; }
		};
		// Поки симуляція рухає вузли, перебудова індексу на кожен рух миші дорожча
		// за повний перебір, тому індекс будується, лише коли граф зупинився.
		if (this.gridDirty && performance.now() - this.lastMove < GRID_SETTLE_MS) {
			for (let i = 0; i < this.nodes.length; i++) test(i);
			return best;
		}
		if (this.gridDirty) {
			this.grid.build(this.pos, this.hitRadii, this.nodes.length);
			this.gridDirty = false;
		}
		const cand = this.grid.query(x, y, slop, this.candidates);
		for (const i of cand) test(i);
		cand.length = 0;
		return best;
	}

	private setHover(i: number): void {
		if (i === this.hover) return;
		this.hover = i;
		this.app.canvas.style.cursor = i >= 0 ? "pointer" : "";
		this.requestRender();
	}

	/**
	 * Обведення груп: опукла оболонка кіл членів (з відступом) — заливка кольором групи
	 * з прозорістю й щільніший контур. Підпис групи — над оболонкою по центру.
	 */
	private drawGroups(k: number): void {
		const g = this.hullGfx;
		g.clear();
		const scale = this.scale;
		this.groups.forEach((grp, gi) => {
			const pts = hullPoints(grp.members, this.pos, this.hitRadii, GROUP_PADDING);
			const hull = convexHull(pts);
			if (hull.length < 6) return;
			g.poly(hull).fill({ color: grp.color, alpha: grp.alpha * 0.12 })
				.stroke({ width: 1.5 / scale, color: grp.color, alpha: grp.alpha * 0.6 });
			const lbl = this.groupLabels[gi];
			if (!lbl) return;
			let minX = Infinity, maxX = -Infinity, minY = Infinity;
			for (let i = 0; i < hull.length; i += 2) {
				minX = Math.min(minX, hull[i]); maxX = Math.max(maxX, hull[i]);
				minY = Math.min(minY, hull[i + 1]);
			}
			lbl.scale.set(k);
			lbl.position.set((minX + maxX) / 2 - (lbl.w * k) / 2, minY - lbl.h * k - 3 * k);
		});
	}

	// ---------- Виділення ----------

	getSelectedIndices(): number[] {
		const out: number[] = [];
		this.nodes.forEach((n, i) => { if (this.selected.has(n.id)) out.push(i); });
		return out;
	}

	isSelected(i: number): boolean {
		return !!this.nodes[i] && this.selected.has(this.nodes[i].id);
	}

	clearSelection(): void {
		if (!this.selected.size) return;
		this.selected.clear();
		this.selectionChanged();
	}

	selectAll(): void {
		for (const n of this.nodes) this.selected.add(n.id);
		this.selectionChanged();
	}

	private toggleSelected(i: number): void {
		const id = this.nodes[i].id;
		if (this.selected.has(id)) this.selected.delete(id);
		else this.selected.add(id);
		this.selectionChanged();
	}

	private selectionChanged(): void {
		this.cb.onSelectionChange(this.selected.size);
		this.requestRender();
	}

	private selectInBand(): void {
		const b = this.band!;
		const [ax, ay] = this.toWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
		const [bx, by] = this.toWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
		for (let i = 0; i < this.nodes.length; i++) {
			const x = this.pos[i * 2], y = this.pos[i * 2 + 1];
			if (x >= ax && x <= bx && y >= ay && y <= by) this.selected.add(this.nodes[i].id);
		}
		this.selectionChanged();
	}

	// ---------- Введення ----------

	private bindInput(): void {
		const c = this.app.canvas;
		c.style.touchAction = "none";
		c.tabIndex = 0;

		c.addEventListener("pointerdown", (e) => {
			c.setPointerCapture(e.pointerId);
			c.focus({ preventScroll: true });
			const [x, y] = this.local(e);
			this.pointers.set(e.pointerId, { x, y });
			if (this.pointers.size === 2) {
				// Другий палець — щипок, скасовує натискання.
				if (this.press) { clearTimeout(this.press.timer); this.finishPress(null); this.press = null; }
				this.startPinch();
				return;
			}
			const node = this.pick(x, y);
			const touchSelect = this.selectMode && e.pointerType !== "mouse";
			// Shift: по вузлу — виділення окремого вузла, по порожньому місцю — рамка.
			const toggle = e.shiftKey || touchSelect;
			const press: Press = {
				id: e.pointerId, node, x, y, moved: false, menu: false, timer: 0,
				toggle, rope: e.ctrlKey || e.metaKey,
				action: node >= 0 ? "drag" : toggle ? "band" : "pan",
				drag: null,
			};
			if (node >= 0 && e.pointerType !== "mouse") {
				press.timer = window.setTimeout(() => {
					if (!press.moved) { press.menu = true; this.cb.onNodeMenu(node, e); }
				}, LONG_PRESS_MS);
			}
			this.press = press;
			if (node >= 0) this.setHover(node);
		});

		c.addEventListener("pointermove", (e) => {
			const [x, y] = this.local(e);
			const p = this.pointers.get(e.pointerId);
			if (p) { p.x = x; p.y = y; }

			if (this.pinch && this.pointers.size === 2) { this.updatePinch(); return; }
			const press = this.press;
			if (press && press.id === e.pointerId) {
				if (!press.moved && Math.hypot(x - press.x, y - press.y) > CLICK_SLOP) {
					press.moved = true;
					clearTimeout(press.timer);
					if (press.action === "drag" && !press.menu) this.beginDrag(press);
					if (press.action === "band") this.band = { x0: press.x, y0: press.y, x1: x, y1: y };
				}
				if (!press.moved || press.menu) return;
				if (press.action === "drag") this.continueDrag(press, x, y);
				else if (press.action === "band") {
					this.band!.x1 = x;
					this.band!.y1 = y;
					this.requestRender();
				} else {
					this.tx += x - press.x;
					this.ty += y - press.y;
					press.x = x;
					press.y = y;
					this.requestRender();
				}
				return;
			}
			if (e.pointerType === "mouse") this.setHover(this.pick(x, y));
		});

		const up = (e: PointerEvent) => {
			this.pointers.delete(e.pointerId);
			if (this.pinch && this.pointers.size < 2) this.pinch = null;
			const press = this.press;
			if (!press || press.id !== e.pointerId) return;
			clearTimeout(press.timer);
			this.press = null;
			if (press.menu) return;
			this.finishPress(e.type === "pointerup" ? e : null, press);
			if (e.pointerType !== "mouse") this.setHover(-1);
		};
		c.addEventListener("pointerup", up);
		c.addEventListener("pointercancel", up);
		c.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !this.press) this.setHover(-1); });

		c.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const [x, y] = this.local(e);
			const node = this.pick(x, y);
			if (node >= 0 && !(e as PointerEvent).pointerType?.startsWith("touch")) this.cb.onNodeMenu(node, e);
		});

		c.addEventListener("wheel", (e) => {
			e.preventDefault();
			const [x, y] = this.local(e);
			const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
			this.zoomAt(x, y, this.scale * factor);
		}, { passive: false });

		c.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				this.clearSelection();
				e.preventDefault();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
				this.selectAll();
				e.preventDefault();
			}
		});
	}

	/** Перетягується все виділення, якщо вузол у ньому, інакше — лише цей вузол. */
	private beginDrag(press: Press): void {
		if (press.toggle && !this.isSelected(press.node)) this.toggleSelected(press.node);
		const indices = this.isSelected(press.node) ? this.getSelectedIndices() : [press.node];
		const [wx, wy] = this.toWorld(press.x, press.y);
		const offsets: number[] = [];
		for (const i of indices) offsets.push(this.pos[i * 2] - wx, this.pos[i * 2 + 1] - wy);
		press.drag = { indices, offsets };
		this.cb.onDragStart(indices, press.rope);
	}

	private continueDrag(press: Press, x: number, y: number): void {
		const d = press.drag;
		if (!d) return;
		const [wx, wy] = this.toWorld(x, y);
		const xy: number[] = [];
		d.indices.forEach((i, k) => {
			const nx = wx + d.offsets[k * 2], ny = wy + d.offsets[k * 2 + 1];
			this.pos[i * 2] = nx;
			this.pos[i * 2 + 1] = ny;
			xy.push(nx, ny);
		});
		this.gridDirty = true;
		this.cb.onDrag(d.indices, xy);
		this.requestRender();
	}

	/** Завершення натискання: кінець перетягування, рамки або клік (одиночний, подвійний, виділення). */
	private finishPress(e: PointerEvent | null, press: Press | null = this.press): void {
		if (!press) return;
		if (press.moved) {
			if (press.drag) {
				const xy: number[] = [];
				for (const i of press.drag.indices) xy.push(this.pos[i * 2], this.pos[i * 2 + 1]);
				this.cb.onDragEnd(press.drag.indices, xy);
			} else if (press.action === "band" && this.band) {
				this.selectInBand();
				this.band = null;
				this.requestRender();
			}
			return;
		}
		if (!e || e.button !== 0) return;
		if (press.node < 0) {
			if (!press.toggle) this.clearSelection();
			return;
		}
		if (press.toggle) {
			this.toggleSelected(press.node);
			return;
		}
		// Подвійний клік відкриває в новій вкладці; одиночний чекає, чи не буде другого.
		const now = performance.now();
		const node = press.node;
		if (this.lastClick && this.lastClick.node === node && now - this.lastClick.time < DOUBLE_CLICK_MS) {
			window.clearTimeout(this.clickTimer);
			this.lastClick = null;
			this.cb.onNodeDoubleClick(node, e);
			return;
		}
		this.lastClick = { node, time: now };
		window.clearTimeout(this.clickTimer);
		this.clickTimer = window.setTimeout(() => {
			this.lastClick = null;
			this.cb.onNodeClick(node, e);
		}, DOUBLE_CLICK_MS);
	}

	private startPinch(): void {
		const [a, b] = [...this.pointers.values()];
		this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
	}

	private updatePinch(): void {
		const pinch = this.pinch!;
		const [a, b] = [...this.pointers.values()];
		const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
		this.tx += mx - pinch.mx;
		this.ty += my - pinch.my;
		pinch.mx = mx;
		pinch.my = my;
		this.zoomAt(mx, my, pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
	}

	private zoomAt(sx: number, sy: number, next: number): void {
		const s = clamp(next, MIN_SCALE, MAX_SCALE);
		const [wx, wy] = this.toWorld(sx, sy);
		this.scale = s;
		this.tx = sx - wx * s;
		this.ty = sy - wy * s;
		this.requestRender();
	}

	destroy(): void {
		cancelAnimationFrame(this.frame);
		this.resizeObserver?.disconnect();
		if (this.press) clearTimeout(this.press.timer);
		window.clearTimeout(this.clickTimer);
		if (this.ready) this.app.destroy(true, { children: true });
		this.ready = false;
	}
}

/** Відступ оболонки групи від краю вузлів (одиниці світу). */
const GROUP_PADDING = 14;
/** Скільки точок кола береться для кожного вузла оболонки. */
const HULL_SAMPLES = 12;
/** Для великих груп кола беруться лише для вузлів на краю групи та найбільших вузлів. */
const HULL_FULL_LIMIT = 300;

/** Точки кіл навколо членів групи: [x0, y0, x1, y1, …]. */
function hullPoints(members: number[], pos: Float32Array, radii: Float32Array, pad: number): number[] {
	let list = members;
	if (members.length > HULL_FULL_LIMIT) {
		const centers: number[] = [];
		for (const i of members) centers.push(pos[i * 2], pos[i * 2 + 1]);
		const edge = new Set(convexHullIndices(centers).map((k) => members[k]));
		const big = [...members].sort((a, b) => radii[b] - radii[a]).slice(0, 50);
		for (const i of big) edge.add(i);
		list = [...edge];
	}
	const out: number[] = [];
	for (const i of list) {
		const x = pos[i * 2], y = pos[i * 2 + 1], r = radii[i] + pad;
		for (let s = 0; s < HULL_SAMPLES; s++) {
			const a = (s / HULL_SAMPLES) * Math.PI * 2;
			out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
		}
	}
	return out;
}

/** Опукла оболонка (монотонний ланцюг Ендрю): індекси точок у порядку обходу. */
function convexHullIndices(flat: number[]): number[] {
	const n = flat.length / 2;
	if (n < 3) return [...Array(n).keys()];
	const idx = [...Array(n).keys()].sort((a, b) => flat[a * 2] - flat[b * 2] || flat[a * 2 + 1] - flat[b * 2 + 1]);
	const cross = (o: number, a: number, b: number) =>
		(flat[a * 2] - flat[o * 2]) * (flat[b * 2 + 1] - flat[o * 2 + 1]) - (flat[a * 2 + 1] - flat[o * 2 + 1]) * (flat[b * 2] - flat[o * 2]);
	const lower: number[] = [];
	for (const p of idx) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: number[] = [];
	for (let k = idx.length - 1; k >= 0; k--) {
		const p = idx[k];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
		upper.push(p);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function convexHull(flat: number[]): number[] {
	const out: number[] = [];
	for (const k of convexHullIndices(flat)) out.push(flat[k * 2], flat[k * 2 + 1]);
	return out;
}

function drawShape(g: Graphics, n: GNode): void {
	const r = n.radius;
	switch (n.shape) {
		case "square": {
			const a = r * 0.886; // площа як у кола
			g.rect(-a, -a, a * 2, a * 2);
			break;
		}
		case "diamond":
			g.poly([0, -r * 1.25, r * 1.25, 0, 0, r * 1.25, -r * 1.25, 0]);
			break;
		case "triangle": {
			const k = r * 1.35;
			g.poly([0, -k, k * 0.866, k * 0.5, -k * 0.866, k * 0.5]);
			break;
		}
		default:
			g.circle(0, 0, r);
	}
	g.fill({ color: n.color, alpha: n.alpha });
	if (n.strokeWidth > 0) g.stroke({ width: n.strokeWidth, color: n.stroke, alpha: n.strokeAlpha, alignment: 0.5 });
}

function arrow(g: Graphics, x: number, y: number, ux: number, uy: number, size: number, color: number, alpha: number): void {
	const bx = x - ux * size, by = y - uy * size;
	const px = -uy * size * 0.5, py = ux * size * 0.5;
	g.poly([x, y, bx + px, by + py, bx - px, by - py]).fill({ color, alpha });
}

function clamp(v: number, a: number, b: number): number {
	return Math.max(a, Math.min(b, v));
}
