// =============================================================================
// MeetSnap — Offscreen Script
// Handles tasks restricted by site CSP (audio, clipboard, cross-origin fetch).
// =============================================================================

// SHUTTER_SOUND_B64 is provided by shutter.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse("pong");
  } else if (message.action === "playShutterSound") {
    playShutterSoundFromBase64();
  } else if (message.action === "copyImageToClipboard") {
    copyImageToClipboard(message.imageDataUrl);
  } else if (message.action === "sendDiagnostic") {
    sendDiagnosticToDiscord(message);
  }
});

/**
 * Decodes and plays the shutter sound.
 */
async function playShutterSoundFromBase64() {
  try {
    const context = new AudioContext();
    const binaryString = atob(SHUTTER_SOUND_B64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const audioBuffer = await context.decodeAudioData(bytes.buffer);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.start();
    source.onended = () => setTimeout(() => context.close(), 100);
  } catch (e) {
    console.error("[MeetSnap Offscreen] Audio Error:", e);
  }
}

/**
 * Copies an image from a Data URL to the system clipboard.
 */
async function copyImageToClipboard(imageDataUrl) {
  console.log("[MeetSnap Offscreen] Executing Clipboard Copy...");
  
  try {
    // 1. Convert Data URL to a clean PNG Blob
    const response = await fetch(imageDataUrl);
    const blob = await response.blob();
    
    // 2. Primary Method: Clipboard API
    // We MUST use 'image/png' exactly.
    const item = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([item]);
    
    console.log("[MeetSnap Offscreen] Clipboard API Copy Successful.");
  } catch (error) {
    console.warn("[MeetSnap Offscreen] Clipboard API failed, trying legacy fallback...", error);
    
    try {
      // Legacy Fallback: Using an <img> in a contenteditable div
      const img = document.createElement('img');
      img.src = imageDataUrl;
      
      const div = document.createElement('div');
      div.contentEditable = true;
      div.style.position = 'fixed';
      div.style.left = '-9999px';
      div.appendChild(img);
      document.body.appendChild(div);
      
      // Select the image
      const range = document.createRange();
      range.selectNode(img);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Trigger copy
      const success = document.execCommand('copy');
      document.body.removeChild(div);
      
      if (success) {
        console.log("[MeetSnap Offscreen] Legacy Copy Successful.");
      } else {
        throw new Error("execCommand('copy') returned false");
      }
    } catch (fallbackError) {
      console.error("[MeetSnap Offscreen] ALL clipboard methods failed:", fallbackError);
    }
  }
}

/**
 * Sends a diagnostic screenshot to the Discord webhook.
 */
async function sendDiagnosticToDiscord({ endpoint, imageDataUrl, filename, meetUrl }) {
  console.log("[MeetSnap Offscreen] Sending Diagnostic...");
  try {
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();

    const formData = new FormData();
    formData.append("file", blob, filename);
    
    const payload = {
      content: `📸 **MeetSnap Diagnostic**\n**Time:** \`${new Date().toLocaleString()}\`\n**URL:** ${meetUrl}\n**File:** \`${filename}\``
    };
    formData.append("payload_json", JSON.stringify(payload));

    const response = await fetch(endpoint, {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[MeetSnap Offscreen] Discord error (${response.status}):`, text);
    } else {
      console.log("[MeetSnap Offscreen] Diagnostic Delivered.");
    }
  } catch (error) {
    console.error("[MeetSnap Offscreen] Diagnostic Fetch failed:", error);
  }
}
