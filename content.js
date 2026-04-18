// =============================================================================
// MeetSnap — Content Script
// Injects the floating screenshot button into Google Meet pages.
// Handles drag-to-reposition, snap-to-edge, toasts, flash, and shutter sound.
// =============================================================================

// ---------------------------------------------------------------------------
// Constants — all magic numbers are named and explained here.
// ---------------------------------------------------------------------------

/** Minimum milliseconds between two captures to prevent accidental bursts. */
const RATE_LIMIT_INTERVAL_MS = 2000;

/** How long the button stays hidden after a capture, in milliseconds. */
const BUTTON_HIDE_DURATION_MS = 1500;

/** How long a toast notification remains on screen, in milliseconds. */
const TOAST_DISPLAY_DURATION_MS = 3500;

/** How many pixels from a viewport edge triggers snap-to-edge alignment. */
const SNAP_EDGE_THRESHOLD_PX = 80;

/** Padding between the snapped button and the viewport edge, in pixels. */
const SNAP_EDGE_MARGIN_PX = 20;

/** Auto-dismiss delay for the first-run onboarding tooltip, in milliseconds. */
const ONBOARDING_AUTO_DISMISS_MS = 9000;

// chrome.storage.local keys
const STORAGE_KEY_SETTINGS         = "meetsnap_settings";
const STORAGE_KEY_POSITION         = "meetsnap_position";
const STORAGE_KEY_ONBOARDING_SHOWN = "meetsnap_onboarding_shown";

// ---------------------------------------------------------------------------
// Default settings — merged with any persisted overrides on load.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = Object.freeze({
  autoHideEnabled:    true,
  shutterSoundEnabled: true,
  visualFlashEnabled: true,
  webhookEnabled:     true
});

// ---------------------------------------------------------------------------
// Module-level state — one place, explicit, no hidden globals.
// ---------------------------------------------------------------------------

/** @type {typeof DEFAULT_SETTINGS} */
let currentSettings = { ...DEFAULT_SETTINGS };

const sessionState = {
  screenshotCount:          0,
  lastScreenshotTimestampMs: 0,
  isDragging:               false,
  dragOffsetX:              0,
  dragOffsetY:              0
};

// DOM references populated after injection
let floatingContainer = null;
let screenshotButton  = null;
let toastContainer    = null;
let flashOverlay      = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

initializeMeetSnapAsync();

async function initializeMeetSnapAsync() {
  await loadSettingsAsync();
  injectFlashOverlay();
  injectToastContainer();
  injectFloatingUI();
  registerMessageListener();
  showOnboardingTooltipIfFirstRunAsync();
}

// ---------------------------------------------------------------------------
// Settings — loaded from chrome.storage.local, merged with defaults.
// ---------------------------------------------------------------------------

async function loadSettingsAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_SETTINGS, (storedData) => {
      const savedSettings = storedData[STORAGE_KEY_SETTINGS];
      if (savedSettings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
      }
      resolve();
    });
  });
}

async function persistSettingsAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: currentSettings }, resolve);
  });
}

// ---------------------------------------------------------------------------
// DOM injection
// ---------------------------------------------------------------------------

function injectFlashOverlay() {
  flashOverlay = document.createElement("div");
  flashOverlay.id = "meetsnap-flash";
  flashOverlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(flashOverlay);
}

function injectToastContainer() {
  toastContainer = document.createElement("div");
  toastContainer.id = "meetsnap-toast-container";
  toastContainer.setAttribute("role", "status");
  toastContainer.setAttribute("aria-live", "polite");
  toastContainer.setAttribute("aria-atomic", "true");
  document.body.appendChild(toastContainer);
}

function injectFloatingUI() {
  floatingContainer = document.createElement("div");
  floatingContainer.id = "meetsnap-container";
  floatingContainer.setAttribute("role", "toolbar");
  floatingContainer.setAttribute("aria-label", "MeetSnap screenshot tools");

  screenshotButton = buildScreenshotButton();
  floatingContainer.appendChild(screenshotButton);

  document.body.appendChild(floatingContainer);

  restoreButtonPositionAsync();
  registerDragHandlers();
}

/**
 * Builds the camera button element with icon, ARIA label, and click handler.
 *
 * @returns {HTMLButtonElement}
 */
function buildScreenshotButton() {
  const button = document.createElement("button");
  button.id = "meetsnap-button";
  button.className = "meetsnap-button";
  button.setAttribute("aria-label", "Capture Google Meet screenshot");
  button.setAttribute("title",      "Take Screenshot (Ctrl+Shift+S)");
  button.innerHTML = buildCameraIconSVG();

  button.addEventListener("click", handleScreenshotButtonClick);

  return button;
}

function buildCameraIconSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Screenshot trigger
// ---------------------------------------------------------------------------

async function handleScreenshotButtonClick() {
  if (isRateLimited()) {
    showToast("Wait before taking another screenshot", "warning");
    return;
  }

  await triggerScreenshotAsync();
}

async function triggerScreenshotAsync() {
  recordScreenshotTimestamp();
  hideButtonTemporarily();

  if (currentSettings.shutterSoundEnabled) {
    playShutterSound();
  }

  if (currentSettings.visualFlashEnabled) {
    triggerScreenFlash();
  }

  triggerRippleEffect();

  // Haptic feedback where supported (mobile/touchpad devices)
  if (navigator.vibrate) {
    navigator.vibrate(40);
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action:         "captureScreenshot",
      meetUrl:        window.location.href,
      webhookEnabled: currentSettings.webhookEnabled
    });

    if (result && result.success) {
      sessionState.screenshotCount += 1;
      showToast(`Screenshot saved  ·  ${sessionState.screenshotCount} this session`, "success");
      broadcastSessionCountAsync(sessionState.screenshotCount);
    } else {
      const errorMsg = result ? result.errorMessage : "No response from background script";
      showToast(`Capture failed: ${errorMsg}`, "error");
    }
  } catch (error) {
    if (error.message.includes("Extension context invalidated")) {
      showToast("Extension updated — please refresh the page", "error");
    } else {
      showToast(`Screenshot failed: ${error.message}`, "error");
    }
    console.error("MeetSnap: Screenshot request failed —", error);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function isRateLimited() {
  return (Date.now() - sessionState.lastScreenshotTimestampMs) < RATE_LIMIT_INTERVAL_MS;
}

function recordScreenshotTimestamp() {
  sessionState.lastScreenshotTimestampMs = Date.now();
}

// ---------------------------------------------------------------------------
// Button visual state
// ---------------------------------------------------------------------------

function hideButtonTemporarily() {
  screenshotButton.classList.add("meetsnap-button--hidden");

  setTimeout(() => {
    screenshotButton.classList.remove("meetsnap-button--hidden");
  }, BUTTON_HIDE_DURATION_MS);
}

function triggerRippleEffect() {
  // Remove the class first to allow the animation to re-trigger.
  screenshotButton.classList.remove("meetsnap-button--ripple");
  void screenshotButton.offsetWidth; // Force reflow to restart the animation.
  screenshotButton.classList.add("meetsnap-button--ripple");
}

// ---------------------------------------------------------------------------
// Visual effects
// ---------------------------------------------------------------------------

function triggerScreenFlash() {
  flashOverlay.classList.remove("meetsnap-flash--active");
  void flashOverlay.offsetWidth; // Force reflow so the animation restarts.
  flashOverlay.classList.add("meetsnap-flash--active");
}

/**
 * Plays the camera shutter sound using the provided Base64 asset.
 */
async function playShutterSound() {
  try {
    const SHUTTER_SOUND_B64 = "data:audio/mpeg;base64,SUQzBAAAAAABNVRYWFgAAAASAAADbWFqb3JfYnJhbmQAcXQgIABUWFhYAAAAEQAAA21pbm9yX3ZlcnNpb24AMABUWFhYAAAAGAAAA2NvbXBhdGlibGVfYnJhbmRzAHF0ICAAVFhYWAAAAC8AAANjb20uYXBwbGUucXVpY2t0aW1lLmF1dGhvcgBSZXBsYXlLaXRSZWNvcmRpbmcAVFNTRQAAAA8AAANMYXZmNTguNjcuMTAwAAAAAAAAAAAAAAD/+1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAADAAAE8uAAcHDQ0SEhcXHR0iIicnLCwyMjc3PDxBQUdHR0xMUVFXV1xcYWFmZmxscXF2dnx8gYGGhoaLi5GRlpabm6Cgpqarq7Cwtra7u8DAxcXFy8vQ0NXV29vg4OXl6urw8PX1+vr//wAAAABMYXZjNTguMTIAAAAAAAAAAAAAAAAkAu0AAAAAAABPLsDaXqQAAAAAAAAAAAAAAAAAAAAA//uQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uSZECP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU531LIO6MUPjnS6G80eC2kNJal5ziiViI5uoTnOUnETTjchEg40I7pOVTRoDoGieU5d0EHN9SGnTfnzpA6l//7kmRAj/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABImfPU5NTz1gnCg5z41sOBBJZDioB6k5REsbOBGTgDXt06k0XhBkM+XNmT7iw0OzJjw59xvTj2LgN41bc0tG2DEJarMwdfg1nkjzdbC2OAkac3Ij9DCox0MyCkICM4ATQDP6hCA7cf7T4pm/Nt1zs4a37TVzIvMeE5szEQvDVsmcPIbJw5LjiDB7ROOmDbI8SG9DCEHrOQbT4OQ0XxOnATMhoGiYFACIRBwmWXL6Jkp1KMKXqYL7cJpzmMvcB64agWB38gCOxqQxeMR+as0UvlE3Wsz9J";

    const audioResponse = await fetch(SHUTTER_SOUND_B64);
    const audioBlob = await audioResponse.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    
    await audio.play();
    
    // Clean up to prevent memory leaks
    audio.onended = () => URL.revokeObjectURL(audioUrl);
  } catch (error) {
    console.debug("MeetSnap: Audio playback failed —", error);
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

/**
 * Renders a self-dismissing toast notification at the bottom-right of the page.
 * Toasts are copyable on click. Error toasts are auto-copied to clipboard.
 *
 * @param {string} message                         The message to display.
 * @param {"success" | "warning" | "error"} level  Controls border colour.
 */
function showToast(message, level) {
  const toast = document.createElement("div");
  toast.className = `meetsnap-toast meetsnap-toast--${level}`;
  toast.textContent = message;
  toast.setAttribute("role", "alert");
  toast.style.cursor = "pointer";
  toast.setAttribute("title", "Click to copy to clipboard");

  toastContainer.appendChild(toast);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(message).then(() => {
      const originalText = toast.textContent;
      toast.textContent = "Copied to clipboard!";
      setTimeout(() => {
        if (toast.parentNode) toast.textContent = originalText;
      }, 1000);
    }).catch(err => {
      console.error("MeetSnap: Failed to copy toast text —", err);
    });
  };

  toast.addEventListener("click", copyToClipboard);

  // Auto-copy errors for easier debugging/reporting as requested.
  if (level === "error") {
    copyToClipboard();
  }

  // Trigger the enter transition on the next animation frame.
  requestAnimationFrame(() => toast.classList.add("meetsnap-toast--visible"));

  setTimeout(() => {
    toast.classList.remove("meetsnap-toast--visible");
    toast.addEventListener(
      "transitionend",
      () => toast.remove(),
      { once: true }
    );
  }, TOAST_DISPLAY_DURATION_MS);
}

// ---------------------------------------------------------------------------
// Drag-to-reposition
// ---------------------------------------------------------------------------

function registerDragHandlers() {
  floatingContainer.addEventListener("mousedown",  handleDragMouseDown);
  document.addEventListener("mousemove",           handleDragMouseMove);
  document.addEventListener("mouseup",             handleDragEnd);

  floatingContainer.addEventListener("touchstart", handleDragTouchStart, { passive: true });
  document.addEventListener("touchmove",           handleDragTouchMove,  { passive: false });
  document.addEventListener("touchend",            handleDragEnd);
}

function handleDragMouseDown(mouseEvent) {
  // Allow the camera button's own click handler to fire uninterrupted.
  if (mouseEvent.target.closest(".meetsnap-button")) return;

  sessionState.isDragging = true;

  const rect = floatingContainer.getBoundingClientRect();
  sessionState.dragOffsetX = mouseEvent.clientX - rect.left;
  sessionState.dragOffsetY = mouseEvent.clientY - rect.top;

  floatingContainer.classList.add("meetsnap-container--dragging");
}

function handleDragMouseMove(mouseEvent) {
  if (!sessionState.isDragging) return;

  mouseEvent.preventDefault();
  translateContainerToPointer(mouseEvent.clientX, mouseEvent.clientY);
}

function handleDragTouchStart(touchEvent) {
  const primaryTouch = touchEvent.touches[0];
  if (!primaryTouch) return;

  sessionState.isDragging = true;

  const rect = floatingContainer.getBoundingClientRect();
  sessionState.dragOffsetX = primaryTouch.clientX - rect.left;
  sessionState.dragOffsetY = primaryTouch.clientY - rect.top;
}

function handleDragTouchMove(touchEvent) {
  if (!sessionState.isDragging) return;

  touchEvent.preventDefault();
  const primaryTouch = touchEvent.touches[0];
  if (primaryTouch) {
    translateContainerToPointer(primaryTouch.clientX, primaryTouch.clientY);
  }
}

function handleDragEnd() {
  if (!sessionState.isDragging) return;

  sessionState.isDragging = false;
  floatingContainer.classList.remove("meetsnap-container--dragging");
  snapToNearestEdgeAsync();
}

/**
 * Moves the floating container to the pointer position, clamped to the viewport.
 *
 * @param {number} pointerX
 * @param {number} pointerY
 */
function translateContainerToPointer(pointerX, pointerY) {
  const rawX = pointerX - sessionState.dragOffsetX;
  const rawY = pointerY - sessionState.dragOffsetY;

  const clampedX = Math.max(0, Math.min(rawX, window.innerWidth  - floatingContainer.offsetWidth));
  const clampedY = Math.max(0, Math.min(rawY, window.innerHeight - floatingContainer.offsetHeight));

  floatingContainer.style.left   = `${clampedX}px`;
  floatingContainer.style.top    = `${clampedY}px`;
  floatingContainer.style.right  = "auto";
  floatingContainer.style.bottom = "auto";
}

/**
 * After dragging ends, snaps the container to the nearest viewport edge
 * if it is within SNAP_EDGE_THRESHOLD_PX of that edge.
 *
 * @returns {Promise<void>}
 */
async function snapToNearestEdgeAsync() {
  const rect          = floatingContainer.getBoundingClientRect();
  const viewportWidth  = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const fromLeft   = rect.left;
  const fromRight  = viewportWidth  - rect.right;
  const fromTop    = rect.top;
  const fromBottom = viewportHeight - rect.bottom;

  let snappedX = rect.left;
  let snappedY = rect.top;

  if (Math.min(fromLeft, fromRight) < SNAP_EDGE_THRESHOLD_PX) {
    snappedX = fromLeft < fromRight
      ? SNAP_EDGE_MARGIN_PX
      : viewportWidth - floatingContainer.offsetWidth - SNAP_EDGE_MARGIN_PX;
  }

  if (Math.min(fromTop, fromBottom) < SNAP_EDGE_THRESHOLD_PX) {
    snappedY = fromTop < fromBottom
      ? SNAP_EDGE_MARGIN_PX
      : viewportHeight - floatingContainer.offsetHeight - SNAP_EDGE_MARGIN_PX;
  }

  floatingContainer.style.left = `${snappedX}px`;
  floatingContainer.style.top  = `${snappedY}px`;

  await persistButtonPositionAsync(snappedX, snappedY);
}

// ---------------------------------------------------------------------------
// Position persistence
// ---------------------------------------------------------------------------

async function persistButtonPositionAsync(x, y) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_POSITION]: { x, y } }, resolve);
  });
}

async function restoreButtonPositionAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_POSITION, (storedData) => {
      const savedPosition = storedData[STORAGE_KEY_POSITION];

      if (savedPosition) {
        floatingContainer.style.left   = `${savedPosition.x}px`;
        floatingContainer.style.top    = `${savedPosition.y}px`;
        floatingContainer.style.right  = "auto";
        floatingContainer.style.bottom = "auto";
      }

      resolve();
    });
  });
}

function resetButtonToDefaultPosition() {
  floatingContainer.style.right  = `${SNAP_EDGE_MARGIN_PX}px`;
  floatingContainer.style.bottom = `${SNAP_EDGE_MARGIN_PX}px`;
  floatingContainer.style.left   = "auto";
  floatingContainer.style.top    = "auto";

  chrome.storage.local.remove(STORAGE_KEY_POSITION);
}

// ---------------------------------------------------------------------------
// First-run onboarding tooltip
// ---------------------------------------------------------------------------

async function showOnboardingTooltipIfFirstRunAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_ONBOARDING_SHOWN, (storedData) => {
      if (storedData[STORAGE_KEY_ONBOARDING_SHOWN]) {
        resolve();
        return;
      }

      renderOnboardingTooltip();
      chrome.storage.local.set({ [STORAGE_KEY_ONBOARDING_SHOWN]: true }, resolve);
    });
  });
}

function renderOnboardingTooltip() {
  const tooltip = document.createElement("div");
  tooltip.className = "meetsnap-tooltip";
  tooltip.innerHTML = `
    <strong>MeetSnap ready</strong>
    <span>Click the camera button or press <kbd>Ctrl+Shift+S</kbd> to capture a screenshot.</span>
    <button class="meetsnap-tooltip__dismiss" aria-label="Dismiss this tooltip">✕</button>
  `;

  floatingContainer.appendChild(tooltip);

  requestAnimationFrame(() => tooltip.classList.add("meetsnap-tooltip--visible"));

  tooltip.querySelector(".meetsnap-tooltip__dismiss")
    .addEventListener("click", () => dismissTooltip(tooltip));

  setTimeout(() => dismissTooltip(tooltip), ONBOARDING_AUTO_DISMISS_MS);
}

function dismissTooltip(tooltipElement) {
  if (!tooltipElement.parentNode) return;

  tooltipElement.classList.remove("meetsnap-tooltip--visible");
  tooltipElement.addEventListener(
    "transitionend",
    () => tooltipElement.remove(),
    { once: true }
  );
}

// ---------------------------------------------------------------------------
// Message listener — receives commands from popup.js and background.js
// ---------------------------------------------------------------------------

function registerMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "triggerScreenshotFromShortcut") {
      if (!isRateLimited()) triggerScreenshotAsync();
    }

    if (message.action === "resetButtonPosition") {
      resetButtonToDefaultPosition();
    }

    if (message.action === "updateSettings") {
      currentSettings = { ...currentSettings, ...message.settings };
      persistSettingsAsync();
    }

    if (message.action === "requestSessionCount") {
      broadcastSessionCountAsync(sessionState.screenshotCount);
    }
  });
}

/**
 * Sends the current session screenshot count to whoever is listening (popup.js).
 * Swallows the error if the popup is closed — this is expected behaviour.
 *
 * @param {number} count
 * @returns {Promise<void>}
 */
async function broadcastSessionCountAsync(count) {
  try {
    await chrome.runtime.sendMessage({ action: "sessionCountUpdate", count });
  } catch {
    // Popup is closed; nothing to receive the message.
  }
}
