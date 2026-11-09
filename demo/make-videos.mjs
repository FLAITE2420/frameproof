// Build MP4s out of the captured frames: one clip per device, plus side-by-side
// videos for the pairs (reference | copy) and (reference | tampered shader).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, ".campaign-out");
const OUT = join(ROOT, "demo", "videos");
mkdirSync(OUT, { recursive: true });

const clips = [
  ["01-hero-stagger", "show-hero-stagger", "Hero: kicker + tres líneas, 100ms entre cada una", 1],
  ["02-headline-wipe", "show-headline-wipe", "Titular con clip-path, 760ms y 180ms de desfase", 1],
  ["03-ticker", "show-ticker", "Dos cintas opuestas, 2400ms por vuelta", 1],
  ["04-product-card", "show-product-card", "Ficha 3D: rotateY -34 a 18 grados", 1],
  ["05-stroke-draw", "show-stroke-draw", "Trazo SVG, 1500ms + 1200ms con offset", 1],
  ["06-parallax", "parallax-loop", "Parallax: tres capas a 0.2 / 0.45 / 0.7", 1],
  ["07-blend", "blend-loop", "mix-blend-mode difference y overlay", 1],
  ["08-stagger", "stagger6", "Test: seis elementos, 100ms de paso", 0],
  ["09-words", "words", "Test: entrada por palabra, pasos de 90ms", 0],
  ["10-card-depth", "card-depth", "Test: push con perspectiva, escala 0.6 a 1", 0],
  ["11-video", "video", "Test: clip muteado en autoplay", 0],
  ["12-wipe", "wipe", "Test: wipe declarado 700ms", 0],
];

const fpsOf = (dir) => {
  try {
    const c = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8"));
    return c.fps || 25;
  } catch { return 25; }
};

const made = [];
const encode = (framesDir, fps, out, label) => {
  const files = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
  if (!files.length) return null;
  const short = (label || "").slice(0, 58).replace(/[:\\']/g, " ").replace(/%/g, "pct");
  const vf = [
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    short
      ? `drawtext=text='${short}':x=22:y=22:fontsize=21:fontcolor=white@0.92:box=1:boxcolor=black@0.6:boxborderw=10`
      : null,
    "format=yuv420p",
  ].filter(Boolean).join(",");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", String(fps),
    "-i", join(framesDir, "%04d.png"), "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out]);
  const bytes = readFileSync(out).length;
  made.push({ file: out, label, bytes, frames: files.length, fps });
  return out;
};

for (const [name, dirName, label] of clips.filter((c) => c[3] === 1)) {
  const dir = join(SRC, dirName, "frames");
  if (!existsSync(dir)) { console.log(`sin frames: ${dirName}`); continue; }
  encode(dir, fpsOf(join(SRC, dirName)), join(OUT, `${name}.mp4`), label);
}

// side by side: resend hero reference vs the copy
const pair = (a, b, name, la, lb) => {
  if (!existsSync(a) || !existsSync(b)) { console.log(`sin par: ${a} / ${b}`); return; }
  const fa = readdirSync(a).filter((f) => f.endsWith(".png")).sort();
  const fb = readdirSync(b).filter((f) => f.endsWith(".png")).sort();
  const n = Math.min(fa.length, fb.length);
  const tmp = join(OUT, ".pair-" + name);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (let i = 0; i < n; i++) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(a, fa[i]), "-i", join(b, fb[i]),
      "-filter_complex", `[0:v]scale=720:-2,drawtext=text='${la}':x=16:y=16:fontsize=22:fontcolor=white@0.9:box=1:boxcolor=black@0.6:boxborderw=10[a];[1:v]scale=720:-2,drawtext=text='${lb}':x=16:y=16:fontsize=22:fontcolor=white@0.9:box=1:boxcolor=black@0.6:boxborderw=10[b];[a][b]hstack=inputs=2,format=yuv420p`,
      join(tmp, String(i).padStart(4, "0") + ".png")]);
  }
  const fps = fpsOf(join(a, ".."));
  encode(tmp, fps, join(OUT, `${name}.mp4`), "");
  rmSync(tmp, { recursive: true, force: true });
};

pair(join(ROOT, "demo", "ref", "frames"), join(ROOT, "demo", "copy-capture", "frames"),
  "pair-resend-hero", "resend.com reference", "copy (motion PASS, pixels FAIL)");
pair(join(ROOT, "demo", "glit-ref", "frames"), join(ROOT, "demo", "glit-slow", "frames"),
  "pair-cube-shader", "cube, shader clock 1x", "clone, shader clock 1.5x");

writeFileSync(join(OUT, "index.json"), JSON.stringify(made, null, 1) + "\n");
for (const m of made) console.log(`${m.file.replace(ROOT + "/", "")}  ${(m.bytes / 1024).toFixed(0)} KB  ${m.frames}f @${m.fps}fps  ${m.label}`);
