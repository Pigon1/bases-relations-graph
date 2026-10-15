import { Notice, Plugin, TFile } from "obsidian";
import { PositionStore } from "./store/positions";
import { GraphView, VIEW_TYPE } from "./view/GraphView";

export default class BasesGraphPlugin extends Plugin {
	positions!: PositionStore;

	async onload(): Promise<void> {
		this.positions = new PositionStore(this.app.vault.adapter, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);

		const ok = this.registerBasesView(VIEW_TYPE, {
			name: "Graph",
			icon: "git-fork",
			factory: (controller, containerEl) => new GraphView(controller, containerEl, this),
			options: () => GraphView.options(),
		});
		if (!ok) new Notice("Bases Graph: enable the core Bases plugin to use the Graph view.");

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			if (file.extension === "base") void this.positions.renameBase(oldPath, file.path);
			else this.positions.renamePath(oldPath, file.path);
		}));
	}

	async onunload(): Promise<void> {
		await this.positions.flush();
	}
}
