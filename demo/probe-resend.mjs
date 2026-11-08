import { chromium } from "playwright";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://resend.com/", { waitUntil: "load", timeout: 90000 });
await p.waitForTimeout(2500);

const info = await p.evaluate(() => {
  const el = document.querySelector("div.origin-center-left");
  if (!el) return { error: "not found", candidates: [...document.querySelectorAll("div[class*='origin-center']")].length };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const kids = [...el.querySelectorAll("*")].slice(0, 12).map((k) => ({
    tag: k.tagName.toLowerCase() + (k.className && typeof k.className === "string" ? "." + k.className.split(" ").slice(0, 2).join(".") : ""),
    text: (k.textContent || "").trim().slice(0, 80),
    anim: getComputedStyle(k).animationName,
    transform: getComputedStyle(k).transform,
  }));
  return {
    box: { x: r.x, y: r.y, w: r.width, h: r.height },
    text: el.innerText,
    html: el.outerHTML.slice(0, 2000),
    style: {
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color,
      textAlign: cs.textAlign, background: cs.backgroundColor,
    },
    kids,
    pageBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log(JSON.stringify(info, null, 1).slice(0, 4000));
await p.screenshot({ path: "demo/resend-hero.png", clip: info.box ? { x: info.box.x - 40, y: info.box.y - 40, width: info.box.w + 80, height: info.box.h + 80 } : undefined });
await b.close();
