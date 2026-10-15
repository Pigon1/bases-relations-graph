import { Application, Container, Graphics, Text } from "pixi.js";
import type { GEdge, GNode } from "../model/build";
import { parseColor } from "../model/color";
import type { ThemeColors } from "../model/types";
import { SpatialGrid } from "./spatial";

export interface RendererCallbacks {
	onNodeClick(index: number, ev: PointerEvent): void;
	onNodeMenu(index: number, ev: MouseEvent | PointerEvent): void;
	onDrag(index: number, x: number, y: number): void;
	onDragEnd(index: number): void;
}

const LONG_PRESS_MS = 550;
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
	private nodeLayer = new Container();
	private labelLayer = new Container();
	private edgeLabelLayer = new Container();

	private nodes: GNode[] = [];
	private edges: GEdge[] = [];
	private adjacency: number[][] = [];
	private nodeGfx: Graphics[] = [];
	private labels: (Text | null)[] = [];
	private edgeLabels: (Text | null)[] = [];
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
	private press: { id: number; node: number; x: number; y: number; moved: boolean; menu: boolean; timer: number } | null = null;
	private pinch: { dist: number; scale: number; mx: number; my: number } | null = null;

	labelZoom = 0.6;

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

		this.world.addChild(this.edgeGfx, this.nodeLayer, this.edgeLabelLayer, this.labelLayer);
		this.app.stage.addChild(this.world);
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
	setGraph(nodes: GNode[], edges: GEdge[], pos: Float32Array): void {
		this.nodes = nodes;
		this.edges = edges;
		this.pos = pos;
		this.pinned = new Uint8Array(nodes.length);
		this.hover = -1;
		this.gridDirty = true;
		this.hitRadii = Float32Array.from(nodes, (n) => n.radius + n.strokeWidth / 2);
		this.adjacency = nodes.map(() => []);
		for (const e of edges) {
			this.adjacency[e.s].push(e.t);
			this.adjacency[e.t].push(e.s);
		}

		for (const g of this.nodeGfx) g.destroy();
		for (const l of this.labels) l?.destroy();
		for (const l of this.edgeLabels) l?.destroy();
		this.nodeLayer.removeChildren();
		this.labelLayer.removeChildren();
		this.edgeLabelLayer.removeChildren();

		this.nodeGfx = nodes.map((n) => {
			const g = new Graphics();
			drawShape(g, n);
			this.nodeLayer.addChild(g);
			return g;
		});
		this.labels = nodes.map((n) => (n.label ? this.makeText(n.label, 12, this.labelLayer) : null));
		this.edgeLabels = edges.map((e) => (e.label ? this.makeText(e.label, 10, this.edgeLabelLayer) : null));
		this.requestRender();
	}

	private makeText(text: string, size: number, layer: Container): Text {
		const t = new Text({
			text,
			style: { fontFamily: this.fontFamily, fontSize: size, fill: this.colors.text },
			resolution: 2,
		});
		t.anchor.set(0.5, 0);
		t.alpha = this.colors.textAlpha;
		layer.addChild(t);
		return t;
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
			if (len <= rs + rt) continue;
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

			const lbl = this.edgeLabels[i];
			if (lbl) {
				lbl.visible = showAllLabels || incident;
				if (lbl.visible) {
					lbl.position.set((x1 + x2) / 2, (y1 + y2) / 2);
					lbl.alpha = alpha * this.colors.textAlpha;
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
			const lbl = this.labels[i];
			if (lbl) {
				lbl.visible = showAllLabels || (related !== null && related.has(i));
				if (lbl.visible) {
					lbl.position.set(x, y + nodes[i].radius + 3);
					lbl.alpha = (dim ? 0.2 : 1) * this.colors.textAlpha;
				}
			}
		}
		this.app.render();
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

	private bindInput(): void {
		const c = this.app.canvas;
		c.style.touchAction = "none";

		c.addEventListener("pointerdown", (e) => {
			c.setPointerCapture(e.pointerId);
			const [x, y] = this.local(e);
			this.pointers.set(e.pointerId, { x, y });
			if (this.pointers.size === 2) {
				// Другий палець — щипок, скасовує натискання.
				if (this.press) { clearTimeout(this.press.timer); this.endDrag(); this.press = null; }
				this.startPinch();
				return;
			}
			const node = this.pick(x, y);
			const press = { id: e.pointerId, node, x, y, moved: false, menu: false, timer: 0 };
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
				}
				if (!press.moved || press.menu) return;
				if (press.node >= 0) {
					const [wx, wy] = this.toWorld(x, y);
					this.pos[press.node * 2] = wx;
					this.pos[press.node * 2 + 1] = wy;
					this.gridDirty = true;
					this.cb.onDrag(press.node, wx, wy);
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
			if (press.node >= 0 && press.moved) this.cb.onDragEnd(press.node);
			else if (press.node >= 0 && !press.moved && e.type === "pointerup" && e.button === 0) this.cb.onNodeClick(press.node, e);
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
	}

	private endDrag(): void {
		if (this.press && this.press.node >= 0 && this.press.moved) this.cb.onDragEnd(this.press.node);
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
		if (this.ready) this.app.destroy(true, { children: true });
		this.ready = false;
	}
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
