import type { BasesEntry, QueryController } from "obsidian";
import type { FilterTree } from "../model/types";

/*
 * Обчислення фільтрів і формул Bases для довільного запису.
 * Публічного API для цього немає, тому використовується внутрішній клас запиту:
 * controller.query.constructor.parse({ filters, views }) → .filters.test(entry).
 * Перевірено зондом на Obsidian 1.13.8 (Android) і 1.14.4 (Linux).
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

interface InternalFilter {
	test(entry: unknown): boolean;
	hasError?(): boolean;
	rule?: { constructor: new (text: string) => InternalFormula };
}
interface InternalFormula {
	getValue(entry: unknown): unknown;
	formula?: { constructor: { name: string } };
}

export class BasesEvaluator {
	private filters = new Map<string, CompiledFilter>();
	private formulas = new Map<string, CompiledFormula>();
	private FormulaClass: (new (text: string) => InternalFormula) | null = null;

	constructor(private controller: QueryController) {}

	private parse(filters: FilterTree): InternalFilter | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const Query = (this.controller as any)?.query?.constructor;
		if (!Query || typeof Query.parse !== "function") throw new Error("Internal Bases API is unavailable (Query.parse)");
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
			if (!f) c = ALWAYS;
			else if (f.hasError && f.hasError()) c = { test: () => false, error: "Invalid expression" };
			else c = {
				test: (e) => {
					try { return f.test(e); } catch { return false; }
				},
				error: null,
			};
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
				if (!this.FormulaClass) throw new Error("Bases formula class is unavailable");
			}
			const formula = new this.FormulaClass(text);
			c = {
				get: (e) => {
					try { return formula.getValue(e); } catch { return null; }
				},
				error: null,
			};
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
