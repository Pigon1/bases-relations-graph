export interface Rgba {
	rgb: number;
	alpha: number;
}

const FALLBACK: Rgba = { rgb: 0x888888, alpha: 1 };

/** Розбирає #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(). */
export function parseColor(input: string | null | undefined, fallback: Rgba = FALLBACK): Rgba {
	if (!input) return fallback;
	const s = input.trim();
	let m = /^#([0-9a-f]{3})$/i.exec(s);
	if (m) {
		const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
		return { rgb: (r << 16) | (g << 8) | b, alpha: 1 };
	}
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
	if (m) return { rgb: parseInt(m[1], 16), alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
	m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
	if (m) {
		const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))));
		let a = 1;
		if (m[4]) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		return { rgb: (r << 16) | (g << 8) | b, alpha: Math.max(0, Math.min(1, a)) };
	}
	return fallback;
}

export function toHex(rgb: number): string {
	return "#" + rgb.toString(16).padStart(6, "0");
}

export function toCss({ rgb, alpha }: Rgba): string {
	const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
	return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}
