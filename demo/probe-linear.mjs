// Dump Linear's hero dot grid: geometry, colours and the per-dot keyframe table.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://linear.app/", { waitUntil: "load", timeout: 90000 });
await p.waitForTimeout(3000);

const data = await p.evaluate(() => {
  const all = [...document.querySelectorAll("circle[class*='grid-dot']")];
  const dots = all.filter((c) => c.getBoundingClientRect().width > 0);
  if (!dots.length) return { error: "no dots" };
  const host = dots[0].closest("svg") || dots[0].parentElement;
  const hb = host.getBoundingClientRect();
  const anims = document.getAnimations();
  const byTarget = new Map();
  for (const a of anims) {
    const t = a.effect?.target;
    if (t && !byTarget.has(t)) byTarget.set(t, a);
  }
  const rows = dots.map((c) => {
    const cs = getComputedStyle(c);
    const r = c.getBoundingClientRect();
    const a = byTarget.get(c);
    let kf = null, timing = null;
    try { kf = a?.effect?.getKeyframes().map((k) => ({ offset: k.offset, opacity: k.opacity, easing: k.easing })); } catch {}
    try { timing = a?.effect?.getTiming(); } catch {}
    return {
      cls: c.getAttribute("class"),
      cx: Number(c.getAttribute("cx")), cy: Number(c.getAttribute("cy")), r: Number(c.getAttribute("r")),
      fill: cs.fill, opacity: cs.opacity,
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
      animationName: cs.animationName, duration: cs.animationDuration, delay: cs.animationDelay,
      iterations: cs.animationIterationCount, direction: cs.animationDirection, timingFunction: cs.animationTimingFunction,
      timing, keyframes: kf,
    };
  });
  const svgBox = { x: hb.x, y: hb.y, w: hb.width, h: hb.height, viewBox: host.getAttribute?.("viewBox") };
  const bg = getComputedStyle(document.body).backgroundColor;
  const host2 = dots[0]?.closest("svg");
  const hb2 = host2?.getBoundingClientRect();
  return { svgBox: hb2 ? { x: hb2.x, y: hb2.y, w: hb2.width, h: hb2.height, viewBox: host2.getAttribute("viewBox"), preserve: getComputedStyle(host2).preserveAspectRatio } : svgBox,
    bg, total: all.length, count: rows.length, dots: rows };
});

writeFileSync("demo/linear-grid.json", JSON.stringify(data, null, 1) + "\n");
console.log(JSON.stringify({ count: data.count, svgBox: data.svgBox, bg: data.bg, first: data.dots?.[0] }, null, 1).slice(0, 1600));
await b.close();
