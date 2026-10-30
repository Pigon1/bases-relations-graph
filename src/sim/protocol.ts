/* Повідомлення між поданням і воркером симуляції. */

export interface SimForces {
	centerStrength: number;
	repelStrength: number;
	linkStrength: number;
	linkDistance: number;
	groupForce: number;
	groupSeparation: number;
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
	/** frozen — фізика вимкнена; нові вузли розставляються короткою локальною симуляцією. */
	| { type: "graph"; nodes: SimNodeIn[]; links: [number, number][]; groups: number[][]; forces: SimForces; frozen: boolean }
	| { type: "forces"; forces: SimForces }
	| { type: "frozen"; frozen: boolean }
	/** rope — «мотузка» (лише в замороженому режимі): сусіди тягнуться за натягнутими зв'язками. */
	| { type: "dragStart"; indices: number[]; rope: boolean }
	/** xy: [x0, y0, x1, y1, …] для indices. */
	| { type: "drag"; indices: number[]; xy: number[] }
	| { type: "dragEnd"; indices: number[] }
	/** Пряме переміщення без фізики (заморожений режим). */
	| { type: "move"; indices: number[]; xy: number[] }
	| { type: "pin"; indices: number[]; pinned: boolean }
	| { type: "reheat" }
	| { type: "stop" };

export type FromWorker =
	/** positions: [x0, y0, x1, y1, …] у порядку вузлів останнього "graph". */
	| { type: "tick"; positions: Float32Array; version: number }
	| { type: "end"; positions: Float32Array; pinned: Uint8Array; version: number };
