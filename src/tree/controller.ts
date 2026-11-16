import type { ViewStateStore } from "../store/viewState";
import {
	applyDrop, emptyTreeState, layoutTree, stickToPositions, topNodes,
	type Dir, type TreeInput, type TreeLayout, type TreeParams, type TreeState,
} from "./layout";

const UNDO_LIMIT = 100;

/** Стан дерева подання: ручні зміни, історія (Ctrl+Z), збереження і перерахунок розташування. */
export class TreeController {
	state: TreeState = emptyTreeState();
	layout: TreeLayout | null = null;
	private input: TreeInput | null = null;
	private params: TreeParams | null = null;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private key = "";

	constructor(private store: ViewStateStore) {}

	async load(key: string, force = false): Promise<void> {
		if (key === this.key && !force) return;
		this.key = key;
		const saved = await this.store.load<TreeState & { shift?: Record<string, [number, number]> }>(key);
		this.state = emptyTreeState();
		if (saved) {
			this.state.orientation = saved.orientation ?? 0;
			this.state.roots = saved.roots ?? [];
			// Старий формат: зсув цілого дерева (shift) — тепер звичайний зсув кореня.
			this.state.offset = { ...(saved.shift ?? {}), ...(saved.offset ?? {}) };
		}
		this.undoStack = [];
		this.redoStack = [];
	}

	/** stick — позиції, у яких вузли мають залишитися (після згортання/розгортання груп). */
	compute(input: TreeInput, params: TreeParams, stick: Map<string, [number, number]> | null = null): TreeLayout {
		this.input = input;
		this.params = params;
		if (stick) {
			stickToPositions(this.state, input, params, stick);
			this.store.save(this.key, this.state);
		}
		this.layout = layoutTree(input, this.state, params);
		return this.layout;
	}

	/** Зміна з можливістю скасування. Після неї треба перерахувати розташування. */
	change(fn: (s: TreeState) => void): void {
		this.undoStack.push(JSON.stringify(this.state));
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = [];
		fn(this.state);
		this.store.save(this.key, this.state);
	}

	undo(): boolean {
		const prev = this.undoStack.pop();
		if (!prev) return false;
		this.redoStack.push(JSON.stringify(this.state));
		this.state = JSON.parse(prev);
		this.store.save(this.key, this.state);
		return true;
	}

	redo(): boolean {
		const next = this.redoStack.pop();
		if (!next) return false;
		this.undoStack.push(JSON.stringify(this.state));
		this.state = JSON.parse(next);
		this.store.save(this.key, this.state);
		return true;
	}

	/** Перенесення вузлів (уже з нащадками) — xy відповідає indices. */
	drop(indices: number[], xy: number[], single = false): void {
		const layout = this.layout, input = this.input;
		if (!layout || !input) return;
		const at = new Map(indices.map((i, k) => [i, [xy[k * 2], xy[k * 2 + 1]] as [number, number]]));
		// Ctrl: кожен вибраний вузол рухається сам (його діти компенсуються), тож беремо всі;
		// інакше — лише найвищі: нащадки їдуть разом із ними.
		const tops = single ? indices : topNodes(layout, indices);
		this.change((s) => {
			for (const v of tops) {
				const p = at.get(v)!;
				applyDrop(s, layout, input.ids, v, p[0], p[1], single);
			}
		});
	}

	setOrientation(d: Dir): void {
		this.change((s) => { s.orientation = d; });
	}

	/** Новий корінь незв'язаної частини; ручні зміни цієї частини скидаються. */
	setRoot(node: number): void {
		const input = this.input;
		if (!input) return;
		const id = input.ids[node];
		const component = componentOf(input, node);
		this.change((s) => {
			s.roots = [id, ...s.roots.filter((r) => r !== id && !component.has(r))];
			for (const v of component) delete s.offset[v];
		});
	}

	/** Скинути ручні зсуви вузлів. */
	resetNodes(nodes: number[]): void {
		const input = this.input;
		if (!input) return;
		this.change((s) => {
			for (const v of nodes) delete s.offset[input.ids[v]];
		});
	}

	resetAll(): void {
		this.change((s) => {
			const orientation = s.orientation;
			Object.assign(s, emptyTreeState(), { orientation });
		});
	}
}

/** Id вузлів незв'язаної частини, що містить node (зв'язки без напрямку). */
function componentOf(input: TreeInput, node: number): Set<string> {
	const adj: number[][] = input.ids.map(() => []);
	for (const [s, t] of input.edges) { adj[s].push(t); adj[t].push(s); }
	const seen = new Set([node]);
	const queue = [node];
	for (let q = 0; q < queue.length; q++) for (const w of adj[queue[q]]) if (!seen.has(w)) { seen.add(w); queue.push(w); }
	return new Set([...seen].map((i) => input.ids[i]));
}
