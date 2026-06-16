/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
import {
  chat_metadata,
  characters,
  eventSource,
  getOneCharacter,
  name2,
  select_selected_character,
  setCharacterId,
  setCharacterName,
  this_chid,
  unshallowCharacter
} from "../../../../../../../script.js";
import { getContext } from "../../../../../../extensions.js";
import { power_user } from "../../../../../../power-user.js";
import {
  charUpdatePrimaryWorld,
  checkWorldInfo,
  convertCharacterBook,
  getWorldInfoSettings,
  loadWorldInfo,
  METADATA_KEY,
  saveWorldInfo,
  selected_world_info,
  updateWorldInfoSettings,
  updateWorldInfoList,
  world_names
} from "../../../../../../world-info.js";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizeText(value = "") {
  return String(value || "").trim();
}
function normalizeIdText(value = "") {
  return value === null || value === void 0 ? "" : String(value).trim();
}
function asEditableText(value = "") {
  return String(value ?? "");
}
function setValueByPath(target, path, value) {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    return;
  }
  let cursor = target;
  parts.slice(0, -1).forEach((part) => {
    const current = cursor[part];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  });
  cursor[parts[parts.length - 1]] = cloneJson(value);
}
function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  const text = normalizeText(value);
  return text ? [text] : [];
}
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
function readWorldbookEntries(data) {
  const entries = asRecord(data).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return [];
  }
  return Object.values(entries).map((entry) => asRecord(entry)).filter((entry) => Object.keys(entry).length > 0);
}
function readWorldbookEntrySlots(data) {
  const entries = asRecord(data).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return [];
  }
  return Object.entries(entries).map(([key, entry], index) => ({
    key,
    index,
    entry: asRecord(entry)
  })).filter((slot) => Object.keys(slot.entry).length > 0);
}
function stableStringify(value) {
  if (value === void 0) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function buildWorldbookEntryHash(entry) {
  return hashString(stableStringify(entry));
}
function findWorldbookEntrySlot(data, uid) {
  const targetUid = normalizeIdText(uid);
  if (!targetUid) {
    return null;
  }
  return readWorldbookEntrySlots(data).find((slot) => normalizeIdText(slot.entry.uid ?? slot.entry.id ?? slot.index) === targetUid || normalizeIdText(slot.key) === targetUid) || null;
}
function buildWorldbookEntryDraft(name, slot) {
  const entry = slot.entry;
  const entryHash = buildWorldbookEntryHash(entry);
  const keysecondary = normalizeStringList(entry.keysecondary);
  return {
    worldbookName: name,
    uid: normalizeIdText(entry.uid ?? entry.id ?? slot.index),
    comment: asEditableText(entry.comment),
    name: asEditableText(entry.name),
    title: asEditableText(entry.title),
    key: normalizeStringList(entry.key),
    keysecondary,
    secondary_keys: normalizeStringList(entry.secondary_keys),
    content: asEditableText(entry.content),
    disable: entry.disable === true,
    enabled: entry.disable !== true,
    constant: entry.constant === true,
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100,
    entryHash,
    revision: entryHash
  };
}
function patchWorldbookEntry(entry, draft) {
  if ("comment" in draft) {
    entry.comment = asEditableText(draft.comment);
  }
  if ("name" in draft) {
    entry.name = asEditableText(draft.name);
  }
  if ("title" in draft) {
    entry.title = asEditableText(draft.title);
  }
  if ("key" in draft || "keys" in draft) {
    entry.key = normalizeStringList(draft.key ?? draft.keys);
  }
  if ("keysecondary" in draft || "secondaryKeys" in draft) {
    entry.keysecondary = normalizeStringList(draft.keysecondary ?? draft.secondaryKeys);
  }
  if ("secondary_keys" in entry && ("secondary_keys" in draft || "secondaryKeys" in draft)) {
    entry.secondary_keys = normalizeStringList(draft.keysecondary ?? draft.secondary_keys ?? draft.secondaryKeys);
  }
  if ("content" in draft) {
    entry.content = asEditableText(draft.content);
  }
  if ("disable" in draft) {
    entry.disable = draft.disable === true;
  }
  if ("enabled" in draft && !("disable" in draft)) {
    entry.disable = draft.enabled === false;
  }
  if ("constant" in draft) {
    entry.constant = draft.constant === true;
  }
  if ("order" in draft) {
    const order = Number(draft.order);
    if (Number.isFinite(order)) {
      entry.order = order;
    }
  }
}
function syncWorldbookOriginalDataEntry(data, uid, entry) {
  const originalData = asRecord(data.originalData);
  const originalEntries = Array.isArray(originalData.entries) ? originalData.entries : [];
  if (!originalEntries.length) {
    return;
  }
  const originalEntry = originalEntries.map((item) => asRecord(item)).find((item) => normalizeIdText(item.uid) === uid || normalizeIdText(item.id) === uid);
  if (!originalEntry) {
    return;
  }
  const mappings = [
    ["comment", entry.comment],
    ["content", entry.content],
    ["keys", normalizeStringList(entry.key)],
    ["secondary_keys", normalizeStringList(entry.keysecondary)],
    ["insertion_order", Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100],
    ["constant", entry.constant === true],
    ["enabled", entry.disable !== true]
  ];
  mappings.forEach(([path, value]) => setValueByPath(originalEntry, path, value));
}
function previewEntryName(entry, index) {
  return normalizeText(entry.comment) || normalizeText(entry.name) || normalizeText(entry.title) || `\u6761\u76EE ${index + 1}`;
}
function readHistoryMessages(context = {}) {
  return Array.isArray(context.history) ? context.history : [];
}
function ensureTimedBucket(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!key || !item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const source = item;
    const normalized = {};
    const hash = Number(source.hash);
    const start = Number(source.start);
    const end = Number(source.end);
    if (Number.isFinite(hash)) {
      normalized.hash = hash;
    }
    if (Number.isFinite(start)) {
      normalized.start = start;
    }
    if (Number.isFinite(end)) {
      normalized.end = end;
    }
    if (source.protected === true) {
      normalized.protected = true;
    }
    if (Object.keys(normalized).length) {
      result[key] = normalized;
    }
  });
  return result;
}
function normalizeTimedState(value) {
  const source = asRecord(value);
  return {
    sticky: ensureTimedBucket(source.sticky),
    cooldown: ensureTimedBucket(source.cooldown)
  };
}
function valuesToRecordList(value) {
  if (!value || typeof value !== "object") {
    return [];
  }
  const maybeValues = value.values;
  if (typeof maybeValues !== "function") {
    return [];
  }
  return Array.from(maybeValues.call(value)).map((entry) => asRecord(entry)).filter((entry) => Object.keys(entry).length > 0);
}
function replaceSelectedWorldInfo(names = []) {
  if (!Array.isArray(selected_world_info)) {
    return;
  }
  selected_world_info.splice(0, selected_world_info.length, ...names);
}
function collectGlobalWorldbookNames(context = {}) {
  const sessionMeta = asRecord(context.sessionMeta);
  const worldbookSources = Array.isArray(sessionMeta.worldbookSources) ? sessionMeta.worldbookSources : [];
  return worldbookSources.filter((source) => normalizeText(asRecord(source).sourceType) === "global").map((source) => normalizeText(asRecord(source).name)).filter(Boolean);
}
function dedupeSources(sources = []) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  sources.forEach((source, index) => {
    const name = normalizeText(source.name);
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    result.push({
      name,
      ...source.sourceType ? { sourceType: source.sourceType } : {},
      ...Number.isFinite(Number(source.sourceIndex)) ? { sourceIndex: Number(source.sourceIndex) } : { sourceIndex: index }
    });
  });
  return result;
}
function isNativeRuntimeSource(source = { name: "" }) {
  return normalizeText(source.sourceType) !== "embedded";
}
function collectRuntimeSources(context = {}) {
  const sessionMeta = asRecord(context.sessionMeta);
  const metaSources = Array.isArray(sessionMeta.worldbookSources) ? sessionMeta.worldbookSources.map((source, index) => {
    const record = asRecord(source);
    return {
      name: normalizeText(record.name),
      sourceType: normalizeText(record.sourceType),
      sourceIndex: Number.isFinite(Number(record.sourceIndex)) ? Number(record.sourceIndex) : index
    };
  }) : [];
  const legacyMetaSources = !metaSources.length && Array.isArray(sessionMeta.worldbookNames) ? sessionMeta.worldbookNames.map((name, index) => ({
    name: normalizeText(name),
    sourceType: "global",
    sourceIndex: index
  })) : [];
  const bookSources = Array.isArray(context.worldBooks) ? context.worldBooks.map((book, index) => ({
    name: normalizeText(book.name),
    sourceType: normalizeText(book.worldSourceType),
    sourceIndex: Number.isFinite(Number(book.worldSourceIndex)) ? Number(book.worldSourceIndex) : index
  })) : [];
  return dedupeSources([...metaSources, ...legacyMetaSources, ...bookSources]).filter((source) => isNativeRuntimeSource(source));
}
function buildHistoryScanLines(context = {}, currentUserMessage = "", includeNames = false) {
  const userName = normalizeText(context.user?.name) || "User";
  const characterName = normalizeText(context.character?.name) || "Assistant";
  const lines = readHistoryMessages(context).filter((message) => ["user", "assistant"].includes(normalizeText(message.role))).map((message) => {
    const role = normalizeText(message.role) === "user" || message.is_user === true ? "user" : "assistant";
    const content = normalizeText(message.content || message.mes || message.message);
    if (!content) {
      return "";
    }
    if (!includeNames) {
      return content;
    }
    const speaker = role === "user" ? normalizeText(message.name) || userName : normalizeText(message.name) || characterName;
    return `${speaker}: ${content}`;
  }).filter(Boolean);
  const current = normalizeText(currentUserMessage);
  if (current) {
    lines.push(includeNames ? `${userName}: ${current}` : current);
  }
  return lines.reverse();
}
function buildGlobalScanData(input = {}) {
  const context = input.context || {};
  const character = context.character || {};
  const user = context.user || {};
  const data = asRecord(character.data);
  const extensions = asRecord(data.extensions);
  return {
    personaDescription: normalizeText(user.persona || user.description),
    characterDescription: normalizeText(character.description || data.description),
    characterPersonality: normalizeText(character.personality || data.personality),
    characterDepthPrompt: normalizeText(asRecord(extensions.depth_prompt).prompt),
    scenario: normalizeText(character.scenario || data.scenario),
    creatorNotes: normalizeText(character.creatorNotes || character.creator_notes || data.creator_notes),
    trigger: normalizeText(input.trigger || context.worldSettings?.trigger) || "normal"
  };
}
function describeActivationReason(entry) {
  if (entry.constant === true) {
    return "constant";
  }
  return "native";
}
function normalizePromptEntryRole(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return 0;
}
function buildActivatedPromptEntries(entries, sources) {
  const sourceByName = new Map(sources.map((source) => [normalizeText(source.name), source]));
  return entries.map((entry, index) => {
    const sourceWorldBook = normalizeText(entry.world || entry.sourceWorldBook);
    const source = sourceByName.get(sourceWorldBook);
    const uid = entry.uid ?? entry.id ?? index;
    return {
      uid,
      id: uid,
      key: normalizeStringList(entry.key),
      keysecondary: normalizeStringList(entry.keysecondary),
      secondary_keys: normalizeStringList(entry.secondary_keys),
      comment: normalizeText(entry.comment),
      title: normalizeText(entry.title),
      name: normalizeText(entry.name),
      content: normalizeText(entry.content),
      order: Number(entry.order ?? 100),
      position: Number(entry.position ?? 0),
      role: normalizePromptEntryRole(entry.role),
      depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : 0,
      constant: entry.constant === true,
      disable: entry.disable === true,
      enabled: entry.disable !== true,
      vectorized: entry.vectorized === true,
      decorators: Array.isArray(entry.decorators) ? cloneJson(entry.decorators) : [],
      selective: entry.selective === true,
      selectiveLogic: Number.isFinite(Number(entry.selectiveLogic)) ? Number(entry.selectiveLogic) : 0,
      scanDepth: Number.isFinite(Number(entry.scanDepth)) ? Number(entry.scanDepth) : null,
      caseSensitive: entry.caseSensitive === true,
      matchWholeWords: entry.matchWholeWords === true,
      ignoreBudget: entry.ignoreBudget === true,
      excludeRecursion: entry.excludeRecursion === true,
      preventRecursion: entry.preventRecursion === true,
      delayUntilRecursion: entry.delayUntilRecursion,
      characterFilter: cloneJson(entry.characterFilter),
      group: normalizeText(entry.group),
      groupOverride: entry.groupOverride === true,
      groupWeight: Number.isFinite(Number(entry.groupWeight)) ? Number(entry.groupWeight) : void 0,
      useGroupScoring: typeof entry.useGroupScoring === "boolean" ? entry.useGroupScoring : null,
      matchPersonaDescription: entry.matchPersonaDescription === true,
      matchCharacterDescription: entry.matchCharacterDescription === true,
      matchCharacterPersonality: entry.matchCharacterPersonality === true,
      matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt === true,
      matchScenario: entry.matchScenario === true,
      matchCreatorNotes: entry.matchCreatorNotes === true,
      probability: Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : void 0,
      useProbability: entry.useProbability !== false,
      sticky: entry.sticky,
      cooldown: Number.isFinite(Number(entry.cooldown)) ? Number(entry.cooldown) : void 0,
      delay: Number.isFinite(Number(entry.delay)) ? Number(entry.delay) : void 0,
      triggers: normalizeStringList(entry.triggers),
      outletName: normalizeText(entry.outletName),
      sourceWorldBook,
      worldSourceType: source?.sourceType,
      worldSourceIndex: source?.sourceIndex,
      extensions: {
        nativeActivationReason: describeActivationReason(entry)
      },
      activationReason: describeActivationReason(entry)
    };
  }).filter((entry) => !!normalizeText(entry.content));
}
function captureRuntimeState() {
  const context = asRecord(getContext?.() || {});
  const extensionPrompts = asRecord(context.extensionPrompts);
  return {
    selectedWorldInfo: Array.isArray(selected_world_info) ? [...selected_world_info] : [],
    chatLore: normalizeText(chat_metadata?.[METADATA_KEY]),
    personaLore: normalizeText(power_user?.persona_description_lorebook),
    characterId: normalizeText(this_chid),
    characterName: normalizeText(name2),
    timedState: normalizeTimedState(chat_metadata?.timedWorldInfo),
    authorNote: cloneJson(extensionPrompts.note),
    emit: eventSource?.emit
  };
}
function applyRuntimeState(input) {
  const globalNames = input.sources.filter((source) => source.sourceType === "global").map((source) => normalizeText(source.name)).filter(Boolean);
  replaceSelectedWorldInfo(globalNames);
  const chatLore = input.sources.find((source) => source.sourceType === "chat")?.name || "";
  const personaLore = input.sources.find((source) => source.sourceType === "persona")?.name || "";
  if (chatLore) {
    chat_metadata[METADATA_KEY] = chatLore;
  } else {
    delete chat_metadata[METADATA_KEY];
  }
  power_user.persona_description_lorebook = personaLore || "";
  setCharacterId(normalizeText(input.context.character?.id) || void 0);
  if (normalizeText(input.context.character?.name)) {
    setCharacterName(normalizeText(input.context.character?.name));
  }
  chat_metadata.timedWorldInfo = cloneJson(normalizeTimedState(input.timedState));
  if (eventSource && typeof eventSource.emit === "function") {
    eventSource.emit = async () => void 0;
  }
}
function restoreRuntimeState(snapshot) {
  replaceSelectedWorldInfo(snapshot.selectedWorldInfo);
  if (snapshot.chatLore) {
    chat_metadata[METADATA_KEY] = snapshot.chatLore;
  } else {
    delete chat_metadata[METADATA_KEY];
  }
  power_user.persona_description_lorebook = snapshot.personaLore || "";
  setCharacterId(snapshot.characterId || void 0);
  setCharacterName(snapshot.characterName || "");
  chat_metadata.timedWorldInfo = cloneJson(snapshot.timedState);
  const context = asRecord(getContext?.() || {});
  const extensionPrompts = asRecord(context.extensionPrompts);
  if (snapshot.authorNote !== void 0) {
    extensionPrompts.note = cloneJson(snapshot.authorNote);
  }
  if (eventSource) {
    eventSource.emit = snapshot.emit;
  }
}
function getCharacterRecordById(characterId) {
  const normalizedId = normalizeIdText(characterId);
  const numericId = Number(normalizedId);
  if (!normalizedId || !Number.isInteger(numericId) || numericId < 0) {
    return {};
  }
  const list = Array.isArray(characters) ? characters : [];
  return asRecord(list[numericId]);
}
async function hydrateCharacterRecordById(characterId) {
  const normalizedId = normalizeIdText(characterId);
  const numericId = Number(normalizedId);
  if (!Number.isInteger(numericId) || numericId < 0) {
    return {};
  }
  const character = getCharacterRecordById(normalizedId);
  const avatar = normalizeText(character.avatar);
  if (avatar && avatar !== "none" && (character.shallow === true || !normalizeText(character.json_data))) {
    if (character.shallow === true) {
      await unshallowCharacter(String(numericId));
    } else {
      await getOneCharacter(avatar);
    }
  }
  return getCharacterRecordById(normalizedId);
}
async function prepareCharacterEditorForWorldbookBinding(characterId) {
  const normalizedId = normalizeIdText(characterId);
  const numericId = Number(normalizedId);
  if (!Number.isInteger(numericId) || numericId < 0 || !Object.keys(getCharacterRecordById(normalizedId)).length) {
    throw new Error("\u5F53\u524D\u89D2\u8272\u672A\u627E\u5230\uFF0C\u65E0\u6CD5\u7ED1\u5B9A\u4E16\u754C\u4E66\u3002");
  }
  select_selected_character(numericId, { switchMenu: false });
  await Promise.resolve();
}
function getJQuery() {
  const candidate = globalThis.$;
  return typeof candidate === "function" ? candidate : null;
}
function readJQueryData(selector, key) {
  return getJQuery()?.(selector).data(key);
}
function captureCharacterEditorJQueryData() {
  const jq = getJQuery();
  if (!jq) {
    return [];
  }
  const slots = [
    { selector: ".open_alternate_greetings", key: "chid" },
    { selector: "#set_character_world", key: "chid" }
  ];
  return slots.flatMap((slot) => {
    const items = [];
    jq(slot.selector).each(function captureDataSlot() {
      const value = jq(this).data(slot.key);
      items.push({
        element: this,
        key: slot.key,
        value,
        hadValue: value !== void 0
      });
    });
    return items;
  });
}
function captureCharacterEditorSnapshot() {
  const form = document.querySelector("#form_create");
  const controls = Array.from(document.querySelectorAll(
    "#form_create input, #form_create select, #form_create textarea"
  )).filter((control) => !(control instanceof HTMLInputElement && control.type === "file")).map((control) => ({
    control,
    value: control.value,
    ...control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type) ? { checked: control.checked } : {},
    ...control instanceof HTMLSelectElement && control.multiple ? { selectedValues: Array.from(control.selectedOptions).map((option) => option.value) } : {}
  }));
  return {
    actionType: form instanceof HTMLFormElement ? form.getAttribute("actiontype") : null,
    controls,
    jqueryData: captureCharacterEditorJQueryData()
  };
}
function restoreCharacterEditorSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  const form = document.querySelector("#form_create");
  if (form instanceof HTMLFormElement) {
    if (snapshot.actionType === null) {
      form.removeAttribute("actiontype");
    } else {
      form.setAttribute("actiontype", snapshot.actionType);
    }
  }
  snapshot.controls.forEach((item) => {
    const control = item.control;
    if (!control.isConnected) {
      return;
    }
    if (control instanceof HTMLSelectElement && control.multiple && item.selectedValues) {
      Array.from(control.options).forEach((option) => {
        option.selected = item.selectedValues?.includes(option.value) === true;
      });
      return;
    }
    control.value = item.value;
    if (control instanceof HTMLInputElement && item.checked !== void 0) {
      control.checked = item.checked;
    }
  });
  const jq = getJQuery();
  if (!jq) {
    return;
  }
  snapshot.jqueryData.forEach((item) => {
    if (!item.element.isConnected) {
      return;
    }
    if (item.hadValue) {
      jq(item.element).data(item.key, item.value);
    } else {
      jq(item.element).removeData(item.key);
    }
  });
}
function isCharacterEditorFocusedOn(characterId) {
  const targetId = normalizeIdText(characterId);
  if (!targetId) {
    return false;
  }
  const form = document.querySelector("#form_create");
  if (form instanceof HTMLFormElement && form.getAttribute("actiontype") === "createcharacter") {
    return false;
  }
  const worldEditorId = normalizeIdText(readJQueryData("#set_character_world", "chid"));
  const greetingsEditorId = normalizeIdText(readJQueryData(".open_alternate_greetings", "chid"));
  return worldEditorId === targetId && greetingsEditorId === targetId;
}
async function bindCharacterWorldbookThroughEditor(characterId, name) {
  const shouldPrepareEditor = !isCharacterEditorFocusedOn(characterId);
  const snapshot = shouldPrepareEditor ? captureCharacterEditorSnapshot() : null;
  try {
    if (shouldPrepareEditor) {
      await prepareCharacterEditorForWorldbookBinding(characterId);
    }
    await charUpdatePrimaryWorld(name);
  } finally {
    restoreCharacterEditorSnapshot(snapshot);
  }
  const state = await readCharacterWorldbookState(characterId);
  if (state.boundWorldbookName !== name || state.boundExists !== true) {
    throw new Error(`\u89D2\u8272\u4E16\u754C\u4E66\u7ED1\u5B9A\u672A\u4FDD\u5B58\u6210\u529F\uFF1A${name}`);
  }
  return state;
}
function readWorldbookBindingState(character, names) {
  const characterData = readCharacterData(character);
  const extensions = asRecord(characterData.extensions);
  const boundWorldbookName = normalizeText(extensions.world);
  return {
    boundWorldbookName,
    boundExists: !!boundWorldbookName && names.includes(boundWorldbookName)
  };
}
function readEmbeddedWorldbookState(character) {
  const book = readCharacterBook(character);
  return {
    hasEmbeddedBook: hasCharacterBookEntries(book),
    embeddedBookName: characterBookName(character, book)
  };
}
function buildCharacterWorldbookState(requestedId, currentCharacterId, character, names, options) {
  const includeBinding = options?.includeBinding !== false;
  const includeEmbedded = options?.includeEmbedded !== false;
  const bindingState = includeBinding ? readWorldbookBindingState(character, names) : { boundWorldbookName: "", boundExists: false };
  const embeddedState = includeEmbedded ? readEmbeddedWorldbookState(character) : { hasEmbeddedBook: false, embeddedBookName: "" };
  const characterData = readCharacterData(character);
  return {
    characterId: requestedId,
    currentCharacterId,
    isCurrentCharacter: !!requestedId && requestedId === currentCharacterId,
    characterName: normalizeText(character.name) || normalizeText(characterData.name),
    ...bindingState,
    ...embeddedState,
    worldbookOptions: names
  };
}
function readCharacterData(character) {
  return asRecord(character.data);
}
function readCharacterBook(character) {
  return asRecord(readCharacterData(character).character_book);
}
function hasCharacterBookEntries(book) {
  return Array.isArray(book.entries) && book.entries.length > 0;
}
function characterBookName(character, book) {
  const characterName = normalizeText(character.name) || normalizeText(readCharacterData(character).name) || "Character";
  return normalizeText(book.name) || `${characterName}'s Lorebook`;
}
async function readCharacterWorldbookState(characterId) {
  const requestedId = normalizeIdText(characterId);
  const currentCharacterId = normalizeIdText(this_chid);
  const names = await ensureWorldbookNames();
  const character = await hydrateCharacterRecordById(requestedId);
  return buildCharacterWorldbookState(requestedId, currentCharacterId, character, names, {
    includeBinding: true,
    includeEmbedded: true
  });
}
async function readGlobalWorldbooksState() {
  const options = await ensureWorldbookNames();
  const selected = Array.isArray(selected_world_info) ? selected_world_info.map((name) => normalizeText(name)).filter((name) => options.includes(name)) : [];
  return { options, selected };
}
async function ensureWorldbookNames() {
  if (!Array.isArray(world_names) || !world_names.length) {
    await updateWorldInfoList();
  }
  return Array.isArray(world_names) ? [...world_names] : [];
}
async function listTavernWorldbookSources(input = {}) {
  const payload = asRecord(input);
  const context = asRecord(payload.context);
  const requestedContext = Object.keys(context).length ? context : void 0;
  const names = await ensureWorldbookNames();
  const sourceContext = requestedContext || {};
  const globalNameSet = new Set(collectGlobalWorldbookNames(sourceContext));
  return {
    books: names.map((name) => ({
      name,
      globalActive: globalNameSet.has(name)
    }))
  };
}
async function getTavernWorldbookPreview(input = {}) {
  const payload = asRecord(input);
  const name = normalizeText(payload.name);
  if (!name) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u540D\u79F0\u3002");
  }
  const names = await ensureWorldbookNames();
  if (!names.includes(name)) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\uFF1A${name}`);
  }
  const data = await loadWorldInfo(name);
  const entries = readWorldbookEntries(data);
  const limit = Math.max(1, Math.floor(Number(payload.limit) || 24));
  const previewEntries = entries.map((entry, index) => {
    const keys = normalizeStringList(entry.key);
    const secondaryKeys = normalizeStringList(entry.keysecondary || entry.secondary_keys);
    const content = normalizeText(entry.content);
    return {
      uid: normalizeIdText(entry.uid ?? entry.id ?? index),
      name: previewEntryName(entry, index),
      keys,
      secondaryKeys,
      contentPreview: content,
      enabled: entry.disable !== true,
      constant: entry.constant === true,
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100
    };
  }).sort((a, b) => Number(b.order) - Number(a.order)).slice(0, limit);
  return {
    name,
    entryCount: entries.length,
    enabledCount: entries.filter((entry) => entry.disable !== true).length,
    constantCount: entries.filter((entry) => entry.constant === true).length,
    disabledCount: entries.filter((entry) => entry.disable === true).length,
    keywordCount: entries.reduce((sum, entry) => sum + normalizeStringList(entry.key).length + normalizeStringList(entry.keysecondary || entry.secondary_keys).length, 0),
    totalChars: entries.reduce((sum, entry) => sum + normalizeText(entry.content).length, 0),
    entries: previewEntries
  };
}
async function getTavernWorldbookEntry(input = {}) {
  const payload = asRecord(input);
  const name = normalizeText(payload.name || payload.worldbookName);
  const uid = normalizeIdText(payload.uid);
  if (!name) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u540D\u79F0\u3002");
  }
  if (!uid) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u6761\u76EE UID\u3002");
  }
  const names = await ensureWorldbookNames();
  if (!names.includes(name)) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\uFF1A${name}`);
  }
  const data = await loadWorldInfo(name);
  const slot = findWorldbookEntrySlot(data, uid);
  if (!slot) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\u6761\u76EE\uFF1A${uid}`);
  }
  return buildWorldbookEntryDraft(name, slot);
}
async function saveTavernWorldbookEntry(input = {}) {
  const payload = asRecord(input);
  const name = normalizeText(payload.name || payload.worldbookName);
  const uid = normalizeIdText(payload.uid);
  const entryHash = normalizeText(payload.entryHash || payload.revision);
  const draft = asRecord(payload.draft || payload.entry || payload);
  if (!name) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u540D\u79F0\u3002");
  }
  if (!uid) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u6761\u76EE UID\u3002");
  }
  if (!entryHash) {
    throw new Error("\u7F3A\u5C11\u4E16\u754C\u4E66\u6761\u76EE\u7248\u672C\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u4FDD\u5B58\u3002");
  }
  const names = await ensureWorldbookNames();
  if (!names.includes(name)) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\uFF1A${name}`);
  }
  const data = await loadWorldInfo(name);
  const slot = findWorldbookEntrySlot(data, uid);
  if (!slot) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\u6761\u76EE\uFF1A${uid}`);
  }
  const currentHash = buildWorldbookEntryHash(slot.entry);
  if (currentHash !== entryHash) {
    throw new Error("\u8FD9\u4E2A\u4E16\u754C\u4E66\u6761\u76EE\u5DF2\u7ECF\u5728\u9152\u9986\u91CC\u88AB\u4FEE\u6539\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u540E\u518D\u4FDD\u5B58\u3002");
  }
  patchWorldbookEntry(slot.entry, draft);
  syncWorldbookOriginalDataEntry(asRecord(data), uid, slot.entry);
  await saveWorldInfo(name, data, true);
  await updateWorldInfoList();
  return buildWorldbookEntryDraft(name, slot);
}
async function getTavernCharacterWorldbookState(input = {}) {
  const payload = asRecord(input);
  return readCharacterWorldbookState(normalizeIdText(payload.characterId));
}
async function activateTavernCharacterWorldbook(input = {}) {
  const payload = asRecord(input);
  const state = await readCharacterWorldbookState(normalizeIdText(payload.characterId));
  if (state.boundWorldbookName && state.boundExists) {
    return { action: "selected", name: state.boundWorldbookName, state };
  }
  const character = await hydrateCharacterRecordById(state.characterId);
  const book = readCharacterBook(character);
  if (hasCharacterBookEntries(book)) {
    const name = characterBookName(character, book);
    if (state.worldbookOptions.includes(name) && payload.confirmed !== true) {
      return { action: "needs_import_confirmation", name, state };
    }
    const convertedBook = convertCharacterBook(book);
    await saveWorldInfo(name, convertedBook, true);
    await updateWorldInfoList();
    const boundState = await bindCharacterWorldbookThroughEditor(state.characterId, name);
    return {
      action: "imported",
      name,
      state: boundState
    };
  }
  return {
    action: "needs_selection",
    worldbookOptions: state.worldbookOptions,
    state
  };
}
async function bindTavernCharacterWorldbook(input = {}) {
  const payload = asRecord(input);
  const characterId = normalizeIdText(payload.characterId);
  const state = await readCharacterWorldbookState(characterId);
  const name = normalizeText(payload.name);
  if (!name) {
    throw new Error("\u7F3A\u5C11\u8981\u7ED1\u5B9A\u7684\u4E16\u754C\u4E66\u540D\u79F0\u3002");
  }
  if (!state.worldbookOptions.includes(name)) {
    throw new Error(`\u627E\u4E0D\u5230\u4E16\u754C\u4E66\uFF1A${name}`);
  }
  return bindCharacterWorldbookThroughEditor(characterId, name);
}
async function getTavernGlobalWorldbooks() {
  return readGlobalWorldbooksState();
}
async function setTavernGlobalWorldbooks(input = {}) {
  const payload = asRecord(input);
  const options = await ensureWorldbookNames();
  const selected = normalizeStringList(payload.selected).filter((name) => options.includes(name));
  const settings = getWorldInfoSettings();
  updateWorldInfoSettings(settings, selected);
  await updateWorldInfoList();
  return readGlobalWorldbooksState();
}
async function getTavernWorldbookRuntime(input = {}) {
  const payload = asRecord(input);
  const context = payload.context || {};
  const includeNames = context.worldSettings?.includeNames === true || getWorldInfoSettings().world_info_include_names === true;
  const chatLines = buildHistoryScanLines(context, payload.currentUserMessage, includeNames);
  const globalScanData = buildGlobalScanData(payload);
  const maxContext = Math.max(1, Number(payload.maxContext) || Number(asRecord(getContext?.() || {}).maxContext) || 4096);
  const sources = collectRuntimeSources(context);
  const snapshot = captureRuntimeState();
  applyRuntimeState({
    context,
    sources,
    timedState: normalizeTimedState(payload.timedState)
  });
  try {
    const activated = await checkWorldInfo(chatLines, maxContext, false, globalScanData);
    const activatedPromptEntries = buildActivatedPromptEntries(
      valuesToRecordList(activated.allActivatedEntries),
      sources
    );
    return {
      trigger: normalizeText(globalScanData.trigger),
      sourceNames: sources,
      activatedEntries: activatedPromptEntries,
      worldInfoBefore: normalizeText(activated.worldInfoBefore),
      worldInfoAfter: normalizeText(activated.worldInfoAfter),
      worldInfoExamples: Array.isArray(activated.EMEntries) ? activated.EMEntries.map((entry) => ({
        position: normalizeText(asRecord(entry).position),
        content: normalizeText(asRecord(entry).content)
      })).filter((entry) => entry.content) : [],
      worldInfoDepth: Array.isArray(activated.WIDepthEntries) ? activated.WIDepthEntries.map((entry) => ({
        depth: Number(asRecord(entry).depth),
        role: Number(asRecord(entry).role),
        entries: normalizeStringList(asRecord(entry).entries)
      })).filter((entry) => Array.isArray(entry.entries) && entry.entries.length) : [],
      anBefore: normalizeStringList(activated.ANBeforeEntries),
      anAfter: normalizeStringList(activated.ANAfterEntries),
      outlets: Object.fromEntries(
        Object.entries(asRecord(activated.outletEntries)).map(([key, value]) => [key, normalizeStringList(value)]).filter(([, value]) => value.length)
      ),
      timedState: normalizeTimedState(chat_metadata?.timedWorldInfo)
    };
  } finally {
    restoreRuntimeState(snapshot);
  }
}
export {
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
};
