import { getContext } from '../../../../../../extensions.js';
import { getRequestHeaders } from '../../../../../../../script.js';

interface TavernHostOptions {
    characterId?: string | number;
    includeHistory?: boolean;
}

interface TavernHostDiagnostics {
    ok: boolean;
    message: string;
    worldbookErrors: Array<{ name: string; error: string }>;
}

interface TavernHostCharacterOption {
    id: string;
    name: string;
    avatar: string;
    description: string;
    personality: string;
    scenario: string;
    firstMessage: string;
}

interface TavernHostContextPayload {
    context: Record<string, unknown>;
    diagnostics: TavernHostDiagnostics;
    availableCharacters: TavernHostCharacterOption[];
    selectedCharacterId: string;
}

function normalizeText(value: unknown = ''): string {
    return String(value || '').trim();
}

function asArray<T = unknown>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readEntryList(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {return value.map((item) => asRecord(item));}
    const record = asRecord(value);
    return Object.keys(record).length ? Object.values(record).map((item) => asRecord(item)) : [];
}

function addUnique(target: string[], value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach((item) => addUnique(target, item));
        return;
    }
    const text = normalizeText(value);
    if (text && !target.includes(text)) {target.push(text);}
}

function cloneJson<T>(value: T): T {
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

function makeWorldbookEntryKey(entry: Record<string, unknown> = {}, fallbackIndex = 0): string {
    const uid = normalizeText(entry.uid ?? entry.id);
    if (uid) {return `uid:${uid}`;}
    const bodyKey = [
        'body',
        normalizeText(entry.comment || entry.title || entry.name),
        normalizeText(entry.content),
        JSON.stringify(entry.key || ''),
        JSON.stringify(entry.keysecondary || entry.secondary_keys || ''),
    ].join('\u0000');
    return bodyKey === 'body\u0000\u0000\u0000""\u0000""' ? `empty:${fallbackIndex}` : bodyKey;
}

function dedupeWorldBooks(books: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    const byName = new Map<string, Record<string, unknown>>();
    books.forEach((book, bookIndex) => {
        const name = normalizeText(book.name) || `worldbook-${bookIndex + 1}`;
        const existing = byName.get(name);
        if (!existing) {
            byName.set(name, {
                ...book,
                name,
                entries: [],
            });
        }
        const target = byName.get(name) as Record<string, unknown>;
        if (!target.error && book.error) {target.error = book.error;}
        const seen = new Set(readEntryList(target.entries).map((entry, index) => makeWorldbookEntryKey(entry, index)));
        readEntryList(book.entries).forEach((entry, entryIndex) => {
            const key = makeWorldbookEntryKey(entry, entryIndex);
            if (seen.has(key)) {return;}
            seen.add(key);
            (target.entries as Record<string, unknown>[]).push(entry);
        });
    });
    return Array.from(byName.values());
}

function getWindowRecord(): Record<string, unknown> {
    return window as unknown as Record<string, unknown>;
}

function resolveCharacterId(ctx: Record<string, unknown> = getContext?.() || {}, options: TavernHostOptions = {}): unknown {
    return options.characterId ?? ctx.characterId ?? ctx.this_chid;
}

function getCurrentCharacter(ctx: Record<string, unknown> = getContext?.() || {}, options: TavernHostOptions = {}): Record<string, unknown> | null {
    const id = resolveCharacterId(ctx, options);
    const getCharacter = typeof ctx.getCharacter === 'function' ? ctx.getCharacter as (id: unknown) => unknown : null;
    if (getCharacter && id !== undefined && id !== null) {
        try {
            const character = getCharacter(id);
            if (character && typeof character === 'object') {return character as Record<string, unknown>;}
        } catch {}
    }
    if (Array.isArray(ctx.characters) && id !== undefined && id !== null) {
        const character = ctx.characters[Number(id)];
        return character && typeof character === 'object' ? character as Record<string, unknown> : null;
    }
    return null;
}

function normalizeCharacter(ctx: Record<string, unknown> = getContext?.() || {}, options: TavernHostOptions = {}): Record<string, unknown> {
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
        data: cloneJson(data),
    };
}

function normalizeUser(ctx: Record<string, unknown> = getContext?.() || {}): Record<string, unknown> {
    return {
        name: normalizeText(ctx.name1) || 'User',
        persona: normalizeText(ctx.userPersona || ctx.persona),
    };
}

function normalizeHistory(ctx: Record<string, unknown> = getContext?.() || {}): Array<Record<string, unknown>> {
    return asArray<Record<string, unknown>>(ctx.chat).map((message) => ({
        role: message?.is_user ? 'user' : 'assistant',
        name: normalizeText(message?.name),
        content: normalizeText(message?.mes || message?.message || message?.content),
        is_user: !!message?.is_user,
    })).filter((message) => message.content);
}

function isCurrentCharacterSelection(ctx: Record<string, unknown>, options: TavernHostOptions = {}): boolean {
    if (options.characterId === undefined || options.characterId === null || options.characterId === '') {return true;}
    const currentId = normalizeText(resolveCharacterId(ctx, {}));
    const selectedId = normalizeText(resolveCharacterId(ctx, options));
    return !!selectedId && selectedId === currentId;
}

function normalizeEmbeddedCharacterBook(ctx: Record<string, unknown> = getContext?.() || {}, options: TavernHostOptions = {}): Record<string, unknown> | null {
    const character = getCurrentCharacter(ctx, options) || {};
    const data = asRecord(character.data) || character;
    const characterBook = asRecord(data.character_book);
    const entries = readEntryList(characterBook.entries);
    if (!entries.length) {return null;}
    const name = normalizeText(characterBook.name) || `${normalizeText(character.name || data.name) || 'Character'} embedded lorebook`;
    return {
        name,
        entries: entries.map((entry) => ({
            ...entry,
            sourceWorldBook: name,
        })),
    };
}

function collectWorldbookNames(ctx: Record<string, unknown> = getContext?.() || {}, options: TavernHostOptions = {}): string[] {
    const character = getCurrentCharacter(ctx, options) || {};
    const data = asRecord(character.data) || character;
    const dataExtensions = asRecord(data.extensions);
    const characterBook = asRecord(data.character_book);
    const windowRecord = getWindowRecord();
    const worldInfo = asRecord(windowRecord.world_info || asRecord(ctx.world_info));
    const names: string[] = [];
    addUnique(names, dataExtensions.world);
    addUnique(names, character.world);
    if (!readEntryList(characterBook.entries).length) {
        addUnique(names, characterBook.name);
    }
    addUnique(names, ctx.worldNames);
    addUnique(names, windowRecord.selected_world_info);
    addUnique(names, worldInfo.globalSelect);
    const avatar = normalizeText(character.avatar);
    asArray<Record<string, unknown>>(worldInfo.charLore).forEach((entry) => {
        if (!avatar || normalizeText(entry?.name) === avatar) {addUnique(names, entry?.extraBooks);}
    });
    return names;
}

function listCharacters(ctx: Record<string, unknown> = getContext?.() || {}): TavernHostCharacterOption[] {
    return asArray<Record<string, unknown>>(ctx.characters).map((character, index) => {
        const data = asRecord(character?.data) || character || {};
        return {
            id: String(index),
            name: normalizeText(character?.name || data.name || `Character ${index + 1}`),
            avatar: normalizeText(character?.avatar || data.avatar),
            description: normalizeText(data.description || character.description),
            personality: normalizeText(data.personality || character.personality),
            scenario: normalizeText(data.scenario || character.scenario),
            firstMessage: normalizeText(data.first_mes || character.first_mes),
        };
    }).filter((character) => character.name);
}

async function fetchWorldbook(name = ''): Promise<Record<string, unknown>> {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {throw new Error(`worldbook_http_${response.status}`);}
    const data = await response.json();
    let entries = data?.entries;
    if (entries && !Array.isArray(entries)) {entries = Object.values(entries);}
    return {
        name,
        entries: Array.isArray(entries)
            ? entries.map((entry) => ({
                ...asRecord(entry),
                sourceWorldBook: name,
            }))
            : [],
    };
}

export async function buildTavernContext(options: TavernHostOptions = {}): Promise<TavernHostContextPayload> {
    const ctx = (getContext?.() || {}) as Record<string, unknown>;
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
                error: error instanceof Error ? error.message : String(error || 'worldbook_failed'),
            };
        }
    }));
    const worldBooks = dedupeWorldBooks([
        ...(embeddedBook ? [embeddedBook] : []),
        ...fetchedWorldBooks,
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
            historySource: useCurrentHistory ? 'sillytavern-current-chat' : 'empty-different-character',
            source: 'sillytavern-current',
        },
    };
    const character = asRecord(context.character);
    return {
        context,
        diagnostics: {
            ok: !!character.name,
            message: character.name
                ? `已读取角色、${useCurrentHistory ? '当前聊天' : '空历史'}和 ${worldBooks.length} 本世界书`
                : '当前没有选中角色，调试台只会显示空资料',
            worldbookErrors: worldBooks.filter((book) => book.error).map((book) => ({
                name: normalizeText(book.name),
                error: normalizeText(book.error),
            })),
        },
        availableCharacters: listCharacters(ctx),
        selectedCharacterId: normalizeText(resolveCharacterId(ctx, options)),
    };
}
