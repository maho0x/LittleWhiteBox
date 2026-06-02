/* eslint-disable -- generated from TypeScript source; run npm run build:tavern */
import { getContext } from "../../../../../../extensions.js";
import { getRequestHeaders } from "../../../../../../../script.js";
function normalizeText(value = "") {
  return String(value || "").trim();
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readEntryList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => asRecord(item));
  }
  const record = asRecord(value);
  return Object.keys(record).length ? Object.values(record).map((item) => asRecord(item)) : [];
}
function addUnique(target, value) {
  if (Array.isArray(value)) {
    value.forEach((item) => addUnique(target, item));
    return;
  }
  const text = normalizeText(value);
  if (text && !target.includes(text)) {
    target.push(text);
  }
}
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
function makeWorldbookEntryKey(entry = {}, fallbackIndex = 0) {
  const uid = normalizeText(entry.uid ?? entry.id);
  if (uid) {
    return `uid:${uid}`;
  }
  const bodyKey = [
    "body",
    normalizeText(entry.comment || entry.title || entry.name),
    normalizeText(entry.content),
    JSON.stringify(entry.key || ""),
    JSON.stringify(entry.keysecondary || entry.secondary_keys || "")
  ].join("\0");
  return bodyKey === 'body\0\0\0""\0""' ? `empty:${fallbackIndex}` : bodyKey;
}
function dedupeWorldBooks(books = []) {
  const byName = /* @__PURE__ */ new Map();
  books.forEach((book, bookIndex) => {
    const name = normalizeText(book.name) || `worldbook-${bookIndex + 1}`;
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, {
        ...book,
        name,
        entries: []
      });
    }
    const target = byName.get(name);
    if (!target.error && book.error) {
      target.error = book.error;
    }
    const seen = new Set(readEntryList(target.entries).map((entry, index) => makeWorldbookEntryKey(entry, index)));
    readEntryList(book.entries).forEach((entry, entryIndex) => {
      const key = makeWorldbookEntryKey(entry, entryIndex);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      target.entries.push(entry);
    });
  });
  return Array.from(byName.values());
}
function getWindowRecord() {
  return window;
}
function resolveCharacterId(ctx = getContext?.() || {}, options = {}) {
  return options.characterId ?? ctx.characterId ?? ctx.this_chid;
}
function getCurrentCharacter(ctx = getContext?.() || {}, options = {}) {
  const id = resolveCharacterId(ctx, options);
  const getCharacter = typeof ctx.getCharacter === "function" ? ctx.getCharacter : null;
  if (getCharacter && id !== void 0 && id !== null) {
    try {
      const character = getCharacter(id);
      if (character && typeof character === "object") {
        return character;
      }
    } catch {
    }
  }
  if (Array.isArray(ctx.characters) && id !== void 0 && id !== null) {
    const character = ctx.characters[Number(id)];
    return character && typeof character === "object" ? character : null;
  }
  return null;
}
function normalizeCharacter(ctx = getContext?.() || {}, options = {}) {
  const character = getCurrentCharacter(ctx, options) || {};
  const data = asRecord(character.data) || character;
  return {
    id: normalizeText(resolveCharacterId(ctx, options)),
    name: normalizeText(character.name || data.name || ctx.name2),
    avatar: normalizeText(character.avatar || data.avatar),
    description: normalizeText(data.description || character.description),
    personality: normalizeText(data.personality || character.personality),
    scenario: normalizeText(data.scenario || character.scenario),
    firstMessage: normalizeText(data.first_mes || character.first_mes),
    mesExample: normalizeText(data.mes_example || character.mes_example),
    creatorNotes: normalizeText(data.creator_notes || character.creator_notes),
    data: cloneJson(data)
  };
}
function normalizeUser(ctx = getContext?.() || {}) {
  return {
    name: normalizeText(ctx.name1) || "User",
    persona: normalizeText(ctx.userPersona || ctx.persona)
  };
}
function normalizeHistory(ctx = getContext?.() || {}) {
  return asArray(ctx.chat).map((message) => ({
    role: message?.is_user ? "user" : "assistant",
    name: normalizeText(message?.name),
    content: normalizeText(message?.mes || message?.message || message?.content),
    is_user: !!message?.is_user
  })).filter((message) => message.content);
}
function isCurrentCharacterSelection(ctx, options = {}) {
  if (options.characterId === void 0 || options.characterId === null || options.characterId === "") {
    return true;
  }
  const currentId = normalizeText(resolveCharacterId(ctx, {}));
  const selectedId = normalizeText(resolveCharacterId(ctx, options));
  return !!selectedId && selectedId === currentId;
}
function normalizeEmbeddedCharacterBook(ctx = getContext?.() || {}, options = {}) {
  const character = getCurrentCharacter(ctx, options) || {};
  const data = asRecord(character.data) || character;
  const characterBook = asRecord(data.character_book);
  const entries = readEntryList(characterBook.entries);
  if (!entries.length) {
    return null;
  }
  const name = normalizeText(characterBook.name) || `${normalizeText(character.name || data.name) || "Character"} embedded lorebook`;
  return {
    name,
    entries: entries.map((entry) => ({
      ...entry,
      sourceWorldBook: name
    }))
  };
}
function collectWorldbookNames(ctx = getContext?.() || {}, options = {}) {
  const character = getCurrentCharacter(ctx, options) || {};
  const data = asRecord(character.data) || character;
  const dataExtensions = asRecord(data.extensions);
  const characterBook = asRecord(data.character_book);
  const windowRecord = getWindowRecord();
  const worldInfo = asRecord(windowRecord.world_info || asRecord(ctx.world_info));
  const names = [];
  addUnique(names, dataExtensions.world);
  addUnique(names, character.world);
  if (!readEntryList(characterBook.entries).length) {
    addUnique(names, characterBook.name);
  }
  addUnique(names, ctx.worldNames);
  addUnique(names, windowRecord.selected_world_info);
  addUnique(names, worldInfo.globalSelect);
  const avatar = normalizeText(character.avatar);
  asArray(worldInfo.charLore).forEach((entry) => {
    if (!avatar || normalizeText(entry?.name) === avatar) {
      addUnique(names, entry?.extraBooks);
    }
  });
  return names;
}
function listCharacters(ctx = getContext?.() || {}) {
  return asArray(ctx.characters).map((character, index) => {
    const data = asRecord(character?.data) || character || {};
    return {
      id: String(index),
      name: normalizeText(character?.name || data.name || `Character ${index + 1}`),
      avatar: normalizeText(character?.avatar || data.avatar),
      description: normalizeText(data.description || character.description),
      personality: normalizeText(data.personality || character.personality),
      scenario: normalizeText(data.scenario || character.scenario),
      firstMessage: normalizeText(data.first_mes || character.first_mes)
    };
  }).filter((character) => character.name);
}
async function fetchWorldbook(name = "") {
  const response = await fetch("/api/worldinfo/get", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    throw new Error(`worldbook_http_${response.status}`);
  }
  const data = await response.json();
  let entries = data?.entries;
  if (entries && !Array.isArray(entries)) {
    entries = Object.values(entries);
  }
  return {
    name,
    entries: Array.isArray(entries) ? entries.map((entry) => ({
      ...asRecord(entry),
      sourceWorldBook: name
    })) : []
  };
}
async function buildTavernContext(options = {}) {
  const ctx = getContext?.() || {};
  const useCurrentHistory = options.includeHistory !== false && isCurrentCharacterSelection(ctx, options);
  const embeddedBook = normalizeEmbeddedCharacterBook(ctx, options);
  const worldbookNames = collectWorldbookNames(ctx, options);
  const fetchedWorldBooks = await Promise.all(worldbookNames.map(async (name) => {
    try {
      return await fetchWorldbook(name);
    } catch (error) {
      return {
        name,
        entries: [],
        error: error instanceof Error ? error.message : String(error || "worldbook_failed")
      };
    }
  }));
  const worldBooks = dedupeWorldBooks([
    ...embeddedBook ? [embeddedBook] : [],
    ...fetchedWorldBooks
  ]);
  const context = {
    character: normalizeCharacter(ctx, options),
    user: normalizeUser(ctx),
    history: useCurrentHistory ? normalizeHistory(ctx) : [],
    worldBooks,
    worldEntries: worldBooks.flatMap((book) => Array.isArray(book.entries) ? book.entries : []),
    sessionMeta: {
      worldbookNames,
      chatLength: useCurrentHistory && Array.isArray(ctx.chat) ? ctx.chat.length : 0,
      historySource: useCurrentHistory ? "sillytavern-current-chat" : "empty-different-character",
      source: "sillytavern-current"
    }
  };
  const character = asRecord(context.character);
  return {
    context,
    diagnostics: {
      ok: !!character.name,
      message: character.name ? `\u5DF2\u8BFB\u53D6\u89D2\u8272\u3001${useCurrentHistory ? "\u5F53\u524D\u804A\u5929" : "\u7A7A\u5386\u53F2"}\u548C ${worldBooks.length} \u672C\u4E16\u754C\u4E66` : "\u5F53\u524D\u6CA1\u6709\u9009\u4E2D\u89D2\u8272\uFF0C\u8C03\u8BD5\u53F0\u53EA\u4F1A\u663E\u793A\u7A7A\u8D44\u6599",
      worldbookErrors: worldBooks.filter((book) => book.error).map((book) => ({
        name: normalizeText(book.name),
        error: normalizeText(book.error)
      }))
    },
    availableCharacters: listCharacters(ctx),
    selectedCharacterId: normalizeText(resolveCharacterId(ctx, options))
  };
}
export {
  buildTavernContext
};
