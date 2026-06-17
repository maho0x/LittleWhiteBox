/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
import {
  baseChatReplace,
  depth_prompt_depth_default,
  depth_prompt_role_default,
  extension_prompt_roles,
  extension_prompt_types,
  extension_prompts,
  name2,
  parseMesExamples,
  setExtensionPrompt
} from "../../../../../../../script.js";
import { NOTE_MODULE_NAME } from "../../../../../../authors-note.js";
import { parseExampleIntoIndividual, prepareOpenAIMessages, promptManager } from "../../../../../../openai.js";
import { power_user } from "../../../../../../power-user.js";
import { persona_description_positions } from "../../../../../../personas.js";
let nativePromptQueue = Promise.resolve();
function normalizeText(value = "") {
  return String(value || "").replace(/\r/g, "").trim();
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizeRole(value) {
  if (value === "user" || value === true || value === 1) {
    return "user";
  }
  if (value === "system" || value === "sys" || value === 0) {
    return "system";
  }
  if (value === "tool") {
    return "tool";
  }
  return "assistant";
}
function captureExtensionPrompts() {
  return Object.fromEntries(
    Object.entries(extension_prompts || {}).map(([key, value]) => [key, { ...asRecord(value) }])
  );
}
function restoreExtensionPrompts(snapshot) {
  Object.keys(extension_prompts || {}).forEach((key) => {
    delete extension_prompts[key];
  });
  Object.entries(snapshot).forEach(([key, value]) => {
    extension_prompts[key] = { ...value };
  });
}
function capturePersonaPrompt() {
  return {
    description: power_user?.persona_description,
    position: power_user?.persona_description_position
  };
}
function restorePersonaPrompt(snapshot) {
  power_user.persona_description = snapshot.description;
  power_user.persona_description_position = snapshot.position;
}
function capturePromptManager() {
  const runtime = asRecord(promptManager);
  const serviceSettings = asRecord(runtime.serviceSettings);
  return {
    activeCharacter: runtime.activeCharacter,
    prompts: cloneJson(serviceSettings.prompts),
    promptOrder: cloneJson(serviceSettings.prompt_order)
  };
}
function restorePromptManager(snapshot) {
  const runtime = asRecord(promptManager);
  const serviceSettings = asRecord(runtime.serviceSettings);
  if ("activeCharacter" in runtime) {
    runtime.activeCharacter = snapshot.activeCharacter;
  }
  serviceSettings.prompts = cloneJson(snapshot.prompts);
  serviceSettings.prompt_order = cloneJson(snapshot.promptOrder);
}
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
function roleNumber(role) {
  if (typeof role === "number" && Number.isFinite(role)) {
    return role;
  }
  if (role === "user") {
    return Number(extension_prompt_roles.USER) || 1;
  }
  if (role === "assistant") {
    return Number(extension_prompt_roles.ASSISTANT) || 2;
  }
  return Number(extension_prompt_roles.SYSTEM) || 0;
}
function buildOpenAiMessages(context = {}, currentUserMessage = "") {
  const characterName = normalizeText(context.character?.name || name2);
  const userName = normalizeText(context.user?.name) || "User";
  const history = Array.isArray(context.history) ? context.history : [];
  const messages = history.map((item) => {
    const role = normalizeRole(item.role ?? item.is_user);
    const content = normalizeText(item.content || item.mes || item.message);
    if (!content) {
      return null;
    }
    return {
      role,
      content,
      ...item.name ? { name: normalizeText(item.name) } : {}
    };
  }).filter(Boolean);
  const userText = normalizeText(currentUserMessage);
  if (userText) {
    messages.push({
      role: "user",
      content: userText,
      name: userName
    });
  }
  const prepared = messages.map((message) => ({
    ...message,
    name: message.name || (message.role === "user" ? userName : message.role === "assistant" ? characterName : void 0)
  }));
  return prepared.reduce((result, message, index) => {
    result[prepared.length - 1 - index] = message;
    return result;
  }, []);
}
function buildMessageExamples(context = {}) {
  const character = context.character || {};
  const data = asRecord(character.data);
  const runtime = context.nativeWorldInfo || {};
  const examples = parseMesExamples(
    baseChatReplace(character.mesExample || character.mes_example || data.mes_example || ""),
    false
  );
  const worldExamples = Array.isArray(runtime.worldInfoExamples) ? runtime.worldInfoExamples : [];
  worldExamples.forEach((entry) => {
    const content = normalizeText(entry?.content);
    if (!content) {
      return;
    }
    const parsed = parseMesExamples(baseChatReplace(content), false);
    const position = String(entry?.position ?? "").toLowerCase();
    if (position === "before" || position === "0") {
      examples.unshift(...parsed);
    } else {
      examples.push(...parsed);
    }
  });
  return examples.map((example) => parseExampleIntoIndividual(
    String(example || "").replace(/<START>/i, "{Example Dialogue:}").replace(/\r/gm, ""),
    true
  ));
}
function addInChatPrompt(key, content, depth, role) {
  const value = normalizeText(content);
  if (!value) {
    return;
  }
  setExtensionPrompt(
    key,
    value,
    Number(extension_prompt_types.IN_CHAT) || 1,
    Math.max(0, Math.floor(Number(depth) || 0)),
    false,
    roleNumber(role)
  );
}
function getUserPersonaPrompt(context = {}) {
  return normalizeText(context.user?.persona || context.user?.description);
}
function applyUserPersonaPrompt(context = {}) {
  const persona = getUserPersonaPrompt(context);
  power_user.persona_description = persona;
  power_user.persona_description_position = persona_description_positions.IN_PROMPT;
  return persona;
}
function readCharacterDepthPrompt(context = {}) {
  const character = context.character || {};
  const data = asRecord(character.data);
  const extensions = asRecord(data.extensions);
  const depthPrompt = asRecord(extensions.depth_prompt);
  const legacyDepthPrompt = asRecord(data.depth_prompt);
  const content = normalizeText(
    character.characterDepthPrompt || character.character_depth_prompt || depthPrompt.prompt || data.character_depth_prompt || legacyDepthPrompt.prompt || (typeof data.depth_prompt === "string" ? data.depth_prompt : "")
  );
  return {
    content,
    depth: Number(depthPrompt.depth ?? depth_prompt_depth_default),
    role: depthPrompt.role ?? depth_prompt_role_default
  };
}
function addCharacterDepthPrompt(context = {}) {
  const prompt = readCharacterDepthPrompt(context);
  if (!prompt.content) {
    return prompt;
  }
  addInChatPrompt(
    "xb_tavern_character_depth_prompt",
    prompt.content,
    prompt.depth,
    prompt.role
  );
  return prompt;
}
function addNativeWorldInfoDepth(runtime = {}) {
  (Array.isArray(runtime.worldInfoDepth) ? runtime.worldInfoDepth : []).forEach((entry, index) => {
    const entries = Array.isArray(entry.entries) ? entry.entries.map(normalizeText).filter(Boolean) : [];
    if (!entries.length) {
      return;
    }
    addInChatPrompt(
      `xb_tavern_wi_depth_${Math.max(0, Number(entry.depth) || 0)}_${roleNumber(entry.role)}_${index}`,
      entries.join("\n"),
      Number(entry.depth) || 0,
      entry.role
    );
  });
}
function characterPromptManagerIdentity(context = {}) {
  const character = context.character || {};
  const id = normalizeText(character.id);
  if (!id) {
    return null;
  }
  return {
    ...asRecord(character.data),
    ...character,
    id,
    name: normalizeText(character.name)
  };
}
function replacePromptOrderForCharacter(existingPromptOrder, characterId = "", nextOrder = []) {
  const containers = (Array.isArray(existingPromptOrder) ? existingPromptOrder : []).map((container) => ({ ...asRecord(container) }));
  const targetId = normalizeText(characterId);
  const targetIndex = containers.findIndex((container) => normalizeText(container.character_id) === targetId);
  const target = targetIndex >= 0 ? containers[targetIndex] : { character_id: targetId };
  const replacement = {
    ...target,
    character_id: normalizeText(target.character_id) || targetId,
    order: cloneJson(nextOrder)
  };
  if (targetIndex >= 0) {
    containers[targetIndex] = replacement;
  } else {
    containers.push(replacement);
  }
  return containers;
}
function applyChatPresetPromptManager(chatPreset = {}, context = {}) {
  const preset = asRecord(chatPreset.promptManager);
  const rawPreset = asRecord(preset.rawPreset);
  const serviceSettings = asRecord(promptManager?.serviceSettings);
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : Array.isArray(rawPreset.prompts) ? rawPreset.prompts : null;
  if (prompts) {
    serviceSettings.prompts = cloneJson(prompts);
  }
  let promptOrder = Array.isArray(preset.promptOrder) ? cloneJson(preset.promptOrder) : Array.isArray(rawPreset.prompt_order) ? cloneJson(rawPreset.prompt_order) : void 0;
  const activeOrder = Array.isArray(preset.activeOrder) ? preset.activeOrder : [];
  const characterId = normalizeText(context.character?.id);
  if (characterId && activeOrder.length) {
    promptOrder = replacePromptOrderForCharacter(promptOrder, characterId, activeOrder);
  }
  if (Array.isArray(promptOrder)) {
    serviceSettings.prompt_order = promptOrder;
  }
}
function applyPromptManagerActiveCharacter(context = {}) {
  const character = characterPromptManagerIdentity(context);
  if (!character || !promptManager) {
    return;
  }
  promptManager.activeCharacter = character;
}
function countUserMessages(context = {}, currentUserMessage = "") {
  const history = Array.isArray(context.history) ? context.history : [];
  const historyCount = history.filter((message) => normalizeRole(message.role ?? message.is_user) === "user").length;
  return historyCount + (normalizeText(currentUserMessage) ? 1 : 0);
}
function resolveAuthorNoteState(context = {}, currentUserMessage = "") {
  const note = asRecord(context.authorNote);
  const interval = Number(note.interval ?? 0);
  const position = Number(note.position ?? extension_prompt_types.IN_CHAT);
  const depth = Number(note.depth ?? 4);
  const role = Number(note.role ?? extension_prompt_roles.SYSTEM);
  let userMessageCount = countUserMessages(context, currentUserMessage);
  if (interval === 1) {
    userMessageCount = 1;
  }
  const shouldAddPrompt = userMessageCount > 0 && interval > 0 && (userMessageCount >= interval ? userMessageCount % interval === 0 : false);
  let prompt = shouldAddPrompt ? normalizeText(note.prompt) : "";
  if (shouldAddPrompt && note.characterUse === true) {
    const charaPrompt = normalizeText(note.characterPrompt);
    switch (Number(note.characterPosition)) {
      case 1:
        prompt = [charaPrompt, prompt].filter(Boolean).join("\n");
        break;
      case 2:
        prompt = [prompt, charaPrompt].filter(Boolean).join("\n");
        break;
      default:
        prompt = charaPrompt;
        break;
    }
  }
  return {
    shouldAddPrompt,
    prompt,
    position,
    depth,
    role,
    scan: note.scan === true
  };
}
function applyAuthorNotePrompt(context = {}, currentUserMessage = "", runtime = {}) {
  const state = resolveAuthorNoteState(context, currentUserMessage);
  const before = (Array.isArray(runtime.anBefore) ? runtime.anBefore : []).map(normalizeText).filter(Boolean);
  const after = (Array.isArray(runtime.anAfter) ? runtime.anAfter : []).map(normalizeText).filter(Boolean);
  const value = state.shouldAddPrompt ? [...before, state.prompt, ...after].filter(Boolean).join("\n") : "";
  setExtensionPrompt(
    NOTE_MODULE_NAME,
    value,
    state.shouldAddPrompt ? state.position : Number(extension_prompt_types.NONE),
    state.depth,
    state.scan,
    state.role
  );
}
function toXbMessage(message) {
  const record = asRecord(message);
  const role = normalizeRole(record.role);
  const content = typeof record.content === "string" ? record.content : record.content === null || record.content === void 0 ? "" : JSON.stringify(record.content);
  if (!content) {
    return null;
  }
  return {
    role,
    content,
    ...record.name ? { name: normalizeText(record.name) } : {},
    ...Array.isArray(record.tool_calls) ? { tool_calls: record.tool_calls } : {},
    ...record.tool_call_id ? { tool_call_id: normalizeText(record.tool_call_id) } : {}
  };
}
function getCharacterField(context = {}, key, camelKey) {
  const character = context.character || {};
  const data = asRecord(character.data);
  return baseChatReplace(character[camelKey] || data[key] || "");
}
async function buildNativePromptNow(input = {}) {
  const context = input.context || {};
  const character = context.character || {};
  const data = asRecord(character.data);
  const runtime = context.nativeWorldInfo || {};
  const snapshot = captureExtensionPrompts();
  const personaSnapshot = capturePersonaPrompt();
  const promptManagerSnapshot = capturePromptManager();
  try {
    applyChatPresetPromptManager(input.chatPreset, context);
    applyPromptManagerActiveCharacter(context);
    applyUserPersonaPrompt(context);
    addInChatPrompt("xb_tavern_memory_d1", input.memoryPrompt, 1, "system");
    addInChatPrompt("xb_tavern_chance_d1", input.chancePrompt, 1, "system");
    addInChatPrompt("xb_tavern_action_check_d0", input.actionCheckPrompt, 0, "system");
    addCharacterDepthPrompt(context);
    addNativeWorldInfoDepth(runtime);
    applyAuthorNotePrompt(context, input.currentUserMessage || "", runtime);
    const [prepared] = await prepareOpenAIMessages({
      name2: normalizeText(character.name || name2),
      charDescription: getCharacterField(context, "description", "description"),
      charPersonality: getCharacterField(context, "personality", "personality"),
      scenario: getCharacterField(context, "scenario", "scenario"),
      worldInfoBefore: normalizeText(runtime.worldInfoBefore),
      worldInfoAfter: normalizeText(runtime.worldInfoAfter),
      extensionPrompts: extension_prompts,
      bias: "",
      type: normalizeText(input.generationType) || "normal",
      quietPrompt: "",
      quietImage: null,
      cyclePrompt: "",
      systemPromptOverride: baseChatReplace(data.system_prompt || ""),
      jailbreakPromptOverride: baseChatReplace(data.post_history_instructions || ""),
      messages: buildOpenAiMessages(context, input.currentUserMessage || ""),
      messageExamples: buildMessageExamples(context)
    }, true);
    const messages = (Array.isArray(prepared) ? prepared : []).map(toXbMessage).filter(Boolean);
    return {
      messages,
      source: "sillytavern-prepareOpenAIMessages",
      promptMessageCount: messages.length
    };
  } finally {
    restorePromptManager(promptManagerSnapshot);
    restorePersonaPrompt(personaSnapshot);
    restoreExtensionPrompts(snapshot);
  }
}
function runNativePromptExclusive(task) {
  const run = nativePromptQueue.then(task, task);
  nativePromptQueue = run.catch(() => void 0);
  return run;
}
async function buildTavernNativeChatPrompt(input = {}) {
  return runNativePromptExclusive(() => buildNativePromptNow(asRecord(input)));
}
export {
  buildTavernNativeChatPrompt
};
