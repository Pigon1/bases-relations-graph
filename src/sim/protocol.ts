/* Повідомлення між поданням і воркером симуляції. */

export interface SimForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
}

export interface SimNodeIn {
	id: string;
	r: number;
	/** Збережена позиція: стартова точка. */
	x?: number;
	y?: number;
	pinned?: boolean;
}

export type ToWorker =
	| { type: "graph"; nodes: SimNodeIn[]; links: [number, number][]; forces: SimForces }
	| { type: "forces"; forces: SimForces }
	| { type: "drag"; index: number; x: number; y: number }
	| { type: "dragEnd"; index: number }
	| { type: "pin"; index: number; pinned: boolean }
	| { type: "reheat" }
	| { type: "stop" };

export type FromWorker =
	/** positions: [x0, y0, x1, y1, …] у порядку вузлів останнього "graph". */
	| { type: "tick"; positions: Float32Array; version: number }
	| { type: "end"; positions: Float32Array; pinned: Uint8Array; version: number };
