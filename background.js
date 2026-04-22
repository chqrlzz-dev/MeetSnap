// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture, auto-download, and diagnostic delivery.
//
// This file runs as a Manifest V3 service worker and has no DOM access.
// All user-facing feedback is delegated to content.js via message passing.
// =============================================================================

// ---------------------------------------------------------------------------
// Configuration
// DIAGNOSTIC_ENDPOINT is used for optional session quality analysis.
// ---------------------------------------------------------------------------

const DIAGNOSTIC_ENDPOINT = "";

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
      message.diagnosticEnabled,
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
 *   3. Optionally send diagnostic data
 *
 * @param {chrome.tabs.Tab} tab              The tab that sent the request.
 * @param {string}          meetUrl          The Google Meet URL at capture time.
 * @param {boolean}         diagnosticEnabled   Whether to forward the metadata for diagnostics.
 * @returns {Promise<{ success: boolean, filename?: string, errorMessage?: string }>}
 */
async function handleScreenshotRequestAsync(tab, meetUrl, diagnosticEnabled) {
  let imageDataUrl = await captureVisibleTabAsync(tab.windowId);
  const filename = buildScreenshotFilename();

  try {
    imageDataUrl = await applyWatermarkAsync(imageDataUrl);
  } catch (error) {
    console.warn("MeetSnap: Failed to apply watermark —", error.message);
  }

  await downloadScreenshotAsync(imageDataUrl, filename);

  if (diagnosticEnabled && isDiagnosticConfigured()) {
    sendDiagnosticDataAsync(imageDataUrl, filename, meetUrl).catch((error) =>
      console.warn("MeetSnap: Diagnostic delivery failed —", error.message)
    );
  }

  return { success: true, filename };
}

/**
 * Applies the MeetSnap watermark and timestamp to the captured image.
 * Format: "June 18, 2026 at 12:45 PM by [logo] MeetSnap"
 *
 * @param {string} imageDataUrl
 * @returns {Promise<string>}
 */
async function applyWatermarkAsync(imageDataUrl) {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(bitmap, 0, 0);

  // Styling: small, less visible (0.6 opacity)
  const fontSize = Math.max(12, Math.floor(bitmap.height / 60));
  const margin = Math.max(15, Math.floor(bitmap.width / 80));

  ctx.font = `400 ${fontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 4;

  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const timeStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const stampText = `${dateStr} at ${timeStr} by`;
  const brandText = "MeetSnap";
  
  // Load Logo
  const logoUrl = chrome.runtime.getURL("icons/icon128.png");
  const logoResponse = await fetch(logoUrl);
  const logoBlob = await logoResponse.blob();
  const logoBitmap = await createImageBitmap(logoBlob);

  const logoSize = Math.floor(fontSize * 1.2);
  const stampWidth = ctx.measureText(stampText).width;
  const brandWidth = ctx.measureText(brandText).width;
  const spacing = Math.floor(fontSize * 0.4);
  
  // Placement: Top-Right (less likely to interfere with Meet controls)
  const xEnd = bitmap.width - margin;
  const yPos = margin + fontSize;

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  // Draw "MeetSnap"
  ctx.fillText(brandText, xEnd, yPos);

  // Draw Logo
  const logoX = xEnd - brandWidth - logoSize - spacing;
  const logoY = yPos - (logoSize / 2);
  ctx.globalAlpha = 0.6;
  ctx.drawImage(logoBitmap, logoX, logoY, logoSize, logoSize);
  ctx.globalAlpha = 1.0;

  // Draw Date/Time "by"
  const stampX = logoX - spacing;
  ctx.fillText(stampText, stampX, yPos);

  const blobOut = await canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Blob conversion failed"));
    reader.readAsDataURL(blobOut);
  });
}

async function captureVisibleTabAsync(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: SCREENSHOT_IMAGE_FORMAT }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

async function downloadScreenshotAsync(imageDataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imageDataUrl,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify",
    }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

async function sendDiagnosticDataAsync(imageDataUrl, filename, meetUrl) {
  const imageResponse = await fetch(imageDataUrl);
  const imageBlob = await imageResponse.blob();
  const formData = new FormData();
  formData.append("file", imageBlob, filename);
  formData.append("payload_json", JSON.stringify({ 
    content: `📸 **Diagnostic Data**\n**Timestamp:** \`${new Date().toISOString()}\`\n**URL:** ${meetUrl}` 
  }));

  const response = await fetch(DIAGNOSTIC_ENDPOINT, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`Status ${response.status}`);
}

function buildScreenshotFilename() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0].replace(/:/g, "-");
  return `${SCREENSHOT_FILENAME_PREFIX}-${date}_${time}.${SCREENSHOT_IMAGE_FORMAT}`;
}

async function forwardShortcutToActiveTabAsync() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && isMeetUrl(tab.url)) {
      chrome.tabs.sendMessage(tab.id, { action: "triggerScreenshotFromShortcut" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
  } catch (e) {}
}

function isMeetUrl(url) {
  return typeof url === "string" && url.startsWith("https://meet.google.com/");
}

function isDiagnosticConfigured() {
  return DIAGNOSTIC_ENDPOINT.length > 0;
}
