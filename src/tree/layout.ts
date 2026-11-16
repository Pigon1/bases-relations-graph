/*
 * Розташування дерева. Чисті функції без Obsidian і Pixi — легко перевіряти окремо.
 *
 * Модель:
 * - Ієрархія — зв'язки за напрямком source → target. Кожна незв'язана частина — окреме
 *   дерево. Корінь: вибраний користувачем (тоді зв'язки обходяться без урахування напрямку)
 *   або вузол без вхідних зв'язків із найбільшою кількістю нащадків. Вузол із кількома
 *   батьками стоїть під тим, що ближчий до кореня (обхід у ширину); інші зв'язки — звичайні лінії.
 * - Кожен вузол росте від батька в одному з чотирьох напрямків. Діти, що ростуть в одному
 *   напрямку від одного «якоря», утворюють область (region): у ній є рівні (уздовж напрямку)
 *   і позиція в рівні (поперек). Поворот гілки (Ctrl) створює нову область біля батька.
 * - Ручні зміни зберігаються в TreeState: корені й вільний зсув вузла від автоматичної
 *   позиції. Зсув успадковують нащадки (гілка рухається разом), але він не прив'язаний до
 *   рівнів і не зсуває сусідів. Решта рахується автоматично (охайне дерево + розсування в рівні).
 */

/** Напрямок росту: 0 — вниз, 1 — праворуч, 2 — вгору, 3 — ліворуч. */
export type Dir = 0 | 1 | 2 | 3;

/** Вісь рівнів (від батька до дітей) для кожного напрямку. */
const DV: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
/** Вісь позиції в рівні (перпендикуляр). */
const UV: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function dirVector(d: number): [number, number] {
	return DV[((d % 4) + 4) % 4];
}

export interface TreeState {
	/** Базова орієнтація всієї карти. */
	orientation: Dir;
	/** Корені, вибрані користувачем (по одному на незв'язану частину). */
	roots: string[];
	/** Вільний зсув вузла від автоматичної позиції (світові координати); успадковують нащадки. */
	offset: Record<string, [number, number]>;
}

export function emptyTreeState(): TreeState {
	return { orientation: 0, roots: [], offset: {} };
}

export interface TreeInput {
	ids: string[];
	/** Радіуси вузлів (разом з обведенням). */
	radii: ArrayLike<number>;
	/** Назви для впорядкування братів. */
	names: string[];
	edges: [number, number][];
}

export interface TreeParams {
	levelGap: number;
	siblingGap: number;
	/** Відстань між сусідніми деревами. */
	treeGap: number;
}

export interface Region {
	anchor: number;
	dir: Dir;
	/** Світова позиція якоря. */
	x: number;
	y: number;
}

export interface TreeLayout {
	pos: Float32Array;
	/** Батько в дереві, −1 для коренів. */
	parent: Int32Array;
	children: number[][];
	/** Напрямок, у якому вузол росте від батька (корені — орієнтація карти). */
	dir: Int8Array;
	/** Область вузла (−1 для коренів). */
	region: Int32Array;
	regions: Region[];
	/** Рівень вузла в його області (якір = 0). */
	level: Int32Array;
	/** Для кожного вхідного зв'язку: 1 — зв'язок ієрархії. */
	treeEdge: Uint8Array;
	roots: number[];
}

// ---------- Ліс ----------

interface Forest {
	parent: Int32Array;
	children: number[][];
	roots: number[];
	treeEdge: Uint8Array;
}

function buildForest(input: TreeInput, state: TreeState): Forest {
	const n = input.ids.length;
	const out: number[][] = Array.from({ length: n }, () => []);
	const und: number[][] = Array.from({ length: n }, () => []);
	const indeg = new Int32Array(n);
	for (const [s, t] of input.edges) {
		if (s === t) continue;
		out[s].push(t);
		und[s].push(t);
		und[t].push(s);
		indeg[t]++;
	}
	// Ранги назв рахуються один раз — порівняння рядків у кожному сортуванні надто дороге.
	const collator = new Intl.Collator(undefined, { numeric: true });
	const rank = new Int32Array(n);
	[...Array(n).keys()].sort((x, y) => collator.compare(input.names[x], input.names[y]) || x - y).forEach((v, k) => { rank[v] = k; });
	const byName = (a: number, b: number) => rank[a] - rank[b];
	for (const list of out) list.sort(byName);
	for (const list of und) list.sort(byName);

	// Незв'язані частини.
	const comp = new Int32Array(n).fill(-1);
	const comps: number[][] = [];
	for (let i = 0; i < n; i++) {
		if (comp[i] >= 0) continue;
		const c = comps.length;
		const list = [i];
		comp[i] = c;
		for (let q = 0; q < list.length; q++) for (const j of und[list[q]]) if (comp[j] < 0) { comp[j] = c; list.push(j); }
		comps.push(list);
	}

	const parent = new Int32Array(n).fill(-1);
	const children: number[][] = Array.from({ length: n }, () => []);
	const visited = new Uint8Array(n);
	const roots: number[] = [];
	const index = new Map(input.ids.map((id, i) => [id, i]));
	const userRoots = state.roots.map((id) => index.get(id)).filter((i): i is number => i !== undefined);

	const bfs = (root: number, adj: number[][]) => {
		visited[root] = 1;
		roots.push(root);
		const queue = [root];
		for (let q = 0; q < queue.length; q++) {
			const v = queue[q];
			for (const w of adj[v]) {
				if (visited[w]) continue;
				visited[w] = 1;
				parent[w] = v;
				children[v].push(w);
				queue.push(w);
			}
		}
	};

	/** Скільки вузлів досяжно за напрямком (для вибору кореня). */
	const reach = (start: number): number => {
		const seen = new Set([start]);
		const queue = [start];
		for (let q = 0; q < queue.length; q++) for (const w of out[queue[q]]) if (!visited[w] && !seen.has(w)) { seen.add(w); queue.push(w); }
		return seen.size;
	};

	for (const list of comps) {
		const user = userRoots.find((r) => comp[r] === comp[list[0]]);
		if (user !== undefined) {
			// Корінь вибрано вручну — уся частина перерозподіляється під нього.
			bfs(user, und);
			continue;
		}
		// Автоматично: корені без вхідних зв'язків, найбільше дерево першим;
		// що лишилося недосяжним (цикли) — окремими деревами.
		while (true) {
			const rest = list.filter((v) => !visited[v]);
			if (!rest.length) break;
			let candidates = rest.filter((v) => indeg[v] === 0);
			if (!candidates.length) candidates = rest;
			if (candidates.length > 64) candidates = candidates.sort((a, b) => out[b].length - out[a].length).slice(0, 64);
			let best = candidates[0], bestReach = -1;
			for (const c of candidates) {
				const r = reach(c);
				if (r > bestReach || (r === bestReach && byName(c, best) < 0)) { best = c; bestReach = r; }
			}
			bfs(best, out);
		}
	}

	const treeEdge = new Uint8Array(input.edges.length);
	input.edges.forEach(([s, t], k) => {
		if (parent[t] === s || parent[s] === t) treeEdge[k] = 1;
	});
	return { parent, children, roots, treeEdge };
}

// ---------- Розташування ----------

export function layoutTree(input: TreeInput, state: TreeState, params: TreeParams): TreeLayout {
	const n = input.ids.length;
	const { parent, children, roots, treeEdge } = buildForest(input, state);
	const ids = input.ids;
	const r = input.radii;

	// Напрямки й області.
	const dir = new Int8Array(n);
	const region = new Int32Array(n).fill(-1);
	const level = new Int32Array(n);
	const regions: Region[] = [];
	const regionKey = new Map<number, number>();
	const getRegion = (anchor: number, d: Dir) => {
		const key = anchor * 4 + d;
		let k = regionKey.get(key);
		if (k === undefined) {
			k = regions.length;
			regions.push({ anchor, dir: d, x: 0, y: 0 });
			regionKey.set(key, k);
		}
		return k;
	};
	/** Члени області, згруповані за батьком (у порядку обходу). */
	const regionChildren = new Map<number, number[]>();

	const order: number[] = [];
	for (const root of roots) {
		dir[root] = state.orientation;
		const queue = [root];
		for (let q = 0; q < queue.length; q++) {
			const v = queue[q];
			order.push(v);
			for (const c of children[v]) {
				const d = dir[v] as Dir;
				dir[c] = d;
				// Та сама область, що й у батька, якщо напрямок не змінився (і батько не корінь).
				const same = parent[v] >= 0 && d === dir[v];
				const reg = same ? region[v] : getRegion(v, d);
				region[c] = reg;
				const anchorChild = regions[reg].anchor === v;
				level[c] = (anchorChild ? 0 : level[v]) + 1;
				let list = regionChildren.get(v * 4 + d);
				if (!list) regionChildren.set(v * 4 + d, (list = []));
				list.push(c);
				queue.push(c);
			}
		}
	}

	const diam = (i: number) => r[i] * 2 + params.siblingGap;
	const kids = (v: number, d: number) => regionChildren.get(v * 4 + d) ?? [];

	// Ширина піддерева в межах його області (повернуті гілки місця не займають).
	const width = new Float64Array(n);
	for (let k = order.length - 1; k >= 0; k--) {
		const v = order[k];
		const d = parent[v] < 0 ? -1 : dir[v];
		let sum = 0;
		if (d >= 0) for (const c of kids(v, d)) sum += width[c];
		width[v] = Math.max(diam(v), sum);
	}

	// Позиція в рівні (u) — охайне дерево.
	const u = new Float64Array(n);
	const place = (list: number[], center: number) => {
		let total = 0;
		for (const c of list) total += width[c];
		let x = center - total / 2;
		for (const c of list) {
			u[c] = x + width[c] / 2;
			x += width[c];
			place(kids(c, dir[c]), u[c]);
		}
	};

	const pos = new Float32Array(n * 2);
	// Корені — поруч уздовж осі рівня базової орієнтації.
	const baseU = UV[state.orientation];
	let cursor = 0;
	const rootWidth = (root: number) => {
		let w = diam(root);
		for (let d = 0; d < 4; d++) {
			let sum = 0;
			for (const c of kids(root, d)) sum += width[c];
			if (d === state.orientation || d === (state.orientation + 2) % 4) w = Math.max(w, sum);
		}
		return w;
	};
	for (const root of roots) {
		const w = rootWidth(root);
		pos[root * 2] = (cursor + w / 2) * baseU[0];
		pos[root * 2 + 1] = (cursor + w / 2) * baseU[1];
		cursor += w + params.treeGap;
	}
	// Вирівнюємо весь ліс відносно нуля.
	const half = (cursor - params.treeGap) / 2;
	for (const root of roots) {
		pos[root * 2] -= half * baseU[0];
		pos[root * 2 + 1] -= half * baseU[1];
	}

	// Області: якір має бути розташований раніше — обходимо в порядку дерева.
	const done = new Uint8Array(regions.length);
	for (const v of order) {
		for (let d = 0; d < 4; d++) {
			const list = kids(v, d);
			if (!list.length) continue;
			const reg = region[list[0]];
			if (regions[reg].anchor !== v || done[reg]) continue;
			done[reg] = 1;
			const R = regions[reg];
			R.x = pos[v * 2];
			R.y = pos[v * 2 + 1];
			place(list, 0);
			// Члени області за рівнями.
			const members: number[] = [];
			const stack = [...list];
			while (stack.length) {
				const c = stack.pop()!;
				members.push(c);
				stack.push(...kids(c, dir[c]));
			}
			// Батько в межах області (якір області — не член, його зсув не передається).
			resolveRows(members, level, u, r, params.siblingGap, (c) => (parent[c] === R.anchor ? -1 : parent[c]));
			const [dx, dy] = DV[R.dir], [ux, uy] = UV[R.dir];
			for (const c of members) {
				const lv = level[c] * params.levelGap;
				pos[c * 2] = R.x + dx * lv + ux * u[c];
				pos[c * 2 + 1] = R.y + dy * lv + uy * u[c];
			}
		}
	}

	// Ручні зсуви: вузол зсувається на свій зсув плюс зсуви всіх предків (гілка рухається разом).
	const cum = new Float64Array(n * 2);
	for (const v of order) {
		const p = parent[v];
		const off = state.offset[ids[v]];
		cum[v * 2] = (p >= 0 ? cum[p * 2] : 0) + (off?.[0] ?? 0);
		cum[v * 2 + 1] = (p >= 0 ? cum[p * 2 + 1] : 0) + (off?.[1] ?? 0);
		pos[v * 2] += cum[v * 2];
		pos[v * 2 + 1] += cum[v * 2 + 1];
	}

	return { pos, parent, children, dir, region, regions, level, treeEdge, roots };
}

/**
 * Розсування в межах рівня: вузли рівня йдуть за зростанням u, і кожен відсувається
 * від попереднього щонайменше на суму радіусів + проміжок. Відсунутий вузол тягне
 * за собою своє піддерево: зсув накопичується й передається дітям, коли обробляється
 * їхній рівень (рівні — згори донизу), тож кожен вузол торкається лише раз.
 */
function resolveRows(
	members: number[], level: Int32Array, u: Float64Array, r: ArrayLike<number>, gap: number,
	parentOf: (v: number) => number,
): void {
	const rows = new Map<number, number[]>();
	for (const c of members) {
		let row = rows.get(level[c]);
		if (!row) rows.set(level[c], (row = []));
		row.push(c);
	}
	const shift = new Map<number, number>();
	for (const lv of [...rows.keys()].sort((a, b) => a - b)) {
		const row = rows.get(lv)!;
		for (const c of row) {
			const p = parentOf(c);
			const inherited = p >= 0 ? shift.get(p) ?? 0 : 0;
			if (inherited) u[c] += inherited;
			shift.set(c, inherited);
		}
		row.sort((a, b) => u[a] - u[b]);
		for (let k = 1; k < row.length; k++) {
			const prev = row[k - 1], cur = row[k];
			const min = u[prev] + r[prev] + r[cur] + gap;
			if (u[cur] < min) {
				const delta = min - u[cur];
				u[cur] = min;
				shift.set(cur, shift.get(cur)! + delta);
			}
		}
	}
}

// ---------- Ручні зміни ----------

/** Нащадки вузлів (усі гілки), без самих вузлів. */
export function descendants(layout: TreeLayout, nodes: number[]): number[] {
	const out: number[] = [];
	const seen = new Set(nodes);
	const stack = [...nodes];
	while (stack.length) {
		const v = stack.pop()!;
		for (const c of layout.children[v]) {
			if (seen.has(c)) continue;
			seen.add(c);
			out.push(c);
			stack.push(c);
		}
	}
	return out;
}

/** Найвищі вузли набору: ті, чиїх предків у наборі немає. */
export function topNodes(layout: TreeLayout, nodes: number[]): number[] {
	const set = new Set(nodes);
	return nodes.filter((v) => {
		for (let p = layout.parent[v]; p >= 0; p = layout.parent[p]) if (set.has(p)) return false;
		return true;
	});
}

/**
 * Перенесення вузла в точку (x, y). Зазвичай нащадки рухаються разом із ним;
 * single (Ctrl) — рухається лише сам вузол: його дітям додається зворотний зсув.
 */
export function applyDrop(
	state: TreeState, layout: TreeLayout, ids: string[], node: number, x: number, y: number, single = false,
): void {
	const ddx = x - layout.pos[node * 2], ddy = y - layout.pos[node * 2 + 1];
	addOffset(state, ids[node], ddx, ddy);
	if (single) for (const c of layout.children[node]) addOffset(state, ids[c], -ddx, -ddy);
}

function addOffset(state: TreeState, id: string, dx: number, dy: number): void {
	const prev = state.offset[id] ?? [0, 0];
	const ox = prev[0] + dx, oy = prev[1] + dy;
	if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) delete state.offset[id];
	else state.offset[id] = [ox, oy];
}

/**
 * Підбирає зсуви так, щоб вузли з prev опинилися саме в цих позиціях, а решта
 * (нові) — на своїх автоматичних місцях відносно батька. Так зміна структури
 * (згортання груп) не переставляє вже розміщені вузли.
 */
export function stickToPositions(state: TreeState, input: TreeInput, params: TreeParams, prev: Map<string, [number, number]>): void {
	const auto = layoutTree(input, { ...state, offset: {} }, params);
	const n = input.ids.length;
	const cum = new Float64Array(n * 2);
	const offset: Record<string, [number, number]> = {};
	const queue = [...auto.roots];
	for (let q = 0; q < queue.length; q++) {
		const v = queue[q];
		const p = auto.parent[v];
		const px = p >= 0 ? cum[p * 2] : 0, py = p >= 0 ? cum[p * 2 + 1] : 0;
		const want = prev.get(input.ids[v]);
		let ox = 0, oy = 0;
		if (want) {
			ox = want[0] - (auto.pos[v * 2] + px);
			oy = want[1] - (auto.pos[v * 2 + 1] + py);
		}
		if (Math.abs(ox) >= 0.01 || Math.abs(oy) >= 0.01) offset[input.ids[v]] = [ox, oy];
		cum[v * 2] = px + ox;
		cum[v * 2 + 1] = py + oy;
		queue.push(...auto.children[v]);
	}
	state.offset = offset;
}
