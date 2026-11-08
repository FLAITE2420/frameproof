# frameproof

Capture a web animation frame by frame on a virtual clock, name its easing, and prove a copy moves the same. Before judging the copy, it measures how much the page moves on its own.

Built for the case where "it looks about right" is not evidence: a clone is accepted only when the numbers from a second capture of your copy match the numbers from the reference.

```
capture → easing → build → capture → compare → repeat
                    ↑                              ↓
                    └──── noisefloor (the floor) ───┘
```

## Why a noise floor

Two captures of the *same* page are not automatically identical. Timers, requestAnimationFrame and the compositor all start at different instants on a cold versus a warm load, so a comparison can report a difference that belongs to the capture, not to your code.

frameproof removes that by construction: the page runs on a frozen clock that the tool advances one step at a time, and every CSS/WAAPI animation is paused and then stepped to the exact frame time. Frame `k` is always the same instant. The `noisefloor` command proves it on your page before you trust any verdict.

Measured on this repo's example (2 runs, 25 fps, 1440x900): **0.0000 % pixel mismatch, 0 s timing drift, 0 px track delta.**

## Install

```sh
npm install
npx playwright install chromium     # ~150 MB, once
```

Node 20+. No build step, no Bun.

## Use

```sh
# 1. what does the reference do?
node src/cli.mjs capture --url https://example.com --out ref \
  --selector ".hero" --duration 2000 --track ".hero h1,.hero .card"

# 2. every declared animation, its timing, easing and keyframes
cat ref/inspect.json

# 3. name the curve of one property
node src/cli.mjs easing --track ref/track.json --selector ".card" --prop ty

# 4. is the copy repeatable, before comparing anything?
node src/cli.mjs noisefloor --url http://localhost:3000 --out floor --runs 3 \
  --selector ".hero" --duration 2000 --track ".hero h1,.hero .card"

# 5. capture the copy the same way, compare
node src/cli.mjs capture --url http://localhost:3000 --out copy-1 \
  --selector ".hero" --duration 2000 --track ".hero h1,.hero .card"
node src/cli.mjs compare --ref ref --clone copy-1 --out compare-1

# 6. look at it
node src/cli.mjs sheet compare --ref ref --clone copy-1 --diff compare-1/diff --out sheets --every 4
```

`compare` exits 0 on pass and 1 on fail, so it drops straight into CI.

## What each command gives you

| command | output |
|---|---|
| `capture` | `frames/NNNN.png`, `inspect.json` (declared animations, timing, keyframes, fonts, libraries), `track.json` (x/y/w/h/opacity/translate/scale/rotate per element per frame), `frames.json`, `capture.json` |
| `easing` | start/end value, delay, visible duration, overshoot, the four best fitting named cubic-beziers with their RMSE and duration, and `--compare-track` for the difference between two curves |
| `compare` | mean pixel mismatch, per-frame table, motion window, timing error (start/end/duration/peak minus reference), aligned offset, diff PNGs, `report.json` + `report.md`. `--level motion` judges timing alone (different copy, colours and fonts allowed); `--level pixel` also requires the pixels |
| `noisefloor` | N captures of one page compared pairwise: pixel floor, timing drift, track delta, `floor.json` |
| `sheet` | contact sheets laid out by Chromium, so frames carry readable labels |

## How the capture is made deterministic

1. Before the page's own CSS runs, `*,*::before,*::after { animation-play-state: paused }` is injected, so every animation is still at frame 0 when the tool arrives — including entrances with `fill: none` that would otherwise finish during a slow load.
2. `page.clock.install()` freezes `Date`, timers and requestAnimationFrame before navigation.
3. After load, `document.getAnimations()` is paused and pinned to `currentTime = 0`.
4. For frame *k* the clock advances in 1/60 s steps to the frame time, then every animation gets `currentTime = t_k`.
5. The screenshot is taken with animations still paused, so the pixels cannot drift between the read and the write.

`--trigger hover|scroll` acts on the page before the clock is taken over; those triggers are approximate to within one frame.

## Measured results in this repo

`npm test` runs 25 hand-written checks (10 end to end, 15 on the edges) plus 766 generated fuzz checks. Current run on Node 22.23.1, Chromium 1248, 1440x900 @ 25 fps:

| check | result |
|---|---|
| fit recovers a curve it was given | `easeOutExpo`, rmse 0.0011, 704 ms for a 700 ms input |
| capture writes frames | 41 frames for `--duration 1600` at 25 fps |
| capture reads the declared spec | 4 animations, durations 500 / 720 ms, per-keyframe easing recovered |
| bad copy is rejected | peak timing error 0.16 s → **FAIL** |
| easing reader names the card curve | `easeOutExpo cubic-bezier(0.16,1,0.3,1) over ~718 ms`, delay 80 ms, travel −64 px, rmse 0.0006 |
| good copy passes | 0.00 % mismatch, 0.00 s timing error → **PASS** |
| noise floor is zero | 0.0000 % mismatch, 0 s drift |
| a `fill: none` entrance is caught at frame 0 | `ty=40`, `opacity=0`, animation still present |
| sheets render | filmstrip and compare PNGs |

The bad copy in `examples/copy-bad.html` is worth a look: its **mean pixel mismatch is only 0.10 %** while its timing is off by 160 ms. Pixels alone would have passed it. That is the reason the timing columns exist and the reason `compare` fails a copy whose motion window does not line up.

## Edge cases, measured

`test/edge.mjs` exists because every one of these broke a naive recorder at some point. Numbers below are from the current run.

| case | what it proves |
|---|---|
| animation with `animation-delay: -200ms` | the capture starts mid-flight: `ty(0) = -12.61px` of a −40→0 move |
| infinite marquee | 218.4 px travelled, and two captures of the same page differ by `0.0000%` |
| `:hover` transition | recorded: scale 1.000→1.040, ty 0.0→−8.0 |
| `transform-origin: bottom right` scale | the box moves, not only grows: corner travels 187.4 px while scale goes 0.40→1.00 |
| `clip-path` wipe | the track cannot see it (x/w constant) yet the pixel activity curve finds the window 3–13 |
| two animations on one element | `slide 302 ms` and `fade 1210 ms` recovered separately (declared 300 / 1200) |
| page with no animation | `compare` passes, `easing` answers `no fit` instead of crashing |
| library detection | `three r178, gsap 3.12.5, anime.js` |
| 8000 ms animation captured as a 2 s slice | 21 samples at 10 fps, tx 0→300 px |
| same motion, different skin | `--level motion` passes (timing 0.00 s), `--level pixel` rejects it (99.55 %) |
| frames of different sizes | refused with `frame size differs: reference 1440x900, clone 800x600` |
| selector that does not exist | falls back to the viewport instead of hanging 30 s |
| 60 fps capture | 31 frames for 500 ms |
| `--level looks-nice` | rejected by name |

## Fuzz battery

`test/fuzz.mjs` is a fixed seed (`0x5eed`) over 766 generated checks, so any failure is reproducible: 120 argument-parser shapes, 100 numeric/boundary parsers, 100 random bezier curves and fit-recovery cases, 50 degenerate series (empty, flat, duplicate timestamps, `NaN`, `Infinity`, `MAX_VALUE`), 40 CLI invocations with bad input, and 6 real captures at the boundary (1 fps, duration 0, scale 2, 64×64 viewport, pre-roll, dark scheme).

The rule it enforces is narrow on purpose: no raw `TypeError`, `RangeError`, `Cannot read`, `NaN` or hang may ever reach the user. Every refusal has to be a named error.

It found six things the hand-written tests did not:

| found | fix |
|---|---|
| `--=` produced an empty option key | `--key=value` only splits when a key exists; a bare `--` or `--=` is positional |
| `--region 1,2,3` crashed inside `crop()` | region is validated with a named error |
| `--offset abc` produced `NaN` indices and an empty comparison | offset is validated as a finite frame number |
| `fit()` returned different object shapes depending on the input | `range` is present on both paths |
| `parseViewport("0x0")` and `parseClip("10,10,0,0")` were accepted | both refuse non-positive sizes |
| a selector that does not exist hung 30 s | `capture` reads the box with no wait and falls back to the viewport |

## Measured on a live site

`https://resend.com/` hero (`div.origin-center-left`), 36 frames at 25 fps, 544x410 px. Nothing was read from their CSS; the numbers below come from the frames and the track.

| | value |
|---|---|
| declared by the page | `hero-text-slide-up-fade`, 1000 ms, `ease-in-out`, `translateY(16px)` → 0, opacity 0 → 1, `fill: none` |
| recovered by `easing` | `ease-in-out cubic-bezier(0.42,0,0.58,1) over ~994 ms`, travel −16 px, delay 0, **rmse 0.0039** |
| copy measured against it | timing error **0.00 s** on start, end, duration and peak |
| pixel mismatch of that copy | 10.14 % — different words and a proprietary typeface, so the motion passes and the pixels do not. That is the motion-faithful level, and `compare` prints both numbers. |
| live noise floor, 2 captures | 3.72 % mean pixel mismatch, **0 s timing drift**, a constant 3 px layout shift |

That last row is the honest part: on a live page the clock is exact, the layout is not. Without the floor you would call a 3 px layout shift a difference in your copy.

The `fill: none` entrance is also the reason step 2 of the capture exists. On a slow load (this page takes ~60 s in software GL) that animation finishes and is dropped from `document.getAnimations()` before any tool can look at it. frameproof injects `animation-play-state: paused` before the page's own CSS runs, so the animation is still there at frame 0.

## Limits

- DOM, CSS and Web Animations. No WebGL/WebGPU trace and no shader extraction — that needs a different tool.
- Live URL, local file or localhost. Video and GIF input are not implemented yet.
- Worker clocks and iframe clocks are not controlled; canvases drawn from a worker will not be frame-exact.
- Fonts and rasterisation are only comparable on the same machine.
- A copy that is shifted by more than 2 frames is reported as a warning: auto-alignment hides that shift from the timing columns.

## Credit

The idea of verifying a cloned animation frame by frame comes from [reanimate](https://github.com/NiazMorshed2007/reanimate) by Niaz Morshed (MIT). frameproof is an independent implementation: no code is copied, it runs on Node without Bun, it steps the animations itself instead of recording video, and it adds the noise-floor measurement and the curve fitter.

## License

MIT — see [LICENSE](LICENSE).
