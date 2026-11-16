import { Menu, setIcon, type App } from "obsidian";
import type { BasesEvaluator } from "../bases/evaluator";
import { parseColor, toCss, toHex } from "../model/color";
import {
	emptyEdgeRule, emptyGroupRule, emptyNodeRule, FIXED, GROUP_COLOR_AUTO, paletteColor, LINK_COUNT, SOURCE_NOTE, TARGET_ALL_LINKS,
	type EdgeRule, type FilterTree, type GraphTables, type GroupLabel, type GroupRule, type LabelSpec, type NodeRule, type ThemeColors,
} from "../model/types";
import { ConditionModal, describeCondition } from "./condition";
import { GroupOrderModal } from "./groupOrder";
import { createPicker, type PickItem } from "./picker";
import type { PropertyCatalog } from "./properties";

export interface TablesContext {
	app: App;
	props: PropertyCatalog;
	ev: BasesEvaluator;
	theme: ThemeColors;
	errors: Map<string, string>;
	/** Наявні значення властивості для груп (за зростанням). */
	groupValues(property: string): string[];
	/** structural = рядки додано/видалено/переміщено — таблицю треба перемалювати. */
	onChange(structural: boolean): void;
}

type Opt = [value: string, label: string];
const INHERIT = "";

// ---------- Комірки ----------

function selectCell(td: HTMLElement, opts: Opt[], value: string | null, inherit: boolean, onChange: (v: string | null) => void): HTMLSelectElement {
	const sel = td.createEl("select", { cls: "dropdown" });
	if (inherit) sel.createEl("option", { value: INHERIT, text: "—" });
	for (const [v, l] of opts) sel.createEl("option", { value: v, text: l });
	sel.value = value ?? INHERIT;
	sel.onchange = () => onChange(sel.value === INHERIT ? null : sel.value);
	return sel;
}

function numberCell(td: HTMLElement, value: number | null, onChange: (v: number | null) => void): void {
	const input = td.createEl("input", { type: "number", cls: "bases-relations-graph-num", attr: { step: "any", placeholder: "—" } });
	input.value = value === null ? "" : String(value);
	input.onchange = () => {
		const n = parseFloat(input.value);
		onChange(input.value.trim() === "" || !isFinite(n) ? null : n);
	};
}

/**
 * Колір із прозорістю.
 * - auto: порожнє значення означає не «успадкувати», а автоматичний колір;
 * - followValue: спеціальне значення «Auto — як колір групи», що вибирається з меню.
 */
function colorCell(
	td: HTMLElement, value: string | null, fallback: string, onChange: (v: string | null) => void,
	auto = false, followValue: string | null = null,
): void {
	const wrap = td.createDiv({ cls: "bases-relations-graph-color" });
	const clearButton = () => {
		const clear = wrap.createEl("button", { cls: "clickable-icon", attr: { "aria-label": auto ? "Automatic" : "Inherit" } });
		setIcon(clear, "x");
		clear.onclick = () => { onChange(null); render(null); };
	};
	const render = (v: string | null) => {
		wrap.empty();
		if (followValue !== null && v === followValue) {
			const b = wrap.createEl("button", { text: "Auto", attr: { "aria-label": "Same as the group color. Click to set a color" } });
			b.onclick = () => { onChange(fallback); render(fallback); };
			clearButton();
			return;
		}
		if (v === null) {
			const b = wrap.createEl("button", { text: auto ? "auto" : "—", attr: { "aria-label": auto ? "Automatic color. Click to set a color" : "Inherited. Click to set a color" } });
			b.onclick = (e) => {
				if (followValue === null) { onChange(fallback); render(fallback); return; }
				const menu = new Menu();
				menu.addItem((it) => it.setTitle("Auto (group color)").setIcon("lucide-paintbrush").onClick(() => { onChange(followValue); render(followValue); }));
				menu.addItem((it) => it.setTitle("Custom color").setIcon("lucide-palette").onClick(() => { onChange(fallback); render(fallback); }));
				menu.showAtMouseEvent(e);
			};
			return;
		}
		const c = parseColor(v);
		const picker = wrap.createEl("input", { type: "color" });
		picker.value = toHex(c.rgb);
		const alpha = wrap.createEl("input", { type: "range", attr: { min: "0", max: "100", "aria-label": "Opacity" } });
		alpha.value = String(Math.round(c.alpha * 100));
		const emit = () => onChange(toCss({ rgb: parseInt(picker.value.slice(1), 16), alpha: parseInt(alpha.value, 10) / 100 }));
		picker.oninput = emit;
		alpha.oninput = emit;
		clearButton();
	};
	render(value);
}

function propItems(ctx: TablesContext, linkOnly = false): PickItem[] {
	return (linkOnly ? ctx.props.linkCapable() : ctx.props.all()).map((p) => ({ value: p.id, label: p.name, icon: p.icon }));
}

function pickerCell(td: HTMLElement, items: () => PickItem[], value: string | null, inherit: boolean, onChange: (v: string | null) => void): void {
	createPicker(td, items, value, { inherit }, onChange);
}

function labelCell(td: HTMLElement, ctx: TablesContext, value: LabelSpec | null, onChange: (v: LabelSpec | null) => void): void {
	const items = (): PickItem[] => [
		{ value: "@none", label: "No label", icon: "lucide-ban" },
		{ value: "@text", label: "Text…", icon: "lucide-type" },
		...propItems(ctx),
	];
	const current = value === null ? null : value.type === "none" ? "@none" : value.type === "text" ? "@text" : value.property;
	let text: HTMLInputElement;
	createPicker(td, items, current, { inherit: true }, (v) => {
		if (v === null) onChange(null);
		else if (v === "@none") onChange({ type: "none" });
		else if (v === "@text") onChange({ type: "text", text: text.value });
		else onChange({ type: "property", property: v });
		text.toggle(v === "@text");
		if (v === "@text") text.focus();
	});
	text = td.createEl("input", { type: "text", cls: "bases-relations-graph-label-text", attr: { placeholder: "label text" } });
	text.value = value?.type === "text" ? value.text : "";
	text.toggle(value?.type === "text");
	text.oninput = () => onChange({ type: "text", text: text.value });
}

function conditionCell(td: HTMLElement, ctx: TablesContext, title: string, value: FilterTree | null, onChange: (v: FilterTree | null) => void): void {
	const b = td.createEl("button", { cls: "bases-relations-graph-cond-btn" });
	const text = describeCondition(value);
	setIcon(b.createSpan({ cls: "bases-relations-graph-picker-icon" }), "lucide-list-filter");
	b.createSpan({ text: text.length > 48 ? text.slice(0, 47) + "…" : text });
	b.setAttr("aria-label", text);
	b.onclick = () => new ConditionModal(ctx.app, title, value, ctx.props, ctx.ev, (v) => {
		onChange(v);
		ctx.onChange(true);
	}).open();
}

/** Спільні колонки: порядок, увімкнення, назва. */
function rowControls<T extends { enabled: boolean; name: string; id: string }>(
	tr: HTMLElement, rows: T[], i: number, ctx: TablesContext,
): void {
	const r = rows[i];
	const ord = tr.createEl("td", { cls: "bases-relations-graph-order" });
	ord.createSpan({ text: String(i + 1) });
	const up = ord.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move up" } });
	setIcon(up, "chevron-up");
	up.disabled = i === 0;
	up.onclick = () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; ctx.onChange(true); };
	const down = ord.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move down" } });
	setIcon(down, "chevron-down");
	down.disabled = i === rows.length - 1;
	down.onclick = () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; ctx.onChange(true); };

	const en = tr.createEl("td").createEl("input", { type: "checkbox", attr: { "aria-label": "Enabled" } });
	en.checked = r.enabled;
	en.onchange = () => { r.enabled = en.checked; ctx.onChange(false); };

	const name = tr.createEl("td").createEl("input", { type: "text", cls: "bases-relations-graph-name", attr: { placeholder: "name" } });
	name.value = r.name;
	name.onchange = () => { r.name = name.value; ctx.onChange(false); };
	if (ctx.errors.has(r.id)) {
		tr.addClass("has-error");
		name.title = "⚠ " + ctx.errors.get(r.id);
	}
}

function deleteCell<T>(tr: HTMLElement, rows: T[], i: number, ctx: TablesContext, minRows = 1): void {
	const del = tr.createEl("td").createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete row" } });
	setIcon(del, "trash-2");
	del.disabled = rows.length <= minRows;
	del.onclick = () => { rows.splice(i, 1); ctx.onChange(true); };
}

function header(table: HTMLElement, cols: string[]): void {
	const tr = table.createEl("thead").createEl("tr");
	for (const c of cols) tr.createEl("th", { text: c });
}

const SHAPES: PickItem[] = [
	{ value: "circle", label: "Circle", icon: "lucide-circle" },
	{ value: "square", label: "Square", icon: "lucide-square" },
	{ value: "diamond", label: "Diamond", icon: "lucide-diamond" },
	{ value: "triangle", label: "Triangle", icon: "lucide-triangle" },
];
const SHOW: PickItem[] = [
	{ value: "show", label: "Show", icon: "lucide-eye" },
	{ value: "hide", label: "Hide", icon: "lucide-eye-off" },
	{ value: "linked", label: "Only if linked", icon: "lucide-link" },
];
const ARROW: Opt[] = [["true", "Yes"], ["false", "No"]];
const LABEL_MODES: PickItem[] = [
	{ value: "horizontal", label: "Horizontal", icon: "lucide-move-horizontal" },
	{ value: "tilted", label: "Along the link", icon: "lucide-trending-up" },
];

/** Спільні колонки оформлення підпису: розмір, колір, фон. */
function labelStyleCells(tr: HTMLElement, ctx: TablesContext, r: { labelSize?: number | null; labelColor?: string | null; labelBackground?: string | null }): void {
	numberCell(tr.createEl("td"), r.labelSize ?? null, (v) => { r.labelSize = v; ctx.onChange(false); });
	colorCell(tr.createEl("td"), r.labelColor ?? null, ctx.theme.text, (v) => { r.labelColor = v; ctx.onChange(false); });
	colorCell(tr.createEl("td"), r.labelBackground ?? null, ctx.theme.background, (v) => { r.labelBackground = v; ctx.onChange(false); });
}

// ---------- Таблиця «Nodes» ----------

export function renderNodesTable(el: HTMLElement, tables: GraphTables, ctx: TablesContext): void {
	el.empty();
	el.createDiv({ cls: "bases-relations-graph-hint", text: "Rows apply top to bottom: a later row overrides earlier ones in every field it sets. “—” means inherit. Each row describes one label; its index sets the place: 0 — node center, 1, 2… — above the node, −1, −2… — below it (empty = −1). Rows with the same index override each other, different indices add more labels." });
	const scroll = el.createDiv({ cls: "bases-relations-graph-table-scroll" });
	const table = scroll.createEl("table", { cls: "bases-relations-graph-table" });
	header(table, ["#", "", "Name", "Condition", "Shape", "Color", "Stroke", "Stroke width", "Size by", "Size value", "Label", "Label index", "Font size", "Font color", "Label background", "Visibility", ""]);
	const body = table.createEl("tbody");
	const rows = tables.nodes;
	const sizeItems = (): PickItem[] => [
		{ value: FIXED, label: "Fixed", icon: "lucide-ruler" },
		{ value: LINK_COUNT, label: "Link count", icon: "lucide-git-fork" },
		...propItems(ctx),
	];

	rows.forEach((r: NodeRule, i) => {
		const tr = body.createEl("tr");
		rowControls(tr, rows, i, ctx);
		conditionCell(tr.createEl("td"), ctx, `Condition, row ${i + 1}`, r.condition, (v) => { r.condition = v; });
		pickerCell(tr.createEl("td"), () => SHAPES, r.shape, true, (v) => { r.shape = v as NodeRule["shape"]; ctx.onChange(false); });
		colorCell(tr.createEl("td"), r.color, ctx.theme.fill, (v) => { r.color = v; ctx.onChange(false); });
		colorCell(tr.createEl("td"), r.strokeColor ?? null, ctx.theme.text, (v) => { r.strokeColor = v; ctx.onChange(false); });
		numberCell(tr.createEl("td"), r.strokeWidth ?? null, (v) => { r.strokeWidth = v; ctx.onChange(false); });
		pickerCell(tr.createEl("td"), sizeItems, r.sizeProperty, true, (v) => { r.sizeProperty = v; ctx.onChange(false); });
		numberCell(tr.createEl("td"), r.sizeValue, (v) => { r.sizeValue = v; ctx.onChange(false); });
		labelCell(tr.createEl("td"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
		numberCell(tr.createEl("td"), r.labelIndex ?? null, (v) => { r.labelIndex = v === null ? null : Math.round(v); ctx.onChange(false); });
		labelStyleCells(tr, ctx, r);
		pickerCell(tr.createEl("td"), () => SHOW, r.show, true, (v) => { r.show = v as NodeRule["show"]; ctx.onChange(false); });
		deleteCell(tr, rows, i, ctx);
	});

	el.createEl("button", { text: "+ Add row", cls: "bases-relations-graph-add" }).onclick = () => {
		rows.push(emptyNodeRule());
		ctx.onChange(true);
	};
}

// ---------- Таблиця «Links» ----------

export function renderEdgesTable(el: HTMLElement, tables: GraphTables, ctx: TablesContext): void {
	el.empty();
	el.createDiv({ cls: "bases-relations-graph-hint", text: "Each row creates links. Source “Note” uses the note's own links; a property source turns the note into a connector that links the source value to the target values. Links not described here are not shown." });
	const scroll = el.createDiv({ cls: "bases-relations-graph-table-scroll" });
	const table = scroll.createEl("table", { cls: "bases-relations-graph-table" });
	header(table, ["#", "", "Name", "Source", "Source value", "Target", "Target value", "Arrow to source", "Arrow to target", "Color", "Width by", "Width value", "Label", "Label mode", "Label position, %", "Font size", "Font color", "Label background", ""]);
	const body = table.createEl("tbody");
	const rows = tables.edges;
	const sourceItems = (): PickItem[] => [{ value: SOURCE_NOTE, label: "Note", icon: "lucide-file-text" }, ...propItems(ctx, true)];
	const targetItems = (): PickItem[] => [{ value: TARGET_ALL_LINKS, label: "All outgoing links", icon: "lucide-link" }, ...propItems(ctx, true)];
	const widthItems = (): PickItem[] => [{ value: FIXED, label: "Fixed", icon: "lucide-ruler" }, ...propItems(ctx)];

	rows.forEach((r: EdgeRule, i) => {
		const tr = body.createEl("tr");
		rowControls(tr, rows, i, ctx);
		pickerCell(tr.createEl("td"), sourceItems, r.source, false, (v) => { r.source = v ?? SOURCE_NOTE; ctx.onChange(false); });
		conditionCell(tr.createEl("td"), ctx, `Source value, row ${i + 1}`, r.sourceValue, (v) => { r.sourceValue = v; });
		pickerCell(tr.createEl("td"), targetItems, r.target, false, (v) => { r.target = v ?? TARGET_ALL_LINKS; ctx.onChange(false); });
		conditionCell(tr.createEl("td"), ctx, `Target value, row ${i + 1}`, r.targetValue, (v) => { r.targetValue = v; });
		selectCell(tr.createEl("td"), ARROW, r.arrowToSource === null ? null : String(r.arrowToSource), true, (v) => { r.arrowToSource = v === null ? null : v === "true"; ctx.onChange(false); });
		selectCell(tr.createEl("td"), ARROW, r.arrowToTarget === null ? null : String(r.arrowToTarget), true, (v) => { r.arrowToTarget = v === null ? null : v === "true"; ctx.onChange(false); });
		colorCell(tr.createEl("td"), r.color, ctx.theme.line, (v) => { r.color = v; ctx.onChange(false); });
		pickerCell(tr.createEl("td"), widthItems, r.widthProperty, true, (v) => { r.widthProperty = v; ctx.onChange(false); });
		numberCell(tr.createEl("td"), r.widthValue, (v) => { r.widthValue = v; ctx.onChange(false); });
		labelCell(tr.createEl("td"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
		pickerCell(tr.createEl("td"), () => LABEL_MODES, r.labelMode ?? null, true, (v) => { r.labelMode = v as EdgeRule["labelMode"]; ctx.onChange(false); });
		numberCell(tr.createEl("td"), r.labelPosition ?? null, (v) => { r.labelPosition = v === null ? null : Math.max(0, Math.min(100, v)); ctx.onChange(false); });
		labelStyleCells(tr, ctx, r);
		deleteCell(tr, rows, i, ctx);
	});

	el.createEl("button", { text: "+ Add row", cls: "bases-relations-graph-add" }).onclick = () => {
		rows.push(emptyEdgeRule());
		ctx.onChange(true);
	};
}

// ---------- Таблиця «Groups» ----------

const DIRECTIONS: PickItem[] = [
	{ value: "ASC", label: "Ascending", icon: "lucide-arrow-up-narrow-wide" },
	{ value: "DESC", label: "Descending", icon: "lucide-arrow-down-wide-narrow" },
	{ value: "MANUAL", label: "Manual", icon: "lucide-list-checks" },
];

/** Порядок груп: за зростанням, спаданням або вручну (вибрані значення в заданому порядку). */
function orderCell(td: HTMLElement, ctx: TablesContext, r: GroupRule, row: number): void {
	const openManual = () => {
		if (!r.groupBy) return;
		const modal = new GroupOrderModal(
			ctx.app,
			`Group order, row ${row + 1}`,
			ctx.groupValues(r.groupBy),
			r.order ?? [],
			(order) => {
				r.order = order;
				ctx.onChange(false);
			},
			// Після закриття — оновити лічильник показаних значень у клітинці.
			() => ctx.onChange(true),
		);
		modal.open();
	};
	createPicker(td, () => DIRECTIONS, r.direction ?? "ASC", {}, (v) => {
		const dir = (v ?? "ASC") as NonNullable<GroupRule["direction"]>;
		if (dir === "MANUAL" && !r.order?.length && r.groupBy) {
			// Перехід на «Вручну» — починаємо з усіх значень у поточному порядку.
			const values = ctx.groupValues(r.groupBy);
			r.order = r.direction === "DESC" ? values.reverse() : values;
		}
		r.direction = dir;
		ctx.onChange(true);
		if (dir === "MANUAL") openManual();
	});
	if (r.direction === "MANUAL") {
		const total = r.groupBy ? ctx.groupValues(r.groupBy).length : 0;
		const present = new Set(r.groupBy ? ctx.groupValues(r.groupBy) : []);
		const shown = (r.order ?? []).filter((v) => present.has(v)).length;
		const b = td.createEl("button", { cls: "bases-relations-graph-order-btn", text: `${shown}/${total}` });
		setIcon(b.createSpan({ prepend: true }), "lucide-list-checks");
		b.setAttr("aria-label", "Choose and order values");
		b.onclick = openManual;
	}
}

/** Підпис групи: як у Nodes, плюс «значення групи» (за замовчуванням). */
function groupLabelCell(td: HTMLElement, ctx: TablesContext, value: GroupLabel | null, onChange: (v: GroupLabel | null) => void): void {
	const items = (): PickItem[] => [
		{ value: "@value", label: "Group value", icon: "lucide-tag" },
		{ value: "@none", label: "No label", icon: "lucide-ban" },
		{ value: "@text", label: "Text…", icon: "lucide-type" },
		...propItems(ctx),
	];
	const current = value === null || value.type === "value" ? "@value"
		: value.type === "none" ? "@none" : value.type === "text" ? "@text" : value.property;
	let text: HTMLInputElement;
	createPicker(td, items, current, { inherit: false }, (v) => {
		if (v === null || v === "@value") onChange(null);
		else if (v === "@none") onChange({ type: "none" });
		else if (v === "@text") onChange({ type: "text", text: text.value });
		else onChange({ type: "property", property: v });
		text.toggle(v === "@text");
		if (v === "@text") text.focus();
	});
	text = td.createEl("input", { type: "text", cls: "bases-relations-graph-label-text", attr: { placeholder: "label text" } });
	text.value = value?.type === "text" ? value.text : "";
	text.toggle(value?.type === "text");
	text.oninput = () => onChange({ type: "text", text: text.value });
}

export function renderGroupsTable(el: HTMLElement, tables: GraphTables, ctx: TablesContext): void {
	el.empty();
	el.createDiv({ cls: "bases-relations-graph-hint", text: "Each row groups nodes by a property, like Group by in Bases: every distinct value becomes its own outlined group; nodes without a value stay ungrouped. A node can belong to groups from several rows. In the force layout groups pull their members together and push other nodes out." });
	if (!tables.groups) tables.groups = [];
	const rows = tables.groups;
	if (rows.length) {
		const scroll = el.createDiv({ cls: "bases-relations-graph-table-scroll" });
		const table = scroll.createEl("table", { cls: "bases-relations-graph-table" });
		header(table, ["#", "", "Name", "Group by", "Order", "Color", "Label", "Font size", "Font color", "Label background", ""]);
		const body = table.createEl("tbody");
		rows.forEach((r: GroupRule, i) => {
			const tr = body.createEl("tr");
			rowControls(tr, rows, i, ctx);
			createPicker(tr.createEl("td"), () => propItems(ctx), r.groupBy ?? null, { placeholder: "Select property" }, (v) => { r.groupBy = v; ctx.onChange(false); });
			orderCell(tr.createEl("td"), ctx, r, i);
			// Порожній колір — окремий колір палітри для кожної групи рядка.
			colorCell(tr.createEl("td"), r.color, paletteColor(i), (v) => { r.color = v; ctx.onChange(false); }, true);
			groupLabelCell(tr.createEl("td"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
			numberCell(tr.createEl("td"), r.labelSize ?? null, (v) => { r.labelSize = v; ctx.onChange(false); });
			colorCell(tr.createEl("td"), r.labelColor ?? null, ctx.theme.text, (v) => { r.labelColor = v; ctx.onChange(false); }, false, GROUP_COLOR_AUTO);
			colorCell(tr.createEl("td"), r.labelBackground ?? null, ctx.theme.background, (v) => { r.labelBackground = v; ctx.onChange(false); });
			deleteCell(tr, rows, i, ctx, 0);
		});
	}
	el.createEl("button", { text: "+ Add group", cls: "bases-relations-graph-add" }).onclick = () => {
		rows.push(emptyGroupRule());
		ctx.onChange(true);
	};
}
