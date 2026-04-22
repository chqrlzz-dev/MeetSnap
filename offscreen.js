// =============================================================================
// MeetSnap — Offscreen Script
// Handles tasks restricted by site CSP (like audio synthesis).
// =============================================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "playShutterSound") {
    playSyntheticShutterSound();
  }
});

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
