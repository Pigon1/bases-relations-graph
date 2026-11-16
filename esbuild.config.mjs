import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const args = new Set(process.argv.slice(2));
const prod = args.has("--production");
const watch = args.has("--watch");
const deploy = args.has("--deploy");

// Сховище, куди --deploy копіює зібраний плагін, — лише зі змінної середовища OBSIDIAN_VAULT.
const VAULT = process.env.OBSIDIAN_VAULT;
const PLUGIN_ID = JSON.parse(fs.readFileSync("manifest.json", "utf8")).id;

/** `import code from "./x.ts?worker"` → окремо зібраний воркер як рядок. */
const inlineWorker = {
	name: "inline-worker",
	setup(build) {
		build.onResolve({ filter: /\?worker$/ }, (a) => ({
			path: path.resolve(a.resolveDir, a.path.replace(/\?worker$/, "")),
			namespace: "inline-worker",
		}));
		build.onLoad({ filter: /.*/, namespace: "inline-worker" }, async (a) => {
			const r = await esbuild.build({
				entryPoints: [a.path],
				bundle: true,
				write: false,
				format: "iife",
				platform: "browser",
				target: "es2020",
				minify: prod,
			});
			return { contents: r.outputFiles[0].text, loader: "text", watchFiles: [a.path] };
		});
	},
};

const deployPlugin = {
	name: "deploy",
	setup(build) {
		build.onEnd((result) => {
			if (!deploy || result.errors.length) return;
			if (!VAULT) {
				console.warn("[deploy] skipped: set OBSIDIAN_VAULT to the vault folder to copy the plugin there");
				return;
			}
			const dest = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);
			fs.mkdirSync(dest, { recursive: true });
			for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(dest, f));
			console.log(`[deploy] → ${dest}`);
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	format: "cjs",
	target: "es2020",
	platform: "browser",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	plugins: [inlineWorker, deployPlugin],
});

if (watch) {
	await ctx.watch();
} else {
	await ctx.rebuild();
	await ctx.dispose();
}
