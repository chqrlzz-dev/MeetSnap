# MeetSnap — Google Meet Screenshot Extension

> Capture and auto-download Google Meet screenshots with smart watermarking and diagnostic insights.
>
> **Created by [@chqrlzz](https://github.com/chqrlzz)**

---

## Table of contents

1. [Project overview](#project-overview)
2. [Features](#features)
3. [Privacy](#privacy)
4. [Diagnostic Data](#diagnostic-data)
5. [Installation](#installation)
6. [Keyboard shortcut](#keyboard-shortcut)
7. [File structure](#file-structure)
8. [Credits](#credits)

---

## Project overview

MeetSnap is a Chrome Manifest V3 extension that adds a floating camera button
to every `meet.google.com` page. Clicking it (or pressing the keyboard shortcut)
captures the visible tab, applies a dynamic watermark, and silently downloads a 
timestamped PNG.

MeetSnap activates **only** on Google Meet tabs. It has no effect on any other
website or browser tab.

---

## Features

| Feature | Description |
|---|---|
| Instant capture | One click or `Ctrl+Shift+S` |
| Auto-download | Timestamped PNG — `google-meet-YYYY-MM-DD_HH-MM-SS.png` |
| Floating button | Draggable, snap-to-edge, position remembered |
| Shutter sound | Web Audio API synthesis — no audio files required |
| Screen flash | Full-viewport white burst on capture |
| **Smart Watermark** | **Date, time, and logo overlay (e.g., "June 18, 2026 at 12:45 PM by [logo] MeetSnap")** |
| **Auto Tiled Layout**| **Automatically switches Meet to Tiled layout during capture** |
| Toast notifications | Success, warning, and error feedback |
| Diagnostic Data | Optional session metadata for quality analysis |
| Rate limiting | Max 1 screenshot per 2 seconds |
| Session counter | Count resets when Meet tab is closed |
| WCAG 2.1 AA | Full keyboard navigation and ARIA support |

---

## Privacy

MeetSnap is designed with minimal data collection as a core principle.

**MeetSnap does NOT:**

- Record audio or video
- Perform background or continuous capture
- Use analytics SDKs or third-party libraries
- Store screenshots locally after download
- Access any tab that is not the active Google Meet tab
- Track usage, behaviour, or identity

**Local storage keys used:**

| Key | Contents | Purpose |
|---|---|---|
| `meetsnap_settings` | Toggle states | Persist user preferences |
| `meetsnap_position` | x / y coordinates | Remember button position |
| `meetsnap_onboarding_shown` | Boolean | Suppress first-run tooltip |

No data is ever sent anywhere other than the diagnostic endpoint (if configured),
and only when the user has the diagnostic toggle enabled.

---

## Diagnostic Data

When the **Send Diagnostic Data** toggle is **enabled**, MeetSnap
may include technical metadata with the capture for session quality analysis:

- The timestamp of the capture (ISO 8601)
- The Google Meet URL
- The browser user agent string

**To disable:** toggle off "Send Diagnostic Data" in the extension popup at
any time. Screenshots will still be downloaded locally.

---

## Installation

### Steps

**1. Download the source**

```bash
git clone https://github.com/chqrlzz/meetsnap.git
```

**2. Load the unpacked extension**

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `google-meet-meetsnap/` folder

The MeetSnap icon will appear in your toolbar. Navigate to any
`meet.google.com` meeting to activate it.

---

## Keyboard shortcut

The default shortcut is **`Ctrl+Shift+S`** (Windows/Linux) or
**`Cmd+Shift+S`** (macOS).

To change it:

1. Open `chrome://extensions/shortcuts`
2. Find **MeetSnap — Google Meet Screenshot**
3. Click the pencil icon next to "Capture a screenshot of the active Google Meet"
4. Press your desired key combination

---

## File structure

```
google-meet-meetsnap/
├── manifest.json           Chrome Manifest V3 declaration
├── background.js           Service worker — capture, download, watermark
├── content.js              Content script — floating UI, drag, layout logic
├── styles.css              Content script stylesheet
├── popup.html              Extension popup markup
├── popup.js                Extension popup logic
├── icons/                  Brand assets
└── website/                Project website
```

---

## Credits

**MeetSnap** was created by **[@chqrlzz](https://github.com/chqrlzz)**.

- No third-party libraries
- No analytics
- No external dependencies
- Pure Chrome Extension APIs only
