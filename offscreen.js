// =============================================================================
// MeetSnap — Offscreen Script
// Handles synthetic audio playback to avoid CSP restrictions on Meet.
// =============================================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "playShutterSound") {
    playBeep();
  }
});

/**
 * Plays a clean camera-like beep using Web Audio API.
 */
function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime); 
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.1);
    
    setTimeout(() => ctx.close(), 200);
  } catch (e) {
    console.warn("Audio failed", e);
  }
}
