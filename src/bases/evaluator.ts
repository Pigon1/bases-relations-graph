import { ListValue, type BasesEntry, type QueryController } from "obsidian";
import { parseExpr, type ExprParts } from "../model/expr";
import type { FilterTree } from "../model/types";
import { getValue, linkedPaths, toNumber, toText } from "./values";

/*
 * Обчислення фільтрів і формул Bases для довільного запису.
 * Якщо внутрішній компілятор Query.parse доступний, використовується він для повної
 * сумісності з синтаксисом Bases; інакше працює безпечний резервний обчислювач
 * на основі публічного BasesEntry.getValue() та TFile.
 */

export interface CompiledFilter {
	test(entry: BasesEntry): boolean;
	error: string | null;
}

export interface CompiledFormula {
	get(entry: BasesEntry): unknown;
	error: string | null;
}

const ALWAYS: CompiledFilter = { test: () => true, error: null };

interface InternalFormulaInstance {
	getValue(entry: unknown): unknown;
}

interface InternalFilterInstance {
	test(entry: unknown): boolean;
	hasError?(): boolean;
	rule?: {
		constructor: new (text: string) => InternalFormulaInstance;
	};
}

interface InternalQueryConstructor {
	parse?(config: { filters: unknown; views: { type: string; name: string }[] }): {
		filters?: InternalFilterInstance;
	} | null;
}

export class BasesEvaluator {
	private filters = new Map<string, CompiledFilter>();
	private formulas = new Map<string, CompiledFormula>();
	private FormulaClass: (new (text: string) => InternalFormulaInstance) | null = null;

	constructor(private controller: QueryController) {}

	private parse(filters: FilterTree): InternalFilterInstance | null {
		const Query = (this.controller as unknown as { query?: { constructor?: InternalQueryConstructor } }).query?.constructor;
		if (!Query || typeof Query.parse !== "function") return null;
		const q = Query.parse({ filters, views: [{ type: "table", name: "_" }] });
		return (q && q.filters) || null;
	}

	/** Порожня умова (null) пропускає все. */
	filter(tree: FilterTree | null): CompiledFilter {
		if (tree === null || tree === undefined || tree === "") return ALWAYS;
		const key = JSON.stringify(tree);
		let c = this.filters.get(key);
		if (c) return c;
		try {
			const f = this.parse(tree);
			if (f) {
				if (f.hasError && f.hasError()) c = { test: () => false, error: "Invalid expression" };
				else c = {
					test: (e) => {
						try { return f.test(e); } catch { return false; }
					},
					error: null,
				};
			} else {
				c = compileFallbackFilter(tree);
			}
		} catch (e) {
			c = { test: () => false, error: (e as Error).message };
		}
		this.filters.set(key, c);
		return c;
	}

	formula(text: string): CompiledFormula {
		let c = this.formulas.get(text);
		if (c) return c;
		try {
			if (!this.FormulaClass) {
				const f = this.parse("true");
				this.FormulaClass = f?.rule?.constructor ?? null;
			}
			if (this.FormulaClass) {
				const formula = new this.FormulaClass(text);
				c = {
					get: (e) => {
						try { return formula.getValue(e); } catch { return null; }
					},
					error: null,
				};
			} else {
				c = {
					get: (e) => getValue(e, text),
					error: null,
				};
			}
		} catch (e) {
			c = { get: () => null, error: (e as Error).message };
		}
		this.formulas.set(text, c);
		return c;
	}

	clear(): void {
		this.filters.clear();
		this.formulas.clear();
	}
}

function compileFallbackFilter(tree: FilterTree): CompiledFilter {
	if (typeof tree === "string") {
		const trimmed = tree.trim();
		if (!trimmed || trimmed === "true") return ALWAYS;
		if (trimmed === "false") return { test: () => false, error: null };
		const parts = parseExpr(trimmed);
		if (!parts) return { test: () => false, error: "Unsupported filter expression" };
		return {
			test: (entry) => evalParts(entry, parts),
			error: null,
		};
	}
	if ("and" in tree) {
		const children = tree.and.map(compileFallbackFilter);
		const err = children.find((c) => c.error)?.error ?? null;
		return { test: (e) => children.every((c) => c.test(e)), error: err };
	}
	if ("or" in tree) {
		const children = tree.or.map(compileFallbackFilter);
		const err = children.find((c) => c.error)?.error ?? null;
		return { test: (e) => children.some((c) => c.test(e)), error: err };
	}
	if ("not" in tree) {
		const children = tree.not.map(compileFallbackFilter);
		const err = children.find((c) => c.error)?.error ?? null;
		return { test: (e) => !children.some((c) => c.test(e)), error: err };
	}
	return ALWAYS;
}

function evalParts(entry: BasesEntry, p: ExprParts): boolean {
	const neg = p.op.startsWith("!") && p.op !== "!=";
	const op = neg ? p.op.slice(1) : p.op;
	const res = evalPositive(entry, p.property, op, p.value);
	return neg ? !res : res;
}

function evalPositive(entry: BasesEntry, prop: string, op: string, target: string): boolean {
	if (prop === "file") {
		const file = entry.file;
		switch (op) {
			case "inFolder": {
				const folder = target.replace(/^\/+|\/+$/g, "");
				const parent = file.parent?.path ?? "";
				return parent === folder || parent.startsWith(folder + "/");
			}
			case "hasTag": {
				const tags = toText(getValue(entry, "file.tags")) ?? "";
				const wanted = target.split(",").map((s) => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
				const actual = tags.split(",").map((s) => s.trim().replace(/^#/, "").toLowerCase());
				return wanted.some((w) => actual.some((a) => a === w || a.startsWith(w + "/")));
			}
			case "hasLink": {
				const clean = target.replace(/^\[\[|\]\]$/g, "").trim();
				const links = linkedPaths(getValue(entry, "file.links"));
				return links.some((l) => l === clean || l.endsWith("/" + clean + ".md") || l === clean + ".md");
			}
			case "hasProperty":
				return getValue(entry, `note.${target.trim()}`) !== null;
			default:
				return false;
		}
	}
	const raw = getValue(entry, prop);
	const text = toText(raw) ?? "";
	if (op === "isEmpty") {
		if (raw instanceof ListValue) return raw.length() === 0;
		return text === "";
	}
	const numA = toNumber(raw);
	const numB = parseFloat(target);
	switch (op) {
		case "==": return numA !== null && isFinite(numB) ? numA === numB : text === target;
		case "!=": return numA !== null && isFinite(numB) ? numA !== numB : text !== target;
		case ">": return numA !== null && isFinite(numB) ? numA > numB : text > target;
		case ">=": return numA !== null && isFinite(numB) ? numA >= numB : text >= target;
		case "<": return numA !== null && isFinite(numB) ? numA < numB : text < target;
		case "<=": return numA !== null && isFinite(numB) ? numA <= numB : text <= target;
		case "contains": return text.toLowerCase().includes(target.toLowerCase());
		case "containsAny":
			return target.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((t) => text.toLowerCase().includes(t));
		case "containsAll":
			return target.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).every((t) => text.toLowerCase().includes(t));
		case "startsWith": return text.toLowerCase().startsWith(target.toLowerCase());
		case "endsWith": return text.toLowerCase().endsWith(target.toLowerCase());
		default: return false;
	}
}
