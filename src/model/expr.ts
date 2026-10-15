/*
 * Перетворення «властивість + оператор + значення» ↔ вираз Bases.
 * Оператори повторюють меню вкладки «Фільтр» (workspace.registerOperatorFuncConfigs("bases", …)).
 */

export type ValueKind = "text" | "number" | "date" | "checkbox" | "list";

export interface OpDef {
	op: string;
	label: string;
	/** Скільки значень потрібно: 0 — жодного, 1 — одне, n — кілька через кому. */
	arity: 0 | 1 | "n";
	/** Для яких типів показувати. Порожньо — для всіх. */
	kinds?: ValueKind[];
	/** Оператор файлу (file.hasTag тощо), а не властивості. */
	fileFunc?: boolean;
}

export const OPS: OpDef[] = [
	{ op: "==", label: "is", arity: 1 },
	{ op: "!=", label: "is not", arity: 1 },
	{ op: ">", label: ">", arity: 1, kinds: ["number", "date"] },
	{ op: ">=", label: "≥", arity: 1, kinds: ["number", "date"] },
	{ op: "<", label: "<", arity: 1, kinds: ["number", "date"] },
	{ op: "<=", label: "≤", arity: 1, kinds: ["number", "date"] },
	{ op: "contains", label: "contains", arity: 1, kinds: ["text", "list"] },
	{ op: "!contains", label: "does not contain", arity: 1, kinds: ["text", "list"] },
	{ op: "containsAny", label: "contains any of", arity: "n", kinds: ["text", "list"] },
	{ op: "!containsAny", label: "does not contain any of", arity: "n", kinds: ["text", "list"] },
	{ op: "containsAll", label: "contains all of", arity: "n", kinds: ["text", "list"] },
	{ op: "!containsAll", label: "does not contain all of", arity: "n", kinds: ["text", "list"] },
	{ op: "startsWith", label: "starts with", arity: 1, kinds: ["text"] },
	{ op: "!startsWith", label: "does not start with", arity: 1, kinds: ["text"] },
	{ op: "endsWith", label: "ends with", arity: 1, kinds: ["text"] },
	{ op: "!endsWith", label: "does not end with", arity: 1, kinds: ["text"] },
	{ op: "isEmpty", label: "is empty", arity: 0 },
	{ op: "!isEmpty", label: "is not empty", arity: 0 },
	{ op: "hasTag", label: "has tag", arity: "n", fileFunc: true },
	{ op: "!hasTag", label: "does not have tag", arity: "n", fileFunc: true },
	{ op: "inFolder", label: "in folder", arity: 1, fileFunc: true },
	{ op: "!inFolder", label: "is not in folder", arity: 1, fileFunc: true },
	{ op: "hasLink", label: "links to", arity: 1, fileFunc: true },
	{ op: "!hasLink", label: "does not link to", arity: 1, fileFunc: true },
	{ op: "hasProperty", label: "has property", arity: 1, fileFunc: true },
	{ op: "!hasProperty", label: "does not have property", arity: 1, fileFunc: true },
];

export interface ExprParts {
	/** id властивості (note.x, file.x, formula.x) або "file" для операторів файлу. */
	property: string;
	op: string;
	value: string;
}

const CMP = new Set(["==", "!=", ">", ">=", "<", "<="]);
const ASCII_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** id властивості → ліва частина виразу (як D$ у Bases, але з явним note.). */
export function propertyToExpr(id: string): string {
	if (id === "file" || id === "file.file") return "file";
	const dot = id.indexOf(".");
	const type = dot > 0 ? id.slice(0, dot) : "note";
	const name = dot > 0 ? id.slice(dot + 1) : id;
	return ASCII_IDENT.test(name) ? `${type}.${name}` : `${type}[${JSON.stringify(name)}]`;
}

/** Ліва частина виразу → id властивості. */
export function exprToProperty(lhs: string): string | null {
	const s = lhs.trim();
	if (s === "file") return "file.file";
	let m = /^(note|file|formula)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
	if (m) return `${m[1]}.${m[2]}`;
	m = /^(note|file|formula)\[("(?:[^"\\]|\\.)*")\]$/.exec(s);
	if (m) return `${m[1]}.${JSON.parse(m[2])}`;
	if (ASCII_IDENT.test(s)) return `note.${s}`;
	return null;
}

function literal(raw: string, kind: ValueKind): string {
	const v = raw.trim();
	if (/^\[\[.*\]\]$/.test(v)) return `link(${JSON.stringify(v.slice(2, -2))})`;
	if (kind === "number" && v !== "" && isFinite(Number(v))) return v;
	if (kind === "checkbox" && (v === "true" || v === "false")) return v;
	if (kind === "date" && /^\d{4}-\d{2}-\d{2}/.test(v)) return `date(${JSON.stringify(v)})`;
	return JSON.stringify(v);
}

function splitValues(v: string): string[] {
	return v.split(",").map((s) => s.trim()).filter((s) => s);
}

export function buildExpr(p: ExprParts, kind: ValueKind): string {
	const def = OPS.find((o) => o.op === p.op);
	if (!def) return "";
	const neg = p.op.startsWith("!") && !CMP.has(p.op);
	const fn = neg ? p.op.slice(1) : p.op;
	const lhs = def.fileFunc ? "file" : propertyToExpr(p.property);
	if (CMP.has(p.op)) return `${lhs} ${p.op} ${literal(p.value, kind)}`;
	let args = "";
	if (def.arity === 1) {
		args = fn === "hasLink" ? literal(p.value.startsWith("[[") ? p.value : `[[${p.value}]]`, "text")
			: fn === "hasProperty" ? JSON.stringify(p.value.trim())
			: literal(p.value, kind === "list" ? "text" : kind);
	} else if (def.arity === "n") {
		args = splitValues(p.value).map((v) => (fn === "hasTag" ? JSON.stringify(v.replace(/^#/, "")) : literal(v, "text"))).join(", ");
	}
	return `${neg ? "!" : ""}${lhs}.${fn}(${args})`;
}

function unliteral(a: string): string {
	const s = a.trim();
	let m = /^link\(("(?:[^"\\]|\\.)*")\)$/.exec(s);
	if (m) return `[[${JSON.parse(m[1])}]]`;
	m = /^date\(("(?:[^"\\]|\\.)*")\)$/.exec(s);
	if (m) return JSON.parse(m[1]);
	if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return JSON.parse(s);
	return s;
}

/** Розбиває аргументи за комами верхнього рівня, з урахуванням лапок і дужок. */
function splitArgs(s: string): string[] {
	const out: string[] = [];
	let depth = 0, quote = false, cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quote) {
			cur += ch;
			if (ch === "\\") { cur += s[++i] ?? ""; continue; }
			if (ch === '"') quote = false;
			continue;
		}
		if (ch === '"') quote = true;
		else if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
		cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out;
}

/** Розбирає вираз, якщо він має форму, яку вміє показати структурований редактор. */
export function parseExpr(expr: string): ExprParts | null {
	const s = expr.trim();
	let m = /^(!?)(.+?)\.(\w+)\((.*)\)$/.exec(s);
	if (m) {
		const neg = m[1] === "!";
		const fn = m[3];
		const op = (neg ? "!" : "") + fn;
		const def = OPS.find((o) => o.op === op);
		if (!def) return null;
		const lhs = m[2];
		let property: string | null;
		if (def.fileFunc) {
			if (lhs !== "file") return null;
			property = "file";
		} else {
			property = exprToProperty(lhs);
		}
		if (!property) return null;
		const args = splitArgs(m[4]).map(unliteral);
		if (def.arity === 0 && args.length) return null;
		if (def.arity === 1 && args.length !== 1) return null;
		return { property, op, value: args.join(", ") };
	}
	m = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(s);
	if (m) {
		const property = exprToProperty(m[1]);
		if (!property) return null;
		return { property, op: m[2], value: unliteral(m[3]) };
	}
	return null;
}

/** Тип значення за віджетом властивості Obsidian. */
export function kindFromWidget(widget: string | undefined | null): ValueKind {
	switch (widget) {
		case "number": return "number";
		case "date":
		case "datetime": return "date";
		case "checkbox": return "checkbox";
		case "multitext":
		case "tags":
		case "aliases": return "list";
		default: return "text";
	}
}
