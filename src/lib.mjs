// Shared helpers: argv, PNG io, frame lists, easing maths.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

export function parseArgs(argv, defaults = {}) {
  const out = { _: [], ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--") || a === "-") { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (!key) { out._.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export const num = (v, d) => (v === undefined || v === true || v === "" ? d : Number.isFinite(Number(v)) ? Number(v) : d);
export const pad = (n, w = 4) => String(n).padStart(w, "0");
export const ensureDir = (p) => (mkdirSync(p, { recursive: true }), p);
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };
export const readPng = (p) => PNG.sync.read(readFileSync(p));

export function writePng(p, png) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, PNG.sync.write(png));
}

export function frameList(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).sort().map((f) => join(dir, f));
}

export function parseViewport(v, fallback = { width: 1440, height: 900 }) {
  if (!v || v === true) return fallback;
  const m = String(v).match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`bad --viewport "${v}", expected WxH`);
  const width = Number(m[1]), height = Number(m[2]);
  if (!(width > 0) || !(height > 0)) throw new Error(`bad --viewport "${v}", both sides must be positive`);
  return { width, height };
}

export function parseClip(v) {
  if (!v || v === true) return null;
  const p = String(v).split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw new Error(`bad --clip "${v}", expected x,y,w,h`);
  if (!(p[2] > 0) || !(p[3] > 0)) throw new Error(`bad --clip "${v}", width and height must be positive`);
  return { x: p[0], y: p[1], width: p[2], height: p[3] };
}

// ---- easing -------------------------------------------------------------

/** Named cubic-beziers used by real sites, plus families. */
export const EASINGS = [
  ["linear", [0, 0, 1, 1]],
  ["ease", [0.25, 0.1, 0.25, 1]],
  ["ease-in", [0.42, 0, 1, 1]],
  ["ease-out", [0, 0, 0.58, 1]],
  ["ease-in-out", [0.42, 0, 0.58, 1]],
  ["easeOutQuad", [0.5, 1, 0.89, 1]],
  ["easeOutCubic", [0.33, 1, 0.68, 1]],
  ["easeOutQuart", [0.25, 1, 0.5, 1]],
  ["easeOutQuint", [0.22, 1, 0.36, 1]],
  ["easeOutExpo", [0.16, 1, 0.3, 1]],
  ["easeOutCirc", [0.075, 0.82, 0.165, 1]],
  ["easeOutBack", [0.34, 1.56, 0.64, 1]],
  ["easeInQuad", [0.11, 0, 0.5, 0]],
  ["easeInCubic", [0.32, 0, 0.67, 0]],
  ["easeInExpo", [0.7, 0, 0.84, 0]],
  ["easeInOutCubic", [0.65, 0, 0.35, 1]],
  ["easeInOutQuart", [0.76, 0, 0.24, 1]],
  ["easeInOutExpo", [0.87, 0, 0.13, 1]],
  ["material-standard", [0.4, 0, 0.2, 1]],
  ["swift-out", [0.4, 0, 0.2, 1]],
];

const bez = (t, p1, p2) => {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
};

/** x (0..1 time) -> progress, by bisection on the bezier's x. */
export function bezierY(x, [x1, y1, x2, y2]) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) {
    const cx = bez(t, x1, x2);
    if (Math.abs(cx - x) < 1e-6) break;
    if (cx < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return bez(t, y1, y2);
}

export function rmse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

/** Largest deviation past the end value, as a fraction of the travel. */
export function overshoot(series) {
  const first = series[0][1];
  const last = series[series.length - 1][1];
  const range = last - first;
  if (Math.abs(range) < 1e-9) return 0;
  let extreme = last;
  for (const [, v] of series) if (Math.abs(v - first) > Math.abs(extreme - first)) extreme = v;
  const past = (extreme - last) / range;
  return Math.max(0, past);
}
