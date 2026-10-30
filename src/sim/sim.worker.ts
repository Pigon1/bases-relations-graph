import {
	forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
	type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import type { FromWorker, SimForces, ToWorker } from "./protocol";

interface N extends SimulationNodeDatum {
	id: string;
	r: number;
	pinned: boolean;
}
type L = SimulationLinkDatum<N>;

const ctx = self as unknown as {
	postMessage(m: FromWorker, transfer?: Transferable[]): void;
	onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

/** Скільки кроків по зв'язках від перетягуваного вузла «мотузка» може зрушити вузли. */
const ROPE_DEPTH = 12;
/** Частка натягу, яку зв'язок «вибирає» за крок. */
const ROPE_STIFFNESS = 0.8;
/** Слабина: зв'язок починає тягнути, коли довшає на 30% (+10) від довжини на початку перетягування. */
const ROPE_SLACK = 1.3;
const ROPE_SLACK_MIN = 10;

let nodes: N[] = [];
let links: L[] = [];
let degree: number[] = [];
let version = 0;
let forces: SimForces = { centerStrength: 0.52, repelStrength: 10, linkStrength: 1, linkDistance: 250 };
let frozen = false;
/**
 * Що зараз робить симуляція:
 * - layout — звичайна фізика;
 * - place — заморожений режим, розставляються лише нові вузли (решта тимчасово зафіксована);
 * - rope — заморожений режим, перетягування «мотузкою».
 */
let mode: "layout" | "place" | "rope" = "layout";
/** Вузли, зафіксовані тимчасово (place/rope), — щоб потім відпустити. */
let tempFixed: N[] = [];

const sim: Simulation<N, L> = forceSimulation<N, L>([])
	.velocityDecay(0.4)
	.alphaDecay(0.0228)
	.stop();

function applyForces(): void {
	const f = forces;
	// Відповідність повзунків нативного графа силам d3 підібрана емпірично.
	sim.force("rope", null);
	sim.force("link", forceLink<N, L>(links)
		.distance(f.linkDistance)
		.strength((l) => f.linkStrength / Math.max(1, Math.min(degree[(l.source as N).index!], degree[(l.target as N).index!]))));
	sim.force("charge", forceManyBody<N>().strength(-f.repelStrength * 30).distanceMax(4000).theta(0.9));
	sim.force("x", forceX<N>(0).strength(f.centerStrength * 0.1));
	sim.force("y", forceY<N>(0).strength(f.centerStrength * 0.1));
	sim.force("collide", forceCollide<N>((n) => n.r + 2).strength(0.6));
	sim.velocityDecay(0.4);
}

function positions(): Float32Array {
	const p = new Float32Array(nodes.length * 2);
	for (let i = 0; i < nodes.length; i++) {
		p[i * 2] = nodes[i].x ?? 0;
		p[i * 2 + 1] = nodes[i].y ?? 0;
	}
	return p;
}

function postEnd(): void {
	const p = positions();
	const pinned = new Uint8Array(nodes.map((n) => (n.pinned ? 1 : 0)));
	ctx.postMessage({ type: "end", positions: p, pinned, version }, [p.buffer, pinned.buffer]);
}

function fixTemporarily(list: N[]): void {
	for (const n of list) {
		if (n.fx != null) continue;
		n.fx = n.x;
		n.fy = n.y;
		tempFixed.push(n);
	}
}

function releaseTemporary(): void {
	for (const n of tempFixed) {
		if (n.pinned) continue;
		n.fx = null;
		n.fy = null;
	}
	tempFixed = [];
}

/** Зупиняє будь-який рух і повертає звичайні сили (заморожений стан). */
function settleFrozen(): void {
	sim.stop();
	sim.alphaTarget(0);
	releaseTemporary();
	for (const n of nodes) { n.vx = 0; n.vy = 0; }
	if (mode === "rope") applyForces();
	mode = "layout";
	postEnd();
}

let lastPost = 0;
sim.on("tick", () => {
	const now = performance.now();
	if (now - lastPost < 15) return;
	lastPost = now;
	const p = positions();
	ctx.postMessage({ type: "tick", positions: p, version }, [p.buffer]);
});

sim.on("end", () => {
	if (mode === "place") {
		releaseTemporary();
		mode = "layout";
	}
	postEnd();
});

/**
 * «Мотузка по підлозі»: зв'язок тягне лише тоді, коли натягнувся довше за свою
 * слабину (довжина на початку перетягування + ROPE_SLACK). Кожна ланка «з'їдає»
 * частину руху, тому далекі вузли зсуваються менше; висока в'язкість — тертя об підлогу.
 */
function startRope(dragged: number[]): void {
	mode = "rope";
	const adj: number[][] = nodes.map(() => []);
	for (const l of links) {
		const s = (l.source as N).index!, t = (l.target as N).index!;
		adj[s].push(t);
		adj[t].push(s);
	}
	const depth = new Int32Array(nodes.length).fill(-1);
	const queue: number[] = [];
	for (const i of dragged) { depth[i] = 0; queue.push(i); }
	for (let q = 0; q < queue.length; q++) {
		const i = queue[q];
		if (depth[i] >= ROPE_DEPTH) continue;
		for (const j of adj[i]) if (depth[j] < 0) { depth[j] = depth[i] + 1; queue.push(j); }
	}
	// Усе поза досяжністю мотузки стоїть на місці.
	fixTemporarily(nodes.filter((n) => depth[n.index!] < 0));

	const rest = new Map<L, number>();
	const active = links.filter((l) => depth[(l.source as N).index!] >= 0 && depth[(l.target as N).index!] >= 0);
	for (const l of active) {
		const a = l.source as N, b = l.target as N;
		const d = Math.max(Math.hypot(b.x! - a.x!, b.y! - a.y!), a.r + b.r + 4);
		rest.set(l, d * ROPE_SLACK + ROPE_SLACK_MIN);
	}
	const rope = () => {
		for (const l of active) {
			const a = l.source as N, b = l.target as N;
			const dx = b.x! - a.x!, dy = b.y! - a.y!;
			const d = Math.hypot(dx, dy) || 1;
			const over = d - rest.get(l)!;
			if (over <= 0) continue;
			const k = (over / d) * ROPE_STIFFNESS;
			const aFixed = a.fx != null, bFixed = b.fx != null;
			if (aFixed && bFixed) continue;
			const wa = aFixed ? 0 : bFixed ? 1 : 0.5, wb = bFixed ? 0 : aFixed ? 1 : 0.5;
			a.vx! += dx * k * wa; a.vy! += dy * k * wa;
			b.vx! -= dx * k * wb; b.vy! -= dy * k * wb;
		}
	};
	sim.force("link", null).force("charge", null).force("x", null).force("y", null);
	sim.force("rope", rope);
	sim.velocityDecay(0.7);
	sim.alpha(1).alphaTarget(1).restart();
}

ctx.onmessage = (e) => {
	const m = e.data;
	switch (m.type) {
		case "graph": {
			version++;
			sim.stop();
			tempFixed = [];
			if (mode === "rope") mode = "layout";
			frozen = m.frozen;
			forces = m.forces;
			const old = new Map(nodes.map((n) => [n.id, n]));
			const known = new Set<number>();
			nodes = m.nodes.map((n, i) => {
				const prev = old.get(n.id);
				const x = prev?.x ?? n.x;
				const y = prev?.y ?? n.y;
				if (x !== undefined && y !== undefined) known.add(i);
				const pinned = prev ? prev.pinned : !!n.pinned;
				return {
					id: n.id, index: i, r: n.r, pinned,
					x, y, vx: 0, vy: 0,
					fx: pinned ? x : null, fy: pinned ? y : null,
				};
			});
			// Нові вузли без позиції — поруч із сусідом, якщо він уже має позицію.
			degree = new Array(nodes.length).fill(0);
			for (const [s, t] of m.links) { degree[s]++; degree[t]++; }
			for (const [s, t] of m.links) {
				const a = nodes[s], b = nodes[t];
				if (a.x === undefined && b.x !== undefined) { a.x = b.x + rnd(); a.y = b.y! + rnd(); }
				if (b.x === undefined && a.x !== undefined) { b.x = a.x + rnd(); b.y = a.y! + rnd(); }
			}
			const spread = Math.sqrt(nodes.length) * 40 + 100;
			for (const n of nodes) if (n.x === undefined) { n.x = (Math.random() - 0.5) * spread; n.y = (Math.random() - 0.5) * spread; }

			links = m.links.map(([s, t]) => ({ source: s, target: t }));
			sim.nodes(nodes);
			applyForces();
			const fresh = nodes.length - known.size;
			if (!frozen) {
				mode = "layout";
				sim.alpha(Math.max(0.15, Math.min(1, fresh / Math.max(1, nodes.length) + 0.1))).restart();
			} else if (fresh > 0) {
				// Заморожено: рухаються лише нові вузли, відомі тимчасово зафіксовані.
				mode = "place";
				fixTemporarily(nodes.filter((n) => known.has(n.index!)));
				// Жодної відомої позиції (нове подання) — повний розрахунок, а не лише «підсаджування».
				sim.alpha(known.size === 0 ? 1 : 0.6).restart();
			} else {
				mode = "layout";
				postEnd();
			}
			break;
		}
		case "forces":
			forces = m.forces;
			if (mode !== "rope") applyForces();
			if (!frozen) sim.alpha(Math.max(sim.alpha(), 0.3)).restart();
			break;
		case "frozen":
			frozen = m.frozen;
			if (frozen) settleFrozen();
			else {
				releaseTemporary();
				if (mode === "rope") applyForces();
				mode = "layout";
				sim.alpha(0.3).restart();
			}
			break;
		case "dragStart": {
			const list = m.indices.filter((i) => nodes[i]);
			for (const i of list) {
				nodes[i].fx = nodes[i].x;
				nodes[i].fy = nodes[i].y;
			}
			if (frozen) {
				if (m.rope) startRope(list);
			} else {
				sim.alphaTarget(0.3).restart();
			}
			break;
		}
		case "drag":
			m.indices.forEach((i, k) => {
				const n = nodes[i];
				if (!n) return;
				n.fx = m.xy[k * 2];
				n.fy = m.xy[k * 2 + 1];
			});
			break;
		case "dragEnd":
			for (const i of m.indices) {
				const n = nodes[i];
				if (!n) continue;
				n.x = n.fx ?? n.x;
				n.y = n.fy ?? n.y;
				if (!n.pinned) { n.fx = null; n.fy = null; }
			}
			if (frozen) settleFrozen();
			else sim.alphaTarget(0);
			break;
		case "move":
			m.indices.forEach((i, k) => {
				const n = nodes[i];
				if (!n) return;
				n.x = m.xy[k * 2];
				n.y = m.xy[k * 2 + 1];
				n.vx = 0; n.vy = 0;
				if (n.pinned) { n.fx = n.x; n.fy = n.y; }
			});
			if (frozen) postEnd();
			else sim.alpha(Math.max(sim.alpha(), 0.1)).restart();
			break;
		case "pin":
			for (const i of m.indices) {
				const n = nodes[i];
				if (!n) continue;
				n.pinned = m.pinned;
				n.fx = m.pinned ? n.x : null;
				n.fy = m.pinned ? n.y : null;
			}
			if (frozen) postEnd();
			else sim.alpha(Math.max(sim.alpha(), 0.05)).restart();
			break;
		case "reheat":
			// У замороженому режимі — одноразовий перерахунок, після якого граф знову стоїть.
			releaseTemporary();
			if (mode === "rope") applyForces();
			mode = "layout";
			sim.alpha(1).restart();
			break;
		case "stop":
			sim.stop();
			break;
	}
};

function rnd(): number {
	return (Math.random() - 0.5) * 60;
}
