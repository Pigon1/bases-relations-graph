import type { BasesEntry } from "obsidian";
import type { BasesEvaluator, CompiledFilter } from "../bases/evaluator";
import { getValue, linkedPaths, toNumber, toText } from "../bases/values";
import { parseColor } from "./color";
import {
	FIXED, LINK_COUNT, SOURCE_NOTE, TARGET_ALL_LINKS,
	type EdgeRule, type GraphTables, type LabelSpec, type NodeRule, type Shape, type ThemeColors, type Visibility,
} from "./types";

export interface GNode {
	id: string;
	label: string | null;
	shape: Shape;
	color: number;
	alpha: number;
	radius: number;
	stroke: number;
	strokeAlpha: number;
	/** 0 — без обведення. */
	strokeWidth: number;
}

export interface GEdge {
	s: number;
	t: number;
	color: number;
	alpha: number;
	width: number;
	arrowToSource: boolean;
	arrowToTarget: boolean;
	label: string | null;
	/** Нотатка-з'єднувач, з якої взято зв'язок (для кліку). */
	connector: string | null;
}

export interface GraphModel {
	nodes: GNode[];
	edges: GEdge[];
	/** Помилки умов: id правила → текст. */
	errors: Map<string, string>;
}

interface EdgeMatch {
	rule: EdgeRule;
	/** Напрям правила збігається з канонічним напрямом зв'язку. */
	forward: boolean;
	/** Запис, з якого читаються властивості ширини й підпису. */
	owner: BasesEntry;
	connector: string | null;
}

interface PendingEdge {
	from: string;
	to: string;
	matches: EdgeMatch[];
}

const MIN_RADIUS = 2;

/** Розмір як у нативному графі: множник × clamp(3·√(зв'язків+1), 8, 30). */
function nativeRadius(degree: number): number {
	return Math.max(8, Math.min(3 * Math.sqrt(degree + 1), 30));
}

function readLabel(spec: LabelSpec | null, entry: BasesEntry | null): string | null {
	if (!spec || spec.type === "none") return null;
	if (spec.type === "text") return spec.text.trim() || null;
	return entry ? toText(getValue(entry, spec.property)) : null;
}

export function buildGraph(
	entries: BasesEntry[],
	tables: GraphTables,
	ev: BasesEvaluator,
	theme: ThemeColors,
): GraphModel {
	const errors = new Map<string, string>();
	const byPath = new Map<string, BasesEntry>();
	for (const e of entries) byPath.set(e.file.path, e);

	// ---- 1. Зв'язки ----
	const pending = new Map<string, PendingEdge>();
	const pairKey = (a: string, b: string) => (a < b ? a + "\n" + b : b + "\n" + a);

	for (const rule of tables.edges) {
		if (!rule.enabled) continue;
		const srcCond = ev.filter(rule.sourceValue);
		const tgtCond = ev.filter(rule.targetValue);
		if (srcCond.error) errors.set(rule.id, "Source: " + srcCond.error);
		if (tgtCond.error) errors.set(rule.id, "Target: " + tgtCond.error);
		const passes = memoTest(byPath);

		for (const e of entries) {
			const fromNote = rule.source === SOURCE_NOTE;
			const sources = fromNote ? [e.file.path] : unique(linkedPaths(getValue(e, rule.source)));
			if (!sources.length) continue;

			let targets: string[];
			if (rule.target === TARGET_ALL_LINKS) {
				targets = unique(linkedPaths(getValue(e, "file.links")));
				// Для з'єднувача «усі посилання» не включають посилання самого джерела.
				if (!fromNote) {
					const srcSet = new Set(sources);
					targets = targets.filter((t) => !srcSet.has(t));
				}
			} else {
				targets = unique(linkedPaths(getValue(e, rule.target)));
			}
			if (!targets.length) continue;

			for (const s of sources) {
				if (!passes(srcCond, s)) continue;
				for (const t of targets) {
					if (t === s || !passes(tgtCond, t)) continue;
					const key = pairKey(s, t);
					let p = pending.get(key);
					if (!p) pending.set(key, (p = { from: s, to: t, matches: [] }));
					p.matches.push({
						rule,
						forward: p.from === s,
						owner: e,
						connector: fromNote ? null : e.file.path,
					});
				}
			}
		}
	}

	// ---- 2. Видимість вузлів ----
	const degreeAll = new Map<string, number>();
	for (const p of pending.values()) {
		degreeAll.set(p.from, (degreeAll.get(p.from) ?? 0) + 1);
		degreeAll.set(p.to, (degreeAll.get(p.to) ?? 0) + 1);
	}

	interface NodeStyle {
		shape: Shape | null; color: string | null; strokeColor: string | null; strokeWidth: number | null;
		sizeProperty: string | null; sizeValue: number | null;
		label: LabelSpec | null; show: Visibility | null;
	}
	const styles = new Map<string, NodeStyle>();
	const compiled = tables.nodes.map((r) => {
		const c = r.enabled ? ev.filter(r.condition) : null;
		if (c?.error) errors.set(r.id, c.error);
		return c;
	});

	for (const e of entries) {
		const st: NodeStyle = { shape: null, color: null, strokeColor: null, strokeWidth: null, sizeProperty: null, sizeValue: null, label: null, show: null };
		tables.nodes.forEach((r: NodeRule, i) => {
			const c = compiled[i];
			if (!c || !c.test(e)) return;
			if (r.shape !== null) st.shape = r.shape;
			if (r.color !== null) st.color = r.color;
			if (r.strokeColor != null) st.strokeColor = r.strokeColor;
			if (r.strokeWidth != null) st.strokeWidth = r.strokeWidth;
			if (r.sizeProperty !== null) st.sizeProperty = r.sizeProperty;
			if (r.sizeValue !== null) st.sizeValue = r.sizeValue;
			if (r.label !== null) st.label = r.label;
			if (r.show !== null) st.show = r.show;
		});
		const show = st.show ?? "show";
		if (show === "hide") continue;
		if (show === "linked" && !degreeAll.get(e.file.path)) continue;
		styles.set(e.file.path, st);
	}

	// ---- 3. Видимі зв'язки ----
	const visible = [...pending.values()].filter((p) => styles.has(p.from) && styles.has(p.to));
	const degree = new Map<string, number>();
	for (const p of visible) {
		degree.set(p.from, (degree.get(p.from) ?? 0) + 1);
		degree.set(p.to, (degree.get(p.to) ?? 0) + 1);
	}

	// ---- 4. Вузли ----
	const nodes: GNode[] = [];
	const index = new Map<string, number>();
	const fill = parseColor(theme.fill);
	for (const [path, st] of styles) {
		const e = byPath.get(path)!;
		const c = parseColor(st.color, fill);
		const sc = parseColor(st.strokeColor, parseColor(theme.text));
		const mult = st.sizeValue ?? 1;
		let radius: number;
		const sp = st.sizeProperty ?? LINK_COUNT;
		if (sp === FIXED) radius = mult;
		else if (sp === LINK_COUNT) radius = mult * nativeRadius(degree.get(path) ?? 0);
		else {
			const n = toNumber(getValue(e, sp));
			radius = n === null ? nativeRadius(degree.get(path) ?? 0) : mult * n;
		}
		index.set(path, nodes.length);
		nodes.push({
			id: path,
			label: readLabel(st.label, e),
			shape: st.shape ?? "circle",
			color: c.rgb,
			alpha: c.alpha,
			radius: Math.max(MIN_RADIUS, radius),
			stroke: sc.rgb,
			strokeAlpha: sc.alpha,
			strokeWidth: st.strokeColor === null ? 0 : Math.max(0, st.strokeWidth ?? 1),
		});
	}

	// ---- 5. Стилі зв'язків (каскад) ----
	const line = parseColor(theme.line);
	const edges: GEdge[] = [];
	for (const p of visible) {
		let color: string | null = null, widthProperty: string | null = null, widthValue: number | null = null;
		let label: LabelSpec | null = null, toSrc: boolean | null = null, toTgt: boolean | null = null;
		let owner: BasesEntry | null = null, connector: string | null = null;
		for (const m of p.matches) {
			const r = m.rule;
			if (r.color !== null) color = r.color;
			if (r.widthProperty !== null) { widthProperty = r.widthProperty; owner = m.owner; }
			if (r.widthValue !== null) widthValue = r.widthValue;
			if (r.label !== null) { label = r.label; owner = m.owner; }
			// Стрілки задано відносно напряму правила.
			const aSrc = m.forward ? r.arrowToSource : r.arrowToTarget;
			const aTgt = m.forward ? r.arrowToTarget : r.arrowToSource;
			if (aSrc !== null) toSrc = aSrc;
			if (aTgt !== null) toTgt = aTgt;
			if (m.connector) connector = m.connector;
		}
		const c = parseColor(color, line);
		const wv = widthValue ?? 1;
		let width = wv;
		if (widthProperty && widthProperty !== FIXED && owner) {
			const n = toNumber(getValue(owner, widthProperty));
			if (n !== null) width = wv * n;
		}
		edges.push({
			s: index.get(p.from)!,
			t: index.get(p.to)!,
			color: c.rgb,
			alpha: c.alpha,
			width: Math.max(0.1, width),
			arrowToSource: toSrc ?? false,
			arrowToTarget: toTgt ?? false,
			label: readLabel(label, owner),
			connector,
		});
	}

	return { nodes, edges, errors };
}

function unique(a: string[]): string[] {
	return a.length < 2 ? a : [...new Set(a)];
}

/** Кешує результат умови для кінця зв'язку в межах одного правила. */
function memoTest(byPath: Map<string, BasesEntry>) {
	const cache = new Map<CompiledFilter, Map<string, boolean>>();
	return (f: CompiledFilter, path: string): boolean => {
		const entry = byPath.get(path);
		if (!entry) return false;
		let m = cache.get(f);
		if (!m) cache.set(f, (m = new Map()));
		let r = m.get(path);
		if (r === undefined) m.set(path, (r = f.test(entry)));
		return r;
	};
}
