// gl.mjs — trace WebGL the way capture traces the DOM: shaders as compiled,
// every uniform value per frame, draw cadence, context attributes.
// Runs inside the page (hookSource) and outside it (summary / compare).

export const hookSource = `(() => {
  if (window.__fpgl) return;
  const state = {
    contexts: [], programs: [], shaders: {}, draws: 0, drawsPerFrame: 0,
    uniformValues: Object.create(null), errors: [],
  };
  window.__fpgl = state;
  const locName = new WeakMap();
  const progIndex = new WeakMap();

  const wrap = (proto) => {
    if (!proto) return;
    const g = proto.getUniformLocation;
    if (!g || g.__fpWrapped) return;
    proto.getUniformLocation = function (prog, name) {
      const loc = g.call(this, prog, name);
      if (loc) locName.set(loc, name);
      return loc;
    };
    proto.getUniformLocation.__fpWrapped = true;
    const setters = ["uniform1f","uniform1i","uniform2f","uniform3f","uniform4f","uniform1fv","uniform2fv","uniform3fv","uniform4fv","uniformMatrix3fv","uniformMatrix4fv"];
    for (const m of setters) {
      const orig = proto[m];
      if (!orig) continue;
      proto[m] = function (loc, ...args) {
        const name = loc && locName.get(loc);
        if (name) state.uniformValues[name] = args.map((a) => (ArrayBuffer.isView(a) ? Array.from(a) : a));
        return orig.call(this, loc, ...args);
      };
    }
    const ss = proto.shaderSource;
    if (ss) {
      proto.shaderSource = function (shader, src) {
        try { shader.__fpSrc = String(src).slice(0, 40000); } catch {}
        return ss.call(this, shader, src);
      };
    }
    const at = proto.attachShader;
    if (at) {
      proto.attachShader = function (program, shader) {
        try { (program.__fpShaders ?? (program.__fpShaders = [])).push(shader); } catch {}
        return at.call(this, program, shader);
      };
    }
    const lp = proto.linkProgram;
    if (lp) {
      proto.linkProgram = function (program) {
        const r = lp.call(this, program);
        try {
          const idx = state.programs.length;
          progIndex.set(program, idx);
          const own = program.__fpShaders ?? [];
          const verts = own.filter((sh) => sh && sh.__fpSrc && sh.__fpSrc.includes("gl_Position"));
          const vs = verts[0]?.__fpSrc;
          const fs = own.find((sh) => sh && sh.__fpSrc && !sh.__fpSrc.includes("gl_Position"))?.__fpSrc;
          const numActive = this.getProgramParameter(program, this.ACTIVE_UNIFORMS) || 0;
          const uniforms = [];
          for (let i = 0; i < numActive; i++) {
            const info = this.getActiveUniform(program, i);
            if (info) uniforms.push(info.name);
          }
          state.programs.push({ index: idx, hasVertex: !!vs, hasFragment: !!fs, uniforms });
          if (vs) state.shaders["p" + idx + ".vert"] = vs;
          if (fs) state.shaders["p" + idx + ".frag"] = fs;
        } catch (e) { state.errors.push(String(e).slice(0, 200)); }
        return r;
      };
    }
    const da = proto.drawArrays;
    if (da) proto.drawArrays = function (...a) { state.draws++; return da.apply(this, a); };
    const de = proto.drawElements;
    if (de) proto.drawElements = function (...a) { state.draws++; return de.apply(this, a); };
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = gc.call(this, type, attrs);
    if (ctx && /webgl/i.test(String(type)) && !ctx.__fpSeen) {
      ctx.__fpSeen = true;
      try {
        const gl = ctx;
        state.contexts.push({
          el: this,
          type: String(type),
          width: this.width, height: this.height,
          cssWidth: this.clientWidth, cssHeight: this.clientHeight,
          attrs: attrs ? JSON.parse(JSON.stringify(attrs)) : {},
          renderer: gl.getParameter(gl.RENDERER),
          vendor: gl.getParameter(gl.VENDOR),
          version: gl.getParameter(gl.VERSION),
          shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        });
      } catch (e) { state.errors.push(String(e).slice(0, 200)); }
    }
    return ctx;
  };
})();`;

/** Called inside the page once per frame: uniform snapshot + draw count. */
export async function collectFrame(page) {
  return page.evaluate(() => {
    const s = window.__fpgl;
    if (!s) return null;
    for (const c of s.contexts) {
      const el = c.el;
      if (el && (el.width !== c.width || el.height !== c.height)) { c.width = el.width; c.height = el.height; }
    }
    const u = {};
    for (const [k, v] of Object.entries(s.uniformValues)) u[k] = v;
    const draws = s.draws;
    s.draws = 0;
    s.frames = (s.frames ?? 0) + 1;
    return { uniforms: u, draws };
  });
}

const flat = (v) => {
  if (Array.isArray(v)) return v.flatMap(flat);
  return typeof v === "number" ? [v] : [];
};

/** Turn per-frame snapshots into channels with a kind, like the DOM track. */
export function channelsFrom(samples) {
  const names = new Set();
  for (const s of samples) for (const k of Object.keys(s.uniforms)) names.add(k);
  const channels = {};
  for (const name of names) {
    const series = samples.map((s) => ({ t: s.t, v: flat(s.uniforms[name] ?? []) }));
    const len = Math.max(...series.map((x) => x.v.length), 0);
    for (let i = 0; i < len; i++) {
      const vals = series.map((x) => (x.v[i] === undefined ? NaN : x.v[i])).filter((n) => Number.isFinite(n));
      if (!vals.length) continue;
      const min = Math.min(...vals), max = Math.max(...vals);
      const key = len > 1 ? `${name}[${i}]` : name;
      const times = series.filter((x) => x.v[i] !== undefined).map((x) => x.t);
      const changing = times.filter((t, idx, arr) => idx > 0 && series[idx].v[i] !== series[idx - 1].v[i]);
      const kind = !changing.length ? "constant" : max - min < 1e-9 ? "constant" : "animated";
      channels[key] = {
        kind, min, max, range: max - min,
        firstChangeMs: changing.length ? Math.round(times[0]) : null,
        lastChangeMs: changing.length ? Math.round(times[times.length - 1]) : null,
        samples: series.map((x) => [Math.round(x.t), x.v[i] ?? null]),
      };
    }
  }
  return channels;
}

export function summarize(dir, glArtifacts) {
  const { gl, shaders, samples, channels } = glArtifacts;
  const ctx = gl.contexts?.[0];
  const animated = Object.entries(channels).filter(([, c]) => c.kind === "animated");
  const lines = [];
  lines.push(`# GPU trace: ${dir}`);
  lines.push("");
  lines.push(`${gl.contexts.length} context(s) · ${gl.programs.length} program(s) · ${samples.length} frames · draws/frame ${(samples.reduce((s, x) => s + x.draws, 0) / Math.max(1, samples.length)).toFixed(1)}`);
  lines.push("");
  lines.push("## Context");
  if (ctx) {
    lines.push(`- ${ctx.type} ${ctx.width}x${ctx.height} (css ${ctx.cssWidth}x${ctx.cssHeight})`);
    lines.push(`- renderer: ${ctx.renderer}`);
    lines.push(`- version: ${ctx.version} · ${ctx.shadingLanguage}`);
    lines.push(`- attrs: ${JSON.stringify(ctx.attrs)}`);
  } else lines.push("- none");
  lines.push("");
  lines.push("## Programs (shaders in gl/shaders/)");
  for (const p of gl.programs.slice(0, 24)) {
    const anim = p.uniforms.filter((u) => channels[u]?.kind === "animated");
    const first = anim.slice(0, 4).map((u) => `${u} ${channels[u].min.toFixed(2)}→${channels[u].max.toFixed(2)}`);
    lines.push(`- p${p.index}: ${p.uniforms.length} uniforms · ${anim.length} animated${first.length ? " — " + first.join(", ") : ""}`);
  }
  if (gl.programs.length > 24) lines.push(`- … ${gl.programs.length - 24} more in gl/gl.json`);
  lines.push("");
  lines.push("## Channels");
  lines.push(`- ${animated.length} animated of ${Object.keys(channels).length}`);
  for (const [k, c] of animated.slice(0, 12)) {
    lines.push(`- ${k} · ${c.min.toFixed(3)} → ${c.max.toFixed(3)} · ${c.firstChangeMs}–${c.lastChangeMs} ms`);
  }
  return { text: lines.join("\n") + "\n", animatedCount: animated.length, shaderCount: Object.keys(shaders).length };
}

// ---------------------------------------------------------------- gl compare

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Compare two GPU traces channel by channel. Same contract as the DOM compare. */
export function compareGl(refGl, cloneGl, { maxTimingMs = 80, maxValuePct = 2 } = {}) {
  const ref = refGl.channels ?? {};
  const clone = cloneGl.channels ?? {};
  const rows = [];
  for (const [name, rc] of Object.entries(ref)) {
    const cc = clone[name];
    if (!cc) { rows.push({ name, status: "missing", detail: `channel ${name} is absent in the clone` }); continue; }
    if (rc.kind === "constant" && cc.kind === "constant") {
      const d = Math.abs((rc.min ?? 0) - (cc.min ?? 0));
      const scale = Math.max(1e-6, Math.abs(rc.min ?? 0));
      const ok = d / scale <= maxValuePct / 100;
      rows.push({ name, status: ok ? "match" : "value", detail: `${rc.min} vs ${cc.min}` });
      continue;
    }
    const timing = {
      firstChange: (cc.firstChangeMs ?? 0) - (rc.firstChangeMs ?? 0),
      lastChange: (cc.lastChangeMs ?? 0) - (rc.lastChangeMs ?? 0),
    };
    const timingOk = Math.abs(timing.firstChange) <= maxTimingMs && Math.abs(timing.lastChange) <= maxTimingMs;
    // value error against the reference's own range, so a big channel is not
    // forgiven and a tiny one is not punished by a unit-scale threshold
    const range = Math.max(1e-6, rc.range ?? 0);
    let worst = 0, at = null;
    const cmap = new Map(cc.samples.map(([t, v]) => [t, v]));
    for (const [t, v] of rc.samples) {
      const w = cmap.get(t);
      if (v === null || w === null || w === undefined) continue;
      const d = Math.abs(v - w) / range;
      if (d > worst) { worst = d; at = t; }
    }
    const valueOk = worst <= maxValuePct / 100;
    rows.push({
      name,
      status: timingOk && valueOk ? "match" : timingOk ? "value" : "timing",
      detail: `worst ${(worst * 100).toFixed(2)}% of range${at !== null ? ` @${at}ms` : ""} · first change ${timing.firstChange >= 0 ? "+" : ""}${timing.firstChange}ms · last change ${timing.lastChange >= 0 ? "+" : ""}${timing.lastChange}ms`,
      timing,
      worstValuePct: worst * 100,
    });
  }
  const extra = Object.keys(clone).filter((k) => !(k in ref));
  const mismatched = rows.filter((r) => r.status !== "match");
  return {
    pass: mismatched.length === 0 && extra.length === 0,
    counts: { channels: rows.length, matched: rows.length - mismatched.length, mismatched: mismatched.length, extraInClone: extra.length },
    mismatched: mismatched.slice(0, 40),
    extraInClone: extra.slice(0, 20),
    rows,
  };
}
