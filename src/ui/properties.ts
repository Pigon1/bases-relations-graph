import type { App } from "obsidian";
import { kindFromWidget, type ValueKind } from "../model/expr";

export interface PropInfo {
	id: string;
	name: string;
	kind: ValueKind;
	/** Іконка типу, як у меню властивостей і фільтрів Bases. */
	icon: string;
}

/** Список властивостей бази (як у вкладці «Властивості») з типами значень. */
export class PropertyCatalog {
	constructor(
		private app: App,
		private ids: () => string[],
		private displayName: (id: string) => string,
	) {}

	all(): PropInfo[] {
		return this.ids().map((id) => this.info(id));
	}

	/** Властивості, що можуть містити посилання (note.* і formula.*). */
	linkCapable(): PropInfo[] {
		return this.all().filter((p) => p.id.startsWith("note.") || p.id.startsWith("formula."));
	}

	info(id: string): PropInfo {
		let kind: ValueKind = "text";
		let icon = "lucide-info";
		if (id.startsWith("note.")) {
			const name = id.slice(5);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const mtm = (this.app as any).metadataTypeManager;
			const info = mtm?.getPropertyInfo?.(name);
			const widget: string | undefined = info?.widget ?? info?.type;
			kind = kindFromWidget(widget);
			// Так само, як Bases: getTypeInfo(name).expected.icon; запасний шлях — іконка віджета.
			icon = safe(() => mtm?.getTypeInfo?.(name)?.expected?.icon)
				?? safe(() => mtm?.registeredTypeWidgets?.[widget ?? "text"]?.icon)
				?? "lucide-text";
		} else if (id.startsWith("formula.")) {
			icon = "lucide-square-function";
		} else {
			if (id === "file.ctime" || id === "file.mtime") kind = "date";
			else if (id === "file.size") kind = "number";
			else if (id === "file.links" || id === "file.backlinks" || id === "file.embeds" || id === "file.tags") kind = "list";
		}
		let name = id;
		try { name = this.displayName(id) || id; } catch { /* лишаємо id */ }
		return { id, name, kind, icon };
	}
}

function safe<T>(fn: () => T): T | undefined {
	try {
		return fn() ?? undefined;
	} catch {
		return undefined;
	}
}
