import { FileValue, LinkValue, ListValue, NullValue, NumberValue, type BasesEntry, type BasesPropertyId, type TFile } from "obsidian";

/* Перетворення значень Bases (Value) на прості типи для графа. */

/** LinkValue.resolve() є в рантаймі (1.10+), але не в публічних типах. */
function resolveLink(v: LinkValue): TFile | null {
	return (v as unknown as { resolve(): TFile | null }).resolve();
}

export function getValue(entry: BasesEntry, id: string): unknown {
	try {
		return entry.getValue(id as BasesPropertyId);
	} catch {
		return null;
	}
}

function listItems(v: ListValue): unknown[] {
	const out: unknown[] = [];
	const n = v.length();
	for (let i = 0; i < n; i++) out.push(v.get(i));
	return out;
}

/** Шляхи файлів, на які посилається значення (посилання, список посилань, файл). */
export function linkedPaths(v: unknown, out: string[] = []): string[] {
	if (!v) return out;
	if (v instanceof ListValue) {
		for (const item of listItems(v)) linkedPaths(item, out);
	} else if (v instanceof LinkValue) {
		const f = resolveLink(v);
		if (f) out.push(f.path);
	} else if (v instanceof FileValue) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const f = (v as any).file;
		if (f?.path) out.push(f.path);
	}
	return out;
}

/** Число зі значення; для списку — кількість елементів. */
export function toNumber(v: unknown): number | null {
	if (v === null || v === undefined || v instanceof NullValue) return null;
	if (v instanceof NumberValue) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const n = (v as any).data;
		return typeof n === "number" && isFinite(n) ? n : null;
	}
	if (v instanceof ListValue) return v.length();
	if (typeof v === "number") return isFinite(v) ? v : null;
	const n = parseFloat(String(v));
	return isFinite(n) ? n : null;
}

/** Текст для підпису; порожнє значення → null. */
export function toText(v: unknown): string | null {
	if (v === null || v === undefined || v instanceof NullValue) return null;
	let s: string;
	if (v instanceof LinkValue) {
		const f = resolveLink(v);
		s = f ? f.basename : String(v.toString()).replace(/^\[\[|\]\]$/g, "");
	} else if (v instanceof ListValue) {
		s = listItems(v).map((i) => toText(i)).filter((x) => x).join(", ");
	} else {
		s = String(v.toString());
	}
	s = s.trim();
	return s ? s : null;
}
