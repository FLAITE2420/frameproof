// compare.mjs — frame by frame comparison of a copy against its reference:
// pixel mismatch, activity curve, motion window and timing error.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensureDir, frameList, num, pad, parseArgs, readJson, readPng, writeJson, writePng } from "./lib.mjs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const HELP = `
frameproof compare — does the copy move the same?

  node src/cli.mjs compare --ref <capture dir> --clone <capture dir> --out <dir>

  --threshold T          pass if mean mismatch ≤ T (fraction of pixels), default 0.02
  --pixel-threshold T    pixelmatch colour sensitivity 0..1, default 0.1
  --level L              motion | pixel. "motion" judges timing and easing only and
                         ignores pixels (different copy, colours, fonts allowed);
                         "pixel" also requires the pixels to match. Explicit
                         --threshold / --motion-threshold win over the level.
  --max-shift N          auto-align search range in frames, default 8
  --offset K             fixed offset instead of auto-align
  --region x,y,w,h       compare only this region
  --no-diffs             do not write diff PNGs

Exit code 0 = pass, 1 = fail.
`;

const framesOf = (dir) => (existsSync(join(dir, "frames")) ? join(dir, "frames") : dir);

function gray(png) {
  const g = new Float32Array(png.width * png.height);
  for (let i = 0, p = 0; i < png.data.length; i += 4, p++) {
    g[p] = (png.data[i] * 0.299 + png.data[i + 1] * 0.587 + png.data[i + 2] * 0.114) / 255;
  }
  return g;
}

function activity(gA, gB) {
  let s = 0;
  for (let i = 0; i < gA.length; i++) s += Math.abs(gA[i] - gB[i]);
  return s / gA.length;
}

function crop(png, region) {
  if (!region) return png;
  const { x, y, width, height } = region;
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * png.width + x) * 4;
    png.data.copy(out.data, row * width * 4, srcStart, srcStart + width * 4);
  }
  return out;
}

export async function compare(opts) {
  const refDir = framesOf(opts.ref);
  const cloneDir = framesOf(opts.clone);
  const out = opts.out ?? join(opts.clone, "compare");
  ensureDir(out);
  const refFiles = frameList(refDir);
  const cloneFiles = frameList(cloneDir);
  if (!refFiles.length || !cloneFiles.length) throw new Error(`no frames in ${refFiles.length ? cloneDir : refDir}`);

  const fps = num(opts.fps, readJsonSafe(join(opts.ref, "frames.json"))?.fps ?? 25);
  const level = opts.level && opts.level !== true ? String(opts.level) : null;
  if (level && level !== "motion" && level !== "pixel") throw new Error(`--level must be motion or pixel, got "${level}"`);
  const threshold = num(opts.threshold, level === "motion" ? 1 : 0.02);
  const pixelThreshold = num(opts["pixel-threshold"], 0.1);
  const region = opts.region && opts.region !== true
    ? (([x, y, width, height]) => ({ x, y, width, height }))(String(opts.region).split(",").map(Number))
    : null;

  const refPngs = refFiles.map((f) => crop(readPng(f), region));
  const clonePngs = cloneFiles.map((f) => crop(readPng(f), region));
  const { width, height } = refPngs[0];
  const c0 = clonePngs[0];
  if (c0.width !== width || c0.height !== height) {
    throw new Error(`frame size differs: reference ${width}x${height}, clone ${c0.width}x${c0.height}. Crop both the same way.`);
  }

  const refGray = refPngs.map(gray);
  const cloneGray = clonePngs.map(gray);

  const refActivity = refGray.map((g, i) => (i === 0 ? 0 : activity(refGray[i - 1], g)));
  const cloneActivity = cloneGray.map((g, i) => (i === 0 ? 0 : activity(cloneGray[i - 1], g)));

  // Align: which clone frame corresponds to reference frame 0.
  let offset = opts.offset !== undefined && opts.offset !== true ? Number(opts.offset) : null;
  if (offset === null) {
    const maxShift = num(opts["max-shift"], 8);
    const probe = Math.min(12, refPngs.length, clonePngs.length);
    // score every shift, then prefer the smallest absolute shift on a tie:
    // on a page where nothing moves, every shift scores zero and the first one
    // tested would otherwise win and eat the first frames of the comparison.
    let best = null;
    for (let shift = -maxShift; shift <= maxShift; shift++) {
      let score = 0, n = 0;
      for (let i = 0; i < probe; i++) {
        const j = i + shift;
        if (j < 0 || j >= clonePngs.length) continue;
        const diff = new PNG({ width, height });
        const m = pixelmatch(refPngs[i].data, clonePngs[j].data, diff.data, width, height, { threshold: pixelThreshold, includeAA: false });
        score += m / (width * height);
        n++;
      }
      if (!n) continue;
      score /= n;
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, score };
      }
    }
    offset = best ? best.shift : 0;
  }

  const pairs = [];
  for (let i = 0; i < refPngs.length; i++) {
    const j = i + offset;
    if (j < 0 || j >= clonePngs.length) continue;
    const diff = new PNG({ width, height });
    const mismatch = pixelmatch(refPngs[i].data, clonePngs[j].data, diff.data, width, height, { threshold: pixelThreshold, includeAA: false });
    pairs.push({ refFrame: i, cloneFrame: j, t: i / fps, mismatch: mismatch / (width * height) });
    if (!opts["no-diffs"] && mismatch > 0) writePng(join(out, "diff", `${pad(i)}.png`), diff);
    else if (!opts["no-diffs"]) writePng(join(out, "diff", `${pad(i)}.png`), diff);
  }

  const mean = pairs.length ? pairs.reduce((s, p) => s + p.mismatch, 0) / pairs.length : NaN;
  if (!pairs.length) throw new Error(`no frame pairs: reference ${refPngs.length} frames, copy ${clonePngs.length}, offset ${offset}. Capture both with the same --duration and --fps.`);
  const worst = [...pairs].sort((a, b) => b.mismatch - a.mismatch).slice(0, 5);

  const window = (acts) => {
    const peak = Math.max(...acts);
    const thr = Math.max(peak * 0.08, 0.0002);
    const idx = acts.map((a, i) => (a > thr ? i : -1)).filter((i) => i >= 0);
    return { start: idx[0] ?? null, end: idx[idx.length - 1] ?? null, peak: acts.indexOf(peak) };
  };
  const wRef = window(refActivity);
  const wClone = window(cloneActivity);
  const timing = wRef.start === null || wClone.start === null ? null : {
    start: (wClone.start - wRef.start) / fps,
    end: (wClone.end - wRef.end) / fps,
    duration: ((wClone.end - wClone.start) - (wRef.end - wRef.start)) / fps,
    peak: (wClone.peak - wRef.peak) / fps,
  };
  const motionLimit = num(opts["motion-threshold"], 0.08);
  const staticBoth = wRef.start === null && wClone.start === null;
  const timingOk = timing ? Math.max(Math.abs(timing.start), Math.abs(timing.end), Math.abs(timing.duration), Math.abs(timing.peak)) <= motionLimit : staticBoth;
  const pass = mean <= threshold && timingOk;
  const offsetNote = Math.abs(offset) > 2
    ? `the copy is ${offset} frames (${(Math.abs(offset) / fps * 1000).toFixed(0)} ms) ${offset > 0 ? "late" : "early"}; auto-alignment hides that from the timing columns`
    : null;

  const report = {
    ref: opts.ref, clone: opts.clone, fps, level, width, height, offset, threshold, pixelThreshold,
    frames: pairs.length, meanMismatch: mean,
    offsetNote,
    motion: { reference: wRef, clone: wClone, timing, limit: motionLimit, pass: timingOk },
    pass, worst,
  };
  writeJson(join(out, "report.json"), report);

  const bars = (acts, max) => acts.map((a) => "·".repeat(Math.round((a / (max || 1)) * 24))).map((s) => s || "·");
  const maxAct = Math.max(...refActivity, ...cloneActivity);
  const rows = refActivity.map((a, i) => {
    const p = pairs.find((x) => x.refFrame === i);
    return `| ${String(i).padStart(4)} | ${(i / fps).toFixed(2)} | ${(p ? p.mismatch * 100 : 0).toFixed(2).padStart(6)}% | ${bars([a], maxAct)[0].padEnd(24)} | ${(cloneActivity[i + offset] !== undefined ? bars([cloneActivity[i + offset]], maxAct)[0] : "").padEnd(24)} |`;
  });
  const md = `# frameproof compare

- reference: \`${opts.ref}\`
- copy: \`${opts.clone}\`
- ${pairs.length} frames at ${fps} fps, ${width}x${height} px, clone offset ${offset}
- mean pixel mismatch: **${(mean * 100).toFixed(2)}%** (limit ${(threshold * 100).toFixed(1)}%)
- motion window — reference ${wRef.start}–${wRef.end} (peak ${wRef.peak}) · copy ${wClone.start}–${wClone.end} (peak ${wClone.peak})
- timing error (copy − reference): ${timing ? `start ${timing.start.toFixed(2)}s, end ${timing.end.toFixed(2)}s, duration ${timing.duration.toFixed(2)}s, peak ${timing.peak.toFixed(2)}s` : staticBoth ? "not applicable — neither set moves" : "not measurable"} (limit ${motionLimit}s)
- verdict: **${pass ? "PASS" : "FAIL"}**
${offsetNote ? `- warning: ${offsetNote}\n` : ""}- worst frames: ${worst.map((w) => `#${w.refFrame} ${(w.mismatch * 100).toFixed(2)}% @ ${w.t.toFixed(2)}s`).join(", ")}

## per frame

| frame | t(s) | mismatch | activity reference | activity copy |
|---|---|---|---|---|
${rows.join("\n")}

Diff images (red = differs): \`${join(out, "diff")}\`
`;
  (await import("node:fs")).writeFileSync(join(out, "report.md"), md);
  console.log(md.split("## per frame")[0].trim());
  console.log(`\nreport: ${join(out, "report.md")}`);
  return pass ? 0 : 1;
}

function readJsonSafe(p) {
  try { return readJson(p); } catch { return null; }
}

export async function compareMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.ref || !opts.clone) { console.log(HELP.trim()); return 0; }
  return compare(opts);
}
