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

const P = "bases-relations-graph";

/**
 * Картка правила замість рядка таблиці: заголовок (порядок, увімкнення, назва, видалення)
 * і тіло з полями, згрупованими за змістом. Групи полів переносяться під ширину панелі,
 * тож горизонтальної прокрутки немає.
 */
function ruleCard<T extends { enabled: boolean; name: string; id: string }>(
	list: HTMLElement, rows: T[], i: number, ctx: TablesContext, minRows = 1,
): HTMLElement {
	const r = rows[i];
	const card = list.createDiv({ cls: `${P}-rule` });
	card.toggleClass("is-disabled", !r.enabled);
	const head = card.createDiv({ cls: `${P}-rule-head` });

	head.createSpan({ cls: `${P}-rule-num`, text: String(i + 1) });
	const up = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move up" } });
	setIcon(up, "chevron-up");
	up.disabled = i === 0;
	up.onclick = () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; ctx.onChange(true); };
	const down = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move down" } });
	setIcon(down, "chevron-down");
	down.disabled = i === rows.length - 1;
	down.onclick = () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; ctx.onChange(true); };

	const en = head.createEl("input", { type: "checkbox", attr: { "aria-label": "Enabled" } });
	en.checked = r.enabled;
	en.onchange = () => {
		r.enabled = en.checked;
		card.toggleClass("is-disabled", !r.enabled);
		ctx.onChange(false);
	};

	const name = head.createEl("input", { type: "text", cls: `${P}-rule-name`, attr: { placeholder: "Rule name" } });
	name.value = r.name;
	name.onchange = () => { r.name = name.value; ctx.onChange(false); };

	const del = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete rule" } });
	setIcon(del, "trash-2");
	del.disabled = rows.length <= minRows;
	del.onclick = () => { rows.splice(i, 1); ctx.onChange(true); };

	const err = ctx.errors.get(r.id);
	if (err) {
		card.addClass("has-error");
		card.createDiv({ cls: `${P}-rule-error`, text: "⚠ " + err });
	}
	return card.createDiv({ cls: `${P}-rule-body` });
}

/** Група полів картки із заголовком. */
function section(body: HTMLElement, title: string): HTMLElement {
	const sec = body.createDiv({ cls: `${P}-section` });
	sec.createDiv({ cls: `${P}-section-title`, text: title });
	return sec.createDiv({ cls: `${P}-fields` });
}

/** Поле з підписом; повертає контейнер для елемента керування. */
function field(sec: HTMLElement, label: string): HTMLElement {
	const f = sec.createDiv({ cls: `${P}-field` });
	f.createSpan({ cls: `${P}-field-label`, text: label });
	return f.createDiv({ cls: `${P}-field-control` });
}

/** Список карток правил і кнопка додавання. */
function ruleList(el: HTMLElement): HTMLElement {
	return el.createDiv({ cls: `${P}-rules` });
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

/** Спільні поля оформлення підпису: розмір, колір, фон. */
function labelStyleFields(sec: HTMLElement, ctx: TablesContext, r: { labelSize?: number | null; labelColor?: string | null; labelBackground?: string | null }, followGroup = false): void {
	numberCell(field(sec, "Font size"), r.labelSize ?? null, (v) => { r.labelSize = v; ctx.onChange(false); });
	colorCell(field(sec, "Font color"), r.labelColor ?? null, ctx.theme.text, (v) => { r.labelColor = v; ctx.onChange(false); }, false, followGroup ? GROUP_COLOR_AUTO : null);
	colorCell(field(sec, "Background"), r.labelBackground ?? null, ctx.theme.background, (v) => { r.labelBackground = v; ctx.onChange(false); });
}

// ---------- Таблиця «Nodes» ----------

export function renderNodesTable(el: HTMLElement, tables: GraphTables, ctx: TablesContext): void {
	el.empty();
	el.createDiv({ cls: `${P}-hint`, text: "Rules apply top to bottom: a later rule overrides earlier ones in every field it sets; “—” means inherit. Each rule adds one label; its index sets the place: 0 — node center, 1, 2… — above the node, −1, −2… — below it (empty = −1)." });
	const list = ruleList(el);
	const rows = tables.nodes;
	const sizeItems = (): PickItem[] => [
		{ value: FIXED, label: "Fixed", icon: "lucide-ruler" },
		{ value: LINK_COUNT, label: "Link count", icon: "lucide-git-fork" },
		...propItems(ctx),
	];

	rows.forEach((r: NodeRule, i) => {
		const body = ruleCard(list, rows, i, ctx);

		// Три групи по 4–5 полів, як у Links: рівні колонки без порожніх ділянок.
		const notes = section(body, "Notes and size");
		conditionCell(field(notes, "Condition"), ctx, `Condition, rule ${i + 1}`, r.condition, (v) => { r.condition = v; });
		pickerCell(field(notes, "Visibility"), () => SHOW, r.show, true, (v) => { r.show = v as NodeRule["show"]; ctx.onChange(false); });
		pickerCell(field(notes, "Size by"), sizeItems, r.sizeProperty, true, (v) => { r.sizeProperty = v; ctx.onChange(false); });
		numberCell(field(notes, "Size value"), r.sizeValue, (v) => { r.sizeValue = v; ctx.onChange(false); });

		const look = section(body, "Shape and color");
		pickerCell(field(look, "Shape"), () => SHAPES, r.shape, true, (v) => { r.shape = v as NodeRule["shape"]; ctx.onChange(false); });
		colorCell(field(look, "Color"), r.color, ctx.theme.fill, (v) => { r.color = v; ctx.onChange(false); });
		colorCell(field(look, "Stroke"), r.strokeColor ?? null, ctx.theme.text, (v) => { r.strokeColor = v; ctx.onChange(false); });
		numberCell(field(look, "Stroke width"), r.strokeWidth ?? null, (v) => { r.strokeWidth = v; ctx.onChange(false); });

		const label = section(body, "Label");
		labelCell(field(label, "Text"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
		numberCell(field(label, "Index"), r.labelIndex ?? null, (v) => { r.labelIndex = v === null ? null : Math.round(v); ctx.onChange(false); });
		labelStyleFields(label, ctx, r);
	});

	el.createEl("button", { text: "+ Add rule", cls: `${P}-add` }).onclick = () => {
		rows.push(emptyNodeRule());
		ctx.onChange(true);
	};
}

// ---------- Таблиця «Links» ----------

export function renderEdgesTable(el: HTMLElement, tables: GraphTables, ctx: TablesContext): void {
	el.empty();
	el.createDiv({ cls: `${P}-hint`, text: "Each rule creates links. Source “Note” uses the note's own links; a property source turns the note into a connector that links the source value to the target values. Links not described here are not shown." });
	const list = ruleList(el);
	const rows = tables.edges;
	const sourceItems = (): PickItem[] => [{ value: SOURCE_NOTE, label: "Note", icon: "lucide-file-text" }, ...propItems(ctx, true)];
	const targetItems = (): PickItem[] => [{ value: TARGET_ALL_LINKS, label: "All outgoing links", icon: "lucide-link" }, ...propItems(ctx, true)];
	const widthItems = (): PickItem[] => [{ value: FIXED, label: "Fixed", icon: "lucide-ruler" }, ...propItems(ctx)];

	rows.forEach((r: EdgeRule, i) => {
		const body = ruleCard(list, rows, i, ctx);

		const conn = section(body, "Connection");
		pickerCell(field(conn, "Source"), sourceItems, r.source, false, (v) => { r.source = v ?? SOURCE_NOTE; ctx.onChange(false); });
		conditionCell(field(conn, "Source value"), ctx, `Source value, rule ${i + 1}`, r.sourceValue, (v) => { r.sourceValue = v; });
		pickerCell(field(conn, "Target"), targetItems, r.target, false, (v) => { r.target = v ?? TARGET_ALL_LINKS; ctx.onChange(false); });
		conditionCell(field(conn, "Target value"), ctx, `Target value, rule ${i + 1}`, r.targetValue, (v) => { r.targetValue = v; });

		const line = section(body, "Line");
		selectCell(field(line, "Arrow to source"), ARROW, r.arrowToSource === null ? null : String(r.arrowToSource), true, (v) => { r.arrowToSource = v === null ? null : v === "true"; ctx.onChange(false); });
		selectCell(field(line, "Arrow to target"), ARROW, r.arrowToTarget === null ? null : String(r.arrowToTarget), true, (v) => { r.arrowToTarget = v === null ? null : v === "true"; ctx.onChange(false); });
		colorCell(field(line, "Color"), r.color, ctx.theme.line, (v) => { r.color = v; ctx.onChange(false); });
		pickerCell(field(line, "Width by"), widthItems, r.widthProperty, true, (v) => { r.widthProperty = v; ctx.onChange(false); });
		numberCell(field(line, "Width"), r.widthValue, (v) => { r.widthValue = v; ctx.onChange(false); });

		const label = section(body, "Label");
		labelCell(field(label, "Text"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
		pickerCell(field(label, "Mode"), () => LABEL_MODES, r.labelMode ?? null, true, (v) => { r.labelMode = v as EdgeRule["labelMode"]; ctx.onChange(false); });
		numberCell(field(label, "Position, %"), r.labelPosition ?? null, (v) => { r.labelPosition = v === null ? null : Math.max(0, Math.min(100, v)); ctx.onChange(false); });
		labelStyleFields(label, ctx, r);
	});

	el.createEl("button", { text: "+ Add rule", cls: `${P}-add` }).onclick = () => {
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
	el.createDiv({ cls: `${P}-hint`, text: "Each rule groups nodes by a property, like Group by in Bases: every distinct value becomes its own outlined group; nodes without a value stay ungrouped. A node can belong to groups from several rules. In the force layout groups pull their members together and push other nodes out." });
	if (!tables.groups) tables.groups = [];
	const rows = tables.groups;
	const list = ruleList(el);
	rows.forEach((r: GroupRule, i) => {
		const body = ruleCard(list, rows, i, ctx, 0);

		const grouping = section(body, "Grouping");
		createPicker(field(grouping, "Group by"), () => propItems(ctx), r.groupBy ?? null, { placeholder: "Select property" }, (v) => { r.groupBy = v; ctx.onChange(false); });
		orderCell(field(grouping, "Order"), ctx, r, i);
		// Порожній колір — окремий колір палітри для кожної групи рядка.
		colorCell(field(grouping, "Color"), r.color, paletteColor(i), (v) => { r.color = v; ctx.onChange(false); }, true);

		const label = section(body, "Label");
		groupLabelCell(field(label, "Text"), ctx, r.label, (v) => { r.label = v; ctx.onChange(false); });
		labelStyleFields(label, ctx, r, true);
	});
	el.createEl("button", { text: "+ Add group", cls: `${P}-add` }).onclick = () => {
		rows.push(emptyGroupRule());
		ctx.onChange(true);
	};
}
