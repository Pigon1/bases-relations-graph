import workerCode from "./sim.worker.ts?worker";
import type { FromWorker, ToWorker } from "./protocol";

/** Запуск воркера симуляції з вбудованого коду (плагін — один файл main.js). */
export class SimClient {
	private worker: Worker;
	private url: string;

	constructor(onMessage: (m: FromWorker) => void) {
		this.url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
		this.worker = new Worker(this.url);
		this.worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
		this.worker.onerror = (e) => console.error("[bases-graph] simulation worker error", e);
	}

	send(m: ToWorker): void {
		this.worker.postMessage(m);
	}

	destroy(): void {
		this.worker.terminate();
		URL.revokeObjectURL(this.url);
	}
}
