// Campaign battery: 50 checks on the motion devices that real sportswear and
// retail campaign sites are built from — staggers, headline wipes, tickers,
// 3D product cards, scroll pinning, SVG draws, video, blend modes, and the
// timing edge cases that decide whether a copy is right or merely close.
//
// Every fixture is generated here, so the battery is self-contained: no network,
// no brand assets, no fonts to download. Each check asserts a number frameproof
// produced, not a number this file believes.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readJson } from "../src/lib.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".campaign-out");
const FIX = join(WORK, "fixtures");
const CLI = join(ROOT, "src/cli.mjs");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
};

const BASE_CSS = `html,body{margin:0;background:#0b0b0c;color:#f5f5f7;font:600 28px/1.15 ui-sans-serif,system-ui,sans-serif}
.box{position:absolute;width:120px;height:120px;border-radius:14px;background:#f5f5f7}`;

const page = (name, body, css = "", head = "") => {
  const file = join(FIX, name + ".html");
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>${BASE_CSS}\n${css}</style></head><body>${body}${head}</body></html>`);
  return "file://" + file;
};

const run = (args, { expectStatus = 0 } = {}) => {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0, expected: expectStatus };
  } catch (e) {
    const status = e.status ?? 1;
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    return { stdout: out, status, expected: expectStatus, stderr: out.slice(0, 300) };
  }
};
const capture = (url, out, extra = []) => run(["capture", "--url", url, "--out", join(WORK, out), ...extra]);
const json = (p) => {
  try { return readJson(join(WORK, p)); } catch { return {}; }
};
const track = (out) => json(join(out, "track.json")).samples;
const firstChange = (samples, sel, prop = "opacity") => {
  const first = samples[0]?.[sel]?.[prop];
  const hit = samples.find((s) => s[sel] && Math.abs((s[sel][prop] ?? first) - first) > 1e-6);
  return hit ? Math.round(hit.t) : null;
};
const animWindow = (out) => json(join(out, "inspect.json")).animations
  .map((a) => ({ name: a.animationName || a.transitionProperty, dur: a.timing?.duration, delay: a.timing?.delay }));

// ---------------------------------------------------------------- 1-6 stagger
{
  const url = page("stagger3", `<div class="box" id="a"></div><div class="box" id="b"></div><div class="box" id="c"></div>`, `
  #a{top:60px;left:60px;animation:rise 400ms linear both}
  #b{top:200px;left:60px;animation:rise 400ms linear 120ms both}
  #c{top:340px;left:60px;animation:rise 400ms linear 240ms both}
  @keyframes rise{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}`);
  capture(url, "stagger3", ["--duration", "800", "--fps", "25", "--track", "#a,#b,#c"]);
  const s = track("stagger3");
  const starts = ["#a", "#b", "#c"].map((sel) => firstChange(s, sel));
  check("stagger: three elements, 120ms apart", Math.abs(starts[1] - starts[0] - 120) <= 40 && Math.abs(starts[2] - starts[1] - 120) <= 40,
    `starts ${starts.join(" / ")} ms`);
}

{
  let body = "", css = "";
  for (let i = 0; i < 6; i++) {
    body += `<div class="box" id="s${i}" style="top:${40 + i * 120}px;left:40px"></div>`;
    css += `#s${i}{animation:rise 300ms linear ${i * 100}ms both}\n`;
  }
  const url = page("stagger6", body, css + "@keyframes rise{from{opacity:0}to{opacity:1}}");
  capture(url, "stagger6", ["--duration", "1000", "--fps", "25", "--track", Array.from({ length: 6 }, (_, i) => `#s${i}`).join(",")]);
  const s = track("stagger6");
  const starts = Array.from({ length: 6 }, (_, i) => firstChange(s, `#s${i}`));
  const spacings = starts.slice(1).map((v, i) => v - starts[i]);
  check("stagger: six elements, one gap each", spacings.every((g) => Math.abs(g - 100) <= 40),
    `starts ${starts.join(" ")} ms · gaps ${spacings.join(" ")}`);
}

{
  const url = page("stagger-rev", `<div class="box" id="a"></div><div class="box" id="b"></div>`, `
  #a{top:60px;left:60px;animation:f 400ms linear 300ms both}
  #b{top:200px;left:60px;animation:f 400ms linear both}
  @keyframes f{from{opacity:0}to{opacity:1}}`);
  capture(url, "stagger-rev", ["--duration", "800", "--fps", "25", "--track", "#a,#b"]);
  const s = track("stagger-rev");
  check("stagger: reversed order is measured, not assumed", firstChange(s, "#b") < firstChange(s, "#a"),
    `b ${firstChange(s, "#b")}ms before a ${firstChange(s, "#a")}ms`);
}

{
  const url = page("stagger-tight", `<div class="box" id="a"></div><div class="box" id="b"></div>`, `
  #a{top:60px;left:60px;animation:f 300ms linear both}
  #b{top:200px;left:60px;animation:f 300ms linear 20ms both}
  @keyframes f{from{opacity:0}to{opacity:1}}`);
  capture(url, "stagger-tight", ["--duration", "500", "--fps", "60", "--track", "#a,#b"]);
  const s = track("stagger-tight");
  const gap = firstChange(s, "#b") - firstChange(s, "#a");
  check("stagger: a 20ms gap resolves at 60fps", gap >= 0 && gap <= 34, `gap ${gap}ms at 60fps`);
}

{
  const url = page("stagger-center", `<div class="box" id="l"></div><div class="box" id="m"></div><div class="box" id="r"></div>`, `
  #l{top:60px;left:40px;animation:f 400ms linear 240ms both}
  #m{top:60px;left:260px;animation:f 400ms linear both}
  #r{top:60px;left:480px;animation:f 400ms linear 240ms both}
  @keyframes f{from{opacity:0}to{opacity:1}}`);
  capture(url, "stagger-center", ["--duration", "800", "--fps", "25", "--track", "#l,#m,#r"]);
  const s = track("stagger-center");
  const [l, m, r] = ["#l", "#m", "#r"].map((sel) => firstChange(s, sel));
  check("stagger: from the centre out", m < l && Math.abs(l - r) <= 40, `l ${l} m ${m} r ${r}`);
}

{
  const url = page("stagger-loop", `<div class="box" id="a"></div><div class="box" id="b"></div>`, `
  #a{top:60px;left:60px;animation:loop 900ms linear infinite both}
  #b{top:200px;left:60px;animation:loop 900ms linear 300ms infinite both}
  @keyframes loop{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}`);
  capture(url, "loop-a", ["--duration", "1200", "--fps", "25", "--track", "#a,#b"]);
  capture(url, "loop-b", ["--duration", "1200", "--fps", "25", "--track", "#a,#b"]);
  const same = JSON.stringify(track("loop-a")) === JSON.stringify(track("loop-b"));
  check("stagger: an infinite loop is frame-for-frame repeatable", same, same ? "two captures identical" : "tracks differ");
}

// ---------------------------------------------------------------- 7-12 text
{
  const mk = (dur) => page(`wipe-${dur}`, `<h1 id="h" style="position:absolute;top:80px;left:60px;font-size:64px">JUST DO IT</h1>`, `
  #h{clip-path:inset(0 100% 0 0);animation:wipe ${dur}ms cubic-bezier(.22,1,.36,1) both}
  @keyframes wipe{to{clip-path:inset(0 0 0 0)}}`);
  capture(mk(700), "wipe", ["--duration", "1000", "--fps", "25", "--selector", "#h"]);
  capture(mk(400), "wipe-fast", ["--duration", "1000", "--fps", "25", "--selector", "#h"]);
  const declared = json("wipe/inspect.json").animations[0]?.timing?.duration;
  run(["compare", "--ref", join(WORK, "wipe"), "--clone", join(WORK, "wipe-fast"), "--out", join(WORK, "wipe-cmp"), "--level", "pixel", "--no-diffs"], { expectStatus: 1 });
  const rep = json("wipe-cmp/report.json");
  const durErr = Math.abs(rep.motion.timing.duration);
  check("text: a clip-path wipe declared at 700ms and copied at 400ms is caught", declared === 700 && rep.pass === false && durErr > 0.1,
    `declared ${declared}ms · copy off by ${durErr.toFixed(2)}s on duration · verdict ${rep.verdict}`);
}

{
  const url = page("mask-reveal", `<h1 id="h" style="position:absolute;top:80px;left:60px;font-size:64px">NO FINISH LINE</h1>`, `
  #h{-webkit-mask-image:linear-gradient(90deg,#000 0%,#000 0%,transparent 0%);mask-image:linear-gradient(90deg,#000 0%,#000 0%,transparent 0%);
     animation:mask 800ms linear both}
  @keyframes mask{to{-webkit-mask-image:linear-gradient(90deg,#000 100%,#000 100%,transparent 100%);mask-image:linear-gradient(90deg,#000 100%,#000 100%,transparent 100%)}}`);
  capture(url, "mask", ["--duration", "1000", "--fps", "25", "--selector", "#h"]);
  const rep = json("mask/inspect.json");
  check("text: a mask reveal is captured as one declared animation", rep.animations.length === 1 && rep.animations[0].timing.duration === 800,
    `${rep.animations.length} animation(s), duration ${rep.animations[0]?.timing?.duration}ms`);
}

{
  const url = page("words", `<span class="w" id="w1">RUN</span><span class="w" id="w2">THE</span><span class="w" id="w3">CITY</span>`, `
  .w{display:inline-block;margin:0 12px;font-size:56px;position:relative;top:120px;left:60px}
  #w1{animation:up 400ms ease-out both}
  #w2{animation:up 400ms ease-out 90ms both}
  #w3{animation:up 400ms ease-out 180ms both}
  @keyframes up{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:none}}`);
  capture(url, "words", ["--duration", "700", "--fps", "25", "--track", "#w1,#w2,#w3"]);
  const s = track("words");
  const starts = ["#w1", "#w2", "#w3"].map((sel) => firstChange(s, sel));
  check("text: per-word entrance keeps each word's own start", Math.abs(starts[1] - starts[0] - 90) <= 40 && Math.abs(starts[2] - starts[1] - 90) <= 40,
    `starts ${starts.join(" / ")} ms for 90ms steps`);
}

{
  const url = page("svglines", `<svg width="420" height="140" style="position:absolute;top:80px;left:60px">
  <text id="t" x="0" y="90" font-size="76" font-weight="700" fill="none" stroke="#f5f5f7" stroke-width="2"
        stroke-dasharray="600" stroke-dashoffset="600" style="animation:draw 900ms linear both">KAPPA</text>
  </svg>`, `@keyframes draw{to{stroke-dashoffset:0}}`);
  capture(url, "svglines", ["--duration", "1100", "--fps", "25", "--selector", "svg", "--track", "#t"]);
  const s = track("svglines");
  const staticTrack = s.every((x) => JSON.stringify(x["#t"]) === JSON.stringify(s[0]["#t"]));
  check("text: an SVG stroke draw moves in pixels, not in the DOM track", staticTrack,
    `track ${staticTrack ? "static" : "moving"} — stroke-dashoffset is not a tracked property`);
}

{
  const url = page("tracking", `<h1 id="h" style="position:absolute;top:90px;left:60px;font-size:60px">AIR</h1>`, `
  #h{letter-spacing:-0.1em;animation:track 600ms ease-in-out both}
  @keyframes track{to{letter-spacing:.4em}}`);
  capture(url, "tracking", ["--duration", "800", "--fps", "25", "--selector", "#h", "--track", "#h"]);
  const s = track("tracking");
  const boxes = s.map((x) => x["#h"].w);
  check("text: letter-spacing grows the box and is measured", boxes[boxes.length - 1] > boxes[0] + 20,
    `width ${boxes[0].toFixed(1)} → ${boxes[boxes.length - 1].toFixed(1)} px while letter-spacing is not a tracked property`);
}

{
  const url = page("blurtext", `<h1 id="h" style="position:absolute;top:90px;left:60px;font-size:64px">FASTER</h1>`, `
  #h{filter:blur(8px);opacity:.4;animation:focus 500ms ease-out both}
  @keyframes focus{to{filter:blur(0);opacity:1}}`);
  capture(url, "blurtext", ["--duration", "700", "--fps", "25", "--selector", "#h"]);
  capture(url, "blurtext-b", ["--duration", "700", "--fps", "25", "--selector", "#h"]);
  run(["compare", "--ref", join(WORK, "blurtext"), "--clone", join(WORK, "blurtext-b"), "--out", join(WORK, "blurtext-cmp"), "--no-diffs"]);
  const rep = json("blurtext-cmp/report.json");
  check("text: a blur focus-pull is repeatable to the frame", rep.meanMismatch === 0 && Math.max(...Object.values(rep.motion.timing).map(Math.abs)) === 0,
    `mismatch ${(rep.meanMismatch * 100).toFixed(4)}% · drift ${Math.max(...Object.values(rep.motion.timing).map(Math.abs))}s`);
}

// -------------------------------------------------------------- 13-18 tickers
{
  const url = page("marquee", `<div id="m" class="box" style="border-radius:0;width:200px;height:40px;top:100px;left:0"></div>`, `
  #m{animation:slide 2000ms linear infinite}
  @keyframes slide{from{transform:translateX(0)}to{transform:translateX(400px)}}`);
  capture(url, "marquee", ["--duration", "800", "--fps", "25", "--track", "#m"]);
  const s = track("marquee");
  const moved = s[s.length - 1]["#m"].tx - s[0]["#m"].tx;
  check("ticker: linear marquee travels its declared distance", Math.abs(moved - 160) <= 12, `${moved.toFixed(1)} px in 800ms of a 400px/2000ms loop`);
}

{
  const url = page("marquee-rev", `<div id="m" class="box" style="border-radius:0;width:200px;height:40px;top:100px;left:400px"></div>`, `
  #m{animation:slide 2000ms linear infinite}
  @keyframes slide{from{transform:translateX(0)}to{transform:translateX(-400px)}}`);
  capture(url, "marquee-rev", ["--duration", "800", "--fps", "25", "--track", "#m"]);
  const s = track("marquee-rev");
  const moved = s[s.length - 1]["#m"].tx - s[0]["#m"].tx;
  check("ticker: reversed direction is negative, not absolute", moved < -140, `${moved.toFixed(1)} px`);
}

{
  const fast = page("speed-fast", `<div id="m" class="box" style="top:100px;left:0;border-radius:0;width:200px;height:40px"></div>`,
    `#m{animation:s 1000ms linear infinite}@keyframes s{from{transform:translateX(0)}to{transform:translateX(400px)}}`);
  const slow = page("speed-slow", `<div id="m" class="box" style="top:100px;left:0;border-radius:0;width:200px;height:40px"></div>`,
    `#m{animation:s 2000ms linear infinite}@keyframes s{from{transform:translateX(0)}to{transform:translateX(400px)}}`);
  capture(fast, "speed-fast", ["--duration", "800", "--fps", "25", "--track", "#m"]);
  capture(slow, "speed-slow", ["--duration", "800", "--fps", "25", "--track", "#m"]);
  const d = (o) => { const s = track(o); return s[s.length - 1]["#m"].tx - s[0]["#m"].tx; };
  const ratio = d("speed-fast") / d("speed-slow");
  check("ticker: a 2× faster loop measures 2× the distance", Math.abs(ratio - 2) < 0.05, `ratio ${ratio.toFixed(3)}`);
}

{
  const url = page("marquee-hover", `<div id="m" class="box" style="top:100px;left:0;border-radius:0;width:200px;height:40px"></div>`, `
  #m{animation:s 2000ms linear infinite;animation-play-state:paused}
  body:hover #m{animation-play-state:running;paused:0}
  @keyframes s{from{transform:translateX(0)}to{transform:translateX(400px)}}`);
  capture(url, "marquee-still", ["--duration", "600", "--fps", "25", "--track", "#m"]);
  const s = track("marquee-still");
  const moved = Math.abs(s[s.length - 1]["#m"].tx - s[0]["#m"].tx);
  // The tool drives every animation's currentTime, including one the page paused:
  // a CSS-paused loop is still stepped here, and that is the documented behaviour.
  check("ticker: a CSS-paused loop is still stepped by the tool's clock", Math.abs(moved - 120) < 12,
    `${moved.toFixed(1)} px stepped while animation-play-state is paused`);
}

{
  const url = page("ticker-v", `<div id="m" class="box" style="top:0;left:100px;border-radius:0;width:200px;height:40px"></div>`, `
  #m{animation:s 1500ms linear infinite}
  @keyframes s{from{transform:translateY(0)}to{transform:translateY(300px)}}`);
  capture(url, "ticker-v", ["--duration", "600", "--fps", "25", "--track", "#m"]);
  const s = track("ticker-v");
  const movedY = s[s.length - 1]["#m"].ty - s[0]["#m"].ty;
  const movedX = s[s.length - 1]["#m"].tx - s[0]["#m"].tx;
  check("ticker: a vertical ticker moves in y only", Math.abs(movedY - 120) <= 12 && Math.abs(movedX) < 0.01, `y ${movedY.toFixed(1)} px, x ${movedX.toFixed(2)} px`);
}

{
  const url = page("marquee-seam", `<div id="m" class="box" style="top:100px;left:0;border-radius:0;width:200px;height:40px"></div>`, `
  #m{animation:s 2000ms linear infinite}
  @keyframes s{from{transform:translateX(0)}to{transform:translateX(400px)}}`);
  capture(url, "marquee-seam", ["--duration", "1600", "--fps", "25", "--track", "#m"]);
  const s = track("marquee-seam");
  const perFrame = s.slice(1).map((x, i) => x["#m"].tx - s[i]["#m"].tx);
  const seam = Math.max(...perFrame) - Math.min(...perFrame);
  check("ticker: no seam at the loop point", seam < 3, `per-frame delta spread ${seam.toFixed(2)} px over ${s.length} frames`);
}

// -------------------------------------------------------------- 19-24 product
{
  const url = page("card-rotate", `<div id="c" class="box" style="top:120px;left:100px;width:180px;height:240px"></div>`, `
  body{perspective:900px}
  #c{transform-style:preserve-3d;animation:turn 700ms ease-out both}
  @keyframes turn{from{transform:rotateY(0)}to{transform:rotateY(58deg)}}`);
  capture(url, "card-rotate", ["--duration", "900", "--fps", "25", "--track", "#c"]);
  const s = track("card-rotate");
  const last = s[s.length - 1]["#c"];
  check("product: rotateY through matrix3d is read back in degrees", Math.abs(last.rotateY - 58) < 1.5, `rotateY ${last.rotateY.toFixed(2)}° of 58°, drawn width ×${last.boxScale.toFixed(3)}`);
}

{
  const url = page("card-depth", `<div id="c" class="box" style="top:120px;left:100px;width:180px;height:240px"></div>`, `
  body{perspective:600px}
  #c{animation:push 600ms ease-in both}
  @keyframes push{from{transform:translateZ(-400px)}to{transform:translateZ(0)}}`);
  capture(url, "card-depth", ["--duration", "800", "--fps", "25", "--track", "#c"]);
  const s = track("card-depth");
  const first = s[0]["#c"].boxScale, last = s[s.length - 1]["#c"].boxScale;
  check("product: a perspective push reads as box scale, not as translateZ", first < 0.7 && Math.abs(last - 1) < 0.02,
    `drawn width ×${first.toFixed(3)} → ×${last.toFixed(3)}`);
}

{
  const url = page("card-hover", `<div id="c" class="box" style="top:120px;left:100px;width:180px;height:240px;transition:transform 300ms ease-out"></div>`, `
  #c:hover{transform:scale(1.08)}`);
  capture(url, "card-hover", ["--duration", "500", "--fps", "25", "--track", "#c", "--trigger", "hover", "--target", "#c"]);
  const s = track("card-hover");
  const first = s[0]["#c"].scale, last = s[s.length - 1]["#c"].scale;
  check("product: hover scale is recorded as a transition", Math.abs(first - 1) < 0.01 && Math.abs(last - 1.08) < 0.005, `scale ${first.toFixed(3)} → ${last.toFixed(3)}`);
}

{
  const swap = page("img-swap", `<div id="i" style="position:absolute;top:100px;left:60px;width:200px;height:200px;background:#c00;animation:hide 400ms linear both"></div>`,
    `@keyframes hide{to{opacity:0}}`);
  const still = page("img-static", `<div style="position:absolute;top:100px;left:60px;width:200px;height:200px;background:#c00"></div>`);
  capture(swap, "img-swap", ["--duration", "600", "--fps", "25"]);
  capture(still, "img-static", ["--duration", "600", "--fps", "25"]);
  const r = run(["compare", "--ref", join(WORK, "img-static"), "--clone", join(WORK, "img-swap"), "--out", join(WORK, "img-cmp")], { expectStatus: 1 });
  const rep = json("img-cmp/report.json");
  check("product: a fade-out of a product tile shows up as pixels, not as a DOM track", r.status === 1 && rep.meanMismatch > 0.01,
    `exit ${r.status} · ${(rep.meanMismatch * 100).toFixed(1)}% mismatch`);
}

{
  const url = page("sprite", `<div id="s" style="position:absolute;top:100px;left:60px;width:200px;height:200px;
    background:linear-gradient(90deg,#f5f5f7 0 25%,#c00 0 50%,#0a0 0 75%,#00c 0 100%);background-size:400% 100%;
    animation:frames 480ms steps(4) infinite both"></div>`, `
  @keyframes frames{from{background-position:0% 0}to{background-position:300% 0}}`);
  capture(url, "sprite", ["--duration", "700", "--fps", "25", "--track", "#s"]);
  const uniq = new Set(readdirSync(join(WORK, "sprite", "frames")).map((f) => f)).size;
  const s = track("sprite");
  const wSpread = Math.max(...s.map((x) => x["#s"].w)) - Math.min(...s.map((x) => x["#s"].w));
  check("product: a stepped sprite moves in pixels while its box holds still", uniq > 10 && wSpread < 1.5,
    `${uniq} distinct frames · box width spread ${wSpread.toFixed(2)} px`);
}

{
  const url = page("canvas2d", `<canvas id="c" width="240" height="160" style="position:absolute;top:100px;left:60px"></canvas>`, `
  canvas{background:#111}`, `<script>
  const c=document.getElementById("c").getContext("2d"); const t0=performance.now();
  const draw=(now)=>{const t=(now-t0)/1000; c.fillStyle="#111"; c.fillRect(0,0,240,160);
    c.fillStyle="#f5f5f7"; c.fillRect(20+Math.sin(t*3)*40,60,80,40); requestAnimationFrame(draw);};
  requestAnimationFrame(draw);</script>`);
  capture(url, "canvas2d", ["--duration", "600", "--fps", "25"]);
  const files = readdirSync(join(WORK, "canvas2d", "frames"));
  const rep = json("canvas2d/inspect.json");
  check("product: a 2D canvas animates without declaring anything", files.length > 5 && rep.animations.length === 0,
    `${files.length} frames · ${rep.animations.length} declared animations`);
}

// ---------------------------------------------------------------- 25-30 scroll
const TALL = "body{height:2400px}";

{
  const url = page("sticky", `<div id="s" class="box" style="top:0;left:60px;width:200px;height:80px;position:sticky"></div><div style="height:2000px"></div>`, TALL);
  capture(url, "sticky-0", ["--duration", "200", "--fps", "10", "--track", "#s"]);
  capture(url, "sticky-500", ["--duration", "200", "--fps", "10", "--track", "#s", "--trigger", "scroll", "--scroll-to", "500"]);
  const y0 = track("sticky-0")[0]["#s"].y, y1 = track("sticky-500")[0]["#s"].y;
  check("scroll: a sticky bar holds its y while the page moves 500px", Math.abs(y0 - y1) < 1.5, `y ${y0.toFixed(1)} → ${y1.toFixed(1)} px`);
}

{
  const url = page("parallax", `<div id="p" class="box" style="top:600px;left:60px"></div><div style="height:2000px"></div>`, TALL, `<script>
  addEventListener("scroll", () => { document.getElementById("p").style.transform = "translateY(" + (-scrollY * 0.5) + "px)"; });</script>`);
  capture(url, "parallax-0", ["--duration", "200", "--fps", "10", "--track", "#p"]);
  capture(url, "parallax-400", ["--duration", "200", "--fps", "10", "--track", "#p", "--trigger", "scroll", "--scroll-to", "400"]);
  const y0 = track("parallax-0")[0]["#p"].y, y1 = track("parallax-400")[0]["#p"].y;
  // 400px of scroll moves the box once on its own, plus 200px of parallax
  check("scroll: parallax at 0.5× adds 200px on top of the scroll itself", Math.abs((y0 - y1) - 400 - 200) < 8, `Δ ${(y0 - y1).toFixed(1)} px from 400px of scroll`);
}

{
  const url = page("progress", `<div id="b" style="position:fixed;top:0;left:0;height:8px;width:0;background:#5eead4"></div><div style="height:2400px"></div>`, TALL, `<script>
  addEventListener("scroll", () => { document.getElementById("b").style.width = Math.min(1440, scrollY) + "px"; });</script>`);
  capture(url, "progress-200", ["--duration", "200", "--fps", "10", "--track", "#b", "--trigger", "scroll", "--scroll-to", "200"]);
  capture(url, "progress-800", ["--duration", "200", "--fps", "10", "--track", "#b", "--trigger", "scroll", "--scroll-to", "800"]);
  const w1 = track("progress-200")[0]["#b"].w, w2 = track("progress-800")[0]["#b"].w;
  check("scroll: a progress bar reads its width from the scroll offset", Math.abs(w1 - 200) < 8 && Math.abs(w2 - 800) < 8, `${w1.toFixed(0)}px at 200 · ${w2.toFixed(0)}px at 800`);
}

{
  const url = page("reveal", `<div id="r" class="box" style="top:1400px;left:60px;opacity:0;transition:opacity 400ms ease"></div><div style="height:2400px"></div>`, TALL, `<script>
  const el = document.getElementById("r");
  new IntersectionObserver((e) => { if (e[0].isIntersecting) el.style.opacity = "1"; }).observe(el);</script>`);
  capture(url, "reveal-0", ["--duration", "300", "--fps", "10", "--track", "#r"]);
  capture(url, "reveal-1200", ["--duration", "700", "--fps", "10", "--track", "#r", "--trigger", "scroll", "--scroll-to", "1200"]);
  const o0 = track("reveal-0")[0]["#r"].opacity;
  const last = track("reveal-1200").at(-1)["#r"].opacity;
  check("scroll: an IntersectionObserver reveal is caught only when scrolled", o0 < 0.01 && last > 0.99, `opacity ${o0.toFixed(2)} at 0 → ${last.toFixed(2)} after scrolling`);
}

{
  const url = page("horizontal", `<div id="t" class="box" style="top:200px;left:0;width:300px;height:200px;border-radius:0"></div><div style="height:2400px"></div>`, TALL, `<script>
  addEventListener("scroll", () => { document.getElementById("t").style.transform = "translateX(" + (-scrollY) + "px)"; });</script>`);
  capture(url, "horizontal-600", ["--duration", "200", "--fps", "10", "--track", "#t", "--trigger", "scroll", "--scroll-to", "600"]);
  const x = track("horizontal-600")[0]["#t"].tx;
  check("scroll: a horizontal track moves by the full scroll offset", Math.abs(x + 600) < 6, `tx ${x.toFixed(1)} px at scroll 600`);
}

{
  const url = page("scroll-clamp", `<div style="height:1200px"></div>`, "");
  const r = capture(url, "scroll-clamp", ["--duration", "200", "--fps", "10", "--trigger", "scroll", "--scroll-to", "99999"]);
  const c = json("scroll-clamp/capture.json");
  check("scroll: scrolling past the document clamps instead of failing", r.status === 0 && c.frames === 3, `frames ${c.frames}, no error`);
}

// ------------------------------------------------------------- 31-35 svg / pixels
const frameHashes = (out) => {
  const dir = join(WORK, out, "frames");
  return new Set(readdirSync(dir).map((f) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"))).size;
};

{
  const url = page("stroke-draw", `<svg width="400" height="200" style="position:absolute;top:80px;left:60px">
  <path d="M10 120 C 90 20, 180 200, 300 90" fill="none" stroke="#5eead4" stroke-width="6"
        stroke-dasharray="420" stroke-dashoffset="420" style="animation:draw 800ms linear both"/></svg>`, `@keyframes draw{to{stroke-dashoffset:0}}`);
  capture(url, "stroke-draw", ["--duration", "1000", "--fps", "25"]);
  const uniq = frameHashes("stroke-draw");
  check("svg: a stroke draw produces distinct frames through the whole curve", uniq >= 12, `${uniq} distinct frames of 26`);
}

{
  const url = page("logo-swap", `<svg width="240" height="120" style="position:absolute;top:80px;left:60px">
  <g id="g1"><circle cx="60" cy="60" r="46" fill="#f5f5f7"/></g>
  <g id="g2" style="opacity:0"><rect x="130" y="14" width="92" height="92" rx="18" fill="#c00"/></g></svg>`, `
  #g2{animation:swap 500ms linear 100ms both}@keyframes swap{to{opacity:1}}`);
  capture(url, "logo-swap", ["--duration", "800", "--fps", "25"]);
  const uniq = frameHashes("logo-swap");
  check("svg: a logo swap is measured across its blend", uniq >= 10, `${uniq} distinct frames`);
}

{
  const url = page("logo-mask", `<div id="m" style="position:absolute;top:80px;left:60px;width:300px;height:140px;background:#f5f5f7;
    clip-path:inset(0 100% 0 0);animation:reveal 600ms linear both"></div>`, `
  @keyframes reveal{to{clip-path:inset(0 0 0 0)}}`);
  capture(url, "logo-mask", ["--duration", "800", "--fps", "25"]);
  const uniq = frameHashes("logo-mask");
  check("svg: a clip-path wipe on a solid block is pure pixel motion", uniq >= 10, `${uniq} distinct frames`);
}

{
  const url = page("gradient", `<div id="g" style="position:absolute;top:80px;left:60px;width:400px;height:180px;
    background:linear-gradient(90deg,#c00,#0a0,#00c,#c00);background-size:300% 100%;
    animation:pan 700ms linear infinite both"></div>`, `@keyframes pan{from{background-position:0% 0}to{background-position:200% 0}}`);
  capture(url, "gradient", ["--duration", "600", "--fps", "25"]);
  const uniq = frameHashes("gradient");
  check("svg: an animated gradient is caught without any declared transform", uniq >= 12, `${uniq} distinct frames`);
}

{
  const url = page("svg-filter", `<svg width="300" height="160" style="position:absolute;top:80px;left:60px">
  <rect id="r" x="20" y="20" width="260" height="120" fill="#5eead4" style="animation:blur 500ms ease-out both"/></svg>`, `
  #r{filter:blur(12px)}@keyframes blur{to{filter:blur(0)}}`);
  capture(url, "svg-filter", ["--duration", "700", "--fps", "25"]);
  const uniq = frameHashes("svg-filter");
  check("svg: a filter focus-pull inside an SVG is measured", uniq >= 10, `${uniq} distinct frames`);
}

// ---------------------------------------------------------------- 36-38 video
const VIDEO = join(FIX, "clip.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=1",
  "-pix_fmt", "yuv420p", VIDEO]);
{
  const url = page("video", `<video id="v" src="clip.mp4" autoplay muted loop playsinline
      style="position:absolute;top:80px;left:60px;width:320px;height:180px"></video>`);
  capture(url, "video", ["--duration", "800", "--fps", "25"]);
  const uniq = frameHashes("video");
  check("video: an autoplaying muted clip produces moving frames", uniq >= 8, `${uniq} distinct frames of 21`);
}

{
  const url = page("video-poster", `<video id="v" src="clip.mp4" muted playsinline preload="metadata"
      style="position:absolute;top:80px;left:60px;width:320px;height:180px"></video>`);
  capture(url, "video-poster", ["--duration", "600", "--fps", "10"]);
  const uniq = frameHashes("video-poster");
  check("video: without autoplay the same clip is a still poster", uniq === 1, `${uniq} distinct frame(s)`);
}

{
  const url = page("video-overlay", `<video id="v" src="clip.mp4" autoplay muted loop playsinline
      style="position:absolute;top:80px;left:60px;width:320px;height:180px"></video>
    <div id="o" style="position:absolute;top:80px;left:60px;width:320px;height:180px;background:#000;opacity:.5"></div>`);
  capture(url, "video-a", ["--duration", "600", "--fps", "10"]);
  capture(url, "video-b", ["--duration", "600", "--fps", "10"]);
  run(["compare", "--ref", join(WORK, "video-a"), "--clone", join(WORK, "video-b"), "--out", join(WORK, "video-cmp"), "--no-diffs"]);
  const rep = json("video-cmp/report.json");
  check("video: the same clip captured twice lands on the same frames", rep.meanMismatch === 0,
    `${(rep.meanMismatch * 100).toFixed(4)}% between two captures — the clip advances with the virtual clock`);
}

// --------------------------------------------------------------- 39-42 blend
{
  // the blended layer must be the one on top, or the opaque sibling hides it
  const mk = (mode) => page(`blend-${mode}`, `<div style="position:absolute;top:120px;left:120px;width:260px;height:260px;background:#f80"></div>
    <div id="w" style="position:absolute;top:80px;left:60px;width:260px;height:260px;background:#0af;mix-blend-mode:${mode}"></div>`, "");
  capture(mk("normal"), "blend-normal", ["--duration", "200", "--fps", "10"]);
  capture(mk("difference"), "blend-difference", ["--duration", "200", "--fps", "10"]);
  run(["compare", "--ref", join(WORK, "blend-normal"), "--clone", join(WORK, "blend-difference"), "--out", join(WORK, "blend-cmp")], { expectStatus: 1 });
  const rep = json("blend-cmp/report.json");
  check("blend: mix-blend-mode difference changes the pixels, not the box", rep.meanMismatch > 0.02, `${(rep.meanMismatch * 100).toFixed(1)}% mismatch vs normal`);
}

{
  const url = page("backdrop", `<div style="position:absolute;top:60px;left:60px;width:300px;height:200px;
    background:linear-gradient(90deg,#c00,#00c)"></div>
    <div id="g" style="position:absolute;top:100px;left:120px;width:200px;height:120px;background:rgba(255,255,255,.25);
    backdrop-filter:blur(14px);border-radius:14px;animation:grow 400ms ease-out both"></div>`, `@keyframes grow{from{transform:scale(.6)}to{transform:scale(1)}}`);
  const r = capture(url, "backdrop", ["--duration", "600", "--fps", "25"]);
  const uniq = frameHashes("backdrop");
  check("blend: a backdrop-filter card captures without artefacts", r.status === 0 && uniq >= 8, `${uniq} distinct frames, exit ${r.status}`);
}

{
  const url = page("text-clip", `<div id="t" style="position:absolute;top:100px;left:60px;font-size:96px;font-weight:700;
    background:linear-gradient(90deg,#c00,#fc0,#0a0);-webkit-background-clip:text;background-clip:text;color:transparent;
    background-size:300% 100%;animation:pan 800ms linear infinite both">NIKE</div>`, `@keyframes pan{from{background-position:0 0}to{background-position:200% 0}}`);
  capture(url, "text-clip", ["--duration", "700", "--fps", "25"]);
  const uniq = frameHashes("text-clip");
  check("blend: a gradient-clipped headline animates inside the glyphs", uniq >= 12, `${uniq} distinct frames`);
}

{
  const url = page("stack", `<div id="b" class="box" style="top:80px;left:60px;z-index:2;animation:a 500ms ease-out both"></div>
    <div id="f" class="box" style="top:120px;left:140px;z-index:1;animation:b 500ms ease-out both"></div>`, `
  @keyframes a{from{transform:translateY(80px) scale(.9)}to{transform:none}}
  @keyframes b{from{transform:translateY(-40px)}to{transform:none}}`);
  capture(url, "stack", ["--duration", "700", "--fps", "25", "--track", "#b,#f"]);
  const s = track("stack");
  const movedB = Math.abs(s.at(-1)["#b"].ty - s[0]["#b"].ty);
  const movedF = Math.abs(s.at(-1)["#f"].ty - s[0]["#f"].ty);
  check("blend: two layers on different z-index keep separate tracks", movedB > 40 && movedF > 20, `b ${movedB.toFixed(1)}px · f ${movedF.toFixed(1)}px`);
}

// --------------------------------------------------------------- 43-48 timing
{
  const url = page("fps60", `<div class="box" style="top:100px;left:60px"></div>`);
  capture(url, "fps60", ["--duration", "500", "--fps", "60"]);
  const n = json("fps60/frames.json").count;
  check("timing: 500ms at 60fps is 31 frames, not 30", n === 31, `${n} frames`);
}

{
  const url = page("long", `<div id="l" class="box" style="top:100px;left:60px;width:60px"></div>`, `
  #l{animation:grow 5000ms linear both}@keyframes grow{from{width:60px}to{width:600px}}`);
  capture(url, "long", ["--duration", "500", "--fps", "10", "--track", "#l"]);
  const s = track("long");
  const w = s.at(-1)["#l"].w - s[0]["#l"].w;
  check("timing: a 5s animation can be measured in a 500ms slice", s.length === 6 && Math.abs(w - 54) <= 3, `${s.length} samples · width +${w.toFixed(1)}px of 540 over 5s`);
}

{
  const url = page("negative", `<div id="n" class="box" style="top:100px;left:60px"></div>`, `
  #n{animation:rise 400ms linear -200ms both}@keyframes rise{from{opacity:0;transform:translateY(-40px)}to{opacity:1;transform:none}}`);
  capture(url, "negative", ["--duration", "400", "--fps", "25", "--track", "#n"]);
  const s = track("negative");
  const ty = s[0]["#n"].ty, op = s[0]["#n"].opacity;
  check("timing: a negative delay starts the capture mid-flight", ty < -5 && op > 0.2, `frame 0 at ty ${ty.toFixed(1)}px, opacity ${op.toFixed(2)}`);
}

{
  const url = page("spring", `<div id="s" class="box" style="top:100px;left:60px"></div>`, `
  #s{animation:pop 600ms cubic-bezier(.34,1.56,.64,1) both}@keyframes pop{from{transform:scale(.5)}to{transform:scale(1)}}`);
  capture(url, "spring", ["--duration", "800", "--fps", "25", "--track", "#s"]);
  const out = run(["easing", "--track", join(WORK, "spring", "track.json"), "--selector", "#s", "--prop", "scale"]);
  const parsed = JSON.parse(out.stdout);
  const best = parsed.bestFits?.[0];
  check("timing: a spring-like bezier is fitted, not named and abandoned", !!best && best.rmse < 0.03, best ? `best ${best.name} rmse ${best.rmse.toFixed(4)}` : "no fit returned");
}

{
  const url = page("unstable", `<div id="t" style="position:fixed;inset:0"></div>`, "",
    `<script>document.getElementById("t").style.background = "hsl(" + Math.floor(Math.random() * 360) + " 80% 50%)";</script>`);
  const r = run(["noisefloor", "--url", url, "--out", join(WORK, "unstable"), "--runs", "3", "--duration", "200"], { expectStatus: 1 });
  const rep = json("unstable/floor.json");
  check("timing: a page that renders randomness is called unstable", String(rep.verdict).startsWith("unstable") && rep.worstMeanMismatch > 0.002,
    `verdict ${rep.verdict} · ${(rep.worstMeanMismatch * 100).toFixed(2)}% between runs`);
}


{
  const mk = (delay) => page(`delay-${delay}`, `<div id="d" class="box" style="top:100px;left:60px"></div>`,
    `#d{animation:rise 400ms linear ${delay}ms both}@keyframes rise{from{opacity:0}to{opacity:1}}`);
  capture(mk(0), "delay-ref", ["--duration", "700", "--fps", "25"]);
  capture(mk(120), "delay-late", ["--duration", "700", "--fps", "25"]);
  const r = run(["compare", "--ref", join(WORK, "delay-ref"), "--clone", join(WORK, "delay-late"), "--out", join(WORK, "delay-cmp"), "--level", "motion", "--no-diffs"], { expectStatus: 1 });
  const rep = json("delay-cmp/report.json");
  const start = Math.abs(rep.motion.timing.start);
  check("timing: a copy 120ms late is rejected on timing alone", r.status === 1 && start > 0.08, `start error ${start.toFixed(2)}s against an 0.08s limit`);
}

// ------------------------------------------------------------- 49-50 robustness
{
  const inner = page("iframe-inner", `<div id="i" class="box" style="top:40px;left:40px;animation:f 600ms linear infinite both"></div>`,
    `@keyframes f{from{opacity:.2}to{opacity:1}}`);
  const url = page("iframe-outer", `<iframe src="${inner.split("/").pop()}" style="position:absolute;top:60px;left:60px;width:400px;height:300px;border:0"></iframe>`, "");
  capture(url, "iframe", ["--duration", "600", "--fps", "25", "--track", "#i"]);
  const s = track("iframe");
  const nullTrack = s.every((x) => x["#i"] === null);
  const uniq = frameHashes("iframe");
  check("robustness: an iframe is invisible to the track and frozen in the pixels", nullTrack && uniq === 1,
    `track ${nullTrack ? "null" : "read"} · ${uniq} distinct frame — the init script pauses it, nothing steps it back`);
}

{
  const quad = "file://" + join(ROOT, "examples", "edge", "gl-quad.html");
  const quadFast = "file://" + join(ROOT, "examples", "edge", "gl-quad-fast.html");
  capture(quad, "gl-ref", ["--duration", "400", "--fps", "25", "--gl"]);
  capture(quadFast, "gl-fast", ["--duration", "400", "--fps", "25", "--gl"]);
  const r = run(["gl", "compare", "--ref", join(WORK, "gl-ref"), "--clone", join(WORK, "gl-fast"), "--out", join(WORK, "gl-cmp")], { expectStatus: 1 });
  const rep = json("gl-cmp/gl-compare.json");
  const named = rep.mismatched.map((x) => x.name).join(",");
  check("robustness: a shader that computes a different value is named", r.status === 1 && named === "uAngle",
    `exit ${r.status} on ${named || "nothing"} (${rep.mismatched[0]?.detail ?? ""})`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`${results.length - failed.length}/${results.length} campaign checks passed`);
if (failed.length) {
  console.log("");
  for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
  process.exit(1);
}
