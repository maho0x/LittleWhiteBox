import Dexie, { type DexieTable } from '../../../libs/dexie.mjs';
import type { XbTavernBuildSnapshot, XbTavernContext, XbTavernMessage, XbTavernPreset, XbTavernWorldEntryState } from './message-assembler';
import { createDefaultXbTavernPreset, DEFAULT_XB_TAVERN_PRESET_ID } from './presets';

export interface TavernSessionRecord {
    id: string;
    title: string;
    characterId?: string;
    characterName?: string;
    createdAt: number;
    updatedAt: number;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    presetId?: string;
    presetName?: string;
    summary?: string;
    state?: TavernSessionState;
}

export interface TavernSessionState {
    turn?: number;
    worldEntryStates?: Record<string, XbTavernWorldEntryState>;
    lastBuildSnapshot?: XbTavernBuildSnapshot;
    lastRequestSnapshot?: unknown;
    lastProvider?: string;
    lastModel?: string;
    [key: string]: unknown;
}

export interface TavernMessageRecord {
    sessionId: string;
    order: number;
    role: string;
    content: string;
    name?: string;
    createdAt: number;
    providerPayload?: unknown;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    presetId?: string;
    presetName?: string;
    requestSnapshot?: unknown;
}

export type TavernAppendMessageInput = XbTavernMessage & {
    providerPayload?: unknown;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    presetId?: string;
    presetName?: string;
    requestSnapshot?: unknown;
};

export interface TavernMetaRecord {
    key: string;
    value: unknown;
    updatedAt: number;
}

export interface TavernPresetRecord {
    id: string;
    name: string;
    description?: string;
    version?: string;
    sourcePresetId?: string;
    isBuiltIn?: boolean;
    createdAt: number;
    updatedAt: number;
    preset: XbTavernPreset;
}

class TavernDatabase extends Dexie {
    sessions!: DexieTable<TavernSessionRecord>;
    messages!: DexieTable<TavernMessageRecord>;
    meta!: DexieTable<TavernMetaRecord>;
    presets!: DexieTable<TavernPresetRecord>;

    constructor() {
        super('LittleWhiteBox_Tavern');
        this.version(1).stores({
            sessions: 'id, updatedAt, characterId, characterName',
            messages: '[sessionId+order], sessionId, order',
            meta: 'key',
        });
        this.version(2).stores({
            sessions: 'id, updatedAt, characterId, characterName',
            messages: '[sessionId+order], sessionId, order',
            meta: 'key',
            presets: 'id, updatedAt, sourcePresetId',
        });
    }
}

const db = new TavernDatabase();

export const tavernSessionsTable = db.sessions;
export const tavernMessagesTable = db.messages;
export const tavernMetaTable = db.meta;
export const tavernPresetsTable = db.presets;

function now(): number {
    return Date.now();
}

function createId(prefix = 'tavern-session'): string {
    return `${prefix}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTitle(value = '', fallback = '小白酒馆会话'): string {
    const normalized = String(value || '').trim();
    return normalized.slice(0, 120) || fallback;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePresetName(value = '', fallback = '我的小白酒馆预设'): string {
    const normalized = String(value || '').trim();
    return normalized.slice(0, 120) || fallback;
}

function normalizeWorldEntryStates(value: unknown): Record<string, XbTavernWorldEntryState> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return {};}
    const states: Record<string, XbTavernWorldEntryState> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, state]) => {
        if (!key || !state || typeof state !== 'object' || Array.isArray(state)) {return;}
        const normalized: XbTavernWorldEntryState = {};
        const source = state as Record<string, unknown>;
        ['stickyUntilTurn', 'cooldownUntilTurn', 'delayUntilTurn'].forEach((field) => {
            const turn = Number(source[field]);
            if (Number.isFinite(turn)) {
                normalized[field as keyof XbTavernWorldEntryState] = turn;
            }
        });
        if (Object.keys(normalized).length) {
            states[key] = normalized;
        }
    });
    return states;
}

export function normalizeTavernSessionState(value: unknown): TavernSessionState {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
        ...source,
        turn: Math.max(0, Number(source.turn) || 0),
        worldEntryStates: normalizeWorldEntryStates(source.worldEntryStates),
    };
}

export function mergeWorldEntryStates(
    existing: Record<string, XbTavernWorldEntryState> = {},
    updates: Record<string, XbTavernWorldEntryState> = {},
): Record<string, XbTavernWorldEntryState> {
    const merged: Record<string, XbTavernWorldEntryState> = cloneJson(existing || {});
    Object.entries(updates || {}).forEach(([key, update]) => {
        if (!key || !update || typeof update !== 'object') {return;}
        merged[key] = {
            ...(merged[key] || {}),
            ...update,
        };
    });
    return merged;
}

export async function createTavernSession(input: Partial<TavernSessionRecord> = {}): Promise<TavernSessionRecord> {
    const timestamp = now();
    const session: TavernSessionRecord = {
        id: String(input.id || createId()),
        title: normalizeTitle(input.title, input.characterName ? `${input.characterName} · 会话` : '小白酒馆会话'),
        characterId: String(input.characterId || ''),
        characterName: String(input.characterName || ''),
        createdAt: Number(input.createdAt) || timestamp,
        updatedAt: timestamp,
        contextSnapshot: input.contextSnapshot,
        buildSnapshot: input.buildSnapshot,
        presetId: String(input.presetId || ''),
        presetName: String(input.presetName || ''),
        summary: String(input.summary || ''),
        state: normalizeTavernSessionState(input.state || {}),
    };
    await tavernSessionsTable.put(session);
    await tavernMetaTable.put({ key: 'selectedSessionId', value: session.id, updatedAt: timestamp });
    return session;
}

export async function listTavernSessions(): Promise<TavernSessionRecord[]> {
    return tavernSessionsTable.orderBy('updatedAt').reverse().toArray();
}

export async function getSelectedTavernSessionId(): Promise<string> {
    const entry = await tavernMetaTable.get('selectedSessionId');
    return String(entry?.value || '').trim();
}

export async function setSelectedTavernSessionId(sessionId = ''): Promise<string> {
    const value = String(sessionId || '').trim();
    await tavernMetaTable.put({ key: 'selectedSessionId', value, updatedAt: now() });
    return value;
}

export async function getTavernSession(sessionId = ''): Promise<TavernSessionRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await tavernSessionsTable.get(id) || null;
}

export async function updateTavernSessionState(sessionId = '', patch: Partial<TavernSessionState> = {}): Promise<TavernSessionRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    const existing = await getTavernSession(id);
    if (!existing) {return null;}
    const timestamp = now();
    const currentState = normalizeTavernSessionState(existing.state || {});
    const patchState = normalizeTavernSessionState(patch);
    const state: TavernSessionState = {
        ...currentState,
        ...patch,
        turn: Math.max(0, Number(patch.turn ?? currentState.turn) || 0),
        worldEntryStates: mergeWorldEntryStates(currentState.worldEntryStates || {}, patchState.worldEntryStates || {}),
    };
    await tavernSessionsTable.update(id, {
        state,
        updatedAt: timestamp,
        buildSnapshot: patch.lastBuildSnapshot || existing.buildSnapshot,
    });
    return await getTavernSession(id);
}

export async function appendTavernMessage(sessionId: string, message: TavernAppendMessageInput): Promise<TavernMessageRecord> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('session_required');}
    const existing = await tavernMessagesTable.where('sessionId').equals(id).toArray();
    const order = Math.max(-1, ...existing.map((item) => Number(item.order) || 0)) + 1;
    const timestamp = now();
    const record: TavernMessageRecord = {
        sessionId: id,
        order,
        role: String(message.role || ''),
        content: String(message.content || ''),
        name: message.name ? String(message.name) : undefined,
        createdAt: timestamp,
        providerPayload: 'providerPayload' in message ? message.providerPayload : undefined,
        contextSnapshot: 'contextSnapshot' in message ? message.contextSnapshot : undefined,
        buildSnapshot: 'buildSnapshot' in message ? message.buildSnapshot : undefined,
        presetId: 'presetId' in message ? String(message.presetId || '') : undefined,
        presetName: 'presetName' in message ? String(message.presetName || '') : undefined,
        requestSnapshot: 'requestSnapshot' in message ? message.requestSnapshot : undefined,
    };
    await db.transaction('rw', tavernMessagesTable, tavernSessionsTable, async () => {
        await tavernMessagesTable.put(record);
        await tavernSessionsTable.update(id, { updatedAt: timestamp });
    });
    return record;
}

export async function listTavernMessages(sessionId = ''): Promise<TavernMessageRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    return tavernMessagesTable.where('sessionId').equals(id).sortBy('order');
}

export function createUserPresetFromBuiltIn(name = '我的小白酒馆预设'): XbTavernPreset {
    const preset = cloneJson(createDefaultXbTavernPreset());
    preset.id = `user-preset-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    preset.name = normalizePresetName(name);
    preset.description = `从 ${createDefaultXbTavernPreset().name} 派生。`;
    return preset;
}

export async function saveTavernPreset(preset: XbTavernPreset, options: {
    sourcePresetId?: string;
    isBuiltIn?: boolean;
} = {}): Promise<TavernPresetRecord> {
    const timestamp = now();
    const id = String(preset.id || createId('tavern-preset'));
    const normalizedPreset = cloneJson({
        ...preset,
        id,
        name: normalizePresetName(preset.name),
    });
    const existing = await tavernPresetsTable.get(id);
    const record: TavernPresetRecord = {
        id,
        name: normalizePresetName(normalizedPreset.name),
        description: String(normalizedPreset.description || ''),
        version: String(normalizedPreset.version || ''),
        sourcePresetId: String(options.sourcePresetId || existing?.sourcePresetId || DEFAULT_XB_TAVERN_PRESET_ID),
        isBuiltIn: options.isBuiltIn === true,
        createdAt: Number(existing?.createdAt) || timestamp,
        updatedAt: timestamp,
        preset: normalizedPreset,
    };
    await tavernPresetsTable.put(record);
    return record;
}

export async function listUserTavernPresets(): Promise<TavernPresetRecord[]> {
    return tavernPresetsTable.orderBy('updatedAt').reverse().toArray();
}

export async function getActiveTavernPresetId(): Promise<string> {
    const entry = await tavernMetaTable.get('activePresetId');
    return String(entry?.value || DEFAULT_XB_TAVERN_PRESET_ID).trim() || DEFAULT_XB_TAVERN_PRESET_ID;
}

export async function setActiveTavernPresetId(presetId = DEFAULT_XB_TAVERN_PRESET_ID): Promise<string> {
    const value = String(presetId || DEFAULT_XB_TAVERN_PRESET_ID).trim() || DEFAULT_XB_TAVERN_PRESET_ID;
    await tavernMetaTable.put({ key: 'activePresetId', value, updatedAt: now() });
    return value;
}

export async function loadActiveTavernPreset(): Promise<XbTavernPreset> {
    const activeId = await getActiveTavernPresetId();
    if (activeId === DEFAULT_XB_TAVERN_PRESET_ID) {return createDefaultXbTavernPreset();}
    const record = await tavernPresetsTable.get(activeId);
    return record?.preset ? cloneJson(record.preset) : createDefaultXbTavernPreset();
}

export async function deriveAndActivateDefaultTavernPreset(name = '我的小白酒馆预设'): Promise<TavernPresetRecord> {
    const preset = createUserPresetFromBuiltIn(name);
    const record = await saveTavernPreset(preset, { sourcePresetId: DEFAULT_XB_TAVERN_PRESET_ID });
    await setActiveTavernPresetId(record.id);
    return record;
}

export default db;
