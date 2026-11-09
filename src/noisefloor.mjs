// noisefloor.mjs — capture the same page N times and measure how much it moves
// on its own. Anything below this floor is not a difference between two builds.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { compare } from "./compare.mjs";
import { capture } from "./capture.mjs";
import { ensureDir, num, parseArgs, readJson } from "./lib.mjs";

const HELP = `
frameproof noisefloor — how repeatable is a capture of this page?

  node src/cli.mjs noisefloor --url <url> --out <dir> [--runs 3] [capture options]

  --runs N            captures of the same page, default 3
  --floor-max T       max acceptable mean mismatch between runs, default 0.002
  --floor-ms M        max acceptable timing drift between runs, default 0.04

Every run is compared against run 1. The result is the floor: a copy whose
numbers sit inside it has not been shown to differ.
`;

const trackDelta = (a, b) => {
  const ta = readJson(join(a, "track.json"));
  const tb = readJson(join(b, "track.json"));
  const per = {};
  for (const sel of ta.selectors) {
    for (const prop of ["x", "y", "w", "h", "opacity", "tx", "ty", "scale", "rotate"]) {
      let max = 0, sum = 0, n = 0;
      for (let i = 0; i < Math.min(ta.samples.length, tb.samples.length); i++) {
        const va = ta.samples[i]?.[sel]?.[prop];
        const vb = tb.samples[i]?.[sel]?.[prop];
        if (va === undefined || vb === undefined || va === null || vb === null) continue;
        const d = Math.abs(va - vb);
        max = Math.max(max, d);
        sum += d;
        n++;
      }
      if (n) per[`${sel} ${prop}`] = { maxAbs: +max.toFixed(3), meanAbs: +(sum / n).toFixed(3) };
    }
  }
  return per;
};

export async function noisefloorMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP.trim()); return 0; }
  if (!opts.url) { console.log(HELP.trim()); return 2; }
  const runs = num(opts.runs, 3);
  if (!Number.isInteger(runs) || runs < 2) throw new Error(`--runs must be an integer of 2 or more, got ${opts.runs}. One run measures nothing.`);
  const base = ensureDir(opts.out ?? "./noisefloor");
  const floorMax = num(opts["floor-max"], 0.002);
  const floorMs = num(opts["floor-ms"], 0.04);

  const dirs = [];
  for (let i = 1; i <= runs; i++) {
    const dir = join(base, `run-${i}`);
    process.stderr.write(`capture ${i}/${runs} → ${dir}\n`);
    await capture({ ...opts, out: dir });
    dirs.push(dir);
  }

  const rows = [];
  let worstMismatch = 0, worstTiming = 0;
  for (let i = 1; i < dirs.length; i++) {
    const out = join(base, `compare-run-1-vs-run-${i + 1}`);
    await compare({ ref: dirs[0], clone: dirs[i], out, "no-diffs": i > 1, threshold: 1, "motion-threshold": 1 });
    const rep = readJson(join(out, "report.json"));
    const timing = rep.motion.timing;
    const drift = timing ? Math.max(Math.abs(timing.start), Math.abs(timing.end), Math.abs(timing.duration), Math.abs(timing.peak)) : null;
    const td = trackDelta(dirs[0], dirs[i]);
    const trackMax = Math.max(0, ...Object.values(td).map((v) => v.maxAbs));
    worstMismatch = Math.max(worstMismatch, rep.meanMismatch);
    if (drift !== null) worstTiming = Math.max(worstTiming, drift);
    rows.push({
      run: i + 1,
      meanMismatch: +rep.meanMismatch.toFixed(6),
      worstFrame: Math.max(...rep.worst.map((w) => w.mismatch)),
      timingDriftS: drift === null ? null : +drift.toFixed(3),
      trackMaxAbs: +trackMax.toFixed(3),
      track: td,
      report: join(out, "report.json"),
    });
  }

  const ok = worstMismatch <= floorMax && worstTiming <= floorMs;
  const result = {
    url: opts.url, runs, floorMax, floorMs,
    worstMeanMismatch: +worstMismatch.toFixed(6),
    worstTimingDriftS: +worstTiming.toFixed(3),
    verdict: ok ? "stable: differences above these numbers are real" : "unstable: this page does not capture repeatably, raise the floor before judging a copy",
    runs: rows,
  };
  writeFileSync(join(base, "floor.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, runs: rows.map(({ track, ...r }) => r) }, null, 2));
  return ok ? 0 : 1;
}
