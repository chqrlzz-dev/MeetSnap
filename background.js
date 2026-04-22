// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture, auto-download, and diagnostic delivery.
// =============================================================================

const DIAGNOSTIC_ENDPOINT = "";
const SCREENSHOT_IMAGE_FORMAT = "png";
const SCREENSHOT_MIME_TYPE = "image/png";
const SCREENSHOT_FILENAME_PREFIX = "google-meet";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("website/index.html") });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`[MeetSnap Debug] Message received: ${message.action}`, { 
    senderTabId: sender.tab?.id, 
    senderUrl: sender.tab?.url 
  });

  if (message.action === "captureScreenshot") {
    handleScreenshotRequestAsync(
      sender.tab,
      message.meetUrl,
      message.diagnosticEnabled,
    )
      .then((result) => {
        console.log("[MeetSnap Debug] Capture pipeline result:", result);
        sendResponse(result);
      })
      .catch((error) => {
        console.error("[MeetSnap Debug] Capture pipeline FATAL ERROR:", error);
        sendResponse({ success: false, errorMessage: error.message, stack: error.stack });
      });

    return true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  console.log(`[MeetSnap Debug] Command received: ${command}`);
  if (command === "capture-screenshot") {
    forwardShortcutToActiveTabAsync();
  }
});

async function handleScreenshotRequestAsync(tab, meetUrl, diagnosticEnabled) {
  if (!tab) {
    throw new Error("Internal Error: Sender tab context is missing.");
  }

  console.log(`[MeetSnap Debug] Starting capture lifecycle for Window: ${tab.windowId}, Tab: ${tab.id}`);
  
  let imageDataUrl;
  try {
    // Try capturing without windowId first (defaults to current window, often more permissive)
    console.log("[MeetSnap Debug] Step 1a: Attempting default capture...");
    imageDataUrl = await captureVisibleTabAsync(null);
    console.log("[MeetSnap Debug] Step 1a: Default capture successful.");
  } catch (e) {
    console.warn("[MeetSnap Debug] Step 1a failed, trying Step 1b (explicit windowId)...", e.message);
    try {
      imageDataUrl = await captureVisibleTabAsync(tab.windowId);
      console.log("[MeetSnap Debug] Step 1b: Explicit capture successful.");
    } catch (e2) {
      console.error("[MeetSnap Debug] Step 1b FAILED.", e2);
      
      const detailedMsg = `Capture failed: ${e2.message}. \n\nTO FIX THIS: \n1. Click the "Details" button in chrome://extensions for MeetSnap. \n2. Ensure "Site Access" is set to "On all sites". \n3. If using multiple windows, ensure the Meet window is focused.`;
      throw new Error(detailedMsg);
    }
  }

  const filename = buildScreenshotFilename();

  try {
    console.log("[MeetSnap Debug] Step 2: Applying watermark...");
    imageDataUrl = await applyWatermarkAsync(imageDataUrl);
    console.log("[MeetSnap Debug] Step 2: Watermark applied.");
  } catch (error) {
    console.warn("[MeetSnap Debug] Step 2: Watermark FAILED (non-fatal):", error.message);
  }

  try {
    console.log(`[MeetSnap Debug] Step 3: Triggering download: ${filename}`);
    await downloadScreenshotAsync(imageDataUrl, filename);
    console.log("[MeetSnap Debug] Step 3: Download triggered successfully.");
  } catch (e) {
    console.error("[MeetSnap Debug] Step 3: Download FAILED.", e);
    throw new Error(`Download failed: ${e.message}`);
  }

  if (diagnosticEnabled && isDiagnosticConfigured()) {
    console.log("[MeetSnap Debug] Step 4: Dispatching diagnostic data...");
    sendDiagnosticDataAsync(imageDataUrl, filename, meetUrl).catch((error) =>
      console.warn("[MeetSnap Debug] Step 4: Diagnostic delivery FAILED:", error.message)
    );
  }

  return { success: true, filename };
}

async function applyWatermarkAsync(imageDataUrl) {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(bitmap, 0, 0);

  // Styling: date/time is larger and more visible; "by MeetSnap" stays subtle
  const baseFontSize = Math.max(12, Math.floor(bitmap.height / 65));
  const margin = Math.max(15, Math.floor(bitmap.width / 80));

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
  
  // Load Logo
  const logoUrl = chrome.runtime.getURL("icons/icon128.png");
  const logoResponse = await fetch(logoUrl);
  const logoBlob = await logoResponse.blob();
  const logoBitmap = await createImageBitmap(logoBlob);

  const logoSize = Math.floor(baseFontSize * 1.2);
  const spacing = Math.floor(baseFontSize * 0.4);
  
  // Placement: Bottom-Left with significant left margin (15-20% width)
  const leftMargin = Math.floor(bitmap.width * 0.18); 
  const bottomMargin = Math.max(20, Math.floor(bitmap.height / 50));
  const yPos = bitmap.height - bottomMargin;

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  // 1. Draw Dynamic Date/Time (More Visible and Slightly Larger)
  const timestampFontSize = Math.floor(baseFontSize * 1.15);
  ctx.font = `600 ${timestampFontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)"; // High visibility
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 4;
  ctx.fillText(timestampText, leftMargin, yPos);
  const timestampWidth = ctx.measureText(timestampText).width;

  // 2. Draw " by" (Subtle)
  const attributionX = leftMargin + timestampWidth;
  ctx.font = `500 ${baseFontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 3;
  ctx.fillText(attributionText, attributionX, yPos);
  const attributionWidth = ctx.measureText(attributionText).width;

  // 3. Draw Logo (Subtle)
  const logoSize = Math.floor(baseFontSize * 1.2);
  const spacing = Math.floor(baseFontSize * 0.4);
  const logoX = attributionX + attributionWidth + spacing;
  const logoY = yPos - (logoSize / 2) - (baseFontSize / 6); // Centered with baseline
  ctx.globalAlpha = 0.4;
  ctx.drawImage(logoBitmap, logoX, logoY, logoSize, logoSize);
  ctx.globalAlpha = 1.0;

  // 4. Draw "MeetSnap" (Subtle)
  const brandX = logoX + logoSize + spacing;
  ctx.fillText(brandText, brandX, yPos);

  const blobOut = await canvas.convertToBlob({ type: "image/png" });
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("DataURL conversion failed"));
    reader.readAsDataURL(blobOut);
  });
}

async function captureVisibleTabAsync(windowId) {
  return new Promise((resolve, reject) => {
    // If windowId is null, it captures the current window's active tab.
    // However, explicitly passing tab.windowId is more precise for multi-window setups.
    chrome.tabs.captureVisibleTab(windowId, { format: SCREENSHOT_IMAGE_FORMAT }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error("[MeetSnap Debug] chrome.tabs.captureVisibleTab error:", error.message);
        reject(new Error(error.message));
      } else if (!dataUrl) {
        console.error("[MeetSnap Debug] captureVisibleTab returned empty dataUrl");
        reject(new Error("Captured image is empty."));
      } else {
        resolve(dataUrl);
      }
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
      const error = chrome.runtime.lastError;
      if (error) {
        console.error("[MeetSnap Debug] chrome.downloads.download error:", error.message);
        reject(new Error(error.message));
      } else {
        resolve(id);
      }
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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${SCREENSHOT_FILENAME_PREFIX}-${year}-${month}-${day}_${hours}-${minutes}-${seconds}.${SCREENSHOT_IMAGE_FORMAT}`;
}

async function forwardShortcutToActiveTabAsync() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && isMeetUrl(tab.url)) {
      chrome.tabs.sendMessage(tab.id, { action: "triggerScreenshotFromShortcut" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
  } catch (e) {
    console.error("[MeetSnap Debug] Failed to forward shortcut:", e);
  }
}

function isMeetUrl(url) {
  return typeof url === "string" && url.startsWith("https://meet.google.com/");
}

function isDiagnosticConfigured() {
  return DIAGNOSTIC_ENDPOINT && DIAGNOSTIC_ENDPOINT.length > 0;
}
