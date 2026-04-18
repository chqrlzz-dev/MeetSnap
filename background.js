// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture, auto-download, and Discord webhook delivery.
//
// This file runs as a Manifest V3 service worker and has no DOM access.
// All user-facing feedback is delegated to content.js via message passing.
// =============================================================================

// ---------------------------------------------------------------------------
// Configuration
// Replace DISCORD_WEBHOOK_URL with your actual Discord webhook before deploying.
// Webhook is used exclusively for screenshot review and moderation analysis.
// ---------------------------------------------------------------------------

const DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1495056511238406174/cKa-HhmUAXyV6_DcKWXyI-myo24hBtVyTmsJY3PRNSKiSH2ojg0RCG5rXBH5UGkrSUgW";

const SCREENSHOT_IMAGE_FORMAT = "png";
const SCREENSHOT_MIME_TYPE = "image/png";
const SCREENSHOT_FILENAME_PREFIX = "google-meet";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("website/index.html") });
  }
});

// ---------------------------------------------------------------------------
// Message routing
// All inbound requests from popup.js and content.js are dispatched here.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "captureScreenshot") {
    handleScreenshotRequestAsync(
      sender.tab,
      message.meetUrl,
      message.webhookEnabled,
    )
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, errorMessage: error.message }),
      );

    // Must return true so the message channel stays open for the async response.
    return true;
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcut forwarding
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot") {
    forwardShortcutToActiveTabAsync();
  }
});

// ---------------------------------------------------------------------------
// Screenshot pipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full screenshot lifecycle:
 *   1. Capture the visible tab
 *   2. Download the PNG to disk silently
 *   3. Optionally send to the Discord webhook
 *
 * @param {chrome.tabs.Tab} tab              The tab that sent the request.
 * @param {string}          meetUrl          The Google Meet URL at capture time.
 * @param {boolean}         webhookEnabled   Whether to forward the image to Discord.
 * @returns {Promise<{ success: boolean, filename?: string, errorMessage?: string }>}
 */
async function handleScreenshotRequestAsync(tab, meetUrl, webhookEnabled) {
  const imageDataUrl = await captureVisibleTabAsync(tab.windowId);
  const filename = buildScreenshotFilename();

  await downloadScreenshotAsync(imageDataUrl, filename);

  if (webhookEnabled && isWebhookConfigured()) {
    // Fire-and-forget — a webhook failure must never block the download.
    sendToDiscordWebhookAsync(imageDataUrl, filename, meetUrl).catch((error) =>
      console.warn(
        "MeetSnap: Discord webhook delivery failed —",
        error.message,
      ),
    );
  }

  return { success: true, filename };
}

/**
 * Captures the visible area of the given window as a base64 PNG data URL.
 *
 * @param {number} windowId
 * @returns {Promise<string>}
 */
async function captureVisibleTabAsync(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      { format: SCREENSHOT_IMAGE_FORMAT },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(dataUrl);
      },
    );
  });
}

/**
 * Triggers a silent browser download of the PNG — no save-dialog shown to the user.
 *
 * @param {string} imageDataUrl   Base64 PNG data URL.
 * @param {string} filename       Target filename with timestamp.
 * @returns {Promise<number>}     Download ID assigned by the browser.
 */
async function downloadScreenshotAsync(imageDataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: imageDataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Discord webhook delivery
// ---------------------------------------------------------------------------

/**
 * Sends the screenshot and session metadata to the configured Discord webhook.
 *
 * Payload format: multipart/form-data
 *   - file          PNG image attachment
 *   - payload_json  Discord message with timestamp, Meet URL, and user agent
 *
 * @param {string} imageDataUrl   Base64 PNG data URL.
 * @param {string} filename       Attachment filename shown in Discord.
 * @param {string} meetUrl        The Google Meet URL where the screenshot was taken.
 * @returns {Promise<void>}
 */
async function sendToDiscordWebhookAsync(imageDataUrl, filename, meetUrl) {
  // Use fetch to convert the data URL to a Blob — cleaner and more robust in MV3.
  const imageResponse = await fetch(imageDataUrl);
  const imageBlob = await imageResponse.blob();

  const messageContent = buildDiscordMessageContent(meetUrl);

  const formData = new FormData();
  formData.append("file", imageBlob, filename);
  formData.append("payload_json", JSON.stringify({ content: messageContent }));

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Discord responded with HTTP ${response.status}`);
  }
}

/**
 * Builds the text content block attached to the Discord webhook message.
 * Includes a human-readable timestamp, Meet URL, and browser user agent.
 *
 * @param {string} meetUrl
 * @returns {string}
 */
function buildDiscordMessageContent(meetUrl) {
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const userAgent = navigator.userAgent;

  return [
    `📸 **Diagnostic Data Captured**`,
    `**Timestamp:** \`${timestamp}\``,
    `**Meet URL:** ${meetUrl}`,
    `**Browser:** \`${userAgent}\``
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Filename generation
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable, collision-safe filename using the current timestamp.
 * Format: google-meet-YYYY-MM-DD_HH-MM-SS.png
 *
 * @returns {string}
 */
function buildScreenshotFilename() {
  const now = new Date();

  // YYYY-MM-DD
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  // HH-MM-SS
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${SCREENSHOT_FILENAME_PREFIX}-${year}-${month}-${day}_${hours}-${minutes}-${seconds}.${SCREENSHOT_IMAGE_FORMAT}`;
}

// ---------------------------------------------------------------------------
// Keyboard shortcut forwarding
// ---------------------------------------------------------------------------

/**
 * Sends the screenshot trigger to the active Meet tab if one is focused.
 * Silently no-ops if the active tab is not a Meet page.
 *
 * @returns {Promise<void>}
 */
async function forwardShortcutToActiveTabAsync() {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!activeTab || !isMeetUrl(activeTab.url)) {
      return;
    }

    chrome.tabs.sendMessage(
      activeTab.id,
      { action: "triggerScreenshotFromShortcut" },
      () => {
        // Swallowing lastError here as it's common for the content script not to be ready.
        if (chrome.runtime.lastError) {
          // No-op
        }
      },
    );
  } catch (error) {
    console.error("MeetSnap: Failed to forward shortcut —", error);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given URL belongs to a Google Meet session.
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isMeetUrl(url) {
  return typeof url === "string" && url.startsWith("https://meet.google.com/");
}

/**
 * Returns true if the Discord webhook URL has been replaced from the default placeholder.
 *
 * @returns {boolean}
 */
function isWebhookConfigured() {
  return (
    DISCORD_WEBHOOK_URL.length > 0 &&
    !DISCORD_WEBHOOK_URL.includes("YOUR_WEBHOOK_ID")
  );
}
