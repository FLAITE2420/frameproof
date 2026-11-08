#!/usr/bin/env node
// frameproof CLI
import { captureMain } from "./capture.mjs";
import { compareMain } from "./compare.mjs";
import { easingMain } from "./easing.mjs";
import { noisefloorMain } from "./noisefloor.mjs";
import { sheetMain } from "./sheet.mjs";

const USAGE = `frameproof — capture, measure and prove web animation

  frameproof capture     record frames, spec and per-frame track of a page
  frameproof compare     does the copy move the same as the reference?
  frameproof easing      name the curve of a tracked property
  frameproof noisefloor  how repeatable is a capture of this page?
  frameproof sheet       labelled contact sheets (filmstrip / compare)

  frameproof <command> --help
`;

const [, , cmd, ...rest] = process.argv;
const table = {
  capture: captureMain,
  compare: compareMain,
  easing: easingMain,
  noisefloor: noisefloorMain,
  sheet: sheetMain,
};

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(USAGE.trim());
  process.exit(0);
}
const fn = table[cmd];
if (!fn) {
  console.error(`unknown command "${cmd}"\n`);
  console.log(USAGE.trim());
  process.exit(2);
}
try {
  const code = await fn(rest);
  process.exit(code ?? 0);
} catch (e) {
  console.error(`frameproof ${cmd}: ${e?.message ?? e}`);
  process.exit(1);
}
