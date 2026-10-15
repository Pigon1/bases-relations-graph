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

let nodes: N[] = [];
let links: L[] = [];
let degree: number[] = [];
let version = 0;

const sim: Simulation<N, L> = forceSimulation<N, L>([])
	.velocityDecay(0.4)
	.alphaDecay(0.0228)
	.stop();

function applyForces(f: SimForces): void {
	// Відповідність повзунків нативного графа силам d3 підібрана емпірично.
	sim.force("link", forceLink<N, L>(links)
		.distance(f.linkDistance)
		.strength((l) => f.linkStrength / Math.max(1, Math.min(degree[(l.source as N).index!], degree[(l.target as N).index!]))));
	sim.force("charge", forceManyBody<N>().strength(-f.repelStrength * 30).distanceMax(4000).theta(0.9));
	sim.force("x", forceX<N>(0).strength(f.centerStrength * 0.1));
	sim.force("y", forceY<N>(0).strength(f.centerStrength * 0.1));
	sim.force("collide", forceCollide<N>((n) => n.r + 2).strength(0.6));
}

function positions(): Float32Array {
	const p = new Float32Array(nodes.length * 2);
	for (let i = 0; i < nodes.length; i++) {
		p[i * 2] = nodes[i].x ?? 0;
		p[i * 2 + 1] = nodes[i].y ?? 0;
	}
	return p;
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
	const p = positions();
	const pinned = new Uint8Array(nodes.map((n) => (n.pinned ? 1 : 0)));
	ctx.postMessage({ type: "end", positions: p, pinned, version }, [p.buffer, pinned.buffer]);
});

ctx.onmessage = (e) => {
	const m = e.data;
	switch (m.type) {
		case "graph": {
			version++;
			const old = new Map(nodes.map((n) => [n.id, n]));
			let known = 0;
			nodes = m.nodes.map((n, i) => {
				const prev = old.get(n.id);
				const x = prev?.x ?? n.x;
				const y = prev?.y ?? n.y;
				if (x !== undefined && y !== undefined) known++;
				const pinned = prev ? prev.pinned : !!n.pinned;
				return {
					id: n.id, index: i, r: n.r, pinned,
					x, y, vx: prev?.vx ?? 0, vy: prev?.vy ?? 0,
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
			applyForces(m.forces);
			const fresh = nodes.length ? 1 - known / nodes.length : 0;
			sim.alpha(Math.max(0.15, Math.min(1, fresh + 0.1))).restart();
			break;
		}
		case "forces":
			applyForces(m.forces);
			sim.alpha(Math.max(sim.alpha(), 0.3)).restart();
			break;
		case "drag": {
			const n = nodes[m.index];
			if (!n) return;
			n.fx = m.x; n.fy = m.y;
			sim.alphaTarget(0.3).restart();
			break;
		}
		case "dragEnd": {
			const n = nodes[m.index];
			if (n && !n.pinned) { n.fx = null; n.fy = null; }
			sim.alphaTarget(0);
			break;
		}
		case "pin": {
			const n = nodes[m.index];
			if (!n) return;
			n.pinned = m.pinned;
			n.fx = m.pinned ? n.x : null;
			n.fy = m.pinned ? n.y : null;
			sim.alpha(Math.max(sim.alpha(), 0.05)).restart();
			break;
		}
		case "reheat":
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
