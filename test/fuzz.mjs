// Fuzz battery: 400+ generated inputs against the argument parser, the numeric
// parsers, the easing maths and the CLI. The rule everywhere: never a raw
// TypeError/RangeError/NaN, never a hang, always a named answer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { EASINGS, bezierY, num, parseArgs, parseClip, parseViewport } from "../src/lib.mjs";
import { fit, seriesOf } from "../src/easing.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".fuzz-out");
const CLI = join(ROOT, "src/cli.mjs");
const URL_STATIC = "file://" + join(ROOT, "examples", "edge", "static.html");

// deterministic PRNG so a failure is reproducible from the printed seed
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(0x5eed);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const fails = [];
let ran = 0;
const record = (kind, detail, err) => {
  ran++;
  if (err) fails.push({ kind, detail, err: String(err?.message ?? err) });
};
const must = (kind, detail, fn) => {
  try { fn(); record(kind, detail, null); } catch (e) { record(kind, detail, e); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

rmSync(WORK, { recursive: true, force: true });

// --- a tiny pair of captures built by hand, so CLI cases need no browser ------
const solid = (w, h, rgb) => {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};
const makeCapture = (dir, w, h, rgb) => {
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, "frames", `${String(i).padStart(4, "0")}.png`), solid(w, h, rgb));
  writeFileSync(join(dir, "frames.json"), JSON.stringify({ fps: 25, count: 4 }) + "\n");
};
makeCapture(join(WORK, "ref"), 8, 8, [10, 10, 10]);
makeCapture(join(WORK, "copy"), 8, 8, [10, 10, 10]);
makeCapture(join(WORK, "big"), 16, 16, [10, 10, 10]);

// --- A. argument parser (120) -----------------------------------------------
{
  const pool = ["--fps", "25", "--fps=25", "--fps=", "--track", ".a,.b", "--flag", "value", "-x", "--", "--level=motion", "--threshold", "0.02", "-", "--=", "---weird", "--a b", ""];
  for (let i = 0; i < 120; i++) {
    const len = Math.floor(rng() * 8);
    const argv = Array.from({ length: len }, () => pick(pool));
    must("args", JSON.stringify(argv), () => {
      const out = parseArgs(argv);
      assert(Array.isArray(out._), "positionals must be an array");
      for (const k of Object.keys(out)) {
        if (k === "_") continue;
        assert(k.length > 0, `empty key from ${JSON.stringify(argv)}`);
        assert(typeof out[k] === "string" || out[k] === true || typeof out[k] === "number", `bad value type for ${k}`);
      }
      // "--" must stop option parsing: everything after the last one is positional
      const di = argv.lastIndexOf("--");
      if (di >= 0) {
        const expected = argv.slice(di + 1);
        const got = out._.slice(out._.length - expected.length);
        assert(JSON.stringify(got) === JSON.stringify(expected), `after -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
      }
    });
  }
}

// --- B. numeric parsers (100) ----------------------------------------------
{
  const junk = [undefined, null, true, false, "", " ", "abc", "NaN", "Infinity", "-Infinity", "0", "-0", "1e309", "-5", "0x10", "12x", "12x34", "1.5x2.5", "0x0", "10x", "x10", "1,2,3", "1,2,3,4", "a,b,c,d", "10,10,0,0", "-10,-10,5,5", [], {}, "2.5", "1e3", " 12 ", "\n40"];
  for (let i = 0; i < 100; i++) {
    const raw = pick(junk);
    const fallback = pick([25, 0, -1, 1e9, 0.5]);
    must("num", `${JSON.stringify(raw)} / ${fallback}`, () => {
      const v = num(raw, fallback);
      assert(!Number.isNaN(v), `num returned NaN for ${JSON.stringify(raw)}`);
      assert(Number.isFinite(v), `num returned ${v} for ${JSON.stringify(raw)}`);
    });
    must("viewport", JSON.stringify(raw), () => {
      try {
        const v = parseViewport(raw, { width: 800, height: 600 });
        assert(Number.isFinite(v.width) && v.width > 0 && Number.isFinite(v.height) && v.height > 0, `parseViewport returned ${JSON.stringify(v)}`);
      } catch (e) {
        assert(e instanceof Error && e.message.length > 3, "parseViewport threw without a message");
        assert(!(e instanceof TypeError) && !(e instanceof RangeError), "parseViewport threw a raw " + e.constructor.name);
      }
    });
    must("clip", JSON.stringify(raw), () => {
      try {
        const v = parseClip(raw);
        if (v !== null) assert(v.width > 0 && v.height > 0 && Number.isFinite(v.x) && Number.isFinite(v.y), `parseClip returned ${JSON.stringify(v)}`);
      } catch (e) {
        assert(e instanceof Error && e.message.length > 3, "parseClip threw without a message");
        assert(!(e instanceof TypeError) && !(e instanceof RangeError), "parseClip threw a raw " + e.constructor.name);
      }
    });
  }
}

// --- C. bezier + fit recovery (100) ----------------------------------------
for (let i = 0; i < 100; i++) {
  const cp = [rng(), rng() * 1 + -0.25, rng(), rng() * 1 + -0.25];
  must("bezier", cp.map((n) => n.toFixed(3)).join(","), () => {
    const y0 = bezierY(0, cp), y1 = bezierY(1, cp);
    assert(y0 === 0 && y1 === 1, `endpoints ${y0}, ${y1}`);
    let prev = -Infinity;
    for (let k = 0; k <= 100; k++) {
      const y = bezierY(k / 100, cp);
      assert(Number.isFinite(y), `non-finite y at x=${k / 100}`);
      if (cp[1] >= 0 && cp[1] <= 1 && cp[3] >= 0 && cp[3] <= 1) assert(y >= prev - 1e-9, `not monotone at x=${k / 100}`);
      prev = y;
    }
  });

  const name = pick(EASINGS)[0];
  const cp2 = EASINGS.find((e) => e[0] === name)[1];
  const duration = 200 + Math.floor(rng() * 800);
  const travel = 40 + Math.floor(rng() * 400);
  const series = [];
  for (let t = 0; t <= duration + 200; t += 40) {
    const noise = (rng() - 0.5) * travel * 0.01;
    series.push([t, 500 - travel * bezierY(Math.min(1, t / duration), cp2) + noise]);
  }
  must("fit recovery", `${name} ${duration}ms ${travel}px`, () => {
    const f = fit(series);
    assert(f && f.fits && f.fits.length > 0, "no fit produced");
    assert(f.fits[0].rmse < 0.05, `rmse ${f.fits[0].rmse.toFixed(4)} too high`);
    const err = Math.abs(f.fits[0].durationMs - duration) / duration;
    assert(err < 0.2, `duration off by ${(err * 100).toFixed(1)}% (${Math.round(f.fits[0].durationMs)} vs ${duration})`);
  });
}

// --- D. degenerate series (50) ---------------------------------------------
{
  const cases = [
    () => [],
    () => [[0, 0]],
    () => [[0, 5], [40, 5], [80, 5]],
    () => [[0, 0], [0, 0], [0, 0]],
    () => [[0, 0], [40, 10], [40, 10], [80, 20]],
    () => [[-200, 10], [-100, 5], [0, 0]],
    () => [[0, 1e12], [40, 5e11], [80, 0]],
    () => [[0, -1e-12], [40, 1e-12], [80, 2e-12]],
    () => [[0, 0], [40, NaN], [80, 10]],
    () => [[0, 0], [Infinity, 10], [80, 20]],
    () => [[0, Number.MAX_VALUE], [40, Number.MAX_VALUE / 2], [80, 0]],
  ];
  for (let i = 0; i < 50; i++) {
    const series = cases[i % cases.length]();
    must("degenerate fit", JSON.stringify(series).slice(0, 60), () => {
      const f = fit(series);
      if (f === null) return;
      assert(f && typeof f === "object", "fit returned a non-object");
      for (const k of ["v0", "v1", "range", "change", "visibleMs"]) assert(k in f, `fit result missing ${k}`);
      assert(Number.isFinite(f.overshootPct), "overshootPct is not finite");
      assert(Array.isArray(f.fits), "fits is not an array");
      for (const item of f.fits) assert(Number.isFinite(item.rmse) && Number.isFinite(item.durationMs), "fit entry has a non-finite number");
    });
    must("seriesOf", `selector-miss ${i}`, () => {
      const s = seriesOf({ samples: [{ t: 0, "#a": { y: 1 } }, { t: 40, "#a": { y: NaN } }] }, "#a", "y");
      assert(Array.isArray(s) && s.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v)), "seriesOf leaked a non-finite sample");
    });
  }
}

// --- E. CLI: invalid arguments (40) ----------------------------------------
{
  const bad = () => "TypeError|RangeError|Cannot read|Cannot convert|is not a function|undefined is not|NaN";
  const run = (args) => {
    try {
      return { status: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
  const cases = [
    ["capture", "--out", join(WORK, "x")],
    ["capture", "--url", URL_STATIC],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--fps", "0"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--fps", "-5"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--fps", "1e6"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--duration", "-5"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--duration", "1e9"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--pre-roll", "-1"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--viewport", "0x0"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--viewport", "abc"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--viewport", "10"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--clip", "1,2,3"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--clip", "a,b,c,d"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--clip", "10,10,0,0"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--scale", "0"],
    ["capture", "--url", URL_STATIC, "--out", join(WORK, "x"), "--scale", "99"],
    ["compare"],
    ["compare", "--ref", join(WORK, "ref")],
    ["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy"), "--level", "pretty"],
    ["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "big")],
    ["compare", "--ref", join(WORK, "nope"), "--clone", join(WORK, "copy")],
    ["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy"), "--region", "1,2,3"],
    ["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy"), "--offset", "abc"],
    ["easing"],
    ["easing", "--track", join(WORK, "nope.json")],
    ["easing", "--track", join(WORK, "ref", "frames.json"), "--prop", "y"],
    ["easing", "--track", join(WORK, "ref", "frames.json"), "--selector", "#a", "--prop", "nope"],
    ["easing", "--track", join(WORK, "ref", "frames.json"), "--selector", "#a", "--prop", "y", "--from-ms", "abc"],
    ["sheet"],
    ["sheet", "nope"],
    ["sheet", "filmstrip", "--frames", join(WORK, "nope"), "--out", join(WORK, "s")],
    ["sheet", "compare", "--ref", join(WORK, "nope"), "--clone", join(WORK, "copy"), "--out", join(WORK, "s")],
    ["noisefloor"],
    ["noisefloor", "--url", URL_STATIC],
    ["nope"],
    ["--help"],
    ["capture", "--help"],
    ["compare", "--help"],
    ["easing", "--help"],
    ["sheet", "--help"],
  ];
  for (const args of cases) {
    must("cli", args.join(" "), () => {
      const r = run(args);
      assert(r.status === 0 || r.status === 1 || r.status === 2, `exit ${r.status}`);
      assert(!new RegExp(bad()).test(r.out), `raw internal error leaked: ${(r.out.match(new RegExp(bad() + "[^\\n]*")) ?? [""])[0].slice(0, 120)}`);
      if (args.includes("--help") || args[0] === "--help") assert(r.status === 0, "help should exit 0");
      if (args.length === 0) assert(r.status === 0, "no command should print usage and exit 0");
      if (!["capture", "compare", "easing", "sheet", "noisefloor", "--help"].includes(args[0])) assert(r.status === 2, `unknown command must exit 2, got ${r.status}`);
      const isBoundary = /--fps|--duration|--pre-roll|--viewport|--clip|--scale|--level|--region|--prop/.test(args.join(" "));
      if (isBoundary && !args.includes("--help")) assert(r.status === 1, `expected a refusal (exit 1), got ${r.status}`);
      if (r.status !== 0) assert(r.out.trim().length > 5, "a refusal must say something");
    });
  }
}

// --- F. capture boundaries, for real (6) ------------------------------------
{
  const cap = (out, extra) => {
    execFileSync("node", [CLI, "capture", "--url", URL_STATIC, "--out", join(WORK, out), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync('${join(WORK, out, "capture.json")}','utf8'))`], { encoding: "utf8" }));
  };
  must("capture fps=1", "frames for 2s at 1fps", () => {
    const info = cap("fps1", ["--duration", "2000", "--fps", "1"]);
    assert(info.frames === 3, `got ${info.frames} frames`);
  });
  must("capture duration=0", "one frame only", () => {
    const info = cap("zero", ["--duration", "0", "--fps", "25"]);
    assert(info.frames === 1, `got ${info.frames} frames`);
  });
  must("capture scale=2", "double pixels", () => {
    const info = cap("scale2", ["--duration", "0", "--scale", "2"]);
    const png = PNG.sync.read(execFileSync("sh", ["-c", `cat ${join(WORK, "scale2", "frames", "0000.png")}`], { maxBuffer: 1 << 26 }));
    assert(png.width === info.viewport.width * 2, `frame ${png.width}px, viewport ${info.viewport.width}`);
  });
  must("capture tiny viewport", "64x64 still runs", () => {
    const info = cap("tiny", ["--duration", "0", "--viewport", "64x64"]);
    assert(info.frames === 1 && info.viewport.width === 64, JSON.stringify(info.viewport));
  });
  must("capture pre-roll", "negative start times", () => {
    execFileSync("node", [CLI, "capture", "--url", URL_STATIC, "--out", join(WORK, "pre"), "--duration", "200", "--fps", "25", "--pre-roll", "200", "--track", "#card"], { stdio: ["ignore", "pipe", "pipe"] });
    const track = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync('${join(WORK, "pre", "track.json")}','utf8'))`], { encoding: "utf8" }));
    assert(track.samples[0].t < 0, `first sample t=${track.samples[0].t}`);
    assert(track.samples.length === 11, `${track.samples.length} samples`);
  });
  must("capture dark scheme", "colour scheme applied", () => {
    const info = cap("dark", ["--duration", "0", "--color-scheme", "dark"]);
    assert(info.frames === 1, `got ${info.frames}`);
  });
}

const pct = ((ran - fails.length) / ran) * 100;
console.log(`\n${ran - fails.length}/${ran} fuzz checks passed (${pct.toFixed(1)}%)`);
if (fails.length) {
  const byKind = fails.reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  console.log("failures by kind:", JSON.stringify(byKind));
  for (const f of fails.slice(0, 15)) console.log(`FAIL [${f.kind}] ${f.detail} → ${f.err}`);
}
process.exit(fails.length ? 1 : 0);
