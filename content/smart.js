// BrowserDarkMode — Smart Mode engine
// Analyzes the page's actual computed colors and restyles elements directly,
// instead of applying a CSS filter.
//
// Bundle architecture: we never map individual hex values. Every color is
// classified into one of four collections (surface / text / mid / accent)
// based on its HSL properties, and each bundle owns a single transform rule
// that produces the dark counterpart. A memo cache guarantees each unique
// color is transformed exactly once. Colors we've never seen still land in
// the right bundle automatically.
//
//   surface (light, desaturated) -> dark surfaces   (#fff -> near-black ramp)
//   text    (dark,  desaturated) -> light text      (#111 -> near-white ramp)
//   mid     (other  desaturated) -> inverted lightness
//   accent  (saturated)          -> hue kept, lightness lifted for dark bg
//
// Anti-flicker invariant: we only ever transform ORIGINAL colors. Each
// element's computed colors are captured the first time we touch it; every
// later pass re-applies from that cache instead of re-reading computed
// styles (which would return our own output and oscillate dark -> light).
//
// Colors are applied as inline !important styles on each element; a
// MutationObserver re-runs the pass (debounced) as the page changes.

(() => {
  const SMART_DEFAULTS = {
    enabled: true,
    mode: "filter", // "filter" | "smart"
    allowedSites: [],
  };

  const STYLE_ID = "bdm-smart-base";
  // Per-pass budget for styling NEW (never-touched) elements. Already-styled
  // elements are skipped during the walk for free, so this cap can never
  // starve any region of the page — worst case, later passes cover the rest.
  const MAX_NEW_NODES = 3000;
  // Offscreen elements are styled lazily once they approach the viewport.
  // Must match the margin used by isNearViewport().
  const VIEWPORT_MARGIN = "100% 0px";
  const RETRY_DELAYS = [0, 100, 300, 700, 1500];
  const SKIP_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "AUDIO", "PICTURE", "SOURCE", "IFRAME", "EMBED", "OBJECT", "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "BR", "TEMPLATE"]);
  // Longhands only: getComputedStyle does not reliably resolve the
  // "border-color" shorthand, so we ask for each side explicitly.
  const BG_PROPS = [
    "background-color",
    "color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
  ];

  const state = {
    active: false,
    observer: null,
    viewportObserver: null,
    passTimer: null,
    retryTimers: [],
    observing: false,
    hidden: false,          // tab not visible -> observers paused
    pendingRescan: false,   // DOM content changed -> walk for new elements
    scannedOnce: false,
  };

  const OBSERVE_OPTS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  };

  // Elements whose style/class the site rewrote after our pass -> re-apply
  // our mapping from the originals cache (targeted, not page-wide).
  const pendingRestyle = new Set();

  const touched = new Set();           // elements we restyled at least once
  const originalStyle = new WeakMap(); // element -> style attribute before first touch
  const originalProps = new WeakMap(); // element -> { prop -> original computed value }
  const transformCache = new Map();    // css color string -> mapped css color
  const bundleCache = new Map();       // hsl key -> bundle id

  // ---------------------------------------------------------------------------
  // Color utilities
  // ---------------------------------------------------------------------------

  // Computed styles always report rgb()/rgba() (or "transparent" etc.).
  function parseColor(str) {
    if (!str) return null;
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[/,\s]+([\d.]+))?\s*\)/.exec(str);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (alpha === 0) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
  }

  function toHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h, s, l };
  }

  function hslToRgb({ h, s, l }) {
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return {
      r: hue2rgb(h + 1 / 3) * 255,
      g: hue2rgb(h) * 255,
      b: hue2rgb(h - 1 / 3) * 255,
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------------------------------------------------------------------------
  // Bundles: classification + transform
  // ---------------------------------------------------------------------------

  const BUNDLES = [
    {
      id: "surface",
      match: (hsl) => hsl.s <= 0.18 && hsl.l >= 0.55,
      // Light band [0.55..1] -> dark band [0.28..0.04]; keep a hint of tint.
      transform: (hsl) => ({ h: hsl.h, s: hsl.s * 0.5, l: 0.04 + (1 - hsl.l) * (0.24 / 0.45) }),
    },
    {
      id: "text",
      match: (hsl) => hsl.s <= 0.18 && hsl.l <= 0.28,
      // Dark band [0..0.28] -> bright text [0.99..0.85].
      transform: (hsl) => ({ h: hsl.h, s: hsl.s * 0.4, l: 0.85 + (0.28 - hsl.l) * 0.5 }),
    },
    {
      id: "mid",
      match: (hsl) => hsl.s <= 0.18,
      // Mid grays: plain lightness inversion, keeps relative ordering readable.
      transform: (hsl) => ({ h: hsl.h, s: hsl.s * 0.7, l: clamp(1 - hsl.l, 0.15, 0.85) }),
    },
    {
      id: "accent",
      match: () => true,
      // Saturated colors: keep hue, lift lightness into a readable-on-dark band.
      transform: (hsl) => ({ h: hsl.h, s: Math.min(1, hsl.s * 1.05), l: clamp(1 - hsl.l, 0.35, 0.8) }),
    },
  ];

  function classify(hsl) {
    const key = `${hsl.h.toFixed(3)}|${hsl.s.toFixed(3)}|${hsl.l.toFixed(3)}`;
    let id = bundleCache.get(key);
    if (id === undefined) {
      id = BUNDLES.find((b) => b.match(hsl)).id;
      bundleCache.set(key, id);
    }
    return id;
  }

  function mapColor(cssColor) {
    if (transformCache.has(cssColor)) return transformCache.get(cssColor);
    const rgb = parseColor(cssColor);
    let out = cssColor; // unmappable -> leave as-is
    if (rgb) {
      const hsl = toHsl(rgb);
      const bundle = BUNDLES.find((b) => b.id === classify(hsl));
      const mapped = hslToRgb(bundle.transform(hsl));
      out = `rgba(${Math.round(mapped.r)}, ${Math.round(mapped.g)}, ${Math.round(mapped.b)}, ${rgb.a})`;
    }
    transformCache.set(cssColor, out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Apply pass
  // ---------------------------------------------------------------------------

  function styleElement(el, cs) {
    const props = el instanceof SVGElement ? ["fill", "stroke"] : BG_PROPS;
    const originals = originalProps.get(el);

    if (originals) {
      // Repeat pass: re-apply from the cached ORIGINAL values. Never re-read
      // computed styles here — they would return our own inline !important
      // output, which would get re-mapped and oscillate dark <-> light.
      for (const prop of props) {
        const value = originals[prop];
        if (value === undefined) continue;
        const mapped = mapColor(value);
        if (mapped !== value) el.style.setProperty(prop, mapped, "important");
      }
      return;
    }

    // First touch: capture the element's true computed colors.
    const isHidden = cs.display === "none" || cs.visibility === "hidden";
    const captured = {};
    let modified = false;

    if (!isHidden) {
      for (const prop of props) {
        const value = cs.getPropertyValue(prop);
        captured[prop] = value;
        if (!value || value === "none" || parseColor(value) === null) continue;
        const mapped = mapColor(value);
        if (mapped !== value) {
          if (!modified) {
            modified = true;
            originalStyle.set(el, el.getAttribute("style"));
          }
          el.style.setProperty(prop, mapped, "important");
        }
      }
    }

    if (modified) {
      originalProps.set(el, captured);
      touched.add(el);
    }
  }

  function runPass() {
    if (!state.active || !document.documentElement || state.hidden) return;

    state.observing = false;
    state.observer?.disconnect(); // our own writes must not re-trigger us

    // 1) Targeted re-application: elements whose style/class the site rewrote.
    for (const el of pendingRestyle) {
      if (el.isConnected && touched.has(el)) styleElement(el);
    }
    pendingRestyle.clear();

    // 2) Rescan for new (never-touched) elements, budget-limited. Touched
    //    elements are skipped via a Set lookup, so the budget only pays for
    //    genuinely new content — no region of the page can be starved.
    //    Offscreen elements are deferred to the viewport observer instead of
    //    being styled now (the biggest win of the two lazy-styling changes).
    let budget = MAX_NEW_NODES;
    const batch = [];
    const deferred = []; // offscreen -> styled lazily when they scroll near
    if (state.pendingRescan || !state.scannedOnce) {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (SKIP_TAGS.has(el.tagName) || touched.has(el)) continue;
        if (state.viewportObserver && !isNearViewport(el)) {
          deferred.push(el);
          continue;
        }
        batch.push(el);
        if (--budget <= 0) break;
      }
    }
    state.pendingRescan = false;
    state.scannedOnce = true;

    // Sample base tokens from pre-write colors of not-yet-touched elements.
    let bg = null, fg = null, bgL = 2, fgL = -1;
    for (const el of batch) {
      const cs = getComputedStyle(el);
      const bgC = parseColor(cs.getPropertyValue("background-color"));
      if (bgC && bgC.a > 0.5) {
        const l = toHsl(bgC).l;
        if (l < bgL) { bgL = l; bg = `rgb(${bgC.r}, ${bgC.g}, ${bgC.b})`; }
      }
      const fgC = parseColor(cs.getPropertyValue("color"));
      if (fgC && fgC.a > 0.5) {
        const l = toHsl(fgC).l;
        if (l > fgL) { fgL = l; fg = `rgb(${fgC.r}, ${fgC.g}, ${fgC.b})`; }
      }
      styleElement(el, cs);
    }

    // Offscreen elements: watch until they approach the viewport, then style.
    for (const el of deferred) state.viewportObserver?.observe(el);
    if (batch.length || deferred.length) {
      injectBaseStyle({ bg: bg ? mapColor(bg) : null, fg: fg ? mapColor(fg) : null });
    }

    state.observing = true;
    state.observer?.observe(document.documentElement, OBSERVE_OPTS);
  }

  // Generic fallbacks so the page is dark even before/without per-element passes.
  function injectBaseStyle(tokens) {
    let el = document.getElementById(STYLE_ID);
    if (el) return;
    if (!document.head && !document.documentElement) return;

    el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = `
:root {
  --bdm-bg: ${tokens.bg ?? "#101114"};
  --bdm-fg: ${tokens.fg ?? "#e6e6e9"};
}
html { background-color: var(--bdm-bg) !important; }
body { background-color: transparent !important; color: var(--bdm-fg) !important; }
::selection { background: #3a4a6b !important; color: #fff !important; }
`;
    (document.head || document.documentElement).appendChild(el);
  }

  function schedulePass() {
    // While the tab is hidden, mutations accumulate but passes stay paused;
    // on return we run one catch-up pass (visibilitychange handler).
    if (state.hidden) return;
    clearTimeout(state.passTimer);
    state.passTimer = setTimeout(runPass, 250);
  }

  // ---------------------------------------------------------------------------
  // Viewport-gated lazy styling
  // ---------------------------------------------------------------------------

  // Elements offscreen by more than the margin return false and are deferred
  // to the IntersectionObserver instead of being styled during the pass.
  function isNearViewport(el) {
    const r = el.getBoundingClientRect();
    const margin = innerHeight; // 100% above/below
    return r.bottom >= -margin && r.top <= innerHeight + margin;
  }

  function ensureViewportObserver() {
    if (state.viewportObserver || !("IntersectionObserver" in globalThis)) return;
    state.viewportObserver = new IntersectionObserver((entries) => {
      state.observing = false;
      for (const entry of entries) {
        state.viewportObserver.unobserve(entry.target);
        if (entry.isIntersecting && !touched.has(entry.target) && state.active) {
          styleElement(entry.target, getComputedStyle(entry.target));
        }
      }
      state.observing = true;
    }, { rootMargin: VIEWPORT_MARGIN });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function activate() {
    state.active = true;
    ensureViewportObserver();
    state.observer = new MutationObserver((mutations) => {
      if (!state.observing) return;
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes.length) {
          // New content (feed items, modals, re-rendered boxes):
          // flag a rescan so the next pass walks for never-touched elements.
          state.pendingRescan = true;
        } else if (m.type === "attributes") {
          // The site rewrote a touched element's style/class after our pass
          // -> re-apply ours from the originals cache (targeted, page untouched).
          if (touched.has(m.target)) pendingRestyle.add(m.target);
        }
      }
      schedulePass();
    });

    const start = () => {
      for (const delay of RETRY_DELAYS) {
        state.retryTimers.push(setTimeout(runPass, delay));
      }
      state.observing = true;
      state.observer.observe(document.documentElement, OBSERVE_OPTS);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  function deactivate() {
    state.active = false;
    state.observer?.disconnect();
    state.observer = null;
    state.viewportObserver?.disconnect();
    state.viewportObserver = null;
    state.observing = false;
    clearTimeout(state.passTimer);
    for (const t of state.retryTimers) clearTimeout(t);
    state.retryTimers = [];
    pendingRestyle.clear();

    // Restore every element's pre-extension inline style.
    for (const el of touched) {
      const original = originalStyle.get(el);
      if (original === undefined || original === null) el.removeAttribute("style");
      else el.setAttribute("style", original);
    }
    touched.clear();
    document.getElementById(STYLE_ID)?.remove();
  }

  async function sync() {
    const settings = await chrome.storage.sync.get(SMART_DEFAULTS);
    const { enabled, mode, allowedSites } = settings;
    const shouldBeActive = enabled && mode === "smart" && allowedSites.includes(location.hostname);
    if (shouldBeActive && !state.active) activate();
    else if (!shouldBeActive && state.active) deactivate();
    else if (shouldBeActive) schedulePass(); // already on; refresh anyway (cheap)
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") sync();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SETTING_CHANGED") sync();
  });

  // Pause all work while the tab is hidden (sustained CPU/battery tax);
  // one catch-up pass runs when the tab becomes visible again.
  document.addEventListener("visibilitychange", () => {
    state.hidden = document.visibilityState === "hidden";
    if (state.active) {
      if (state.hidden) {
        clearTimeout(state.passTimer);
      } else {
        schedulePass();
      }
    }
  });

  sync();
})();
