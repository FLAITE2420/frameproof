// Recon: what motion do the big sportswear campaign sites actually run?
// One capture each, short, with GPU tracing, results into demo/brands/<name>/.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SITES = [
  ["nike", "https://www.nike.com/"],
  ["puma", "https://eu.puma.com/nl/en/home"],
  ["adidas", "https://www.adidas.com/"],
  ["reebok", "https://www.reebok.com/"],
  ["underarmour", "https://www.underarmour.com/en-us/"],
  ["diadora", "https://www.diadora.com/"],
  ["otto", "https://www.otto.de/"],
  ["kappa", "https://www.kappa.com/"],
];

const ROOT = process.cwd();
const out = [];
mkdirSync(join(ROOT, "demo", "brands"), { recursive: true });

for (const [name, url] of SITES) {
  const dir = join("demo", "brands", name);
  const t0 = Date.now();
  let err = null, inspect = null, gl = null, cap = null;
  try {
    execFileSync("node", [
      "src/cli.mjs", "capture", "--url", url, "--out", dir,
      "--duration", "600", "--fps", "10", "--gl", "--wait-before", "2500",
      "--viewport", "1440x900",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000 });
    inspect = JSON.parse(readFileSync(join(dir, "inspect.json"), "utf8"));
    cap = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    try { gl = JSON.parse(readFileSync(join(dir, "gl", "gl.json"), "utf8")); } catch {}
  } catch (e) {
    err = String(e.stderr ?? e.message).split("\n").slice(-3).join(" | ").slice(0, 300);
  }
  const row = {
    brand: name, url, seconds: Math.round((Date.now() - t0) / 1000), error: err,
    title: inspect?.title ?? null,
    animations: inspect?.animations?.length ?? null,
    kinds: inspect ? [...new Set(inspect.animations.map((a) => a.kind))] : null,
    names: inspect ? [...new Set(inspect.animations.map((a) => a.animationName || a.transitionProperty).filter(Boolean))].slice(0, 12) : null,
    libs: inspect?.libs ?? null,
    canvases: inspect?.canvases ?? null,
    fonts: inspect?.fonts?.length ?? null,
    consoleErrors: cap?.consoleErrors?.length ?? null,
    gl: gl ? { programs: gl.programs.length, shaders: Object.keys(gl.shaders ?? {}).length, animated: Object.values(gl.channels ?? {}).filter((c) => c.kind === "animated").length } : null,
  };
  out.push(row);
  console.log(JSON.stringify(row));
}

writeFileSync(join(ROOT, "demo", "brands", "summary.json"), JSON.stringify(out, null, 1) + "\n");
