/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
import { getRequestHeaders } from "../../../../../../script.js";
import { extensionFolderPath } from "../../core/constants.js";
import { createFirstPartyIframeOverlay, loadFirstPartyIframeCacheKey } from "../../core/first-party-iframe-app.js";
import { isTrustedMessage, postToIframe } from "../../core/iframe-messaging.js";
import { buildTavernFrameConfig, saveTavernAgentConfig } from "./host/agent-config.js";
import {
  getTavernChatPresetBundle,
  listTavernChatPresetBundles,
  saveTavernChatPresetBundle,
  selectTavernChatPresetBundle
} from "./host/chat-presets.js";
import {
  applyTavernRegex,
  deleteTavernRegexScript,
  listTavernRegexScripts,
  saveTavernRegexScript
} from "./host/regex.js";
import { applyTavernSubstituteParams } from "./host/substitute-params.js";
import { runTavernSlashCommand } from "./host/slash-commands.js";
import { buildTavernContext } from "./host/sillytavern-context.js";
import {
  activateTavernCharacterWorldbook,
  bindTavernCharacterWorldbook,
  getTavernCharacterWorldbookState,
  getTavernGlobalWorldbooks,
  getTavernWorldbookEntry,
  getTavernWorldbookPreview,
  getTavernWorldbookRuntime,
  listTavernWorldbookSources,
  saveTavernWorldbookEntry,
  setTavernGlobalWorldbooks
} from "./host/worldbooks.js";
const SOURCE_HOST = "xb-tavern-host";
const SOURCE_APP = "xb-tavern-app";
const OVERLAY_ID = "xiaobaix-tavern-overlay";
const IFRAME_ID = "xiaobaix-tavern-iframe";
const HTML_PATH = `${extensionFolderPath}/modules/tavern/tavern.html`;
const BUILD_INFO_PATH = `${extensionFolderPath}/modules/tavern/dist/tavern-build.json`;
let tavernCacheKey = "";
let frameReady = false;
let pendingMessages = [];
let messageHandlerInstalled = false;
let overlayResizeHandler = null;
const pendingDrawRequests = /* @__PURE__ */ new Map();
async function getDrawGalleryCacheModule() {
  return await import("../draw/shared/gallery-cache.js");
}
function cloneFramePayload(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") {
        return String(item);
      }
      if (typeof item === "function" || typeof item === "symbol") {
        return void 0;
      }
      if (!item || typeof item !== "object") {
        return item;
      }
      if (seen.has(item)) {
        return void 0;
      }
      seen.add(item);
      return item;
    }));
  } catch {
    return {};
  }
}
async function loadTavernCacheKey() {
  if (tavernCacheKey) {
    return tavernCacheKey;
  }
  tavernCacheKey = await loadFirstPartyIframeCacheKey(BUILD_INFO_PATH);
  return tavernCacheKey;
}
function getIframe() {
  const iframe = document.getElementById(IFRAME_ID);
  return iframe instanceof HTMLIFrameElement ? iframe : null;
}
function isTavernMobileDevice() {
  const mobileTypes = ["mobile", "tablet"];
  try {
    const bowser = globalThis;
    const platformType = bowser.Bowser?.parse?.(navigator.userAgent)?.platform?.type;
    if (mobileTypes.includes(platformType)) {
      return true;
    }
  } catch {
  }
  return window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 900px)").matches;
}
function getTavernMobileTopOffset() {
  const rawValue = getComputedStyle(document.documentElement).getPropertyValue("--topBarBlockSize").trim();
  const parsedValue = Number.parseFloat(rawValue);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}
function getTavernMobileViewportHeight() {
  return Math.max(240, window.innerHeight - getTavernMobileTopOffset());
}
function applyTavernOverlayViewport(overlay = document.getElementById(OVERLAY_ID)) {
  if (!(overlay instanceof HTMLElement)) {
    return;
  }
  overlay.style.left = "0";
  overlay.style.right = "0";
  overlay.style.width = "100vw";
  if (!isTavernMobileDevice()) {
    overlay.style.top = "0";
    overlay.style.height = "100vh";
    overlay.style.padding = "0";
    overlay.classList.remove("is-mobile");
    return;
  }
  const topOffset = getTavernMobileTopOffset();
  const viewportHeight = getTavernMobileViewportHeight();
  overlay.style.top = `${topOffset}px`;
  overlay.style.height = `${viewportHeight}px`;
  overlay.style.padding = "env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)";
  overlay.classList.add("is-mobile");
}
function installOverlayResizeHandler(overlay) {
  if (overlayResizeHandler) {
    return;
  }
  overlayResizeHandler = () => applyTavernOverlayViewport(overlay);
  window.addEventListener("resize", overlayResizeHandler);
  window.addEventListener("orientationchange", overlayResizeHandler);
  window.visualViewport?.addEventListener("resize", overlayResizeHandler);
  window.visualViewport?.addEventListener("scroll", overlayResizeHandler);
}
function removeOverlayResizeHandler() {
  if (!overlayResizeHandler) {
    return;
  }
  window.removeEventListener("resize", overlayResizeHandler);
  window.removeEventListener("orientationchange", overlayResizeHandler);
  window.visualViewport?.removeEventListener("resize", overlayResizeHandler);
  window.visualViewport?.removeEventListener("scroll", overlayResizeHandler);
  overlayResizeHandler = null;
}
function postToFrame(type, payload = {}) {
  const iframe = getIframe();
  if (!iframe?.contentWindow) {
    return false;
  }
  const message = cloneFramePayload({ type, payload });
  if (!frameReady) {
    pendingMessages.push(message);
    return false;
  }
  return postToIframe(iframe, message, SOURCE_HOST);
}
function flushPendingMessages() {
  if (!frameReady) {
    return;
  }
  const iframe = getIframe();
  if (!iframe?.contentWindow) {
    return;
  }
  pendingMessages.forEach((message) => postToIframe(iframe, message, SOURCE_HOST));
  pendingMessages = [];
}
async function sendConfigToFrame(options = {}) {
  const contextPayload = await buildTavernContext(options);
  postToFrame("xb-tavern:config", await buildTavernFrameConfig(contextPayload));
}
async function refreshContext(options = {}) {
  postToFrame("xb-tavern:context", await buildTavernContext(options));
}
async function saveConfigFromFrame(payload = {}) {
  const requestId = String(payload.requestId || "");
  const configPatch = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
  const result = await saveTavernAgentConfig(configPatch, { silent: false });
  postToFrame("xb-tavern:config-saved", {
    requestId,
    ok: result.ok,
    config: result.config,
    error: result.error || ""
  });
  if (result.ok) {
    await sendConfigToFrame();
  }
}
function replyHostResult(requestId = "", payload = {}) {
  postToFrame("xb-tavern:host-result", {
    requestId,
    ...payload
  });
}
function hostErrorPayload(error, fallback = "host_request_failed") {
  if (error instanceof Error) {
    return {
      ok: false,
      error: error.message || fallback,
      errorName: error.name || "Error",
      errorStack: error.stack || ""
    };
  }
  return {
    ok: false,
    error: String(error || fallback),
    errorName: "",
    errorStack: ""
  };
}
function handleHostRequestHeaders(payload = {}) {
  replyHostResult(String(payload.requestId || ""), {
    ok: true,
    hostRequestHeaders: getRequestHeaders?.() || {}
  });
}
function getDrawStatus() {
  const facade = window.xiaobaixDraw;
  const status = typeof facade?.getStatus === "function" ? facade.getStatus() : {
    provider: typeof facade?.getProvider === "function" ? facade.getProvider() : "disabled",
    enabled: !!facade?.isEnabled?.(),
    ready: !!facade?.generateImagesFromText
  };
  return {
    provider: String(status?.provider || "disabled"),
    enabled: !!status?.enabled,
    ready: !!status?.ready
  };
}
function handleDrawStatus(payload = {}) {
  replyHostResult(String(payload.requestId || ""), {
    ok: true,
    ...getDrawStatus()
  });
}
async function handleDrawGenerate(payload = {}) {
  const requestId = String(payload.requestId || "");
  const controller = new AbortController();
  if (requestId) {
    pendingDrawRequests.set(requestId, controller);
  }
  try {
    const facade = window.xiaobaixDraw;
    if (typeof facade?.generateImagesFromText !== "function") {
      throw new Error("\u753B\u56FE\u6A21\u5757\u672A\u521D\u59CB\u5316");
    }
    const drawPayload = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
    const result = await facade.generateImagesFromText({
      ...drawPayload,
      signal: controller.signal,
      onStateChange: (state, data = {}) => {
        postToFrame("xb-tavern:draw-progress", {
          requestId,
          state,
          data
        });
      }
    });
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "draw_failed"));
  } finally {
    if (requestId) {
      pendingDrawRequests.delete(requestId);
    }
  }
}
function previewToTransferableUrl(preview = {}) {
  const savedUrl = String(preview.savedUrl || "").trim();
  if (savedUrl) {
    return savedUrl;
  }
  const base64 = String(preview.base64 || "").trim();
  if (!base64) {
    return "";
  }
  if (/^data:[^;]+;base64,/i.test(base64)) {
    return base64;
  }
  return `data:image/png;base64,${base64}`;
}
async function handleDrawImage(payload = {}) {
  const requestId = String(payload.requestId || "");
  const source = payload.payload && typeof payload.payload === "object" ? payload.payload : payload;
  const slotId = String(source.slotId || "").trim();
  try {
    if (!slotId) {
      throw new Error("slot_id_required");
    }
    const { getDisplayPreviewForSlot } = await getDrawGalleryCacheModule();
    const result = await getDisplayPreviewForSlot(slotId);
    const preview = result.preview || {};
    const failedInfo = result.failedInfo || {};
    replyHostResult(requestId, {
      ok: true,
      result: {
        slotId,
        hasData: !!result.hasData,
        isFailed: !!result.isFailed,
        historyCount: Number(result.historyCount) || 0,
        url: result.hasData ? previewToTransferableUrl(preview) : "",
        tags: preview.tags || failedInfo.tags || "",
        positive: preview.positive || failedInfo.positive || "",
        errorType: failedInfo.errorType || "",
        errorMessage: failedInfo.errorMessage || ""
      }
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "image_lookup_failed"));
  }
}
function handleCancelRequest(payload = {}) {
  const requestId = String(payload.requestId || "").trim();
  if (!requestId) {
    return;
  }
  pendingDrawRequests.get(requestId)?.abort();
}
async function handleChatPresetRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:list-chat-presets") {
      result = listTavernChatPresetBundles();
    } else if (type === "xb-tavern:get-chat-preset") {
      result = getTavernChatPresetBundle();
    } else if (type === "xb-tavern:save-chat-preset") {
      result = await saveTavernChatPresetBundle(payload.payload);
    } else if (type === "xb-tavern:select-chat-preset") {
      result = await selectTavernChatPresetBundle(payload.payload);
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
    if (type !== "xb-tavern:list-chat-presets") {
      await sendConfigToFrame();
    }
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "chat_preset_failed"));
  }
}
async function handleContextRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:get-context") {
      result = await buildTavernContext(payload.payload || {});
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "context_request_failed"));
  }
}
async function handleWorldbookRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:list-worldbook-sources") {
      result = await listTavernWorldbookSources(payload.payload);
    } else if (type === "xb-tavern:get-worldbook-preview") {
      result = await getTavernWorldbookPreview(payload.payload);
    } else if (type === "xb-tavern:get-worldbook-entry") {
      result = await getTavernWorldbookEntry(payload.payload);
    } else if (type === "xb-tavern:save-worldbook-entry") {
      result = await saveTavernWorldbookEntry(payload.payload);
    } else if (type === "xb-tavern:get-character-worldbook-state") {
      result = await getTavernCharacterWorldbookState(payload.payload);
    } else if (type === "xb-tavern:activate-character-worldbook") {
      result = await activateTavernCharacterWorldbook(payload.payload);
    } else if (type === "xb-tavern:bind-character-worldbook") {
      result = await bindTavernCharacterWorldbook(payload.payload);
    } else if (type === "xb-tavern:get-global-worldbooks") {
      result = await getTavernGlobalWorldbooks();
    } else if (type === "xb-tavern:set-global-worldbooks") {
      result = await setTavernGlobalWorldbooks(payload.payload);
    } else if (type === "xb-tavern:get-worldbook-runtime") {
      result = await getTavernWorldbookRuntime(payload.payload);
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "worldbook_failed"));
  }
}
async function handleRegexRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:list-regex-scripts") {
      result = listTavernRegexScripts();
    } else if (type === "xb-tavern:save-regex-script") {
      result = await saveTavernRegexScript(payload.payload);
    } else if (type === "xb-tavern:delete-regex-script") {
      result = await deleteTavernRegexScript(payload.payload);
    } else if (type === "xb-tavern:apply-regex") {
      result = applyTavernRegex(payload.payload);
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "regex_failed"));
  }
}
async function handleSubstituteParamsRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:substitute-params") {
      result = applyTavernSubstituteParams(payload.payload);
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "substitute_params_failed"));
  }
}
async function handleSlashCommandRequest(type, payload = {}) {
  const requestId = String(payload.requestId || "");
  try {
    let result;
    if (type === "xb-tavern:run-slash-command") {
      result = await runTavernSlashCommand(payload.payload);
    }
    replyHostResult(requestId, {
      ok: true,
      result
    });
  } catch (error) {
    replyHostResult(requestId, hostErrorPayload(error, "slash_command_failed"));
  }
}
async function createOverlay() {
  const overlay = await createFirstPartyIframeOverlay({
    overlayId: OVERLAY_ID,
    iframeId: IFRAME_ID,
    htmlPath: HTML_PATH,
    version: await loadTavernCacheKey(),
    overlayCss: `
            position: fixed !important;
            left: 0 !important;
            right: 0 !important;
            top: 0;
            bottom: auto !important;
            width: 100vw !important;
            height: 100vh;
            height: 100dvh;
            z-index: 100001 !important;
            display: flex !important;
            align-items: stretch !important;
            justify-content: stretch !important;
            overflow: hidden !important;
            box-sizing: border-box !important;
            background: #171512 !important;
            overscroll-behavior: none;
            touch-action: manipulation;
        `,
    iframeCss: `
            display: block !important;
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            border: none !important;
            background: transparent !important;
        `
  });
  applyTavernOverlayViewport(overlay);
  installOverlayResizeHandler(overlay);
  return overlay;
}
async function openTavern() {
  const existingOverlay = document.getElementById(OVERLAY_ID);
  if (existingOverlay) {
    applyTavernOverlayViewport(existingOverlay);
    return;
  }
  frameReady = false;
  pendingMessages = [];
  installMessageHandler();
  await createOverlay();
}
function closeTavern() {
  removeOverlayResizeHandler();
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.remove();
  }
  frameReady = false;
  pendingMessages = [];
}
function handleFrameMessage(event) {
  const iframe = getIframe();
  if (!isTrustedMessage(event, iframe, SOURCE_APP)) {
    return;
  }
  const data = event.data || {};
  switch (data.type) {
    case "xb-tavern:frame-ready":
      frameReady = true;
      void sendConfigToFrame().then(flushPendingMessages);
      break;
    case "xb-tavern:close":
      closeTavern();
      break;
    case "xb-tavern:refresh-context":
      void refreshContext(data.payload || {});
      break;
    case "xb-tavern:save-config":
      void saveConfigFromFrame(data.payload || {});
      break;
    case "xb-tavern:get-host-request-headers":
      handleHostRequestHeaders(data.payload || {});
      break;
    case "xb-tavern:draw-status":
      handleDrawStatus(data.payload || {});
      break;
    case "xb-tavern:draw-generate":
      void handleDrawGenerate(data.payload || {});
      break;
    case "xb-tavern:draw-image":
      void handleDrawImage(data.payload || {});
      break;
    case "xb-tavern:cancel-request":
      handleCancelRequest(data.payload || {});
      break;
    case "xb-tavern:get-context":
      void handleContextRequest(data.type, data.payload || {});
      break;
    case "xb-tavern:list-chat-presets":
    case "xb-tavern:get-chat-preset":
    case "xb-tavern:save-chat-preset":
    case "xb-tavern:select-chat-preset":
      void handleChatPresetRequest(data.type, data.payload || {});
      break;
    case "xb-tavern:list-worldbook-sources":
    case "xb-tavern:get-worldbook-preview":
    case "xb-tavern:get-worldbook-entry":
    case "xb-tavern:save-worldbook-entry":
    case "xb-tavern:get-character-worldbook-state":
    case "xb-tavern:activate-character-worldbook":
    case "xb-tavern:bind-character-worldbook":
    case "xb-tavern:get-global-worldbooks":
    case "xb-tavern:set-global-worldbooks":
    case "xb-tavern:get-worldbook-runtime":
      void handleWorldbookRequest(data.type, data.payload || {});
      break;
    case "xb-tavern:list-regex-scripts":
    case "xb-tavern:save-regex-script":
    case "xb-tavern:delete-regex-script":
    case "xb-tavern:apply-regex":
      void handleRegexRequest(data.type, data.payload || {});
      break;
    case "xb-tavern:substitute-params":
      void handleSubstituteParamsRequest(data.type, data.payload || {});
      break;
    case "xb-tavern:run-slash-command":
      void handleSlashCommandRequest(data.type, data.payload || {});
      break;
    default:
      break;
  }
}
function installMessageHandler() {
  if (messageHandlerInstalled) {
    return;
  }
  window.addEventListener("message", handleFrameMessage);
  messageHandlerInstalled = true;
}
async function initTavern() {
  installMessageHandler();
  window.xiaobaixTavern = {
    open: openTavern,
    close: closeTavern,
    refreshContext
  };
}
function cleanupTavern() {
  closeTavern();
}
export {
  cleanupTavern,
  closeTavern,
  initTavern,
  openTavern
};
