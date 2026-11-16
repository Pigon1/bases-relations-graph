import { App, Platform, PluginSettingTab, Setting, setIcon } from "obsidian";
import type BasesRelationsGraphPlugin from "./main";

export type ModifierKey = "Mod" | "Shift" | "Alt" | "Ctrl";

export interface HotkeyBinding {
	modifiers: ModifierKey[];
	key: string;
}

export type GraphActionId =
	| "fit"
	| "freeze"
	| "reheat"
	| "selectAll"
	| "clearSelection"
	| "undo"
	| "redo"
	| "pickRoot"
	| "resetTree";

export interface MouseModifiers {
	/** Виділення вузлів кліком, групи за оболонкою та рамка виділення. */
	select: ModifierKey;
	/** Модифікатор + клік по згорнутій групі — оверлей підглядання. */
	peek: ModifierKey;
	/** Модифікатор + перетягування у замороженому режимі — тягне сусідів («мотузка»). */
	ropeDrag: ModifierKey;
	/** Модифікатор + перетягування у дереві — рухає вузол без його нащадків. */
	treeSingleDrag: ModifierKey;
}

export interface PluginSettings {
	modifiers: MouseModifiers;
	hotkeys: Record<GraphActionId, HotkeyBinding[]>;
}

export interface ActionMeta {
	id: GraphActionId;
	name: string;
	desc: string;
}

export const GRAPH_ACTIONS: ActionMeta[] = [
	{
		id: "fit",
		name: "Fit graph to view",
		desc: "Zoom and pan so all visible nodes fit in the viewport.",
	},
	{
		id: "freeze",
		name: "Toggle freeze layout",
		desc: "Switch between live force simulation and frozen layout.",
	},
	{
		id: "reheat",
		name: "Restart simulation",
		desc: "Reheat the force simulation or recalculate frozen layout once.",
	},
	{
		id: "selectAll",
		name: "Select all nodes",
		desc: "Select all visible nodes in the graph.",
	},
	{
		id: "clearSelection",
		name: "Clear selection / close preview",
		desc: "Deselect nodes, close the collapsed group preview, or cancel root picking.",
	},
	{
		id: "undo",
		name: "Tree: undo layout change",
		desc: "Undo the last manual change in tree layout.",
	},
	{
		id: "redo",
		name: "Tree: redo layout change",
		desc: "Redo the previously undone manual change in tree layout.",
	},
	{
		id: "pickRoot",
		name: "Tree: choose root node",
		desc: "Toggle root selection mode in tree layout.",
	},
	{
		id: "resetTree",
		name: "Tree: reset manual layout",
		desc: "Reset manual node offsets and custom root in tree layout.",
	},
];

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
	modifiers: {
		select: "Shift",
		peek: "Mod",
		ropeDrag: "Mod",
		treeSingleDrag: "Mod",
	},
	hotkeys: {
		fit: [],
		freeze: [],
		reheat: [],
		selectAll: [{ modifiers: ["Mod"], key: "a" }],
		clearSelection: [{ modifiers: [], key: "Escape" }],
		undo: [{ modifiers: ["Mod"], key: "z" }],
		redo: [
			{ modifiers: ["Mod", "Shift"], key: "z" },
			{ modifiers: ["Mod"], key: "y" },
		],
		pickRoot: [],
		resetTree: [],
	},
};

export function cloneSettings(s: PluginSettings): PluginSettings {
	return JSON.parse(JSON.stringify(s)) as PluginSettings;
}

export function mergeSettings(raw: unknown): PluginSettings {
	const out = cloneSettings(DEFAULT_PLUGIN_SETTINGS);
	if (!raw || typeof raw !== "object") return out;
	const obj = raw as Partial<PluginSettings>;
	if (obj.modifiers && typeof obj.modifiers === "object") {
		for (const k of Object.keys(out.modifiers) as (keyof MouseModifiers)[]) {
			const v = obj.modifiers[k];
			if (isModifierKey(v)) out.modifiers[k] = v;
		}
	}
	if (obj.hotkeys && typeof obj.hotkeys === "object") {
		for (const a of GRAPH_ACTIONS) {
			const list = obj.hotkeys[a.id];
			if (Array.isArray(list)) {
				out.hotkeys[a.id] = list
					.filter((b): b is HotkeyBinding => !!b && typeof b.key === "string" && Array.isArray(b.modifiers))
					.map((b) => ({
						modifiers: b.modifiers.filter(isModifierKey),
						key: b.key,
					}));
			}
		}
	}
	return out;
}

function isModifierKey(v: unknown): v is ModifierKey {
	return v === "Mod" || v === "Shift" || v === "Alt" || v === "Ctrl";
}

/** Перевірка, чи натиснуто вибрану клавішу-модифікатор. */
export function matchModifier(
	e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
	mod: ModifierKey,
): boolean {
	switch (mod) {
		case "Mod":
			return Platform.isMacOS ? e.metaKey : e.ctrlKey;
		case "Ctrl":
			return e.ctrlKey;
		case "Shift":
			return e.shiftKey;
		case "Alt":
			return e.altKey;
	}
}

/** Людська назва модифікатора для підказок та меню. */
export function formatModifier(mod: ModifierKey): string {
	if (Platform.isMacOS) {
		switch (mod) {
			case "Mod": return "Cmd";
			case "Ctrl": return "Ctrl";
			case "Shift": return "Shift";
			case "Alt": return "Opt";
		}
	}
	switch (mod) {
		case "Mod":
		case "Ctrl":
			return "Ctrl";
		case "Shift":
			return "Shift";
		case "Alt":
			return "Alt";
	}
}

export function formatHotkey(b: HotkeyBinding): string {
	const parts = b.modifiers.map(formatModifier);
	parts.push(formatKeyName(b.key));
	return parts.join("+");
}

export function formatActionHotkeys(bindings: HotkeyBinding[]): string {
	if (!bindings.length) return "";
	return bindings.map(formatHotkey).join(", ");
}

function formatKeyName(key: string): string {
	if (key === " ") return "Space";
	if (key.length === 1) return key.toUpperCase();
	return key;
}

const MODIFIER_ORDER: ModifierKey[] = ["Mod", "Ctrl", "Alt", "Shift"];

function normalizeKey(key: string): string {
	if (key.length === 1) return key.toLowerCase();
	return key;
}

export function eventModifiers(e: KeyboardEvent): ModifierKey[] {
	const mods: ModifierKey[] = [];
	if (Platform.isMacOS) {
		if (e.metaKey) mods.push("Mod");
		if (e.ctrlKey) mods.push("Ctrl");
	} else {
		if (e.ctrlKey) mods.push("Mod");
	}
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	return mods;
}

export function matchHotkey(e: KeyboardEvent, bindings: HotkeyBinding[]): boolean {
	if (!bindings.length) return false;
	const pressedMods = eventModifiers(e);
	const key = normalizeKey(e.key);
	const codeKey = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : null;
	for (const b of bindings) {
		const targetKey = normalizeKey(b.key);
		// Підтримка розкладок, відмінних від латиниці (наприклад, української при натисканні Ctrl+Z / Ctrl+A).
		const keyMatches = key === targetKey || (codeKey !== null && targetKey.length === 1 && codeKey === targetKey);
		if (!keyMatches) continue;
		const reqMods = new Set(b.modifiers.map((m) => (!Platform.isMacOS && m === "Ctrl" ? "Mod" : m)));
		if (reqMods.size !== pressedMods.length) continue;
		if (pressedMods.every((m) => reqMods.has(m))) return true;
	}
	return false;
}

const IGNORED_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "Tab"]);

export function eventToHotkey(e: KeyboardEvent): HotkeyBinding | null {
	if (IGNORED_KEYS.has(e.key)) return null;
	const modifiers = eventModifiers(e).sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
	let key = e.key;
	if (e.code.startsWith("Key") && e.code.length === 4) {
		key = e.code.slice(3).toLowerCase();
	} else if (e.code.startsWith("Digit") && e.code.length === 6) {
		key = e.code.slice(5);
	} else if (key.length === 1) {
		key = key.toLowerCase();
	}
	return { modifiers, key };
}

export function sameHotkey(a: HotkeyBinding, b: HotkeyBinding): boolean {
	if (normalizeKey(a.key) !== normalizeKey(b.key)) return false;
	if (a.modifiers.length !== b.modifiers.length) return false;
	const sa = new Set(a.modifiers);
	return b.modifiers.every((m) => sa.has(m));
}

export class BasesRelationsGraphSettingTab extends PluginSettingTab {
	private stopRecording: (() => void) | null = null;

	constructor(app: App, private plugin: BasesRelationsGraphPlugin) {
		super(app, plugin);
	}

	hide(): void {
		this.stopRecording?.();
	}

	display(): void {
		this.stopRecording?.();
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Mouse modifiers")
			.setHeading();

		this.addModifierSetting(
			containerEl,
			"Select nodes and box selection",
			"Hold this key and click a node or group outline to toggle its selection, or drag on empty space to draw a selection box.",
			"select",
		);
		this.addModifierSetting(
			containerEl,
			"Preview collapsed group",
			"Hold this key and click a collapsed group node to open its interactive preview overlay.",
			"peek",
		);
		this.addModifierSetting(
			containerEl,
			"Physics drag in frozen layout",
			"Hold this key while dragging a node in Frozen force layout to pull connected neighbors along (“rope” drag).",
			"ropeDrag",
		);
		this.addModifierSetting(
			containerEl,
			"Drag single node in tree layout",
			"Hold this key while dragging a node in Tree layout to move only that node without its descendants.",
			"treeSingleDrag",
		);

		new Setting(containerEl)
			.setName("Graph hotkeys")
			.setDesc("Shortcuts active when the graph canvas is focused. All actions are also registered as standard Obsidian commands.")
			.setHeading()
			.addButton((btn) => {
				btn.setButtonText("Open Obsidian hotkeys").onClick(() => {
					const setting = (this.app as unknown as {
						setting?: { openTabById?(id: string): { setQuery?(q: string): void } | undefined };
					}).setting;
					if (setting?.openTabById) {
						const tab = setting.openTabById("hotkeys");
						tab?.setQuery?.(this.plugin.manifest.name);
					}
				});
			});

		for (const action of GRAPH_ACTIONS) {
			this.addHotkeySetting(containerEl, action);
		}
	}

	private addModifierSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: keyof MouseModifiers,
	): void {
		const def = DEFAULT_PLUGIN_SETTINGS.modifiers[key];
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addDropdown((dd) => {
				dd.addOption("Shift", "Shift");
				dd.addOption("Mod", Platform.isMacOS ? "Cmd (⌘)" : "Ctrl");
				if (Platform.isMacOS) dd.addOption("Ctrl", "Ctrl (⌃)");
				dd.addOption("Alt", Platform.isMacOS ? "Option (⌥)" : "Alt");
				dd.setValue(this.plugin.settings.modifiers[key]);
				dd.onChange(async (val) => {
					this.plugin.settings.modifiers[key] = val as ModifierKey;
					await this.plugin.saveSettings();
					this.display();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon("rotate-ccw")
					.setTooltip(`Reset to default (${formatModifier(def)})`)
					.setDisabled(this.plugin.settings.modifiers[key] === def)
					.onClick(async () => {
						this.plugin.settings.modifiers[key] = def;
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private addHotkeySetting(containerEl: HTMLElement, action: ActionMeta): void {
		const setting = new Setting(containerEl)
			.setName(action.name)
			.setDesc(action.desc);

		const list = this.plugin.settings.hotkeys[action.id];
		const defList = DEFAULT_PLUGIN_SETTINGS.hotkeys[action.id];
		const isDefault =
			list.length === defList.length &&
			list.every((b, i) => sameHotkey(b, defList[i]));

		const badgesEl = setting.controlEl.createDiv({ cls: "bases-relations-graph-hotkey-list" });
		if (!list.length) {
			badgesEl.createSpan({ cls: "bases-relations-graph-hotkey-empty", text: "Blank" });
		} else {
			list.forEach((b, idx) => {
				const badge = badgesEl.createSpan({ cls: "setting-hotkey" });
				badge.createSpan({ text: formatHotkey(b) });
				const del = badge.createSpan({ cls: "setting-hotkey-icon", attr: { "aria-label": "Delete hotkey" } });
				setIcon(del, "x");
				del.onclick = async () => {
					list.splice(idx, 1);
					await this.plugin.saveSettings();
					this.display();
				};
			});
		}

		setting.addExtraButton((btn) => {
			btn.setIcon("plus-circle")
				.setTooltip("Add hotkey")
				.onClick(() => this.startRecording(action.id, badgesEl));
		});

		setting.addExtraButton((btn) => {
			btn.setIcon("rotate-ccw")
				.setTooltip("Restore default")
				.setDisabled(isDefault)
				.onClick(async () => {
					this.plugin.settings.hotkeys[action.id] = cloneSettings(DEFAULT_PLUGIN_SETTINGS).hotkeys[action.id];
					await this.plugin.saveSettings();
					this.display();
				});
		});
	}

	private startRecording(actionId: GraphActionId, badgesEl: HTMLElement): void {
		this.stopRecording?.();
		const recBadge = badgesEl.createSpan({ cls: "setting-hotkey mod-active", text: "Press hotkey…" });

		const cleanup = () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("pointerdown", onPointerDown, true);
			recBadge.detach();
			if (this.stopRecording === cleanup) this.stopRecording = null;
		};

		const onKeyDown = async (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const list = this.plugin.settings.hotkeys[actionId];
			const hasEscape = list.some((b) => b.modifiers.length === 0 && b.key === "Escape");
			if (e.key === "Escape" && (actionId !== "clearSelection" || hasEscape)) {
				cleanup();
				return;
			}
			const binding = eventToHotkey(e);
			if (!binding) return;
			cleanup();
			if (!list.some((b) => sameHotkey(b, binding))) {
				list.push(binding);
				await this.plugin.saveSettings();
			}
			this.display();
		};

		const onPointerDown = (e: PointerEvent) => {
			if (recBadge.contains(e.target as Node)) return;
			cleanup();
		};

		this.stopRecording = cleanup;
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("pointerdown", onPointerDown, true);
	}
}
