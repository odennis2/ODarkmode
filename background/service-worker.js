// BrowserDarkMode — MV3 service worker
// Handles install, startup, and cross-tab coordination.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Seed default settings on first install. Whitelist model: dark mode is
    // off on all sites until the user enables it per site.
    chrome.storage.sync.get({ enabled: true, mode: "filter", brightness: 100, contrast: 100, allowedSites: [] }).then((defaults) => {
      chrome.storage.sync.set(defaults);
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Reserved for future startup logic (e.g., re-applying state to open tabs).
});
