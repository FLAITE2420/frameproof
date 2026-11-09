// easing.mjs — which curve is this? Fits a tracked property to named cubic-beziers,
// reports delay, duration, overshoot, and diffs two tracks.
import { EASINGS, bezierY, num, overshoot, parseArgs, readJson, rmse } from "./lib.mjs";

const HELP = `
frameproof easing — name the curve behind a tracked property

  node src/cli.mjs easing --track <track.json> --selector <css> --prop <y|opacity|scale|tx|ty|rotate|x|w|h>
         [--from-ms T] [--to-ms T] [--compare-track <other track.json>]

Prints delay, visible duration, overshoot and the best fitting named easings.
With --compare-track it also prints the difference between the two curves.
`;

const PROPS = new Set(["x", "y", "w", "h", "opacity", "scale", "tx", "ty", "rotate"]);

export function seriesOf(track, selector, prop, fromMs, toMs) {
  const samples = track.samples ?? track;
  const out = [];
  for (const s of samples) {
    const el = s[selector];
    if (!el || el[prop] === undefined) continue;
    const t = s.t;
    if (!Number.isFinite(t)) continue;
    const v = Number(el[prop]);
    if (!Number.isFinite(v)) continue;
    if (fromMs !== undefined && t < fromMs) continue;
    if (toMs !== undefined && t > toMs) continue;
    out.push([t, v]);
  }
  return out;
}

export function fit(series, opts = {}) {
  if (series.length < 3) return null;
  const v0 = series[0][1];
  const v1 = series[series.length - 1][1];
  const range = v1 - v0;
  const eps = Math.max(Math.abs(range) * 0.001, 1e-6);
  const t0Series = series[0][0];
  const tEnd = series[series.length - 1][0];

  // first and last sample that actually moved
  let first = null, last = null;
  for (const [t, v] of series) {
    if (first === null && Math.abs(v - v0) > eps) first = t;
    if (Math.abs(v - v1) > eps) last = t;
  }
  const frameMs = Math.max(1e-3, (tEnd - t0Series) / Math.max(1, series.length - 1));
  if (first === null) return { v0, v1, range, change: range, delayMs: null, durationMs: null, visibleMs: 0, overshootPct: 0, fits: [] };
  if (last === null) last = tEnd;
  const visible = Math.max(frameMs, last - first);

  // x -> y tables, so the search below is cheap
  const TABLES = new Map();
  const table = (name, cp) => {
    if (TABLES.has(name)) return TABLES.get(name);
    const N = 1000;
    const arr = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) arr[i] = bezierY(i / N, cp);
    TABLES.set(name, arr);
    return arr;
  };
  const evalTable = (arr, x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const p = x * 1000, i = Math.floor(p), f = p - i;
    return arr[i] * (1 - f) + arr[Math.min(1000, i + 1)] * f;
  };

  const normal = range === 0 ? series.map(() => 0) : series.map(([, v]) => (v - v0) / range);
  const best = [];
  for (const [name, cp] of EASINGS) {
    const arr = table(name, cp);
    let local = { name, cp, durationMs: visible, rmse: Infinity, startMs: first, coverage: 0 };
    for (let k = 60; k <= 190; k += 2) {
      const D = (visible * k) / 100;
      for (let s = -3; s <= 2; s += 1) {
        const start = first + (s * frameMs) / 2;
        const end = start + D;
        let sum = 0, n = 0;
        for (let i = 0; i < series.length; i++) {
          const t = series[i][0];
          if (t < start || t > end) continue;
          const x = (t - start) / D;
          const d = evalTable(arr, x) - normal[i];
          sum += d * d;
          n++;
        }
        const expected = Math.max(3, Math.round(D / frameMs));
        const coverage = Math.min(1, n / expected);
        if (coverage < 0.9 || n < 5) continue;
        const e = Math.sqrt(sum / n) + 0.25 * (1 - coverage);
        if (e < local.rmse) local = { name, cp, durationMs: D, rmse: Math.sqrt(sum / n), startMs: start, coverage };
      }
    }
    if (Number.isFinite(local.rmse)) best.push(local);
  }
  const byName = new Map();
  for (const b of best) {
    const prev = byName.get(b.name);
    if (!prev || b.rmse < prev.rmse) byName.set(b.name, b);
  }
  const fits = [...byName.values()].sort((a, b) => a.rmse - b.rmse).slice(0, 4);
  return {
    v0, v1, range, change: range,
    delayMs: Math.round(fits[0]?.startMs ?? first),
    visibleMs: Math.round(visible),
    overshootPct: +(overshoot(series) * 100).toFixed(1),
    fits,
  };
}


const fmt = (f) => `${f.name} cubic-bezier(${f.cp.join(",")}) over ~${Math.round(f.durationMs)}ms (rmse ${f.rmse.toFixed(4)})`;

export async function easingMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP.trim()); return 0; }
  if (!opts.track) { console.log(HELP.trim()); return 2; }
  const prop = String(opts.prop ?? "y");
  if (!PROPS.has(prop)) throw new Error(`unknown --prop "${prop}", use one of ${[...PROPS].join(", ")}`);
  const selector = String(opts.selector ?? "");
  const track = readJson(opts.track);
  const series = seriesOf(track, selector, prop, opts["from-ms"] !== undefined ? num(opts["from-ms"], 0) : undefined, opts["to-ms"] !== undefined ? num(opts["to-ms"], 0) : undefined);
  if (!series.length) throw new Error(`no samples for selector "${selector}" prop "${prop}" in ${opts.track}`);
  const result = fit(series);
  if (!result) throw new Error(`series too short to fit: ${series.length} sample(s) of "${prop}" for "${selector}". Capture at least 3 frames of the motion.`);
  const out = {
    selector, prop, samples: series.length,
    start: +result.v0.toFixed(4), end: +result.v1.toFixed(4), change: +result.change.toFixed(4),
    delayMs: result.delayMs, visibleDurationMs: result.visibleMs,
    overshootPct: result.overshootPct,
    verdict: result.fits[0] ? fmt(result.fits[0]) : "no fit",
    bestFits: result.fits.map((f) => ({ name: f.name, cubicBezier: f.cp, durationMs: Math.round(f.durationMs), rmse: +f.rmse.toFixed(4) })),
  };

  if (opts["compare-track"]) {
    const other = readJson(opts["compare-track"]);
    const otherSeries = seriesOf(other, selector, prop);
    if (otherSeries.length) {
      const map = new Map(otherSeries.map(([t, v]) => [t.toFixed(2), v]));
      let maxAbs = 0, sum = 0, n = 0;
      for (const [t, v] of series) {
        const ov = map.get(t.toFixed(2));
        if (ov === undefined) continue;
        const d = Math.abs(v - ov);
        maxAbs = Math.max(maxAbs, d);
        sum += d;
        n++;
      }
      if (!n) throw new Error(`no timestamps in common between ${opts.track} and ${opts["compare-track"]}: both tracks need the same --fps and pre-roll`);
      const otherFit = fit(otherSeries);
      out.compare = {
        against: opts["compare-track"],
        samplesPaired: n,
        maxAbsDiff: +maxAbs.toFixed(2),
        meanAbsDiff: +(n ? sum / n : 0).toFixed(3),
        pctOfTravel: +((n ? sum / n : 0) / Math.max(1e-6, Math.abs(result.change)) * 100).toFixed(2),
        otherVerdict: otherFit?.fits[0] ? fmt(otherFit.fits[0]) : "no fit",
        sameFamily: !!(otherFit?.fits[0] && result.fits[0] && otherFit.fits[0].name === result.fits[0].name),
      };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}
