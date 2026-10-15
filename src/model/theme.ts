import { parseColor, toCss } from "./color";
import type { ThemeColors } from "./types";

const CLASSES: Record<keyof ThemeColors, string> = {
	fill: "color-fill",
	line: "color-line",
	text: "color-text",
	arrow: "color-arrow",
	fillHighlight: "color-fill-highlight",
	lineHighlight: "color-line-highlight",
};

/** Читає кольори так само, як нативний граф: div.graph-view.<клас> → color × opacity. */
export function readThemeColors(): ThemeColors {
	const out = {} as ThemeColors;
	for (const key of Object.keys(CLASSES) as (keyof ThemeColors)[]) {
		const el = document.body.createDiv({ cls: "graph-view " + CLASSES[key] });
		const cs = getComputedStyle(el);
		const c = parseColor(cs.color);
		const opacity = parseFloat(cs.opacity);
		el.detach();
		out[key] = toCss({ rgb: c.rgb, alpha: c.alpha * (isNaN(opacity) ? 1 : opacity) });
	}
	return out;
}
