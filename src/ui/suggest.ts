import { AbstractInputSuggest, getAllTags, type App } from "obsidian";

/**
 * Значення зі сховища для підказок у редакторі умов.
 * Збираються ліниво й кешуються на час життя екземпляра (одне відкриття редактора).
 */
export class VaultValues {
	private cache = new Map<string, string[]>();

	constructor(private app: App) {}

	private memo(key: string, fn: () => string[]): string[] {
		let v = this.cache.get(key);
		if (!v) this.cache.set(key, (v = fn()));
		return v;
	}

	folders(): string[] {
		return this.memo("folders", () => this.app.vault.getAllFolders(false).map((f) => f.path).sort(collate));
	}

	/** Теги за частотою; withHash — у форматі file.tags ("#tag"). */
	tags(withHash: boolean): string[] {
		const plain = this.memo("tags", () => {
			const counts = new Map<string, number>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(f);
				if (!cache) continue;
				for (const t of new Set(getAllTags(cache) ?? [])) {
					const tag = t.replace(/^#/, "");
					counts.set(tag, (counts.get(tag) ?? 0) + 1);
				}
			}
			return byFrequency(counts);
		});
		return withHash ? plain.map((t) => "#" + t) : plain;
	}

	basenames(): string[] {
		return this.memo("basenames", () => unique(this.app.vault.getMarkdownFiles().map((f) => f.basename)).sort(collate));
	}

	fileNames(): string[] {
		return this.memo("names", () => this.app.vault.getFiles().map((f) => f.name).sort(collate));
	}

	paths(): string[] {
		return this.memo("paths", () => this.app.vault.getFiles().map((f) => f.path).sort(collate));
	}

	extensions(): string[] {
		return this.memo("ext", () => unique(this.app.vault.getFiles().map((f) => f.extension)).sort(collate));
	}

	wikilinks(): string[] {
		return this.memo("links", () => this.basenames().map((b) => `[[${b}]]`));
	}

	propertyNames(): string[] {
		return this.memo("propNames", () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const infos = (this.app.metadataCache as any).getAllPropertyInfos?.();
			if (infos) return Object.values(infos as Record<string, { name: string }>).map((i) => i.name).sort(collate);
			const names = new Set<string>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (fm) for (const k of Object.keys(fm)) names.add(k);
			}
			return [...names].sort(collate);
		});
	}

	/** Наявні значення властивості в усьому сховищі, найчастіші — першими. */
	propertyValues(name: string): string[] {
		return this.memo("values:" + name, () => {
			const counts = new Map<string, number>();
			const add = (v: unknown) => {
				if (v === null || v === undefined || typeof v === "object") return;
				const s = String(v).trim();
				if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
			};
			const lower = name.toLowerCase();
			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (!fm) continue;
				// Ключі властивостей у Obsidian нечутливі до регістру.
				const key = Object.keys(fm).find((k) => k.toLowerCase() === lower);
				if (key === undefined) continue;
				const v = fm[key];
				if (Array.isArray(v)) v.forEach(add);
				else add(v);
			}
			return byFrequency(counts);
		});
	}
}

/**
 * Підказки для поля значення. `multi` — значення через кому: підказується останнє,
 * а вибране замінює лише його.
 */
export class ValueSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private input: HTMLInputElement,
		private source: () => string[] | null,
		private multi: () => boolean,
	) {
		super(app, input);
		this.limit = 100;
	}

	protected getSuggestions(query: string): string[] {
		const all = this.source();
		if (!all || !all.length) return [];
		const q = (this.multi() ? query.split(",").pop() ?? "" : query).trim().toLowerCase();
		if (!q) return all.slice(0, this.limit);
		const starts: string[] = [], contains: string[] = [];
		for (const v of all) {
			const l = v.toLowerCase();
			if (l.startsWith(q)) starts.push(v);
			else if (l.includes(q)) contains.push(v);
			if (starts.length >= this.limit) break;
		}
		return starts.concat(contains).slice(0, this.limit);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		let next = value;
		if (this.multi()) {
			const parts = this.input.value.split(",");
			parts[parts.length - 1] = (parts.length > 1 ? " " : "") + value;
			next = parts.join(",");
		}
		this.setValue(next);
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

function unique(a: string[]): string[] {
	return [...new Set(a)];
}

function byFrequency(counts: Map<string, number>): string[] {
	return [...counts].sort((a, b) => b[1] - a[1] || collate(a[0], b[0])).map(([v]) => v);
}

function collate(a: string, b: string): number {
	return a.localeCompare(b);
}
