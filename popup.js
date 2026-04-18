// =============================================================================
// MeetSnap — Popup Script
// Controls the extension popup UI.
// Checks whether the active tab is a Meet page, loads and persists settings,
// and routes user actions to the content script and background worker.
// =============================================================================

const STORAGE_KEY_SETTINGS  = "meetsnap_settings";
const GOOGLE_MEET_URL_PREFIX = "https://meet.google.com/";

// ---------------------------------------------------------------------------
// DOM references — queried once at startup.
// ---------------------------------------------------------------------------

const statusBadgeElement      = document.getElementById("status-badge");
const statusLabelElement      = document.getElementById("status-label");
const activePanelElement      = document.getElementById("active-panel");
const inactivePanelElement    = document.getElementById("inactive-panel");
const captureButtonElement    = document.getElementById("btn-capture");
const resetPositionButton     = document.getElementById("btn-reset-position");
const sessionCountElement     = document.getElementById("session-count");
const privacyNoticeElement    = document.getElementById("privacy-notice");

const toggleAutoHide          = document.getElementById("toggle-auto-hide");
const toggleShutterSound      = document.getElementById("toggle-shutter-sound");
const toggleVisualFlash       = document.getElementById("toggle-visual-flash");
const toggleWebhook           = document.getElementById("toggle-webhook");

// ---------------------------------------------------------------------------
// Popup initialisation
// ---------------------------------------------------------------------------

initializePopupAsync();

async function initializePopupAsync() {
  const [activeTab, savedSettings] = await Promise.all([
    queryActiveTabAsync(),
    loadSavedSettingsAsync()
  ]);

  const isOnMeetPage = isMeetUrl(activeTab?.url);

  renderMeetStatus(isOnMeetPage);
  applySettingsToToggles(savedSettings);
  updatePrivacyNoticeVisibility(savedSettings.webhookEnabled);

  if (isOnMeetPage) {
    registerActiveTabEventListeners(activeTab.id);
    requestSessionCountFromContentScriptAsync(activeTab.id);
  }

  registerSessionCountListener();
}

// ---------------------------------------------------------------------------
// Tab detection
// ---------------------------------------------------------------------------

/**
 * Returns the active tab in the current window.
 *
 * @returns {Promise<chrome.tabs.Tab | undefined>}
 */
async function queryActiveTabAsync() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      resolve(activeTab);
    });
  });
}

/**
 * Returns true if the given URL belongs to a Google Meet session.
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isMeetUrl(url) {
  return typeof url === "string" && url.startsWith(GOOGLE_MEET_URL_PREFIX);
}

// ---------------------------------------------------------------------------
// Settings — loaded from chrome.storage.local, merged with defaults.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = Object.freeze({
  autoHideEnabled:     true,
  shutterSoundEnabled: true,
  visualFlashEnabled:  true,
  webhookEnabled:      true
});

async function loadSavedSettingsAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_SETTINGS, (storedData) => {
      const saved = storedData[STORAGE_KEY_SETTINGS];
      resolve(saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS });
    });
  });
}

async function persistSettingsAsync(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderMeetStatus(isOnMeetPage) {
  if (isOnMeetPage) {
    statusBadgeElement.className  = "status-badge status-badge--active";
    statusLabelElement.textContent = "Google Meet detected";
    activePanelElement.classList.remove("hidden");
    inactivePanelElement.classList.add("hidden");
  } else {
    statusBadgeElement.className  = "status-badge status-badge--inactive";
    statusLabelElement.textContent = "Not on Google Meet";
    activePanelElement.classList.add("hidden");
    inactivePanelElement.classList.remove("hidden");
    captureButtonElement.disabled = true;
  }
}

/**
 * Syncs all toggle elements to match the loaded settings object.
 *
 * @param {typeof DEFAULT_SETTINGS} settings
 */
function applySettingsToToggles(settings) {
  toggleAutoHide.checked      = settings.autoHideEnabled;
  toggleShutterSound.checked  = settings.shutterSoundEnabled;
  toggleVisualFlash.checked   = settings.visualFlashEnabled;
  toggleWebhook.checked       = settings.webhookEnabled;
}

function updatePrivacyNoticeVisibility(isWebhookEnabled) {
  if (isWebhookEnabled) {
    privacyNoticeElement.classList.remove("hidden");
  } else {
    privacyNoticeElement.classList.add("hidden");
  }
}

function updateSessionCountDisplay(count) {
  sessionCountElement.textContent = String(count);
}

// ---------------------------------------------------------------------------
// Event listeners — only registered when on a Meet page.
// ---------------------------------------------------------------------------

function registerActiveTabEventListeners(meetTabId) {
  captureButtonElement.addEventListener("click", () => {
    triggerCaptureOnTabAsync(meetTabId);
  });

  resetPositionButton.addEventListener("click", () => {
    sendMessageToTabAsync(meetTabId, { action: "resetButtonPosition" });
  });

  toggleAutoHide.addEventListener("change",     () => handleToggleChange(meetTabId));
  toggleShutterSound.addEventListener("change", () => handleToggleChange(meetTabId));
  toggleVisualFlash.addEventListener("change",  () => handleToggleChange(meetTabId));
  toggleWebhook.addEventListener("change",      () => handleToggleChange(meetTabId));
}

/**
 * Reads the current state of all toggle inputs, persists the settings,
 * and forwards them to the content script.
 *
 * @param {number} meetTabId
 */
async function handleToggleChange(meetTabId) {
  const updatedSettings = {
    autoHideEnabled:     toggleAutoHide.checked,
    shutterSoundEnabled: toggleShutterSound.checked,
    visualFlashEnabled:  toggleVisualFlash.checked,
    webhookEnabled:      toggleWebhook.checked
  };

  updatePrivacyNoticeVisibility(updatedSettings.webhookEnabled);

  await persistSettingsAsync(updatedSettings);
  await sendMessageToTabAsync(meetTabId, {
    action:   "updateSettings",
    settings: updatedSettings
  });
}

// ---------------------------------------------------------------------------
// Screenshot trigger from popup
// ---------------------------------------------------------------------------

async function triggerCaptureOnTabAsync(meetTabId) {
  captureButtonElement.disabled = true;

  try {
    await sendMessageToTabAsync(meetTabId, { action: "triggerScreenshotFromShortcut" });
  } finally {
    // Re-enable after a brief delay to prevent accidental double-clicks.
    setTimeout(() => {
      captureButtonElement.disabled = false;
    }, 1600);
  }
}

// ---------------------------------------------------------------------------
// Session counter sync
// ---------------------------------------------------------------------------

/**
 * Asks the content script for the current session screenshot count.
 * The response arrives via the message listener registered below.
 *
 * @param {number} meetTabId
 */
async function requestSessionCountFromContentScriptAsync(meetTabId) {
  await sendMessageToTabAsync(meetTabId, { action: "requestSessionCount" });
}

function registerSessionCountListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "sessionCountUpdate") {
      updateSessionCountDisplay(message.count);
    }
  });
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

/**
 * Sends a message to the content script in the given tab.
 * Swallows errors that occur when the content script has not yet loaded.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<any>}
 */
async function sendMessageToTabAsync(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not ready yet; this is expected on fresh tab loads.
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}
