// capture.mjs — record a page on a virtual clock: numbered frames, the animation
// spec the page declares, and a per-frame track of chosen elements.
import { chromium } from "playwright";
import { join, resolve, dirname } from "node:path";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { ensureDir, frameList, num, pad, parseArgs, parseClip, parseViewport, writeJson } from "./lib.mjs";
import { hookSource, collectFrame, channelsFrom, summarize } from "./gl.mjs";

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
  const scale = num(opts.scale, 1);
  // Refuse the values that would make the loop divide by zero, allocate forever or
  // ask Chromium for something it cannot do. A named error beats a hang.
  if (!(fps > 0) || fps > 240) throw new Error(`--fps must be between 0 and 240, got ${opts.fps}`);
  if (!(duration >= 0) || duration > 600000) throw new Error(`--duration must be between 0 and 600000 ms, got ${opts.duration}`);
  if (!(preRoll >= 0) || preRoll > 600000) throw new Error(`--pre-roll must be between 0 and 600000 ms, got ${opts["pre-roll"]}`);
  if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error(`--viewport must be positive, got ${viewport.width}x${viewport.height}`);
  if (!(scale > 0) || scale > 8) throw new Error(`--scale must be between 0 and 8, got ${opts.scale}`);
  const trackSelectors = String(opts.track ?? opts.selector ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const trigger = opts.trigger === true ? "load" : (opts.trigger ?? "load");
  if (!["load", "none", "hover", "scroll"].includes(trigger)) {
    throw new Error(`--trigger must be load, none, hover or scroll, got "${trigger}"`);
  }
  const waitBefore = num(opts["wait-before"], 0);

  const framesDir = ensureDir(join(out, "frames"));
  // Start from an empty frame directory: a shorter re-capture into the same --out
  // must not inherit the longer run's frames.
  for (const f of frameList(framesDir)) { try { rmSync(f); } catch {} }
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
  if (opts.gl) await context.addInitScript({ content: hookSource });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  page.on("requestfailed", (r) => consoleErrors.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ""}`));

  // Freeze CSS animations at their first frame before a single byte of the page's
  // own CSS runs. Without this, an entrance animation that finishes while the page
  // is still loading (fill: none) is dropped from getAnimations() and can never be
  // stepped back to frame 0.
  await context.addInitScript(() => {
    const css = "*,*::before,*::after{animation-play-state:paused !important}";
    const inject = () => {
      if (document.getElementById("__fp_pause")) return;
      const s = document.createElement("style");
      s.id = "__fp_pause";
      s.textContent = css;
      (document.head ?? document.documentElement).appendChild(s);
    };
    if (document.documentElement) inject();
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  });

  // The clock starts frozen: timers, Date and requestAnimationFrame only move
  // when this script advances them. install() alone leaves time flowing, which
  // makes a page that renders Date.now() differ between two captures; pauseAt()
  // freezes it. Frame k is then always the same instant.
  const epoch = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: epoch });
  await page.clock.pauseAt(epoch);
  const rawUrl = String(opts.url);
  const url = /^(https?:|file:|data:|about:)/.test(rawUrl) ? rawUrl : "file://" + resolve(rawUrl);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
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
      // never wait on the element: a selector that does not exist falls back to the viewport
      const box = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, sel);
      if (box && box.width > 0 && box.height > 0) clip = box;
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
    // Animations that already exist start at the capture's zero; anything created
    // later (a timer toggling a class, a hover transition) is timed from the frame
    // it first appeared, not from the capture's zero.
    window.__fpBorn = new Map(anims.map((a) => [a, 0]));

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

  const sample = async (t) => page.evaluate(({ selectors }) => {
    const read = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // DOMMatrixReadOnly understands matrix(), matrix3d() and 'none'; the
      // individual translate/scale/rotate properties are added on top.
      let m = null;
      try { m = new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform); } catch { m = null; }
      const tProp = (p) => {
        const v = cs[p];
        if (!v || v === "none") return null;
        const nums = String(v).match(/-?[\d.]+/g)?.map(Number) ?? [];
        return nums.length ? nums : null;
      };
      const tr = tProp("translate");
      const sc = tProp("scale");
      const ro = tProp("rotate");
      const tx = (m ? m.m41 : 0) + (tr ? tr[0] : 0);
      const ty = (m ? m.m42 : 0) + (tr && tr.length > 1 ? tr[1] : 0);
      const scale = m ? Math.hypot(m.m11, m.m12) * (sc ? sc[0] : 1) : (sc ? sc[0] : 1);
      const rotate = m ? Math.atan2(m.m12, m.m11) * 180 / Math.PI + (ro ? ro[0] : 0) : (ro ? ro[0] : 0);
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        opacity: Number(cs.opacity),
        tx, ty, scale, rotate,
      };
    };
    const out = {};
    for (const s of selectors) out[s] = read(document.querySelector(s));
    return out;
  }, { selectors: trackSelectors });

  const stepMs = 1000 / 60;
  let simMs = 0;
  const startT = -preRoll;
  const total = Math.round((duration + preRoll) / (1000 / fps)) + 1;
  const track = [];
  const glSamples = [];
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
        const born = window.__fpBorn ?? (window.__fpBorn = new Map());
        for (const a of document.getAnimations()) {
          try {
            if (!born.has(a)) born.set(a, time);
            a.currentTime = Math.max(0, time - born.get(a));
          } catch {}
        }
      }, t);
    }
    const file = join(framesDir, `${pad(i)}.png`);
    await page.screenshot({ path: file, clip: clip ?? undefined, animations: "allow", caret: "hide" });
    frames.push({ i, t });
    if (trackSelectors.length) track.push({ t, ...(await sample(t)) });
    if (opts.gl) {
      const g = await collectFrame(page);
      if (g) glSamples.push({ t, draws: g.draws, uniforms: g.uniforms });
    }
  }

  writeJson(join(out, "frames.json"), { fps, count: total, trigger, clock: "virtual", preRoll, viewport, scale: num(opts.scale, 1), clip });
  writeJson(join(out, "inspect.json"), spec);
  writeJson(join(out, "track.json"), { fps, selectors: trackSelectors, samples: track });
  writeJson(join(out, "capture.json"), {
    url: opts.url, out, trigger, fps, duration, preRoll, viewport, selector: opts.selector ?? null, clip,
    frames: total, wallMs: Date.now() - t0, consoleErrors: consoleErrors.slice(0, 20), capturedAt: new Date().toISOString(),
  });

  let glInfo = null;
  if (opts.gl) {
    const glDir = ensureDir(join(out, "gl"));
    const shaders = glSamples.length ? await page.evaluate(() => window.__fpgl?.shaders ?? {}) : {};
    const gl = await page.evaluate(() => {
      const s = window.__fpgl;
      if (!s) return { contexts: [], programs: [], shaders: {}, errors: ["no webgl hook"] };
      return { contexts: s.contexts, programs: s.programs, errors: s.errors.slice(0, 20), frames: s.frames ?? 0 };
    });
    if (Object.keys(shaders).length) ensureDir(join(glDir, "shaders"));
    for (const [name, src] of Object.entries(shaders)) writeFileSync(join(glDir, "shaders", name), src);
    const channels = channelsFrom(glSamples);
    gl.programUniforms = Object.fromEntries(gl.programs.map((p) => [p.index, p.uniforms]));
    writeJson(join(glDir, "gl.json"), { ...gl, shaders: Object.keys(shaders), channels });
    writeJson(join(glDir, "track.json"), { fps, frames: glSamples.length, samples: glSamples.map((s) => ({ t: s.t, draws: s.draws })) });
    const sum = summarize(out, { gl, shaders, samples: glSamples, channels });
    writeFileSync(join(glDir, "summary.md"), sum.text);
    glInfo = { programs: gl.programs.length, shaders: Object.keys(shaders).length, animatedChannels: sum.animatedCount, drawsPerFrame: +(glSamples.reduce((a, b) => a + b.draws, 0) / Math.max(1, glSamples.length)).toFixed(1) };
  }

  if (!opts["keep-open"]) await browser.close();
  if (glInfo) {
    writeJson(join(out, "capture.json"), { ...JSON.parse(readFileSync(join(out, "capture.json"), "utf8")), gl: glInfo });
  }
  return { out, frames: total, animations: spec.animations.length, fonts: spec.fonts.length, wallMs: Date.now() - t0, consoleErrors: consoleErrors.length, gl: glInfo };
}

export async function captureMain(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP.trim()); return 0; }
  if (!opts.url) { console.log(HELP.trim()); return 2; }
  const r = await capture(opts);
  console.log(JSON.stringify(r, null, 2));
  return 0;
}
