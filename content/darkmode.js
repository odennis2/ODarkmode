// BrowserDarkMode — content script
// Runs on every page at document_start. Injects a filter-based dark mode
// stylesheet before first paint, and reacts live to setting changes.

const DEFAULTS = {
  enabled: true,
  mode: "filter", // "filter" | "smart"
  brightness: 100,
  contrast: 100,
  allowedSites: [],
};

const STYLE_ID = "bdm-style";

function styleText({ brightness, contrast }) {
  return `
html {
  filter: invert(1) hue-rotate(180deg) brightness(${brightness / 100}) contrast(${contrast / 100});
  background: #fff;
}
img, video, picture, canvas, iframe, embed, object {
  filter: invert(1) hue-rotate(180deg);
}
`;
}

function applyStyle(settings) {
  const { enabled, mode, brightness, contrast, allowedSites } = settings;
  const host = location.hostname;
  const active = enabled && mode === "filter" && allowedSites.includes(host);

  let el = document.getElementById(STYLE_ID);
  if (!active) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = styleText({ brightness, contrast });
}

async function init() {
  // Storage may not be readable super early at document_start on some pages;
  // apply what we can now, then re-apply once storage answers.
  applyStyle(DEFAULTS);
  applyStyle(await chrome.storage.sync.get(DEFAULTS));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") init();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SETTING_CHANGED") init();
});

init();
