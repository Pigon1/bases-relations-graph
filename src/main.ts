import { Notice, Plugin, requireApiVersion, TFile } from "obsidian";
import { BasesRelationsGraphSettingTab, DEFAULT_PLUGIN_SETTINGS, GRAPH_ACTIONS, mergeSettings, type PluginSettings } from "./settings";
import { PositionStore, type SavedPos } from "./store/positions";
import { ViewStateStore } from "./store/viewState";
import { GraphView, VIEW_TYPE } from "./view/GraphView";

interface StoredPluginData extends Partial<PluginSettings> {
	positions?: Record<string, Record<string, SavedPos>>;
	treeStates?: Record<string, unknown>;
}

export default class BasesRelationsGraphPlugin extends Plugin {
	settings: PluginSettings = mergeSettings(DEFAULT_PLUGIN_SETTINGS);
	positions!: PositionStore;
	/** Ручні зміни дерева — окремо для кожного подання. */
	treeStates!: ViewStateStore;
	private views = new Set<GraphView>();
	private lastActiveView: GraphView | null = null;

	async onload(): Promise<void> {
		this.positions = new PositionStore(() => this.persistAllData());
		this.treeStates = new ViewStateStore(() => this.persistAllData());

		if (!requireApiVersion(this.manifest.minAppVersion) || typeof this.registerBasesView !== "function") {
			new Notice(`${this.manifest.name} requires Obsidian ${this.manifest.minAppVersion} or newer.`);
			return;
		}

		this.addSettingTab(new BasesRelationsGraphSettingTab(this.app, this));

		const ok = this.registerBasesView(VIEW_TYPE, {
			name: "Relations graph",
			icon: "git-fork",
			factory: (controller, containerEl) => new GraphView(controller, containerEl, this),
			options: () => GraphView.options(),
		});
		if (!ok) new Notice(`${this.manifest.name}: enable the core Bases plugin to use the Graph view.`);

		for (const action of GRAPH_ACTIONS) {
			this.addCommand({
				id: action.id,
				name: action.name,
				checkCallback: (checking) => {
					const view = this.getActiveGraphView();
					if (!view || !view.canRunAction(action.id)) return false;
					if (!checking) view.runAction(action.id);
					return true;
				},
			});
		}

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			if (file.extension === "base") {
				void this.positions.renameBase(oldPath, file.path);
				this.treeStates.renameBase(oldPath, file.path);
			} else {
				this.positions.renamePath(oldPath, file.path);
			}
		}));

		const raw = (await this.loadData()) as StoredPluginData | null;
		this.settings = mergeSettings(raw);
		this.positions.init(raw?.positions);
		this.treeStates.init(raw?.treeStates);
		for (const v of this.views) {
			v.syncPluginSettings();
			v.reloadSavedState();
		}
	}

	async saveSettings(): Promise<void> {
		await this.persistAllData();
		for (const v of this.views) v.syncPluginSettings();
	}

	private async persistAllData(): Promise<void> {
		const payload: StoredPluginData = {
			modifiers: this.settings.modifiers,
			hotkeys: this.settings.hotkeys,
			positions: this.positions.toJSON(),
			treeStates: this.treeStates.toJSON(),
		};
		await this.saveData(payload);
	}

	registerGraphView(view: GraphView): void {
		this.views.add(view);
		this.lastActiveView = view;
	}

	unregisterGraphView(view: GraphView): void {
		this.views.delete(view);
		if (this.lastActiveView === view) {
			this.lastActiveView = null;
		}
	}

	setActiveGraphView(view: GraphView): void {
		this.lastActiveView = view;
	}

	getActiveGraphView(): GraphView | null {
		for (const v of this.views) {
			if (v.isGraphVisible() && v.hasGraphFocus()) return v;
		}
		const leafEl = this.app.workspace.getMostRecentLeaf()?.view?.containerEl;
		if (leafEl) {
			for (const v of this.views) {
				if (v.isGraphVisible() && v.isInContainer(leafEl)) return v;
			}
		}
		if (this.lastActiveView?.isGraphVisible()) return this.lastActiveView;
		for (const v of this.views) {
			if (v.isGraphVisible()) return v;
		}
		return null;
	}

	onunload(): void {
		void this.positions.flush();
		void this.treeStates.flush();
	}
}
