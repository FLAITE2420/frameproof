// sheet.mjs — labelled contact sheets: a filmstrip of frames, or one row per
// frame with reference, copy and diff side by side. Layout runs in Chromium
// (already a dependency), so every tile carries real, readable labels.
import { chromium } from "playwright";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ensureDir, frameList, num, parseArgs, readJson } from "./lib.mjs";

const HELP = `
frameproof sheet — contact sheets you can actually read

  node src/cli.mjs sheet filmstrip --frames <dir> --out <dir> [--cols 6] [--width 240] [--every K] [--rows 4]
  node src/cli.mjs sheet compare   --ref <dir> --clone <dir> [--diff <dir>] --out <dir> [--every K] [--rows 5] [--width 420] [--offset K]

compare lays out one row per frame: reference, copy, diff.
`;

const dataUri = (file) => "data:image/png;base64," + readFileSync(file).toString("base64");

const CSS = `
  body{margin:0;background:#0b0b0c;color:#d8d8dc;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  h1{font-size:13px;font-weight:600;padding:14px 16px 8px;margin:0;color:#fff}
  .grid{display:grid;gap:8px;padding:8px 16px 20px}
  .row{display:grid;gap:8px}
  figure{margin:0;background:#151517;border:1px solid #26262b;border-radius:6px;overflow:hidden}
  img{display:block;width:100%;height:auto}
  figcaption{padding:4px 6px;font-size:11px;color:#9a9aa2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .diff figcaption{color:#ff7b72}
`;

const fig = (file, label, cls = "") =>
  `<figure class="${cls}"><img src="${dataUri(file)}"><figcaption>${label}</figcaption></figure>`;

async function render(html, outFile, width) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: outFile, fullPage: true });
  await browser.close();
}

const wrap = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><h1>${title}</h1>${body}</body></html>`;

const framesIn = (dir) => (dir ? frameList(existsSync(join(dir, "frames")) ? join(dir, "frames") : dir) : []);

export async function sheetMain(argv) {
  const opts = parseArgs(argv);
  const mode = opts._[0];
  if (opts.help || (mode !== "filmstrip" && mode !== "compare")) { console.log(HELP.trim()); return 0; }
  const outDir = ensureDir(opts.out ?? "./sheets");
  const every = num(opts.every, 1);
  const pages = [];

  if (mode === "filmstrip") {
    const cols = num(opts.cols, 6);
    const width = num(opts.width, 240);
    const rows = num(opts.rows, 4);
    const meta = (() => { try { return readJson(join(opts.frames, "frames.json")); } catch { return null; } })();
    const fps = num(opts.fps, meta?.fps ?? 25);
    const files = framesIn(opts.frames);
    const tiles = files
      .map((f, i) => ({ f, i }))
      .filter(({ i }) => i % every === 0)
      .map(({ f, i }) => fig(f, `frame ${String(i).padStart(4, "0")} · ${(i / fps).toFixed(2)}s`));
    const perSheet = cols * rows;
    for (let s = 0; s * perSheet < tiles.length; s++) {
      const file = join(outDir, `filmstrip-${String(s + 1).padStart(2, "0")}.png`);
      const body = `<div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${tiles.slice(s * perSheet, (s + 1) * perSheet).join("")}</div>`;
      await render(wrap(`${opts.frames} — ${fps} fps`, body), file, cols * (width + 8) + 40);
      pages.push(file);
    }
  } else {
    const width = num(opts.width, 420);
    const rows = num(opts.rows, 5);
    const ref = framesIn(opts.ref);
    const copy = framesIn(opts.clone);
    const diff = opts.diff ? framesIn(opts.diff) : [];
    const fps = (() => { try { return readJson(join(opts.ref, "frames.json")).fps; } catch { return num(opts.fps, 25); } })();
    const offset = num(opts.offset, 0);
    const columns = diff.length ? 3 : 2;
    const rowsHtml = [];
    for (let i = 0; i < ref.length; i += every) {
      const j = i + offset;
      const cells = [fig(ref[i], `ref ${String(i).padStart(4, "0")} · ${(i / fps).toFixed(2)}s`)];
      if (copy[j]) cells.push(fig(copy[j], `copy ${String(j).padStart(4, "0")} · ${(j / fps).toFixed(2)}s`));
      if (diff.length && diff[i]) cells.push(fig(diff[i], "diff (red = differs)", "diff"));
      rowsHtml.push(`<div class="row" style="grid-template-columns:repeat(${columns},1fr)">${cells.join("")}</div>`);
    }
    for (let s = 0; s * rows < rowsHtml.length; s++) {
      const file = join(outDir, `compare-${String(s + 1).padStart(2, "0")}.png`);
      const body = `<div class="grid">${rowsHtml.slice(s * rows, (s + 1) * rows).join("")}</div>`;
      await render(wrap(`reference vs copy${diff.length ? " vs diff" : ""} — every ${every} frames, ${fps} fps`, body), file, columns * (width + 8) + 40);
      pages.push(file);
    }
  }
  console.log(pages.join("\n"));
  return 0;
}
