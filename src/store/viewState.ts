const SAVE_DELAY = 1000;

/**
 * Довільний стан подання (наприклад, ручні зміни дерева та згорнуті групи).
 * Зберігається через стандартний механізм даних плагіна (loadData / saveData).
 */
export class ViewStateStore {
	private data = new Map<string, unknown>();
	private dirty = false;
	private timer: number | null = null;

	constructor(private onFlush: () => Promise<void>) {}

	init(raw: Record<string, unknown> | undefined): void {
		if (!raw || typeof raw !== "object") return;
		for (const [key, value] of Object.entries(raw)) {
			if (!this.data.has(key)) {
				this.data.set(key, value);
			}
		}
	}

	toJSON(): Record<string, unknown> {
		return Object.fromEntries(this.data);
	}

	async load<T>(key: string): Promise<T | null> {
		if (!this.data.has(key)) return null;
		const val = this.data.get(key);
		return val !== undefined ? (JSON.parse(JSON.stringify(val)) as T) : null;
	}

	save(key: string, value: unknown): void {
		this.data.set(key, JSON.parse(JSON.stringify(value)));
		this.dirty = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.flush(), SAVE_DELAY);
	}

	renameBase(oldPath: string, newPath: string): void {
		const prefix = oldPath + "::";
		let changed = false;
		for (const [oldKey, val] of [...this.data.entries()]) {
			if (!oldKey.startsWith(prefix)) continue;
			const newKey = newPath + oldKey.slice(oldPath.length);
			this.data.delete(oldKey);
			this.data.set(newKey, val);
			changed = true;
		}
		if (changed) {
			this.dirty = true;
			void this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (!this.dirty) return;
		this.dirty = false;
		await this.onFlush();
	}
}
