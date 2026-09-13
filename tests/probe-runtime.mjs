import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t0 = performance.now();
const mark = (s) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);

const DATA_DIR = path.join(ROOT, ".verify-data");

const { legacyCtx } = await import(pathToFileURL(path.join(ROOT, "lib/legacy-ctx.js")).href);
const { getSettings } = await import(pathToFileURL(path.join(ROOT, "lib/settings.js")).href);
const { prepareRuntime, runCollector } = await import(pathToFileURL(path.join(ROOT, "lib/runtime.js")).href);

const ctx = legacyCtx({
  dataDir: DATA_DIR,
  logger: { info: (m) => console.log("   [log]", m), warn: (m) => console.log("   [warn]", m), error: (m) => console.log("   [err]", m), debug: () => {} },
  config: { get: async (k) => (k === "autoBootstrapPython" ? false : undefined) },
});

mark("ctx ready");
const settings = await getSettings(ctx);
mark("settings: " + JSON.stringify({ mode: settings.runtimeMode, auto: settings.autoBootstrapPython }));

const runtime = await prepareRuntime(ctx, settings);
mark("runtime ready: " + runtime.venvDir + " (selectedMode=" + runtime.selectedMode + ")");

const res = await runCollector(runtime, { action: "health", outputDir: runtime.capturesRoot, platform: "auto", cookiesDir: "" });
mark("collector done");
console.log(JSON.stringify(res, null, 2).slice(0, 1200));
