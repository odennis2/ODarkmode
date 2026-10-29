# BrowserDarkMode

A dark mode web browser extension for Chrome (Manifest V3).

## Structure

```
manifest.json            MV3 manifest — metadata, permissions, entry points
background/service-worker.js   Extension lifecycle (install, startup)
content/darkmode.js      Filter engine (CSS inversion)
content/smart.js         Smart engine (computed-color analysis + restyle)
popup/                   Toolbar popup (toggle, mode, sliders, per-site)
icons/                   Toolbar + store icons (16/32/48/128 px)
```

## Development

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension to the toolbar

## Features

- **Two engines**: Filter (`invert(1) hue-rotate(180deg)`, media re-inverted)
  and Smart (samples computed colors, restyles elements directly via a
  bundle-based color transform — see `PLAN.md`)
- **Whitelist model**: dark mode is off everywhere by default; enable it per
  site from the popup
- **Master on/off toggle** and **mode selector** (Filter / Smart) in the popup
- **Brightness & contrast sliders** (filter mode)
- Live-updates on every setting change

## Storage model

- `chrome.storage.sync` keys: `enabled`, `mode` (`"filter"` | `"smart"`),
  `brightness`, `contrast`, `allowedSites` (hostname whitelist).
- Content scripts also listen for `SETTING_CHANGED` messages for instant updates.

See `PLAN.md` for architecture notes and future ideas.

## Status

- [x] Base MV3 scaffolding
- [x] Filter engine (CSS inversion)
- [x] Popup controls (toggle, mode, sliders, per-site whitelist)
- [x] Smart engine v1 (bundle-based color analysis)
- [ ] Polish: icon design, store listing, smart-mode tuning
