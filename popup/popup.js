// ODarkMode — popup logic
// Whitelist model: dark mode is OFF on all sites by default; the site button
// turns it ON for the current site. Also handles master toggle, mode
// (filter/smart), and filter-mode-only brightness/contrast sliders,
// all backed by chrome.storage.sync.

const DEFAULTS = { enabled: true, mode: "filter", brightness: 100, contrast: 100, allowedSites: [] };

const els = {
  enabled: document.getElementById("enabled"),
  mode: document.getElementById("mode"),
  brightness: document.getElementById("brightness"),
  brightnessVal: document.getElementById("brightnessVal"),
  contrast: document.getElementById("contrast"),
  contrastVal: document.getElementById("contrastVal"),
  siteToggle: document.getElementById("siteToggle"),
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const persist = debounce((key, value) => chrome.storage.sync.set({ [key]: value }), 150);

// Broadcast to tabs so content scripts update instantly (storage.onChanged
// also fires, but this avoids any per-tab lag).
async function broadcast() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "SETTING_CHANGED" }).catch(() => {});
  }
}

async function currentHostname() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("http")) return null;
  return new URL(tab.url).hostname;
}

async function renderSiteToggle() {
  const host = await currentHostname();
  const { allowedSites } = await chrome.storage.sync.get(DEFAULTS);
  const allowed = host && allowedSites.includes(host);
  els.siteToggle.textContent = !host
    ? "N/A on this page"
    : allowed
      ? `Remove ${host} from list`
      : `Enable on ${host}`;
  els.siteToggle.disabled = !host;
}

els.enabled.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: els.enabled.checked });
  broadcast();
});

els.mode.addEventListener("change", async () => {
  await chrome.storage.sync.set({ mode: els.mode.value });
  document.body.classList.toggle("smart-mode", els.mode.value === "smart");
  broadcast();
});

// Sliders only affect filter mode.
for (const key of ["brightness", "contrast"]) {
  els[key].addEventListener("input", () => {
    els[`${key}Val`].textContent = `${els[key].value}%`;
    persist(key, Number(els[key].value));
  });
  els[key].addEventListener("change", broadcast);
}

els.siteToggle.addEventListener("click", async () => {
  const host = await currentHostname();
  if (!host) return;
  const { allowedSites } = await chrome.storage.sync.get(DEFAULTS);
  const next = allowedSites.includes(host)
    ? allowedSites.filter((h) => h !== host)
    : [...allowedSites, host];
  await chrome.storage.sync.set({ allowedSites: next });
  renderSiteToggle();
  broadcast();
});

document.addEventListener("DOMContentLoaded", async () => {
  const s = await chrome.storage.sync.get(DEFAULTS);
  els.enabled.checked = s.enabled;
  els.mode.value = s.mode;
  document.body.classList.toggle("smart-mode", s.mode === "smart");
  els.brightness.value = s.brightness;
  els.brightnessVal.textContent = `${s.brightness}%`;
  els.contrast.value = s.contrast;
  els.contrastVal.textContent = `${s.contrast}%`;
  renderSiteToggle();
});
