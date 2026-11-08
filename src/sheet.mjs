// sheet.mjs — labelled contact sheets: frames or reference/copy/diff rows.
// Layout is done by Chromium (already a dependency) so the labels are real text.
import { chromium } from "playwright";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ensureDir, frameList, num, parseArgs, readJson } from "./lib.mjs";

const HELP = `
frameproof sheet — contact sheets you can actually read

  node src/cli.mjs sheet filmstrip --frames <dir> --out <file-dir> [--cols 6] [--width 240] [--every K]
  node src/cli.mjs sheet compare   --ref <dir> --clone <dir> [--diff <dir>] --out <file-dir> [--every K] [--offset K]

Frames are laid out by Chromium, so every tile carries its frame number and time.
`;

async function render(html, outFile, width) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: outFile, fullPage: true });
  await browser.close();
}

const pageHtml = (title, tiles, cols, tileWidth) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#0b0b0c;color:#d8d8dc;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  h1{font-size:13px;font-weight:600;padding:14px 16px 6px;margin:0;color:#fff}
  .grid{display:grid;grid-template-columns:repeat(${cols},${tileWidth}px);gap:8px;padding:10px 16px 18px}
  figure{margin:0;background:#151517;border:1px solid #26262b;border-radius:6px;overflow:hidden}
  img{display:block;width:100%;height:auto}
  figcaption{padding:4px 6px;font-size:11px;color:#9a9aa2;display:flex;justify-content:space-between}
  .bad{color:#ff7b72}
</style></head><body><h1>${title}</h1><div class="grid">${tiles.join("")}</div></body></html>`;

import { readFileSync } from "node:fs";

const dataUri = (file) => "data:image/png;base64," + readFileSync(file).toString("base64");

const tile = (file, label, extra = "") =>
  `<figure><img src="${dataUri(file)}"><figcaption><span${extra}>${label}</span></figcaption></figure>`;

export async function sheetMain(argv) {
  const opts = parseArgs(argv);
  const mode = opts._[0];
  if (opts.help || !mode) { console.log(HELP.trim()); return 0; }
  const outDir = ensureDir(opts.out ?? "./sheets");
  const cols = num(opts.cols, 6);
  const tileWidth = num(opts.width, 240);
  const every = num(opts.every, 1);
  const pages = [];

  if (mode === "filmstrip") {
    const dir = existsSync(join(opts.frames, "frames")) ? join(opts.frames, "frames") : opts.frames;
    const meta = (() => { try { return readJson(join(opts.frames, "frames.json")); } catch { return null; } })();
    const fps = num(opts.fps, meta?.fps ?? 25);
    const files = frameList(dir).filter((_, i) => i % every === 0);
    const tiles = files.map((f, i) => tile(f, `${String(i * every).padStart(4, "0")} · ${((i * every) / fps).toFixed(2)}s`));
    const perSheet = cols * 4;
    for (let s = 0; s * perSheet < tiles.length; s++) {
      const file = join(outDir, `filmstrip-${String(s + 1).padStart(2, "0")}.png`);
      await render(pageHtml(`${dir} — ${fps} fps`, tiles.slice(s * perSheet, (s + 1) * perSheet), cols, tileWidth), file, cols * (tileWidth + 8) + 32);
      pages.push(file);
    }
  } else if (mode === "compare") {
    const refDir = existsSync(join(opts.ref, "frames")) ? join(opts.ref, "frames") : opts.ref;
    const cloneDir = existsSync(join(opts.clone, "frames")) ? join(opts.clone, "frames") : opts.clone;
    const diffDir = opts.diff && existsSync(opts.diff) ? opts.diff : null;
    const ref = frameList(refDir);
    const clone = frameList(cloneDir);
    const offset = num(opts.offset, 0);
    const fps = num(opts.fps, 25);
    const idx = ref.map((_, i) => i).filter((i) => i % every === 0);
    const tiles = [];
    for (const i of idx) {
      const j = i + offset;
      const c = clone[j];
      tiles.push(tile(ref[i], `ref ${String(i).padStart(4, "0")} · ${(i / fps).toFixed(2)}s`));
      if (c) tiles.push(tile(c, `copy ${String(j).padStart(4, "0")}`));
      if (diffDir) {
        const d = frameList(diffDir)[i];
        if (d) tiles.push(tile(d, `diff`, " class=\"bad\""));
      }
    }
    const perSheet = (diffDir ? 3 : 2) * Math.min(cols, 3) * 4;
    for (let s = 0; s * perSheet < tiles.length; s++) {
      const file = join(outDir, `compare-${String(s + 1).padStart(2, "0")}.png`);
      await render(pageHtml(`reference vs copy${diffDir ? " vs diff" : ""}`, tiles.slice(s * perSheet, (s + 1) * perSheet), diffDir ? 3 : 2, tileWidth * 2), file, (diffDir ? 3 : 2) * (tileWidth * 2 + 8) + 32);
      pages.push(file);
    }
  } else {
    console.log(HELP.trim());
    return 0;
  }
  console.log(pages.join("\n"));
  return 0;
}
