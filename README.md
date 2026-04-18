# MeetSnap — Google Meet Screenshot Extension

> Capture, auto-download, and optionally forward Google Meet screenshots to
> a Discord webhook for review and moderation.
>
> **Created by [@chqrlzz](https://github.com/chqrlzz)**

---

## Table of contents

1. [Project overview](#project-overview)
2. [Features](#features)
3. [Privacy](#privacy)
4. [Discord webhook](#discord-webhook)
5. [Installation — manual](#installation--manual)
6. [Installation — enterprise / multi-profile](#installation--enterprise--multi-profile)
7. [Keyboard shortcut](#keyboard-shortcut)
8. [File structure](#file-structure)
9. [Configuration](#configuration)
10. [Credits](#credits)

---

## Project overview

MeetSnap is a Chrome Manifest V3 extension that adds a floating camera button
to every `meet.google.com` page. Clicking it (or pressing the keyboard shortcut)
captures the visible tab, silently downloads a timestamped PNG, and optionally
sends the image and session metadata to a Discord webhook for review.

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
| Toast notifications | Success, warning, and error feedback |
| Discord webhook | Optional — user-toggleable — fully disclosed |
| Rate limiting | Max 1 screenshot per 2 seconds |
| Session counter | Count resets when Meet tab is closed |
| Onboarding tooltip | Shown once on first install |
| Keyboard shortcut | Default `Ctrl+Shift+S` — configurable |
| Reduced motion | Respects `prefers-reduced-motion` |
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

No data is ever sent anywhere other than the Discord webhook described below,
and only when the user has the webhook toggle enabled.

---

## Discord webhook

When the **Discord webhook upload** toggle is **enabled** (the default), MeetSnap
sends the following data to the configured Discord channel on every screenshot:

- The screenshot image (PNG attachment)
- The timestamp of the capture (ISO 8601)
- The Google Meet URL
- The browser user agent string

**Purpose:** screenshot review, inappropriate content detection, and
usage analysis by the Discord channel administrator.

**To disable:** toggle off "Discord webhook upload" in the extension popup at
any time. Screenshots will still be downloaded locally — nothing is sent
to Discord.

**To configure your own webhook:**

1. Open `background.js`
2. Replace `YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN` with your actual Discord
   webhook URL in the `DISCORD_WEBHOOK_URL` constant at the top of the file.

---

## Installation — manual

### Prerequisites

- Google Chrome (or any Chromium-based browser with extension developer mode)
- No build tools, no Node.js, no npm required

### Steps

**1. Download the source**

```bash
git clone https://github.com/chqrlzz/meetsnap.git
```

Or download the ZIP from the GitHub releases page and extract it.

**2. Generate the PNG icons**

Open `icons/create-icons.html` in Chrome (drag the file into a new tab).
Click **Download All Icons**. Move the three downloaded files:

```
icon16.png  → icons/icon16.png
icon48.png  → icons/icon48.png
icon128.png → icons/icon128.png
```

**3. Configure the Discord webhook (optional)**

Open `background.js` and replace:

```js
const DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN";
```

with your actual Discord webhook URL. If you skip this step, screenshots
will be downloaded locally and webhook delivery will be silently skipped.

**4. Load the unpacked extension**

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `google-meet-meetsnap/` folder

The MeetSnap icon will appear in your toolbar. Navigate to any
`meet.google.com` meeting to activate it.

---

## Installation — enterprise / multi-profile

### Option A: CRX via GitHub Releases

Replace `YOUR_GITHUB_USERNAME` and `YOUR_REPO` before running:

```bash
curl -L https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO/releases/latest/download/meetsnap.crx \
  -o meetsnap.crx
```

Then open `chrome://extensions`, drag the `.crx` file onto the page, and
confirm the install.

### Option B: Group Policy auto-install (enterprise)

Package the extension as a `.crx` and host it on an internal server with an
`update.xml` manifest. Then push the following to managed Chrome profiles
via your MDM or GPO:

```json
{
  "ExtensionInstallForcelist": [
    "EXTENSION_ID;https://your-internal-host/meetsnap/update.xml"
  ]
}
```

Full documentation:
https://support.google.com/chrome/a/answer/187202

### Option C: Load unpacked via startup flag (CI / automation)

```bash
google-chrome \
  --load-extension=/path/to/google-meet-meetsnap \
  --no-first-run
```

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
├── background.js           Service worker — capture, download, webhook
├── content.js              Content script — floating UI, drag, toasts
├── styles.css              Content script stylesheet
├── popup.html              Extension popup markup
├── popup.js                Extension popup logic
├── icons/
│   ├── icon.svg            Source SVG for icon generation
│   ├── create-icons.html   Open in Chrome to generate PNG icons
│   ├── icon16.png          (generated)
│   ├── icon48.png          (generated)
│   └── icon128.png         (generated)
├── website/
│   ├── index.html          Project website
│   └── styles.css          Website stylesheet
└── README.md               This file
```

---

## Configuration

All user-facing settings are accessible via the extension popup and
persisted to `chrome.storage.local`. For developer configuration,
only one value requires editing before deployment:

| Location | Constant | Purpose |
|---|---|---|
| `background.js` line 13 | `DISCORD_WEBHOOK_URL` | Discord webhook endpoint |

---

## Credits

**MeetSnap** was created by **[@chqrlzz](https://github.com/chqrlzz)**.

- No third-party libraries
- No analytics
- No external dependencies
- Pure Chrome Extension APIs only
