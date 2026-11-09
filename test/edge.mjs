// Edge battery: the cases that break a frame recorder. Every check states what
// must happen, and fails loudly with the number it got instead.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson } from "../src/lib.mjs";
import { seriesOf, fit } from "../src/easing.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".edge-out");
const CLI = join(ROOT, "src/cli.mjs");
const edge = (p) => "file://" + join(ROOT, "examples", "edge", p);
const ex = (p) => "file://" + join(ROOT, "examples", p);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
};

const run = (args, { expectStatus = 0 } = {}) => {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (expectStatus !== 0) throw new Error(`expected exit ${expectStatus}, got 0`);
    return { stdout, status: 0 };
  } catch (e) {
    const status = e.status ?? 1;
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (status === expectStatus) return { stdout: out, status };
    throw new Error(`cli ${args[0]} ${args[1] ?? ""} exited ${status}: ${out.slice(0, 400)}`);
  }
};
const capture = (file, out, extra = []) => run(["capture", "--url", file, "--out", join(WORK, out), ...extra]);
const json = (p) => readJson(join(WORK, p));

rmSync(WORK, { recursive: true, force: true });

// 1. negative delay: the animation is born half-finished
{
  capture(edge("negative-delay.html"), "negative-delay", ["--duration", "400", "--fps", "25", "--track", "#box"]);
  const s = json("negative-delay/track.json").samples;
  const ty0 = s[0]["#box"].ty;
  check("negative delay starts mid-flight", ty0 > -40 && ty0 < -1, `ty(0)=${ty0.toFixed(2)}px of a -40→0 animation`);
}

// 2. infinite loop: deterministic across captures
{
  capture(edge("infinite-marquee.html"), "marquee-a", ["--duration", "800", "--fps", "25", "--track", ".track"]);
  capture(edge("infinite-marquee.html"), "marquee-b", ["--duration", "800", "--fps", "25", "--track", ".track"]);
  const a = json("marquee-a/track.json").samples;
  const moved = a[0][".track"].tx - a[a.length - 1][".track"].tx;
  run(["compare", "--ref", join(WORK, "marquee-a"), "--clone", join(WORK, "marquee-b"), "--out", join(WORK, "cmp-marquee")]);
  const rep = json("cmp-marquee/report.json");
  check("infinite marquee moves and repeats", moved > 0 && rep.meanMismatch === 0, `tx moved ${moved.toFixed(1)}px, two captures differ ${(rep.meanMismatch * 100).toFixed(4)}%`);
}

// 3. hover transition
{
  capture(edge("hover.html"), "hover", ["--trigger", "hover", "--target", "#btn", "--duration", "600", "--fps", "25", "--track", "#btn"]);
  const s = json("hover/track.json").samples;
  const first = s[0]["#btn"], last = s[s.length - 1]["#btn"];
  check("hover transition is recorded", last.scale > first.scale + 0.01 && last.ty < first.ty, `scale ${first.scale.toFixed(3)}→${last.scale.toFixed(3)}, ty ${first.ty.toFixed(1)}→${last.ty.toFixed(1)}`);
}

// 4. transform-origin makes the box move, not only grow
{
  capture(edge("origin-scale.html"), "origin-scale", ["--duration", "600", "--fps", "25", "--track", "#menu"]);
  const s = json("origin-scale/track.json").samples;
  const a = s[0]["#menu"], b = s[s.length - 1]["#menu"];
  const shift = Math.hypot(b.x - a.x, b.y - a.y);
  check("scale from a corner shifts the box", b.scale > a.scale * 2 && shift > 20, `scale ${a.scale.toFixed(2)}→${b.scale.toFixed(2)}, corner moved ${shift.toFixed(1)}px`);
}

// 5. clip-path reveals: the track cannot see it, the pixels can
{
  capture(edge("clip-reveal.html"), "clip-a", ["--duration", "700", "--fps", "25", "--track", "#pic"]);
  capture(edge("clip-reveal.html"), "clip-b", ["--duration", "700", "--fps", "25", "--track", "#pic"]);
  const s = json("clip-a/track.json").samples;
  const staticTrack = s.every((x) => x["#pic"].w === s[0]["#pic"].w && x["#pic"].x === s[0]["#pic"].x);
  run(["compare", "--ref", join(WORK, "clip-a"), "--clone", join(WORK, "clip-b"), "--out", join(WORK, "cmp-clip")]);
  const rep = json("cmp-clip/report.json");
  check("clip-path motion lives in the pixels", staticTrack && rep.motion.reference.start !== null && rep.motion.reference.end - rep.motion.reference.start >= 8, `track static=${staticTrack}, pixel motion window ${rep.motion.reference.start}–${rep.motion.reference.end}`);
}

// 6. two animations on one element, two different durations
{
  capture(edge("two-animations.html"), "two-anim", ["--duration", "1400", "--fps", "25", "--track", "#card"]);
  const t = json("two-anim/track.json");
  const move = fit(seriesOf(t, "#card", "tx"));
  const fade = fit(seriesOf(t, "#card", "opacity"));
  check("two animations keep their own clocks", Math.abs(move.fits[0].durationMs - 300) < 60 && Math.abs(fade.fits[0].durationMs - 1200) < 120, `slide ${Math.round(move.fits[0].durationMs)}ms (300), fade ${Math.round(fade.fits[0].durationMs)}ms (1200)`);
}

// 7. a static page: compare passes, easing says so instead of crashing
{
  capture(edge("static.html"), "static", ["--duration", "300", "--fps", "25", "--track", "#card"]);
  run(["compare", "--ref", join(WORK, "static"), "--clone", join(WORK, "static"), "--out", join(WORK, "cmp-static")]);
  const out = run(["easing", "--track", join(WORK, "static", "track.json"), "--selector", "#card", "--prop", "ty"]).stdout;
  const e = JSON.parse(out.slice(out.indexOf("{")));
  check("static page: nothing moves, nothing crashes", e.verdict === "no fit" && e.change === 0, `verdict="${e.verdict}", change=${e.change}`);
}

// 8. library detection
{
  capture(edge("libs.html"), "libs", ["--duration", "200", "--fps", "25"]);
  const libs = json("libs/inspect.json").libs;
  const want = ["three r178", "gsap 3.12.5", "anime.js"];
  check("libraries are detected", want.every((w) => libs.includes(w)), libs.join(", ") || "none");
}

// 9. a long animation captured as a slice
{
  capture(edge("long.html"), "long", ["--duration", "2000", "--fps", "10", "--track", "#bar"]);
  const s = json("long/track.json").samples;
  const first = s[0]["#bar"].tx, last = s[s.length - 1]["#bar"].tx;
  check("a long animation is captured as a slice", last - first > 200 && s.length === 21, `tx ${first.toFixed(0)}→${last.toFixed(0)}px over ${s.length} samples at 10 fps`);
}

// 10. fidelity levels: same motion, different skin
{
  capture(ex("reference.html"), "fid-ref", ["--duration", "1400", "--fps", "25", "--track", ".title,.card"]);
  capture(edge("motion-only.html"), "fid-copy", ["--duration", "1400", "--fps", "25", "--track", ".title,.card"]);
  const motion = run(["compare", "--ref", join(WORK, "fid-ref"), "--clone", join(WORK, "fid-copy"), "--out", join(WORK, "fid-motion"), "--level", "motion"]);
  const pixel = run(["compare", "--ref", join(WORK, "fid-ref"), "--clone", join(WORK, "fid-copy"), "--out", join(WORK, "fid-pixel"), "--level", "pixel"], { expectStatus: 1 });
  const m = json("fid-motion/report.json"), p = json("fid-pixel/report.json");
  check("motion level passes a reskin", m.pass === true, `timing ${JSON.stringify(m.motion.timing)}, pixels ignored (${(m.meanMismatch * 100).toFixed(2)}%)`);
  check("pixel level rejects the same reskin", p.pass === false, `pixels ${(p.meanMismatch * 100).toFixed(2)}% > 2%`);
}

// 11. mismatched frame sizes are an error, not a silent number
{
  capture(edge("static.html"), "size-small", ["--duration", "200", "--fps", "25", "--viewport", "800x600"]);
  const r = run(["compare", "--ref", join(WORK, "static"), "--clone", join(WORK, "size-small"), "--out", join(WORK, "cmp-size")], { expectStatus: 1 });
  check("size mismatch is refused", /frame size differs/.test(r.stdout), (r.stdout.match(/frame size differs[^\n]*/) ?? ["no message"])[0]);
}

// 12. a selector that does not exist
{
  capture(edge("static.html"), "no-selector", ["--duration", "200", "--fps", "25", "--selector", "#nope"]);
  const info = json("no-selector/capture.json");
  check("a missing selector falls back to the viewport", info.clip === null && info.frames === 6, `clip=${JSON.stringify(info.clip)} frames=${info.frames}`);
}

// 13. 60 fps capture
{
  capture(edge("static.html"), "fps60", ["--duration", "500", "--fps", "60"]);
  const info = json("fps60/capture.json");
  check("60 fps capture counts frames right", info.frames === 31, `frames=${info.frames} for 500ms at 60fps`);
}

// 14. a bad level is named
{
  const r = run(["compare", "--ref", join(WORK, "static"), "--clone", join(WORK, "static"), "--out", join(WORK, "cmp-bad-level"), "--level", "looks-nice"], { expectStatus: 1 });
  check("a bad --level is rejected", /--level must be motion or pixel/.test(r.stdout), (r.stdout.match(/--level must[^\n]*/) ?? ["no message"])[0]);
}

// 15. the page clock is frozen: two captures of a page that prints Date.now() agree
{
  capture(edge("clock-probe.html"), "clock-a", ["--duration", "800", "--fps", "25"]);
  capture(edge("clock-probe.html"), "clock-b", ["--duration", "800", "--fps", "25"]);
  run(["compare", "--ref", join(WORK, "clock-a"), "--clone", join(WORK, "clock-b"), "--out", join(WORK, "cmp-clock"), "--no-diffs"]);
  const rep = json("cmp-clock/report.json");
  const drift = Math.max(...Object.values(rep.motion.timing).map(Math.abs));
  // A page that prints its own clock is the hard case: work done during load is
  // not fully ours. Timing must still be exact; pixels get the measured floor.
  check("two captures of a clock page agree", rep.meanMismatch < 0.0002 && drift === 0, `mismatch=${(rep.meanMismatch * 100).toFixed(4)}% (floor 0.02%) timingDrift=${drift}s`);
}

// 16. a shorter re-capture does not inherit the longer run's frames
{
  capture(edge("static.html"), "stale", ["--duration", "400", "--fps", "25"]);
  const long = json("stale/capture.json").frames;
  capture(edge("static.html"), "stale", ["--duration", "80", "--fps", "25"]);
  const short = json("stale/capture.json").frames;
  check("re-capture clears old frames", long === 11 && short === 3, `${long} frames then ${short}`);
}

// 17. individual translate/scale/rotate properties, with no `transform` in sight
{
  capture(edge("transform-props.html"), "props", ["--duration", "600", "--fps", "25", "--track", "#box"]);
  const s = json("props/track.json").samples;
  const last = s[s.length - 1]["#box"];
  check("individual transform properties are tracked", last.ty > 70 && last.scale > 1.25 && Math.abs(last.rotate) > 15, `ty=${last.ty.toFixed(1)} scale=${last.scale.toFixed(2)} rotate=${last.rotate.toFixed(1)}`);
}

// 18. an animation born at 300ms runs from its own zero, not the capture's
{
  capture(edge("late-animation.html"), "late", ["--duration", "900", "--fps", "25", "--track", "#box"]);
  const s = json("late/track.json").samples;
  const at = (ms) => s.find((x) => x.t === ms)["#box"].tx;
  const before = at(240), mid = at(400), after = at(560), last = at(800);
  const moved = mid - before > 100 && after >= mid && mid < 299.5;
  check("a late transition keeps its own clock", before === 0 && moved && Math.abs(last - 300) < 1,
    `tx: 240ms=${before.toFixed(1)} → 400ms=${mid.toFixed(1)} → 560ms=${after.toFixed(1)} → 800ms=${last.toFixed(1)} of 300`);
}

// 19. --gl traces a shader: programs, sources, uniforms per frame
{
  capture(edge("gl-quad.html"), "gq", ["--duration", "400", "--fps", "25", "--gl"]);
  const gl = json("gq/gl/gl.json");
  const shaders = readdirSync(join(WORK, "gq", "gl", "shaders"));
  const u = gl.channels.uAngle;
  check("--gl traces shaders and uniforms", gl.programs.length === 1 && shaders.length === 2 && u?.kind === "animated",
    `programs=${gl.programs.length} shaders=${shaders.length} uAngle=${u ? u.min.toFixed(3) + "→" + u.max.toFixed(3) : "missing"}`);
}

// 20. gl compare holds the clone to the reference's uniforms, and names the one that drifts
{
  capture(edge("gl-quad-fast.html"), "gq-fast", ["--duration", "400", "--fps", "25", "--gl"]);
  const same = run(["gl", "compare", "--ref", join(WORK, "gq"), "--clone", join(WORK, "gq"), "--out", join(WORK, "gqc-same")], { expectStatus: 0 });
  const diff = run(["gl", "compare", "--ref", join(WORK, "gq"), "--clone", join(WORK, "gq-fast"), "--out", join(WORK, "gqc-diff")], { expectStatus: 1 });
  const rep = json("gqc-diff/gl-compare.json");
  const named = rep.mismatched.map((r) => r.name).join(",");
  check("gl compare passes the same shader and names the altered one", same.status === 0 && diff.status === 1 && named === "uAngle",
    `same exit ${same.status} · altered exit ${diff.status} on ${named || "nothing"} (${rep.mismatched[0]?.detail ?? ""})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} edge checks passed`);
process.exit(failed.length ? 1 : 0);
