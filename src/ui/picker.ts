import { Menu, setIcon } from "obsidian";

export interface PickItem {
	value: string;
	label: string;
	icon: string;
}

export interface Picker {
	el: HTMLElement;
	set(value: string | null): void;
}

/**
 * Випадний вибір з іконками (рідний <select> не вміє показувати іконки).
 * `inherit` додає пункт «—» — значення null, тобто «успадкувати».
 */
export function createPicker(
	parent: HTMLElement,
	items: PickItem[] | (() => PickItem[]),
	value: string | null,
	opts: { inherit?: boolean; placeholder?: string },
	onChange: (value: string | null) => void,
): Picker {
	const btn = parent.createEl("button", { cls: "bases-graph-picker" });
	let current = value;
	const list = () => (typeof items === "function" ? items() : items);

	const paint = () => {
		btn.empty();
		const item = list().find((i) => i.value === current);
		const icon = btn.createSpan({ cls: "bases-graph-picker-icon" });
		if (item) setIcon(icon, item.icon);
		else if (current !== null) setIcon(icon, "lucide-circle-help");
		const text = item ? item.label : current === null ? opts.placeholder ?? "—" : current;
		btn.createSpan({ cls: "bases-graph-picker-label", text });
		setIcon(btn.createSpan({ cls: "bases-graph-picker-chevron" }), "lucide-chevron-down");
		btn.toggleClass("is-inherit", current === null);
		btn.setAttr("aria-label", text);
	};

	const select = (v: string | null) => {
		current = v;
		paint();
		onChange(v);
	};

	btn.onclick = (e) => {
		e.preventDefault();
		const menu = new Menu();
		if (opts.inherit) {
			menu.addItem((mi) => mi.setTitle("— Inherit").setIcon("lucide-corner-left-up").setChecked(current === null).onClick(() => select(null)));
			menu.addSeparator();
		}
		for (const it of list()) {
			menu.addItem((mi) => mi.setTitle(it.label).setIcon(it.icon).setChecked(it.value === current).onClick(() => select(it.value)));
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(menu as any).dom?.addClass("bases-graph-menu");
		const r = btn.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom });
	};

	paint();
	return {
		el: btn,
		set(v) {
			current = v;
			paint();
		},
	};
}
