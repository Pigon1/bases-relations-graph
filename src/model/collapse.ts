import type { GEdge, GGroup, GNode, GraphModel } from "./build";
import { parseColor } from "./color";
import { NODE_LABEL_SIZE, type ThemeColors } from "./types";

/** Префікс id вузла згорнутої групи (не може збігтися зі шляхом файлу). */
export const GROUP_NODE_PREFIX = "\u0001group:";

/** Згорнута група: вузол, що її заміняє, і що всередині (для «підглядання»). */
/** Зв'язок члена згорнутої групи з вузлом поза нею. */
export interface ExternalLink {
	/** Індекс у members. */
	member: number;
	/** Індекс зовнішнього вузла в моделі після згортання. */
	node: number;
	color: number;
	alpha: number;
	width: number;
}

export interface CollapsedGroup {
	group: GGroup;
	/** Вузли-члени в початковому вигляді. */
	members: GNode[];
	/** Зв'язки між членами: індекси в members. */
	internal: GEdge[];
	/** Зв'язки членів із зовнішніми вузлами (для оверлею). */
	external: ExternalLink[];
}

export interface ViewModel extends GraphModel {
	/** Індекс вузла в моделі → згорнута група, яку він заміняє. */
	collapsed: Map<number, CollapsedGroup>;
}

export function isGroupNode(id: string): boolean {
	return id.startsWith(GROUP_NODE_PREFIX);
}

/** Розмір вузла згорнутої групи росте з кількістю членів. */
function groupRadius(count: number): number {
	return Math.max(12, Math.min(60, 6 + 8 * Math.sqrt(count)));
}

/**
 * Згортає групи: члени згорнутої групи ховаються і заміняються одним вузлом; їхні
 * зв'язки з рештою графа переходять на цей вузол (без повторів), внутрішні — ховаються.
 * Вузол, що належить кільком згорнутим групам, потрапляє в першу з них.
 */
export function collapseGroups(model: GraphModel, collapsed: Set<string>, theme: ThemeColors): ViewModel {
	const active = model.groups.filter((g) => collapsed.has(g.id));
	if (!active.length) return { ...model, collapsed: new Map() };

	const owner = new Int32Array(model.nodes.length).fill(-1);
	active.forEach((g, k) => { for (const i of g.members) if (owner[i] < 0) owner[i] = k; });

	const nodes: GNode[] = [];
	const remap = new Int32Array(model.nodes.length).fill(-1);
	model.nodes.forEach((n, i) => {
		if (owner[i] >= 0) return;
		remap[i] = nodes.length;
		nodes.push(n);
	});

	const result = new Map<number, CollapsedGroup>();
	const groupIndex = new Int32Array(active.length).fill(-1);
	const local = new Int32Array(model.nodes.length).fill(-1);
	active.forEach((g, k) => {
		const members = g.members.filter((i) => owner[i] === k);
		if (!members.length) return;
		members.forEach((i, j) => { local[i] = j; });
		groupIndex[k] = nodes.length;
		nodes.push(groupNode(g, members.length, theme));
		result.set(groupIndex[k], { group: g, members: members.map((i) => model.nodes[i]), internal: [], external: [] });
	});
	model.nodes.forEach((_, i) => { if (owner[i] >= 0) remap[i] = groupIndex[owner[i]]; });

	const edges: GEdge[] = [];
	const seen = new Set<string>();
	const seenExternal = new Set<string>();
	/** Член згорнутої групи (кінець a) — зв'язок із вузлом на кінці b. */
	const addExternal = (a: number, b: number, e: GEdge) => {
		const info = owner[a] >= 0 ? result.get(groupIndex[owner[a]]) : undefined;
		if (!info || remap[b] < 0) return;
		const key = groupIndex[owner[a]] + ":" + local[a] + ">" + remap[b];
		if (seenExternal.has(key)) return;
		seenExternal.add(key);
		info.external.push({ member: local[a], node: remap[b], color: e.color, alpha: e.alpha, width: e.width });
	};
	for (const e of model.edges) {
		const s = remap[e.s], t = remap[e.t];
		if (s < 0 || t < 0) continue;
		if (owner[e.s] !== owner[e.t]) {
			addExternal(e.s, e.t, e);
			addExternal(e.t, e.s, e);
		}
		if (s === t) {
			// Внутрішній зв'язок згорнутої групи — показується лише при підгляданні.
			const info = result.get(s);
			if (info && owner[e.s] === owner[e.t]) info.internal.push({ ...e, s: local[e.s], t: local[e.t] });
			continue;
		}
		if (s === e.s && t === e.t) {
			edges.push(e);
			continue;
		}
		const key = s + ">" + t;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ ...e, s, t });
	}

	const groups = model.groups
		.filter((g) => !collapsed.has(g.id))
		.map((g) => ({ ...g, members: g.members.filter((i) => owner[i] < 0).map((i) => remap[i]) }))
		.filter((g) => g.members.length > 0);

	return { nodes, edges, groups, errors: model.errors, collapsed: result };
}

function groupNode(g: GGroup, count: number, theme: ThemeColors): GNode {
	const text = `${g.label?.text ?? g.name} (${count})`;
	const base = g.label ?? {
		text, size: NODE_LABEL_SIZE, color: parseColor(theme.text).rgb, alpha: parseColor(theme.text).alpha,
		background: 0, backgroundAlpha: 0,
	};
	return {
		id: GROUP_NODE_PREFIX + g.id,
		labels: [{ ...base, text, index: -1 }],
		shape: "circle",
		color: g.color,
		alpha: g.alpha * 0.35,
		radius: groupRadius(count),
		stroke: g.color,
		strokeAlpha: g.alpha,
		strokeWidth: 3,
	};
}
