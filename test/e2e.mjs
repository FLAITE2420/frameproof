// End-to-end test: the tool must pass a good copy, fail a bad one, and prove
// that two captures of the same page land in the same place.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { bezierY, readJson, rmse } from "../src/lib.mjs";
import { fit } from "../src/easing.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".test-out");
const CLI = join(ROOT, "src/cli.mjs");
const url = (p) => "file://" + join(ROOT, "examples", p);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

const run = (args, { expectFail = false } = {}) => {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (expectFail) throw new Error("command was expected to fail but exited 0");
    return out;
  } catch (e) {
    if (expectFail && e.status === 1) return String(e.stdout ?? "") + String(e.stderr ?? "");
    throw new Error(`node cli ${args[0]} failed (${e.status}): ${String(e.stderr ?? e.message).slice(0, 600)}`);
  }
};

rmSync(WORK, { recursive: true, force: true });

// 1. easing maths recovers a curve it was given
{
  const cp = [0.16, 1, 0.3, 1];
  const series = [];
  for (let t = 0; t <= 700; t += 10) series.push([t, 400 - 200 * bezierY(Math.min(1, t / 700), cp)]);
  const f = fit(series);
  const names = f.fits.map((x) => x.name);
  check("fit recovers easeOutExpo", names[0] === "easeOutExpo", `best=${names[0]} rmse=${f.fits[0].rmse.toFixed(4)} duration=${Math.round(f.fits[0].durationMs)}ms`);
}

// 2. capture the reference
{
  const r = run(["capture", "--url", url("reference.html"), "--out", join(WORK, "ref"), "--duration", "1600", "--fps", "25", "--track", ".title,.card"]);
  const info = readJson(join(WORK, "ref", "capture.json"));
  const inspect = readJson(join(WORK, "ref", "inspect.json"));
  check("capture writes frames", info.frames === 41 && existsSync(join(WORK, "ref", "frames", "0040.png")), `frames=${info.frames}`);
  check("capture reads the declared spec", inspect.animations.length === 4 && inspect.animations.some((a) => a.timing?.duration === 720), `animations=${inspect.animations.length} durations=${[...new Set(inspect.animations.map((a) => a.timing?.duration))].join("/")}`);
}

// 3. a bad copy fails
{
  run(["capture", "--url", url("copy-bad.html"), "--out", join(WORK, "copy-bad"), "--duration", "1600", "--fps", "25", "--track", ".title,.card"]);
  run(["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy-bad"), "--out", join(WORK, "compare-bad")], { expectFail: true });
  const rep = readJson(join(WORK, "compare-bad", "report.json"));
  const timing = Math.max(...Object.values(rep.motion.timing).map(Math.abs));
  check("bad copy is rejected", rep.pass === false, `mean=${(rep.meanMismatch * 100).toFixed(2)}% timingErr=${timing.toFixed(2)}s`);
}

// 4. the easing reader names the reference curve
{
  const out = run(["easing", "--track", join(WORK, "ref", "track.json"), "--selector", ".card", "--prop", "ty"]);
  const e = JSON.parse(out.slice(out.indexOf("{")));
  check("easing reader names the card curve", e.verdict.startsWith("easeOutExpo"), `${e.verdict} · delay ${e.delayMs}ms · change ${e.change}px`);
}

// 5. a good copy passes, and the difference is inside the noise floor
{
  run(["capture", "--url", url("copy-good.html"), "--out", join(WORK, "copy-good"), "--duration", "1600", "--fps", "25", "--track", ".title,.card"]);
  run(["compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy-good"), "--out", join(WORK, "compare-good")]);
  const rep = readJson(join(WORK, "compare-good", "report.json"));
  const timing = Math.max(...Object.values(rep.motion.timing).map(Math.abs));
  check("good copy passes", rep.pass === true, `mean=${(rep.meanMismatch * 100).toFixed(2)}% timingErr=${timing.toFixed(2)}s`);
}

// 6. the page captures the same way twice
{
  const out = run(["noisefloor", "--url", url("reference.html"), "--out", join(WORK, "floor"), "--runs", "2", "--duration", "1200", "--fps", "25", "--track", ".title,.card"]);
  const floor = readJson(join(WORK, "floor", "floor.json"));
  check("noise floor is zero", floor.worstMeanMismatch < 1e-6 && (floor.worstTimingDriftS ?? 1) <= 0.04, `mismatch=${(floor.worstMeanMismatch * 100).toFixed(4)}% drift=${floor.worstTimingDriftS}s`);
}

// 7. an entrance animation that is over before the tool can look at it
{
  run(["capture", "--url", url("entrance.html"), "--out", join(WORK, "entrance"), "--duration", "300", "--fps", "25", "--track", "#box"]);
  const t = readJson(join(WORK, "entrance", "track.json"));
  const first = t.samples[0]["#box"];
  const last = t.samples[t.samples.length - 1]["#box"];
  const anims = readJson(join(WORK, "entrance", "inspect.json")).animations;
  check("a fill:none entrance is caught at frame 0", first.ty === 40 && first.opacity === 0 && anims.length === 1, `t0 ty=${first.ty} opacity=${first.opacity} animations=${anims.length}`);
}

// 8. sheets render
{
  const out = run(["sheet", "filmstrip", "--frames", join(WORK, "ref", "frames"), "--out", join(WORK, "sheets"), "--every", "4", "--cols", "5", "--width", "200"]);
  const file = out.trim().split("\n")[0];
  check("filmstrip sheet renders", existsSync(file), file.replace(ROOT, "."));
  const out2 = run(["sheet", "compare", "--ref", join(WORK, "ref"), "--clone", join(WORK, "copy-good"), "--diff", join(WORK, "compare-good", "diff"), "--out", join(WORK, "sheets"), "--every", "8"]);
  check("compare sheet renders", existsSync(out2.trim().split("\n")[0]), out2.trim().split("\n")[0].replace(ROOT, "."));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
