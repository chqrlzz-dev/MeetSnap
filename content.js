// =============================================================================
// MeetSnap — Content Script
// =============================================================================

const RATE_LIMIT_INTERVAL_MS = 2000;
const BUTTON_HIDE_DURATION_MS = 1500;
const TOAST_DISPLAY_DURATION_MS = 4500;
const SNAP_EDGE_THRESHOLD_PX = 80;
const SNAP_EDGE_MARGIN_PX = 20;
const ONBOARDING_AUTO_DISMISS_MS = 9000;

const STORAGE_KEY_SETTINGS         = "meetsnap_settings";
const STORAGE_KEY_POSITION         = "meetsnap_position";
const STORAGE_KEY_ONBOARDING_SHOWN = "meetsnap_onboarding_shown";

const DEFAULT_SETTINGS = Object.freeze({
  autoHideEnabled:    true,
  shutterSoundEnabled: true,
  visualFlashEnabled: true,
  autoTiledEnabled:    true,
  diagnosticEnabled:   true
});

let currentSettings = { ...DEFAULT_SETTINGS };

const sessionState = {
  screenshotCount:          0,
  lastScreenshotTimestampMs: 0,
  isDragging:               false,
  dragOffsetX:              0,
  dragOffsetY:              0,
  isInitialized:            false
};

let floatingContainer = null;
let screenshotButton  = null;
let toastContainer    = null;
let flashOverlay      = null;

initializeMeetSnapAsync();

async function initializeMeetSnapAsync() {
  console.log("MeetSnap: Starting initialization...");

  const performInjection = () => {
    if (!document.body || sessionState.isInitialized) return false;
    
    try {
      injectFlashOverlay();
      injectToastContainer();
      injectFloatingUI();
      sessionState.isInitialized = true;
      console.log("MeetSnap: UI successfully injected.");
      return true;
    } catch (e) {
      console.error("MeetSnap: Injection error:", e);
      return false;
    }
  };

  if (!performInjection()) {
    const observer = new MutationObserver(() => {
      if (performInjection()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    
    const pollInterval = setInterval(() => {
      if (performInjection()) clearInterval(pollInterval);
    }, 500);
    
    setTimeout(() => clearInterval(pollInterval), 10000);
  }

  try {
    await loadSettingsAsync();
    registerMessageListener();
    showOnboardingTooltipIfFirstRunAsync();
  } catch (error) {
    console.error("MeetSnap: Context setup failed:", error);
  }
}

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

function injectFlashOverlay() {
  if (document.getElementById("meetsnap-flash")) return;
  flashOverlay = document.createElement("div");
  flashOverlay.id = "meetsnap-flash";
  flashOverlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(flashOverlay);
}

function injectToastContainer() {
  if (document.getElementById("meetsnap-toast-container")) return;
  toastContainer = document.createElement("div");
  toastContainer.id = "meetsnap-toast-container";
  toastContainer.setAttribute("role", "status");
  toastContainer.setAttribute("aria-live", "polite");
  toastContainer.setAttribute("aria-atomic", "true");
  document.body.appendChild(toastContainer);
}

function injectFloatingUI() {
  if (document.getElementById("meetsnap-container")) return;
  
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

function buildScreenshotButton() {
  const button = document.createElement("button");
  button.id = "meetsnap-button";
  button.className = "meetsnap-button";
  button.setAttribute("aria-label", "Capture Google Meet screenshot");
  button.setAttribute("title",      "Take Screenshot (Ctrl+Shift+S)");
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

  button.addEventListener("click", handleScreenshotButtonClick);
  return button;
}

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

  if (currentSettings.visualFlashEnabled) {
    triggerScreenFlash();
  }

  triggerRippleEffect();

  try {
    console.debug("MeetSnap: Sending capture request...");
    const result = await chrome.runtime.sendMessage({
      action:         "captureScreenshot",
      meetUrl:        window.location.href,
      diagnosticEnabled: currentSettings.diagnosticEnabled
    });

    if (result && result.success) {
      sessionState.screenshotCount += 1;
      showToast(`Screenshot saved & copied to clipboard  ·  ${sessionState.screenshotCount} this session`, "success");
      broadcastSessionCountAsync(sessionState.screenshotCount);

      if (currentSettings.autoTiledEnabled) {
        ensureTiledLayoutAsync().catch(e => console.debug("MeetSnap: Auto-tiled failed:", e));
      }
    } else {
      const errorMsg = result ? result.errorMessage : "Capture blocked.";
      showToast(errorMsg, "error");
    }
  } catch (error) {
    showToast("Refresh Google Meet to enable capture.", "error");
  }
}

async function ensureTiledLayoutAsync() {
  const moreOptionsBtn = document.querySelector('[aria-label="More options"], [data-tooltip*="More options"]');
  if (!moreOptionsBtn) return;
  moreOptionsBtn.click();
  await new Promise(r => setTimeout(r, 250));

  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], span'));
  const layoutBtn = menuItems.find(el => el.textContent && el.textContent.includes("Change layout"));
  if (!layoutBtn) return;
  layoutBtn.click();

  await new Promise(r => setTimeout(r, 250));
  const tiledOption = Array.from(document.querySelectorAll('span, div[role="radio"]')).find(el => el.textContent === "Tiled");
  if (tiledOption) tiledOption.click();

  const closeBtn = document.querySelector('[aria-label="Close"], [data-tooltip="Close"]');
  if (closeBtn) closeBtn.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

function isRateLimited() {
  return (Date.now() - sessionState.lastScreenshotTimestampMs) < RATE_LIMIT_INTERVAL_MS;
}

function recordScreenshotTimestamp() {
  sessionState.lastScreenshotTimestampMs = Date.now();
}

function hideButtonTemporarily() {
  if (!screenshotButton) return;
  screenshotButton.classList.add("meetsnap-button--hidden");
  setTimeout(() => {
    if (screenshotButton) screenshotButton.classList.remove("meetsnap-button--hidden");
  }, BUTTON_HIDE_DURATION_MS);
}

function triggerRippleEffect() {
  if (!screenshotButton) return;
  screenshotButton.classList.remove("meetsnap-button--ripple");
  void screenshotButton.offsetWidth; 
  screenshotButton.classList.add("meetsnap-button--ripple");
}

function triggerScreenFlash() {
  if (!flashOverlay) return;
  flashOverlay.classList.remove("meetsnap-flash--active");
  void flashOverlay.offsetWidth; 
  flashOverlay.classList.add("meetsnap-flash--active");
}

function showToast(message, level) {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `meetsnap-toast meetsnap-toast--${level}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(message).then(() => {
      const originalText = toast.textContent;
      toast.textContent = "Copied!";
      setTimeout(() => { if (toast.parentNode) toast.textContent = originalText; }, 1000);
    });
  };

  toast.addEventListener("click", copyToClipboard);
  if (level === "error") copyToClipboard();

  requestAnimationFrame(() => toast.classList.add("meetsnap-toast--visible"));
  setTimeout(() => {
    toast.classList.remove("meetsnap-toast--visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, TOAST_DISPLAY_DURATION_MS);
}

function registerDragHandlers() {
  if (!floatingContainer) return;
  floatingContainer.addEventListener("mousedown",  handleDragMouseDown);
  document.addEventListener("mousemove",           handleDragMouseMove);
  document.addEventListener("mouseup",             handleDragEnd);
}

function handleDragMouseDown(mouseEvent) {
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

function handleDragEnd() {
  if (!sessionState.isDragging) return;
  sessionState.isDragging = false;
  floatingContainer.classList.remove("meetsnap-container--dragging");
  snapToNearestEdgeAsync();
}

function translateContainerToPointer(pointerX, pointerY) {
  if (!floatingContainer) return;
  const rawX = pointerX - sessionState.dragOffsetX;
  const rawY = pointerY - sessionState.dragOffsetY;
  const clampedX = Math.max(0, Math.min(rawX, window.innerWidth  - floatingContainer.offsetWidth));
  const clampedY = Math.max(0, Math.min(rawY, window.innerHeight - floatingContainer.offsetHeight));
  floatingContainer.style.left = `${clampedX}px`;
  floatingContainer.style.top  = `${clampedY}px`;
  floatingContainer.style.right = "auto";
  floatingContainer.style.bottom = "auto";
}

async function snapToNearestEdgeAsync() {
  if (!floatingContainer) return;
  const rect = floatingContainer.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let snappedX = rect.left;
  let snappedY = rect.top;

  if (Math.min(rect.left, viewportWidth - rect.right) < SNAP_EDGE_THRESHOLD_PX) {
    snappedX = rect.left < (viewportWidth - rect.right) ? SNAP_EDGE_MARGIN_PX : viewportWidth - floatingContainer.offsetWidth - SNAP_EDGE_MARGIN_PX;
  }
  if (Math.min(rect.top, viewportHeight - rect.bottom) < SNAP_EDGE_THRESHOLD_PX) {
    snappedY = rect.top < (viewportHeight - rect.bottom) ? SNAP_EDGE_MARGIN_PX : viewportHeight - floatingContainer.offsetHeight - SNAP_EDGE_MARGIN_PX;
  }

  floatingContainer.style.left = `${snappedX}px`;
  floatingContainer.style.top  = `${snappedY}px`;
  chrome.storage.local.set({ [STORAGE_KEY_POSITION]: { x: snappedX, y: snappedY } });
}

async function restoreButtonPositionAsync() {
  chrome.storage.local.get(STORAGE_KEY_POSITION, (storedData) => {
    const pos = storedData[STORAGE_KEY_POSITION];
    if (pos && floatingContainer) {
      floatingContainer.style.left = `${pos.x}px`;
      floatingContainer.style.top  = `${pos.y}px`;
      floatingContainer.style.right = "auto";
      floatingContainer.style.bottom = "auto";
    }
  });
}

function resetButtonToDefaultPosition() {
  if (!floatingContainer) return;
  floatingContainer.style.right  = `${SNAP_EDGE_MARGIN_PX}px`;
  floatingContainer.style.bottom = `${SNAP_EDGE_MARGIN_PX}px`;
  floatingContainer.style.left   = "auto";
  floatingContainer.style.top    = "auto";
  chrome.storage.local.remove(STORAGE_KEY_POSITION);
}

async function showOnboardingTooltipIfFirstRunAsync() {
  chrome.storage.local.get(STORAGE_KEY_ONBOARDING_SHOWN, (storedData) => {
    if (!storedData[STORAGE_KEY_ONBOARDING_SHOWN]) {
      renderOnboardingTooltip();
      chrome.storage.local.set({ [STORAGE_KEY_ONBOARDING_SHOWN]: true });
    }
  });
}

function renderOnboardingTooltip() {
  if (!floatingContainer) return;
  const tooltip = document.createElement("div");
  tooltip.className = "meetsnap-tooltip";
  tooltip.innerHTML = `<strong>MeetSnap ready</strong><span>Click the button or press <kbd>Ctrl+Shift+S</kbd>.</span><button class="meetsnap-tooltip__dismiss">✕</button>`;
  floatingContainer.appendChild(tooltip);
  requestAnimationFrame(() => tooltip.classList.add("meetsnap-tooltip--visible"));
  tooltip.querySelector(".meetsnap-tooltip__dismiss").addEventListener("click", () => dismissTooltip(tooltip));
  setTimeout(() => dismissTooltip(tooltip), ONBOARDING_AUTO_DISMISS_MS);
}

function dismissTooltip(tooltipElement) {
  if (!tooltipElement.parentNode) return;
  tooltipElement.classList.remove("meetsnap-tooltip--visible");
  tooltipElement.addEventListener("transitionend", () => tooltipElement.remove(), { once: true });
}

function registerMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "triggerScreenshotFromShortcut") {
      if (!isRateLimited()) triggerScreenshotAsync();
    }
    if (message.action === "resetButtonPosition") resetButtonToDefaultPosition();
    if (message.action === "updateSettings") {
      currentSettings = { ...currentSettings, ...message.settings };
    }
    if (message.action === "requestSessionCount") broadcastSessionCountAsync(sessionState.screenshotCount);
  });
}

async function broadcastSessionCountAsync(count) {
  try { await chrome.runtime.sendMessage({ action: "sessionCountUpdate", count }); } catch {}
}
