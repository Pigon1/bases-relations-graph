import { normalizePath, type DataAdapter } from "obsidian";

/** [x, y, закріплено ? 1 : 0] */
export type SavedPos = [number, number, number];

interface FileData {
	key: string;
	positions: Record<string, SavedPos>;
}

const SAVE_DELAY = 2000;

/**
 * Позиції вузлів — окремий файл на кожне подання в теці плагіна,
 * щоб не роздувати .base і data.json. Ключ: шлях бази + назва подання.
 */
export class PositionStore {
	private cache = new Map<string, Map<string, SavedPos>>();
	private dirty = new Set<string>();
	private timer: number | null = null;

	constructor(private adapter: DataAdapter, private dir: string) {}

	static key(basePath: string, viewName: string): string {
		return basePath + "::" + viewName;
	}

	private file(key: string): string {
		return normalizePath(`${this.dir}/positions/${hash(key)}.json`);
	}

	async load(key: string): Promise<Map<string, SavedPos>> {
		const cached = this.cache.get(key);
		if (cached) return cached;
		let map = new Map<string, SavedPos>();
		try {
			const path = this.file(key);
			if (await this.adapter.exists(path)) {
				const data = JSON.parse(await this.adapter.read(path)) as FileData;
				map = new Map(Object.entries(data.positions ?? {}));
			}
		} catch (e) {
			console.warn("[bases-graph] failed to read positions", e);
		}
		this.cache.set(key, map);
		return map;
	}

	update(key: string, ids: string[], pos: Float32Array, pinned: Uint8Array | null): void {
		const map = this.cache.get(key) ?? new Map<string, SavedPos>();
		for (let i = 0; i < ids.length; i++) {
			const x = Math.round(pos[i * 2] * 10) / 10, y = Math.round(pos[i * 2 + 1] * 10) / 10;
			if (!isFinite(x) || !isFinite(y)) continue;
			const prevPinned = map.get(ids[i])?.[2] ?? 0;
			map.set(ids[i], [x, y, pinned ? pinned[i] : prevPinned]);
		}
		this.cache.set(key, map);
		this.markDirty(key);
	}

	setPinned(key: string, id: string, x: number, y: number, pinned: boolean): void {
		const map = this.cache.get(key) ?? new Map<string, SavedPos>();
		map.set(id, [x, y, pinned ? 1 : 0]);
		this.cache.set(key, map);
		this.markDirty(key);
	}

	/** Перейменування нотатки — для подань, що вже завантажені. */
	renamePath(oldPath: string, newPath: string): void {
		for (const [key, map] of this.cache) {
			const p = map.get(oldPath);
			if (!p) continue;
			map.delete(oldPath);
			map.set(newPath, p);
			this.markDirty(key);
		}
	}

	/** Перейменування файлу бази: переносимо файли позицій усіх його подань. */
	async renameBase(oldPath: string, newPath: string): Promise<void> {
		await this.flush();
		const posDir = normalizePath(`${this.dir}/positions`);
		if (!(await this.adapter.exists(posDir))) return;
		const listing = await this.adapter.list(posDir);
		for (const f of listing.files) {
			try {
				const data = JSON.parse(await this.adapter.read(f)) as FileData;
				if (!data.key?.startsWith(oldPath + "::")) continue;
				const oldKey = data.key;
				const key = newPath + oldKey.slice(oldPath.length);
				data.key = key;
				await this.adapter.write(this.file(key), JSON.stringify(data));
				await this.adapter.remove(f);
				const cached = this.cache.get(oldKey);
				if (cached) {
					this.cache.delete(oldKey);
					this.cache.set(key, cached);
				}
			} catch {
				/* пошкоджений файл позицій — пропускаємо */
			}
		}
	}

	private markDirty(key: string): void {
		this.dirty.add(key);
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.flush(), SAVE_DELAY);
	}

	async flush(): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		const keys = [...this.dirty];
		this.dirty.clear();
		if (!keys.length) return;
		const posDir = normalizePath(`${this.dir}/positions`);
		if (!(await this.adapter.exists(posDir))) await this.adapter.mkdir(posDir);
		for (const key of keys) {
			const map = this.cache.get(key);
			if (!map) continue;
			const data: FileData = { key, positions: Object.fromEntries(map) };
			await this.adapter.write(this.file(key), JSON.stringify(data));
		}
	}
}

/** FNV-1a — коротке стабільне ім'я файлу. */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}
