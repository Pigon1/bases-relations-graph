/** Дерево фільтра у форматі Bases: рядок-вираз або група and/or/not. */
export type FilterTree = string | { and: FilterTree[] } | { or: FilterTree[] } | { not: FilterTree[] };

export type Shape = "circle" | "square" | "diamond" | "triangle";
export type Visibility = "show" | "hide" | "linked";

export type LabelSpec =
	| { type: "none" }
	| { type: "property"; property: string }
	| { type: "text"; text: string };

/** Спеціальні значення для полів «… за властивістю». */
export const FIXED = "@fixed";
export const LINK_COUNT = "@links";
/** Джерело зв'язку — сама нотатка. */
export const SOURCE_NOTE = "@note";
/** Призначення зв'язку — усі вихідні посилання нотатки. */
export const TARGET_ALL_LINKS = "@links";

/**
 * Правило вузлів. `null` у полі стилю = успадкувати від попередніх рядків.
 * Рядки застосовуються згори донизу, пізніші перекривають ранні поле за полем.
 */
export interface NodeRule {
	id: string;
	name: string;
	enabled: boolean;
	condition: FilterTree | null;
	shape: Shape | null;
	color: string | null;
	/** Обведення; у старих таблицях полів може не бути (= null). */
	strokeColor?: string | null;
	strokeWidth?: number | null;
	sizeProperty: string | null;
	sizeValue: number | null;
	label: LabelSpec | null;
	show: Visibility | null;
}

/**
 * Правило зв'язків. Кожен рядок створює зв'язки (джерело → призначення) і стилізує їх.
 * Якщо той самий зв'язок створено кількома рядками, стиль каскадується як у вузлах.
 */
export interface EdgeRule {
	id: string;
	name: string;
	enabled: boolean;
	source: string;
	sourceValue: FilterTree | null;
	target: string;
	targetValue: FilterTree | null;
	arrowToSource: boolean | null;
	arrowToTarget: boolean | null;
	color: string | null;
	widthProperty: string | null;
	widthValue: number | null;
	label: LabelSpec | null;
}

export interface GraphTables {
	nodes: NodeRule[];
	edges: EdgeRule[];
}

/** Налаштування подання (опції Bases). */
export interface GraphSettings {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	labelZoom: number;
	savePositions: boolean;
}

export const DEFAULT_SETTINGS: GraphSettings = {
	centerStrength: 0.52,
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 250,
	labelZoom: 0.6,
	savePositions: true,
};

/** Кольори нативного графа з поточної теми. */
export interface ThemeColors {
	fill: string;
	line: string;
	text: string;
	arrow: string;
	fillHighlight: string;
	lineHighlight: string;
}

export function newId(prefix: string): string {
	return prefix + Math.random().toString(36).slice(2, 9);
}

export function defaultTables(theme: ThemeColors): GraphTables {
	return {
		nodes: [
			{
				id: newId("n"),
				name: "Default",
				enabled: true,
				condition: null,
				shape: "circle",
				color: theme.fill,
				sizeProperty: LINK_COUNT,
				sizeValue: 1,
				label: { type: "property", property: "file.basename" },
				show: "show",
			},
		],
		edges: [
			{
				id: newId("e"),
				name: "Links",
				enabled: true,
				source: SOURCE_NOTE,
				sourceValue: null,
				target: TARGET_ALL_LINKS,
				targetValue: null,
				arrowToSource: false,
				arrowToTarget: false,
				color: theme.line,
				widthProperty: FIXED,
				widthValue: 1,
				label: { type: "none" },
			},
		],
	};
}

export function emptyNodeRule(): NodeRule {
	return {
		id: newId("n"), name: "", enabled: true, condition: null,
		shape: null, color: null, strokeColor: null, strokeWidth: null, sizeProperty: null, sizeValue: null, label: null, show: null,
	};
}

export function emptyEdgeRule(): EdgeRule {
	return {
		id: newId("e"), name: "", enabled: true,
		source: SOURCE_NOTE, sourceValue: null, target: TARGET_ALL_LINKS, targetValue: null,
		arrowToSource: null, arrowToTarget: null, color: null, widthProperty: null, widthValue: null, label: null,
	};
}
