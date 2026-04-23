// =============================================================================
// MeetSnap — Offscreen Script
// Handles tasks restricted by site CSP (like audio synthesis).
// =============================================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "playShutterSound") {
    playSyntheticShutterSound();
  } else if (message.action === "copyImageToClipboard") {
    copyImageToClipboard(message.imageDataUrl);
  }
});

/**
 * Copies an image from a Data URL to the system clipboard.
 */
async function copyImageToClipboard(imageDataUrl) {
  try {
    // 1. Convert Data URL to Blob
    const response = await fetch(imageDataUrl);
    const blob = await response.blob();

    // 2. Ensure it is a PNG for standard clipboard compatibility
    // Most browsers only support 'image/png' for ClipboardItem
    const pngBlob = blob.type === "image/png" ? blob : await convertToPngAsync(blob);

    // 3. Write to Clipboard
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": pngBlob
      })
    ]);
    
    console.log("[MeetSnap Offscreen] Image copied to clipboard.");
  } catch (error) {
    console.error("[MeetSnap Offscreen] Clipboard error:", error);
    // Note: Some browsers require a user gesture even in offscreen documents 
    // for clipboard access, though 'CLIPBOARD' reason usually grants it.
  }
}

/**
 * Fallback to ensure we have a PNG blob if the input format differs.
 */
async function convertToPngAsync(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Synthesizes a shutter sound using Web Audio API in the extension context.
 */
function playSyntheticShutterSound() {
  try {
    const context = new AudioContext();
    
    // Create white noise
    const bufferSize = context.sampleRate * 0.08;
    const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = context.createBufferSource();
    noise.buffer = buffer;

    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 1200;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.35, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.07);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);

    noise.start();
    noise.stop(context.currentTime + 0.1);
    
    setTimeout(() => context.close(), 200);
  } catch (e) {
    console.error("Offscreen Audio Error:", e);
  }
}
