import { Modal, setIcon, type App } from "obsidian";

/**
 * Ручний порядок груп — як «Вручну» в меню «Групувати» Bases: список значень
 * із прапорцями (показати/сховати) і перетягуванням. Зміни застосовуються одразу.
 * Значення, яких зараз немає в даних, зберігаються в кінці списку прихованими.
 */
export class GroupOrderModal extends Modal {
	private shown: string[];
	private hidden: string[];
	private absent: string[];
	private listEl!: HTMLElement;
	private dragFrom = -1;

	constructor(app: App, title: string, values: string[], order: string[], private onChangeOrder: (order: string[]) => void) {
		super(app);
		this.titleEl.setText(title);
		const present = new Set(values);
		this.shown = order.filter((v) => present.has(v));
		this.absent = order.filter((v) => !present.has(v));
		const inOrder = new Set(order);
		this.hidden = values.filter((v) => !inOrder.has(v));
	}

	onOpen(): void {
		this.modalEl.addClass("bases-graph-order-modal");
		const bar = this.contentEl.createDiv({ cls: "bases-graph-order-bar" });
		const toggleAll = bar.createEl("button");
		const updateToggle = () => {
			const any = this.shown.length > 0;
			toggleAll.empty();
			setIcon(toggleAll.createSpan(), any ? "lucide-eye-off" : "lucide-eye");
			toggleAll.createSpan({ text: any ? " Hide all" : " Show all" });
		};
		toggleAll.onclick = () => {
			if (this.shown.length) { this.hidden = [...this.shown, ...this.hidden]; this.shown = []; }
			else { this.shown = [...this.shown, ...this.hidden]; this.hidden = []; }
			this.changed();
			updateToggle();
		};
		updateToggle();
		this.listEl = this.contentEl.createDiv({ cls: "bases-graph-order-list" });
		this.render();
	}

	private changed(): void {
		this.onChangeOrder([...this.shown, ...this.absent]);
		this.render();
	}

	private render(): void {
		const el = this.listEl;
		el.empty();
		if (!this.shown.length && !this.hidden.length) {
			el.createDiv({ cls: "bases-graph-hint", text: "No values for this property." });
			return;
		}
		this.shown.forEach((v, i) => this.row(el, v, true, i));
		this.hidden.forEach((v) => this.row(el, v, false, -1));
	}

	private row(parent: HTMLElement, value: string, checked: boolean, index: number): void {
		const row = parent.createDiv({ cls: "bases-graph-order-row" + (checked ? "" : " is-hidden") });
		const handle = row.createSpan({ cls: "bases-graph-order-handle" });
		if (checked) {
			setIcon(handle, "lucide-grip-vertical");
			row.draggable = true;
			row.addEventListener("dragstart", (e) => {
				this.dragFrom = index;
				e.dataTransfer?.setData("text/plain", value);
				row.addClass("is-dragging");
			});
			row.addEventListener("dragend", () => row.removeClass("is-dragging"));
			row.addEventListener("dragover", (e) => { e.preventDefault(); row.addClass("is-drop-target"); });
			row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
			row.addEventListener("drop", (e) => {
				e.preventDefault();
				this.move(this.dragFrom, index);
			});
		}
		const cb = row.createEl("input", { type: "checkbox" });
		cb.checked = checked;
		cb.onchange = () => {
			if (checked) {
				this.shown.remove(value);
				this.hidden.unshift(value);
			} else {
				this.hidden.remove(value);
				this.shown.push(value);
			}
			this.changed();
		};
		row.createSpan({ cls: "bases-graph-order-value", text: value });
		if (checked) {
			// Кнопки для сенсорних екранів, де перетягування в списку незручне.
			const up = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move up" } });
			setIcon(up, "chevron-up");
			up.disabled = index === 0;
			up.onclick = () => this.move(index, index - 1);
			const down = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Move down" } });
			setIcon(down, "chevron-down");
			down.disabled = index === this.shown.length - 1;
			down.onclick = () => this.move(index, index + 1);
		}
	}

	private move(from: number, to: number): void {
		if (from < 0 || to < 0 || from === to || to >= this.shown.length) return;
		const [v] = this.shown.splice(from, 1);
		this.shown.splice(to, 0, v);
		this.changed();
	}
}
