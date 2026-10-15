/**
 * Рівномірна сітка для пошуку вузла під курсором.
 * Вузол потрапляє в усі клітинки, які перекриває його коло, тож запит перевіряє
 * лише кілька кандидатів замість усіх вузлів. Дуже великі вузли (більше MAX_CELLS
 * клітинок) зберігаються окремим списком і перевіряються завжди.
 * На відміну від квадродерева, сітка коректно працює з вузлами різного радіуса.
 */
const MAX_CELLS = 64;

export class SpatialGrid {
	private cell = 32;
	private cells = new Map<number, number[]>();
	private big: number[] = [];

	private key(cx: number, cy: number): number {
		// Цілі координати клітинок у межах ±2^20 — без колізій.
		return (cx + 0x100000) * 0x200000 + (cy + 0x100000);
	}

	build(pos: Float32Array, radii: ArrayLike<number>, count: number): void {
		this.cells.clear();
		this.big = [];
		if (!count) return;

		// Розмір клітинки — близько діаметра типового вузла.
		const sample: number[] = [];
		const step = Math.max(1, Math.floor(count / 256));
		for (let i = 0; i < count; i += step) sample.push(radii[i]);
		sample.sort((a, b) => a - b);
		this.cell = Math.max(8, sample[sample.length >> 1] * 2);

		const c = this.cell;
		for (let i = 0; i < count; i++) {
			const x = pos[i * 2], y = pos[i * 2 + 1], r = radii[i];
			if (!isFinite(x) || !isFinite(y)) continue;
			const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
			const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
			if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
				this.big.push(i);
				continue;
			}
			for (let cx = x0; cx <= x1; cx++) {
				for (let cy = y0; cy <= y1; cy++) {
					const k = this.key(cx, cy);
					const list = this.cells.get(k);
					if (list) list.push(i);
					else this.cells.set(k, [i]);
				}
			}
		}
	}

	/** Кандидати поблизу точки (x, y) у радіусі slop; можуть повторюватися. */
	query(x: number, y: number, slop: number, out: number[] = []): number[] {
		const c = this.cell;
		const x0 = Math.floor((x - slop) / c), x1 = Math.floor((x + slop) / c);
		const y0 = Math.floor((y - slop) / c), y1 = Math.floor((y + slop) / c);
		for (let cx = x0; cx <= x1; cx++) {
			for (let cy = y0; cy <= y1; cy++) {
				const list = this.cells.get(this.key(cx, cy));
				if (list) for (const i of list) out.push(i);
			}
		}
		for (const i of this.big) out.push(i);
		return out;
	}
}
