/** [x, y, закріплено ? 1 : 0] */
export type SavedPos = [number, number, number];

const SAVE_DELAY = 2000;

/**
 * Позиції вузлів для кожного подання (ключ: шлях бази + назва подання).
 * Зберігаються через стандартний механізм даних плагіна (loadData / saveData)
 * із відкладеним записом, щоб не навантажувати диск під час симуляції.
 */
export class PositionStore {
	private cache = new Map<string, Map<string, SavedPos>>();
	private dirty = false;
	private timer: number | null = null;

	constructor(private onFlush: () => Promise<void>) {}

	static key(basePath: string, viewName: string): string {
		return basePath + "::" + viewName;
	}

	init(raw: Record<string, Record<string, SavedPos>> | undefined): void {
		if (!raw || typeof raw !== "object") return;
		for (const [key, positions] of Object.entries(raw)) {
			if (!positions || typeof positions !== "object") continue;
			const existing = this.cache.get(key);
			if (!existing) {
				this.cache.set(key, new Map(Object.entries(positions)));
			} else {
				for (const [id, pos] of Object.entries(positions)) {
					if (!existing.has(id)) existing.set(id, pos);
				}
			}
		}
	}

	toJSON(): Record<string, Record<string, SavedPos>> {
		const out: Record<string, Record<string, SavedPos>> = {};
		for (const [key, map] of this.cache) {
			if (map.size) out[key] = Object.fromEntries(map);
		}
		return out;
	}

	async load(key: string): Promise<Map<string, SavedPos>> {
		let map = this.cache.get(key);
		if (!map) {
			map = new Map<string, SavedPos>();
			this.cache.set(key, map);
		}
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
		this.markDirty();
	}

	setPinned(key: string, id: string, x: number, y: number, pinned: boolean): void {
		const map = this.cache.get(key) ?? new Map<string, SavedPos>();
		map.set(id, [x, y, pinned ? 1 : 0]);
		this.cache.set(key, map);
		this.markDirty();
	}

	/** Перейменування нотатки в усіх збережених поданнях. */
	renamePath(oldPath: string, newPath: string): void {
		let changed = false;
		for (const map of this.cache.values()) {
			const p = map.get(oldPath);
			if (!p) continue;
			map.delete(oldPath);
			map.set(newPath, p);
			changed = true;
		}
		if (changed) this.markDirty();
	}

	/** Перейменування файлу бази: переносимо ключі позицій усіх його подань. */
	async renameBase(oldPath: string, newPath: string): Promise<void> {
		const prefix = oldPath + "::";
		let changed = false;
		for (const [oldKey, map] of [...this.cache.entries()]) {
			if (!oldKey.startsWith(prefix)) continue;
			const newKey = newPath + oldKey.slice(oldPath.length);
			this.cache.delete(oldKey);
			this.cache.set(newKey, map);
			changed = true;
		}
		if (changed) await this.flush(true);
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.flush(), SAVE_DELAY);
	}

	async flush(force = false): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (!this.dirty && !force) return;
		this.dirty = false;
		await this.onFlush();
	}
}
