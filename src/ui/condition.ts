import { Modal, setIcon, type App } from "obsidian";
import type { BasesEvaluator } from "../bases/evaluator";
import { buildExpr, OPS, parseExpr, type ExprParts } from "../model/expr";
import type { FilterTree } from "../model/types";
import { createPicker, type PickItem } from "./picker";
import type { PropertyCatalog } from "./properties";
import { ValueSuggest, VaultValues } from "./suggest";

type Conj = "and" | "or" | "not";
interface GroupNode { kind: "group"; conj: Conj; children: Node[] }
interface ExprNode { kind: "expr"; text: string; raw: boolean }
type Node = GroupNode | ExprNode;

const CONJ_LABEL: Record<Conj, string> = {
	and: "All the following are true",
	or: "Any of the following are true",
	not: "None of the following are true",
};

function toNode(t: FilterTree): Node {
	if (typeof t === "string") return { kind: "expr", text: t, raw: parseExpr(t) === null };
	const conj = (Object.keys(t)[0] ?? "and") as Conj;
	const list = (t as Record<Conj, FilterTree[]>)[conj] ?? [];
	return { kind: "group", conj, children: list.map(toNode) };
}

function toTree(n: Node): FilterTree | null {
	if (n.kind === "expr") return n.text.trim() ? n.text.trim() : null;
	const children = n.children.map(toTree).filter((c): c is FilterTree => c !== null);
	if (!children.length) return null;
	return { [n.conj]: children } as FilterTree;
}

/** Короткий опис умови для клітинки таблиці. */
export function describeCondition(t: FilterTree | null): string {
	if (t === null) return "all";
	if (typeof t === "string") return t;
	const conj = Object.keys(t)[0] as Conj;
	const list = (t as Record<Conj, FilterTree[]>)[conj] ?? [];
	if (list.length === 1 && conj === "and") return describeCondition(list[0]);
	const sep = conj === "or" ? " or " : " and ";
	const body = list.map((c) => (typeof c === "string" ? c : "(" + describeCondition(c) + ")")).join(sep);
	return conj === "not" ? "not (" + body + ")" : body;
}

/** Редактор умови у стилі вкладки «Фільтр» Bases. Порожня умова = усі. */
export class ConditionModal extends Modal {
	private root: GroupNode;
	private errorEl!: HTMLElement;
	private values: VaultValues;

	constructor(
		app: App,
		title: string,
		value: FilterTree | null,
		private props: PropertyCatalog,
		private ev: BasesEvaluator,
		private onSave: (value: FilterTree | null) => void,
	) {
		super(app);
		this.values = new VaultValues(app);
		this.titleEl.setText(title);
		const node = value === null ? null : toNode(value);
		this.root = node?.kind === "group" ? node : { kind: "group", conj: "and", children: node ? [node] : [] };
	}

	onOpen(): void {
		this.modalEl.addClass("bases-graph-condition-modal");
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		const top = contentEl.scrollTop;
		contentEl.empty();
		this.renderGroup(contentEl, this.root, null);
		this.errorEl = contentEl.createDiv({ cls: "bases-graph-condition-error" });
		this.validate();

		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Clear (match all)" }).onclick = () => {
			this.root = { kind: "group", conj: "and", children: [] };
			this.render();
		};
		const save = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		save.onclick = () => {
			this.onSave(toTree(this.root));
			this.close();
		};
		contentEl.scrollTop = top;
	}

	private validate(): void {
		const tree = toTree(this.root);
		const err = this.ev.filter(tree).error;
		this.errorEl.setText(err ? "⚠ " + err : "");
	}

	private renderGroup(parent: HTMLElement, g: GroupNode, owner: GroupNode | null): void {
		const box = parent.createDiv({ cls: "bases-graph-cond-group" });
		const head = box.createDiv({ cls: "bases-graph-cond-head" });
		const conj = head.createEl("select", { cls: "dropdown" });
		for (const c of ["and", "or", "not"] as Conj[]) conj.createEl("option", { value: c, text: CONJ_LABEL[c] });
		conj.value = g.conj;
		conj.onchange = () => { g.conj = conj.value as Conj; this.validate(); };

		head.createEl("button", { text: "+ Add filter" }).onclick = () => {
			g.children.push({ kind: "expr", text: "", raw: false });
			this.render();
		};
		head.createEl("button", { text: "+ Add filter group" }).onclick = () => {
			g.children.push({ kind: "group", conj: "and", children: [] });
			this.render();
		};
		if (owner) this.removeButton(head, owner, g);

		const list = box.createDiv({ cls: "bases-graph-cond-list" });
		for (const child of g.children) {
			if (child.kind === "group") this.renderGroup(list, child, g);
			else this.renderExpr(list, child, g);
		}
	}

	private removeButton(el: HTMLElement, owner: GroupNode, node: Node): void {
		const b = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove" } });
		setIcon(b, "x");
		b.onclick = () => {
			owner.children.remove(node);
			this.render();
		};
	}

	/** Звідки брати підказки значень — як у вкладці «Фільтр» Bases. */
	private valueSource(p: ExprParts): string[] | null {
		const v = this.values;
		const op = p.op.replace(/^!/, "");
		if (p.property === "file") {
			switch (op) {
				case "inFolder": return v.folders();
				case "hasTag": return v.tags(false);
				case "hasLink": return v.basenames();
				case "hasProperty": return v.propertyNames();
				default: return null;
			}
		}
		switch (p.property) {
			case "file.folder": return v.folders();
			case "file.tags": return v.tags(true);
			case "file.name":
			case "file.fullname": return v.fileNames();
			case "file.basename": return v.basenames();
			case "file.path": return v.paths();
			case "file.ext": return v.extensions();
			case "file.file":
			case "file.links":
			case "file.backlinks":
			case "file.embeds": return v.wikilinks();
		}
		if (p.property.startsWith("note.")) {
			const name = p.property.slice(5);
			const kind = this.props.info(p.property).kind;
			if (kind === "checkbox") return ["true", "false"];
			if (kind === "date") return null;
			if (name.toLowerCase() === "tags") return v.tags(false);
			return v.propertyValues(name);
		}
		return null;
	}

	private renderExpr(parent: HTMLElement, n: ExprNode, owner: GroupNode): void {
		const row = parent.createDiv({ cls: "bases-graph-cond-row" });
		const parts: ExprParts | null = n.raw ? null : parseExpr(n.text) ?? (n.text ? null : { property: "", op: "==", value: "" });

		if (!parts) {
			n.raw = true;
			const input = row.createEl("input", { type: "text", cls: "bases-graph-cond-raw", attr: { placeholder: "Bases expression, e.g. file.links.length > 2" } });
			input.value = n.text;
			input.oninput = () => { n.text = input.value; this.validate(); };
		} else {
			const propItems = (): PickItem[] => [
				{ value: "file", label: "File (tags, folder, links)", icon: "lucide-file" },
				...this.props.all().map((p) => ({ value: p.id, label: p.name, icon: p.icon })),
			];
			createPicker(row, propItems, parts.property || null, { placeholder: "Select property" }, (v) => {
				parts.property = v ?? "";
				fillOps();
				update();
			});

			const opSel = row.createEl("select", { cls: "dropdown" });
			const valInput = row.createEl("input", { type: "text", cls: "bases-graph-cond-value" });
			valInput.value = parts.value;
			new ValueSuggest(this.app, valInput, () => this.valueSource(parts), () => OPS.find((o) => o.op === parts.op)?.arity === "n");

			const kind = () => (parts.property && parts.property !== "file" ? this.props.info(parts.property).kind : "text");
			const fillOps = () => {
				opSel.empty();
				const isFile = parts.property === "file";
				const k = kind();
				for (const o of OPS) {
					if (isFile !== !!o.fileFunc) continue;
					if (o.kinds && !o.kinds.includes(k)) continue;
					opSel.createEl("option", { value: o.op, text: o.label });
				}
				if (![...opSel.options].some((x) => x.value === parts.op)) parts.op = opSel.options[0]?.value ?? "==";
				opSel.value = parts.op;
				const def = OPS.find((o) => o.op === parts.op);
				valInput.toggle(def?.arity !== 0);
				valInput.placeholder = def?.arity === "n" ? "values, comma-separated" : k === "date" ? "YYYY-MM-DD" : "value";
			};
			const update = () => {
				n.text = parts.property ? buildExpr(parts, kind()) : "";
				this.validate();
			};
			fillOps();
			opSel.onchange = () => { parts.op = opSel.value; fillOps(); update(); };
			valInput.oninput = () => { parts.value = valInput.value; update(); };
		}

		const rawBtn = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": n.raw ? "Switch to builder" : "Edit as expression" } });
		setIcon(rawBtn, n.raw ? "list-filter" : "code");
		rawBtn.onclick = () => {
			if (n.raw && n.text && !parseExpr(n.text)) {
				this.errorEl.setText("This expression can't be shown in the builder — keeping it as text.");
				return;
			}
			n.raw = !n.raw;
			this.render();
		};
		this.removeButton(row, owner, n);
	}
}
