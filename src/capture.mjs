// capture.mjs — record a page on a virtual clock: numbered frames, the animation
// spec the page declares, and a per-frame track of chosen elements.
import { chromium } from "playwright";
import { join } from "node:path";
import { ensureDir, frameList, num, pad, parseArgs, parseClip, parseViewport, writeJson } from "./lib.mjs";

const HELP = `
frameproof capture — deterministic frame capture of a web page

  node src/cli.mjs capture --url <url|file> --out <dir> [options]

  --viewport WxH      default 1440x900
  --fps N             frames per second written, default 25
  --duration MS       recorded length after the start, default 2000
  --pre-roll MS       frames before the start mark, default 0
  --selector CSS      crop to this element and scroll it into view
  --clip x,y,w,h      explicit crop (overrides --selector)
  --track "CSS, CSS"  elements sampled every frame (default: --selector)
  --trigger T         load (default) | none | hover | scroll
  --target CSS        element to hover (default --selector)
  --scroll-to PX      scroll position for --trigger scroll
  --wait-before MS    settle time before the first frame, default 0
  --pre-js FILE|CODE  JS to run after load, before the frames
  --color-scheme S    light | dark
  --scale N           device pixel ratio, default 1
  --headed            show the browser
  --keep-open         leave the browser open (debugging)

Writes <out>/frames/NNNN.png, frames.json, inspect.json, track.json, capture.json
`;

export async function capture(opts) {
  const out = opts.out;
  if (!out) throw new Error("capture needs --out");
  const fps = num(opts.fps, 25);
  const duration = num(opts.duration, 2000);
  const preRoll = num(opts["pre-roll"], 0);
  const viewport = parseViewport(opts.viewport);
  const trackSelectors = String(opts.track ?? opts.selector ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const trigger = opts.trigger === true ? "load" : (opts.trigger ?? "load");
  const waitBefore = num(opts["wait-before"], 0);

  const framesDir = ensureDir(join(out, "frames"));
  for (const f of frameList(framesDir)) { /* keep old frames out of the run */ }
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ["--force-color-profile=srgb", "--hide-scrollbars", "--font-render-hinting=none", "--disable-lcd-text"],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: num(opts.scale, 1),
    colorScheme: opts["color-scheme"] === "dark" ? "dark" : opts["color-scheme"] === "light" ? "light" : undefined,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  page.on("requestfailed", (r) => consoleErrors.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ""}`));

  // The clock starts frozen: timers, Date and requestAnimationFrame only move
  // when this script advances them, so frame k is always the same instant.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(opts.url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => Promise.race([document.fonts?.ready ?? true, new Promise((r) => setTimeout(r, 2000))]));

  if (waitBefore > 0) await page.clock.runFor(waitBefore);

  if (opts["pre-js"]) {
    const src = String(opts["pre-js"]);
    const code = src.endsWith(".js") ? (await import("node:fs")).readFileSync(src, "utf8") : src;
    await page.evaluate(code);
  }

  let clip = parseClip(opts.clip);
  if (opts.selector) {
    const sel = String(opts.selector);
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }, sel);
    if (!clip) {
      const box = await page.locator(sel).first().boundingBox();
      if (box) clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    }
  }
  if (clip) clip = { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) };

  if (trigger === "hover") {
    const t = String(opts.target ?? opts.selector ?? "body");
    await page.hover(t);
  } else if (trigger === "scroll") {
    const y = num(opts["scroll-to"], 0);
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: "instant" }), y);
  }

  // Take over the animation clock before the first frame.
  const spec = await page.evaluate(() => {
    const path = (el) => {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return "#" + el.id;
      const cls = [...el.classList].slice(0, 2).join(".");
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    };
    const anims = document.getAnimations();
    const list = anims.map((a) => {
      let timing = null, keyframes = null;
      try { timing = a.effect?.getTiming?.() ?? null; } catch {}
      try {
        keyframes = a.effect?.getKeyframes?.().map((k) => {
          const o = {};
          for (const [k2, v] of Object.entries(k)) if (v !== null && typeof v !== "object" || (k2 === "easing" || k2 === "offset" || k2 === "computedOffset")) o[k2] = typeof v === "object" ? JSON.stringify(v) : v;
          return o;
        }) ?? null;
      } catch {}
      return {
        kind: a.constructor?.name ?? "Animation",
        animationName: a.animationName ?? null,
        transitionProperty: a.transitionProperty ?? null,
        target: path(a.effect?.target),
        timing,
        keyframes,
      };
    });
    for (const a of anims) { try { a.pause(); a.currentTime = 0; } catch {} }

    const fonts = [];
    try { document.fonts.forEach((f) => fonts.push(`${f.family} ${f.weight} ${f.style}`)); } catch {}
    const canvases = [...document.querySelectorAll("canvas")].map((c) => ({
      type: (() => { try { return c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl" : "2d"; } catch { return "?"; } })(),
      width: c.width, height: c.height,
    }));
    return {
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scrollY,
      fonts: [...new Set(fonts)],
      canvases,
      libs: (() => {
        const found = [];
        if (window.THREE?.REVISION) found.push("three r" + window.THREE.REVISION);
        if (window.gsap?.version) found.push("gsap " + window.gsap.version);
        if (window.anime) found.push("anime.js");
        if (window.Lenis) found.push("lenis");
        const src = [...document.scripts].map((s) => s.src).join(" ");
        for (const [re, name] of [["framer-motion", "framer-motion"], ["motion/react", "motion"], ["@react-spring", "react-spring"], ["ScrollTrigger", "gsap ScrollTrigger"]]) {
          if (re instanceof RegExp ? re.test(src) : src.includes(re)) found.push(name);
        }
        return [...new Set(found)];
      })(),
      animations: list,
    };
  });

  const sample = async (t) => page.evaluate(({ selectors, time }) => {
    const read = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const m = cs.transform === "none" ? null : cs.transform.match(/matrix\(([^)]+)\)/)?.[1].split(",").map(Number);
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        opacity: Number(cs.opacity),
        tx: m ? m[4] : 0, ty: m ? m[5] : 0,
        scale: m ? m[0] : 1,
        rotate: m ? Math.atan2(m[1], m[0]) * 180 / Math.PI : 0,
      };
    };
    const out = {};
    for (const s of selectors) out[s] = read(document.querySelector(s));
    return out;
  }, { selectors: trackSelectors, time: t });

  const stepMs = 1000 / 60;
  let simMs = 0;
  const startT = -preRoll;
  const total = Math.round((duration + preRoll) / (1000 / fps)) + 1;
  const track = [];
  const frames = [];
  const t0 = Date.now();

  for (let i = 0; i < total; i++) {
    const t = startT + (i * 1000) / fps;
    const target = Math.max(0, t);
    while (simMs < target - 1e-9) {
      const step = Math.min(stepMs, target - simMs);
      await page.clock.runFor(step);
      simMs += step;
    }
    if (t >= 0) {
      await page.evaluate((time) => {
        for (const a of document.getAnimations()) {
          try { a.currentTime = time; } catch {}
        }
      }, t);
    }
    const file = join(framesDir, `${pad(i)}.png`);
    await page.screenshot({ path: file, clip: clip ?? undefined, animations: "allow", caret: "hide" });
    frames.push({ i, t });
    if (trackSelectors.length) track.push({ t, ...(await sample(t)) });
  }

  writeJson(join(out, "frames.json"), { fps, count: total, trigger, clock: "virtual", preRoll, viewport, scale: num(opts.scale, 1), clip });
  writeJson(join(out, "inspect.json"), spec);
  writeJson(join(out, "track.json"), { fps, selectors: trackSelectors, samples: track });
  writeJson(join(out, "capture.json"), {
    url: opts.url, out, trigger, fps, duration, preRoll, viewport, selector: opts.selector ?? null, clip,
    frames: total, wallMs: Date.now() - t0, consoleErrors: consoleErrors.slice(0, 20), capturedAt: new Date().toISOString(),
  });

  if (!opts["keep-open"]) await browser.close();
  return { out, frames: total, animations: spec.animations.length, fonts: spec.fonts.length, wallMs: Date.now() - t0, consoleErrors: consoleErrors.length };
}

export async function captureMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.url) { console.log(HELP.trim()); return 0; }
  const r = await capture(opts);
  console.log(JSON.stringify(r, null, 2));
  return 0;
}
