import { parseColor, toCss } from "./color";
import type { ThemeColors } from "./types";

const CLASSES: Record<Exclude<keyof ThemeColors, "background">, string> = {
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
	for (const key of Object.keys(CLASSES) as (keyof typeof CLASSES)[]) {
		const el = document.body.createDiv({ cls: "graph-view " + CLASSES[key] });
		const cs = getComputedStyle(el);
		const c = parseColor(cs.color);
		const opacity = parseFloat(cs.opacity);
		el.detach();
		out[key] = toCss({ rgb: c.rgb, alpha: c.alpha * (isNaN(opacity) ? 1 : opacity) });
	}
	// Тло: змінна теми може бути у будь-якому форматі CSS — нормалізуємо через computed style.
	const bg = document.body.createDiv();
	bg.style.color = "var(--background-primary)";
	out.background = toCss({ ...parseColor(getComputedStyle(bg).color, { rgb: 0xffffff, alpha: 1 }), alpha: 0.85 });
	bg.detach();
	return out;
}
