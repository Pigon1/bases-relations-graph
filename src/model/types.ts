/** Дерево фільтра у форматі Bases: рядок-вираз або група and/or/not. */
export type FilterTree = string | { and: FilterTree[] } | { or: FilterTree[] } | { not: FilterTree[] };

export type Shape = "circle" | "square" | "diamond" | "triangle";
export type Visibility = "show" | "hide" | "linked";

export type LabelMode = "horizontal" | "tilted";

export const NODE_LABEL_SIZE = 12;
export const EDGE_LABEL_SIZE = 10;

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
	/**
	 * Місце підпису: 0 — по центру вузла, 1, 2… — над вузлом (2 над 1), −1, −2… — під ним.
	 * Каскад підписів іде окремо для кожного індексу; порожньо = −1.
	 */
	labelIndex?: number | null;
	labelSize?: number | null;
	labelColor?: string | null;
	labelBackground?: string | null;
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
	labelMode?: LabelMode | null;
	/** 0 — біля вузла-джерела, 100 — біля вузла-призначення (відносно напряму правила). */
	labelPosition?: number | null;
	labelSize?: number | null;
	labelColor?: string | null;
	labelBackground?: string | null;
}

/** Підпис групи: її назва, довільний текст або без підпису. */
/** Підпис групи: як у Nodes (без підпису / текст / властивість) плюс значення, за яким групуємо. */
export type GroupLabel = LabelSpec | { type: "value" };

/** MANUAL — як «Вручну» в Bases: лише вибрані значення, у заданому порядку. */
export type GroupDirection = "ASC" | "DESC" | "MANUAL";

/** Колір підпису групи, що наслідує колір самої групи. */
export const GROUP_COLOR_AUTO = "@group";

/**
 * Рядок таблиці Groups — як кнопка «Групувати» в Bases: вузли групуються за значенням
 * властивості groupBy, і кожне окреме значення дає окрему групу. Вузли без значення
 * в групи не потрапляють. Порядок груп (і кольори палітри) — за direction.
 * Колір без значення — з палітри, окремий для кожної групи.
 */
export interface GroupRule {
	id: string;
	name: string;
	enabled: boolean;
	groupBy: string | null;
	direction: GroupDirection | null;
	/** Для MANUAL: ключі показаних значень у потрібному порядку; решта значень груп не утворює. */
	order?: string[] | null;
	color: string | null;
	/** null — значення групи. */
	label: GroupLabel | null;
	labelSize: number | null;
	/** GROUP_COLOR_AUTO — колір групи. */
	labelColor: string | null;
	labelBackground: string | null;
}

export const GROUP_LABEL_SIZE = 12;

/** Палітра груп за замовчуванням. */
export const GROUP_PALETTE = [
	"#4ecdc4", "#5bc06c", "#a78bfa", "#f59e42", "#ef5b5b",
	"#5b9cf5", "#e879b9", "#d4b84a", "#9b8574", "#8d99ae",
];

export function paletteColor(index: number): string {
	return GROUP_PALETTE[index % GROUP_PALETTE.length];
}

export interface GraphTables {
	nodes: NodeRule[];
	edges: EdgeRule[];
	/** У старих поданнях груп може не бути. */
	groups: GroupRule[];
}

/** Налаштування подання (опції Bases). */
export type LayoutKind = "force" | "frozen" | "tree";
export type TreeLinkStyle = "curved" | "straight" | "orthogonal";

export interface GraphSettings {
	/** force — жива фізика; frozen — фізика вимкнена, вузли стоять, де їх поставили. */
	layout: LayoutKind;
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	labelZoom: number;
	/** Притягання вузлів до центру їхньої групи (0–1). */
	groupForce: number;
	/** Відштовхування груп одна від одної (0–1). */
	groupSeparation: number;
	showLegend: boolean;
	/** Дерево: відстань між рівнями і між сусідами в рівні. */
	treeLevelGap: number;
	treeSiblingGap: number;
	treeLinkStyle: TreeLinkStyle;
	/** Дерево: члени групи, ближчі за стільки «клітинок», обводяться разом (мінімум 1). */
	groupStretch: number;
	/** Підписи сталого розміру на екрані (не масштабуються разом із графом). */
	fixedLabelSize: boolean;
	savePositions: boolean;
}

export const DEFAULT_SETTINGS: GraphSettings = {
	layout: "force",
	centerStrength: 0.52,
	repelStrength: 10,
	linkStrength: 1,
	linkDistance: 250,
	labelZoom: 0.6,
	groupForce: 0.3,
	groupSeparation: 0.5,
	showLegend: true,
	treeLevelGap: 150,
	treeSiblingGap: 30,
	treeLinkStyle: "curved",
	groupStretch: 2,
	fixedLabelSize: false,
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
	/** Тло нотатки — типовий колір фону підписів. */
	background: string;
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
			// Шаблон нотатки-з'єднувача: subjects → objects, підпис — relations.
			// Якщо таких властивостей у сховищі немає, рядок просто не дає зв'язків.
			{
				id: newId("e"),
				name: "Connector notes",
				enabled: true,
				source: "note.subjects",
				sourceValue: null,
				target: "note.objects",
				targetValue: null,
				arrowToSource: false,
				arrowToTarget: true,
				color: null,
				widthProperty: null,
				widthValue: null,
				label: { type: "property", property: "note.relations" },
				labelMode: "tilted",
			},
		],
		groups: [],
	};
}

export function emptyGroupRule(): GroupRule {
	return {
		id: newId("g"), name: "", enabled: true, groupBy: null, direction: null, color: null,
		label: null, labelSize: null, labelColor: GROUP_COLOR_AUTO, labelBackground: null,
	};
}

export function emptyNodeRule(): NodeRule {
	return {
		id: newId("n"), name: "", enabled: true, condition: null,
		shape: null, color: null, strokeColor: null, strokeWidth: null, sizeProperty: null, sizeValue: null,
		label: null, labelIndex: null, labelSize: null, labelColor: null, labelBackground: null, show: null,
	};
}

export function emptyEdgeRule(): EdgeRule {
	return {
		id: newId("e"), name: "", enabled: true,
		source: SOURCE_NOTE, sourceValue: null, target: TARGET_ALL_LINKS, targetValue: null,
		arrowToSource: null, arrowToTarget: null, color: null, widthProperty: null, widthValue: null,
		label: null, labelMode: null, labelPosition: null, labelSize: null, labelColor: null, labelBackground: null,
	};
}
