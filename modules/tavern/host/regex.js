/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
import {
  characters,
  eventSource,
  event_types,
  getCurrentChatId,
  saveSettingsDebounced,
  this_chid
} from "../../../../../../../script.js";
import * as nativeRegexEngine from "../../../../../../extensions/regex/engine.js";
const {
  allowPresetScripts,
  allowScopedScripts,
  getCurrentPresetAPI,
  getCurrentPresetName,
  getRegexedString,
  getScriptsByType,
  isPresetScriptsAllowed,
  isScopedScriptsAllowed,
  regex_placement,
  saveScriptsByType,
  SCRIPT_TYPES,
  substitute_find_regex
} = nativeRegexEngine;
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
function text(value) {
  return String(value || "").trim();
}
function normalizeScriptType(value) {
  const parsed = Number(value);
  if (parsed === SCRIPT_TYPES.GLOBAL || parsed === SCRIPT_TYPES.SCOPED || parsed === SCRIPT_TYPES.PRESET) {
    return parsed;
  }
  const label = text(value).toLowerCase();
  if (label === "global") {
    return SCRIPT_TYPES.GLOBAL;
  }
  if (label === "scoped" || label === "character") {
    return SCRIPT_TYPES.SCOPED;
  }
  if (label === "preset") {
    return SCRIPT_TYPES.PRESET;
  }
  throw new Error("\u672A\u77E5\u6B63\u5219\u7C7B\u578B\u3002");
}
function createId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `regex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).filter(Boolean);
  }
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
function normalizeNumberArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}
function nullableNumber(value) {
  if (value === null || value === void 0 || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizePlacementKey(value) {
  const key = text(value);
  if (key === "userInput" || key === "aiOutput" || key === "worldInfo" || key === "reasoning") {
    return key;
  }
  throw new Error("\u672A\u77E5\u6B63\u5219\u5E94\u7528\u4F4D\u7F6E\u3002");
}
function placementToNative(value) {
  switch (value) {
    case "userInput":
      return regex_placement.USER_INPUT;
    case "aiOutput":
      return regex_placement.AI_OUTPUT;
    case "worldInfo":
      return regex_placement.WORLD_INFO;
    case "reasoning":
      return regex_placement.REASONING;
    default:
      throw new Error("\u672A\u77E5\u6B63\u5219\u5E94\u7528\u4F4D\u7F6E\u3002");
  }
}
function normalizeRegexOptions(value) {
  const source = asRecord(value);
  const options = {};
  if (source.characterOverride !== void 0) {
    options.characterOverride = String(source.characterOverride || "");
  }
  if (source.isMarkdown !== void 0) {
    options.isMarkdown = source.isMarkdown === true;
  }
  if (source.isPrompt !== void 0) {
    options.isPrompt = source.isPrompt === true;
  }
  if (source.isEdit !== void 0) {
    options.isEdit = source.isEdit === true;
  }
  const depth = nullableNumber(source.depth);
  if (depth !== null) {
    options.depth = depth;
  }
  return options;
}
function fallbackScriptId(scriptType, index) {
  if (Number.isFinite(Number(scriptType)) && Number.isInteger(Number(index)) && Number(index) >= 0) {
    return `native-${Number(scriptType)}-${Number(index)}`;
  }
  return createId();
}
function normalizeRegexScript(input, scriptType, index) {
  const source = asRecord(input);
  return {
    ...cloneJson(source),
    id: text(source.id) || fallbackScriptId(scriptType, index),
    scriptName: text(source.scriptName),
    findRegex: String(source.findRegex || ""),
    replaceString: String(source.replaceString || ""),
    trimStrings: normalizeStringArray(source.trimStrings),
    placement: normalizeNumberArray(source.placement),
    disabled: source.disabled === true,
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
    runOnEdit: source.runOnEdit === true,
    substituteRegex: Number.isFinite(Number(source.substituteRegex)) ? Number(source.substituteRegex) : substitute_find_regex.NONE,
    minDepth: nullableNumber(source.minDepth),
    maxDepth: nullableNumber(source.maxDepth)
  };
}
function currentCharacter() {
  const index = Number(this_chid);
  return Number.isFinite(index) ? characters?.[index] : void 0;
}
function buildGroup(scriptType, key, label) {
  const scripts = getScriptsByType(scriptType).map((script, index) => normalizeRegexScript(script, scriptType, index));
  const presetApi = getCurrentPresetAPI();
  const presetName = getCurrentPresetName();
  return {
    key,
    label,
    scriptType,
    scripts,
    allowed: scriptType === SCRIPT_TYPES.SCOPED ? isScopedScriptsAllowed(currentCharacter()) : scriptType === SCRIPT_TYPES.PRESET ? isPresetScriptsAllowed(presetApi, presetName) : true
  };
}
async function syncNativeRegexUiAfterWrite() {
  try {
    nativeRegexEngine.RegexProvider?.instance?.clear?.();
    saveSettingsDebounced?.();
    const chatId = getCurrentChatId?.();
    const chatChangedEvent = event_types?.CHAT_CHANGED;
    if (chatChangedEvent && typeof eventSource?.emit === "function") {
      await eventSource.emit(chatChangedEvent, chatId);
    }
  } catch (error) {
    console.warn("[LittleWhiteBox] Failed to refresh native regex UI after write.", error);
  }
}
function listTavernRegexScripts() {
  return {
    groups: [
      buildGroup(SCRIPT_TYPES.GLOBAL, "global", "\u5168\u5C40"),
      buildGroup(SCRIPT_TYPES.SCOPED, "scoped", "\u5F53\u524D\u89D2\u8272"),
      buildGroup(SCRIPT_TYPES.PRESET, "preset", "\u9884\u8BBE\u6B63\u5219")
    ],
    placements: {
      userInput: regex_placement.USER_INPUT,
      aiOutput: regex_placement.AI_OUTPUT,
      slashCommand: regex_placement.SLASH_COMMAND,
      worldInfo: regex_placement.WORLD_INFO,
      reasoning: regex_placement.REASONING
    }
  };
}
async function saveTavernRegexScript(input) {
  const source = asRecord(input);
  const scriptType = normalizeScriptType(source.scriptType);
  const script = normalizeRegexScript(source.script);
  if (!script.scriptName) {
    throw new Error("\u6B63\u5219\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  }
  const scripts = getScriptsByType(scriptType).map((item, index2) => normalizeRegexScript(item, scriptType, index2));
  const index = scripts.findIndex((item) => item.id === script.id);
  if (index >= 0) {
    scripts[index] = script;
  } else {
    scripts.push(script);
  }
  await saveScriptsByType(scripts, scriptType);
  if (scriptType === SCRIPT_TYPES.SCOPED) {
    allowScopedScripts(currentCharacter());
  } else if (scriptType === SCRIPT_TYPES.PRESET) {
    allowPresetScripts(getCurrentPresetAPI(), getCurrentPresetName());
  }
  await syncNativeRegexUiAfterWrite();
  return {
    ...listTavernRegexScripts(),
    savedScriptId: script.id,
    savedScriptType: scriptType
  };
}
async function deleteTavernRegexScript(input) {
  const source = asRecord(input);
  const scriptType = normalizeScriptType(source.scriptType);
  const id = text(source.id);
  if (!id) {
    throw new Error("\u7F3A\u5C11\u6B63\u5219 ID\u3002");
  }
  const scripts = getScriptsByType(scriptType).map((item, index) => normalizeRegexScript(item, scriptType, index)).filter((item) => item.id !== id);
  await saveScriptsByType(scripts, scriptType);
  await syncNativeRegexUiAfterWrite();
  return listTavernRegexScripts();
}
function applyTavernRegex(input) {
  const source = asRecord(input);
  const rawItems = Array.isArray(source.items) ? source.items : [];
  let changedCount = 0;
  const items = rawItems.map((rawItem, index) => {
    const item = asRecord(rawItem);
    const id = text(item.id) || `item-${index}`;
    const placement = normalizePlacementKey(item.placement);
    const original = String(item.text || "");
    const textResult = getRegexedString(
      original,
      placementToNative(placement),
      normalizeRegexOptions(item.options)
    );
    const textValue = String(textResult || "");
    const changed = textValue !== original;
    if (changed) {
      changedCount += 1;
    }
    return {
      id,
      text: textValue,
      changed
    };
  });
  return {
    items,
    changedCount
  };
}
export {
  applyTavernRegex,
  deleteTavernRegexScript,
  listTavernRegexScripts,
  saveTavernRegexScript
};
