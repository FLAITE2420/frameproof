// gl command: report a GPU trace, or compare two of them.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensureDir, parseArgs, readJson, writeJson } from "./lib.mjs";
import { compareGl } from "./gl.mjs";

const HELP = `frameproof gl — WebGL traces

  frameproof gl summary <dir>                 print the GPU trace of a capture
  frameproof gl compare --ref A --clone B     compare two traces channel by channel

  Capture with \`capture --gl\` first; the trace lives in <dir>/gl/.
  --max-timing <ms>   allow this much timing difference (default 80)
  --max-value <pct>   allow this much value error, as % of the channel range (default 2)
`;

const load = (dir) => {
  const p = join(dir, "gl", "gl.json");
  if (!existsSync(p)) throw new Error(`no GPU trace in ${dir}: capture it with --gl first (expected ${p})`);
  return readJson(p);
};

export async function glMain(argv) {
  const [mode, target] = argv.filter((a) => !a.startsWith("-"));
  const opts = parseArgs(argv);
  if (opts.help && !mode) { console.log(HELP.trim()); return 0; }
  if (!mode) { console.log(HELP.trim()); return 2; }

  if (mode === "summary") {
    if (!target) { console.log(HELP.trim()); return 2; }
    const gl = load(target);
    const channels = gl.channels ?? {};
    const animated = Object.entries(channels).filter(([, c]) => c.kind === "animated");
    console.log(`GPU trace ${target}`);
    const ctx = gl.contexts?.[0];
    if (ctx) console.log(`  ${ctx.type} ${ctx.width}x${ctx.height} · ${gl.programs.length} programs · ${Object.keys(gl.shaders ?? {}).length} shaders · ${animated.length} animated channels`);
    for (const [k, c] of animated) console.log(`  ${k}: ${c.min.toFixed(3)} → ${c.max.toFixed(3)} · ${c.firstChangeMs}–${c.lastChangeMs} ms`);
    return 0;
  }

  if (mode === "compare") {
    if (!opts.ref || !opts.clone) { console.log(HELP.trim()); return 2; }
    const ref = load(opts.ref), clone = load(opts.clone);
    const res = compareGl(ref, clone, {
      maxTimingMs: Number(opts["max-timing"] ?? 80),
      maxValuePct: Number(opts["max-value"] ?? 2),
    });
    const out = ensureDir(opts.out ?? join("gl-compare"));
    writeJson(join(out, "gl-compare.json"), res);
    const lines = [];
    lines.push(`# GPU compare: ${opts.ref} vs ${opts.clone}`);
    lines.push("");
    lines.push(`${res.counts.matched}/${res.counts.channels} channels match · ${res.counts.mismatched} differ · ${res.counts.extraInClone} only in the clone`);
    lines.push("");
    for (const row of res.mismatched) lines.push(`- ${row.status.toUpperCase()} ${row.name} — ${row.detail}`);
    if (res.extraInClone.length) lines.push(`- extra in clone: ${res.extraInClone.join(", ")}`);
    lines.push("");
    lines.push(res.pass ? "**PASS** — same uniforms, same cadence." : "**FAIL**");
    writeJson(join(out, "gl-compare.json"), res);
    const fs = await import("node:fs");
    fs.writeFileSync(join(out, "gl-compare.md"), lines.join("\n") + "\n");
    console.log(lines.join("\n"));
    return res.pass ? 0 : 1;
  }

  console.log(HELP.trim());
  return 2;
}
