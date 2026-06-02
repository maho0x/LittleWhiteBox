import Dexie, { type DexieTable } from '../../../libs/dexie.mjs';
import type {
    XbTavernBuildSnapshot,
    XbTavernContext,
    XbTavernMessage,
    XbTavernPreset,
    XbTavernPresetSection,
    XbTavernWorldEntryState,
} from './message-assembler';
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

export type TavernMemoryRecordStatus = 'active' | 'stale';
export type TavernManagerRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TavernMessageRecord {
    sessionId: string;
    order: number;
    role: string;
    content: string;
    name?: string;
    error?: boolean;
    createdAt: number;
    provider?: string;
    model?: string;
    finishReason?: string;
    providerPayload?: unknown;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    presetId?: string;
    presetName?: string;
    requestSnapshot?: unknown;
}

export interface TavernTurnSummaryRecord {
    id: string;
    sessionId: string;
    turn: number;
    userOrder: number;
    assistantOrder: number;
    episodeId?: string;
    summary: string;
    characterState?: string;
    relationshipChange?: string;
    locationTimeItems?: string;
    hooks?: string[];
    tags?: string[];
    status: TavernMemoryRecordStatus;
    createdAt: number;
    updatedAt: number;
}

export interface TavernEpisodeSummaryRecord {
    id: string;
    sessionId: string;
    title: string;
    summary: string;
    startTurn: number;
    endTurn: number;
    turnSummaryIds: string[];
    keyChanges?: string[];
    unresolved?: string[];
    status: TavernMemoryRecordStatus;
    createdAt: number;
    updatedAt: number;
}

export interface TavernManagerRunRecord {
    id: string;
    sessionId: string;
    turn: number;
    userOrder: number;
    assistantOrder: number;
    trigger: string;
    status: TavernManagerRunStatus;
    provider?: string;
    model?: string;
    inputSummary?: string;
    outputText?: string;
    parsedAction?: string;
    toolTrace?: unknown;
    changedFiles?: string[];
    error?: string;
    createdAt: number;
    updatedAt: number;
}

export type TavernMemoryFileStatus = 'active' | 'stale';
export type TavernMemoryIndexStatus = 'ready' | 'stale' | 'failed';

export interface TavernMemoryFileRecord {
    sessionId: string;
    path: string;
    content: string;
    status: TavernMemoryFileStatus;
    createdAt: number;
    updatedAt: number;
    source?: string;
    staleFromOrder?: number;
}

export interface TavernMemoryIndexRecord {
    sessionId: string;
    kind: string;
    status: TavernMemoryIndexStatus;
    error?: string;
    sourceFingerprint?: string;
    derivedAt?: number;
    updatedAt: number;
}

export type TavernAppendMessageInput = XbTavernMessage & {
    error?: boolean;
    provider?: string;
    model?: string;
    finishReason?: string;
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
    turnSummaries!: DexieTable<TavernTurnSummaryRecord>;
    episodeSummaries!: DexieTable<TavernEpisodeSummaryRecord>;
    managerRuns!: DexieTable<TavernManagerRunRecord>;
    memoryFiles!: DexieTable<TavernMemoryFileRecord>;
    memoryIndexes!: DexieTable<TavernMemoryIndexRecord>;

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
        this.version(3).stores({
            sessions: 'id, updatedAt, characterId, characterName',
            messages: '[sessionId+order], sessionId, order',
            meta: 'key',
            presets: 'id, updatedAt, sourcePresetId',
            turnSummaries: 'id, sessionId, episodeId, turn, userOrder, assistantOrder, status, updatedAt',
            episodeSummaries: 'id, sessionId, status, updatedAt, startTurn, endTurn',
            managerRuns: 'id, sessionId, status, turn, updatedAt',
        });
        this.version(4).stores({
            sessions: 'id, updatedAt, characterId, characterName',
            messages: '[sessionId+order], sessionId, order',
            meta: 'key',
            presets: 'id, updatedAt, sourcePresetId',
            turnSummaries: 'id, sessionId, episodeId, turn, userOrder, assistantOrder, status, updatedAt',
            episodeSummaries: 'id, sessionId, status, updatedAt, startTurn, endTurn',
            managerRuns: 'id, sessionId, status, turn, updatedAt',
            memoryFiles: '[sessionId+path], sessionId, path, status, updatedAt',
            memoryIndexes: '[sessionId+kind], sessionId, kind, status, updatedAt',
        });
    }
}

const db = new TavernDatabase();

export const tavernSessionsTable = db.sessions;
export const tavernMessagesTable = db.messages;
export const tavernMetaTable = db.meta;
export const tavernPresetsTable = db.presets;
export const tavernTurnSummariesTable = db.turnSummaries;
export const tavernEpisodeSummariesTable = db.episodeSummaries;
export const tavernManagerRunsTable = db.managerRuns;
export const tavernMemoryFilesTable = db.memoryFiles;
export const tavernMemoryIndexesTable = db.memoryIndexes;

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

function cloneSerializable<T>(value: T, fallback: T): T {
    if (value === undefined) {return fallback;}
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return fallback;
    }
}

function normalizePresetName(value = '', fallback = '我的小白酒馆预设'): string {
    const normalized = String(value || '').trim();
    return normalized.slice(0, 120) || fallback;
}

function normalizeTavernPresetSchema(preset: XbTavernPreset = {}): XbTavernPreset {
    const normalized: XbTavernPreset = {
        id: String(preset.id || '').trim(),
        name: normalizePresetName(preset.name),
        description: String(preset.description || ''),
        version: String(preset.version || ''),
        stylePrompt: String(preset.stylePrompt || ''),
        postHistoryPrompt: String(preset.postHistoryPrompt || ''),
        assistantPrefill: String(preset.assistantPrefill || ''),
        historySeparator: String(preset.historySeparator || ''),
        sections: Array.isArray(preset.sections)
            ? preset.sections.map((section): XbTavernPresetSection => ({
                id: String(section?.id || '').trim(),
                label: String(section?.label || '').trim(),
                locked: section?.locked !== false,
                enabled: section?.enabled !== false,
                role: section?.role,
                content: String(section?.content || ''),
                placement: section?.placement,
            }))
            : [],
    };
    if (!normalized.id) {delete normalized.id;}
    return normalized;
}

function normalizeStringArray(value: unknown, limit = 12): string[] {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return items
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, limit);
}

function createTurnSummaryId(sessionId = '', userOrder = -1, assistantOrder = -1): string {
    return `turn-summary-${sessionId}-${userOrder}-${assistantOrder}`;
}

function normalizeMemoryStatus(value: unknown): TavernMemoryRecordStatus {
    return value === 'stale' ? 'stale' : 'active';
}

function normalizeManagerRunStatus(value: unknown): TavernManagerRunStatus {
    return ['queued', 'running', 'completed', 'failed'].includes(String(value || ''))
        ? value as TavernManagerRunStatus
        : 'queued';
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
        contextSnapshot: cloneSerializable(input.contextSnapshot, undefined),
        buildSnapshot: cloneSerializable(input.buildSnapshot, undefined),
        presetId: String(input.presetId || ''),
        presetName: String(input.presetName || ''),
        summary: String(input.summary || ''),
        state: cloneSerializable(normalizeTavernSessionState(input.state || {}), {}),
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
        state: cloneSerializable(state, {}),
        updatedAt: timestamp,
        buildSnapshot: cloneSerializable(patch.lastBuildSnapshot || existing.buildSnapshot, undefined),
    });
    return await getTavernSession(id);
}

export async function replaceTavernSessionState(sessionId = '', stateInput: Partial<TavernSessionState> = {}): Promise<TavernSessionRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    const existing = await getTavernSession(id);
    if (!existing) {return null;}
    const timestamp = now();
    const normalized = normalizeTavernSessionState(stateInput);
    const state: TavernSessionState = {
        ...stateInput,
        turn: Math.max(0, Number(normalized.turn) || 0),
        worldEntryStates: normalized.worldEntryStates || {},
    };
    await tavernSessionsTable.update(id, {
        state: cloneSerializable(state, {}),
        updatedAt: timestamp,
        buildSnapshot: cloneSerializable(state.lastBuildSnapshot || existing.buildSnapshot, undefined),
    });
    return await getTavernSession(id);
}

export async function updateTavernSessionSnapshot(sessionId = '', patch: {
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    presetId?: string;
    presetName?: string;
    characterId?: string;
    characterName?: string;
} = {}): Promise<TavernSessionRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    const existing = await getTavernSession(id);
    if (!existing) {return null;}
    const contextSnapshot = 'contextSnapshot' in patch ? patch.contextSnapshot : existing.contextSnapshot;
    const character = contextSnapshot?.character || {};
    const update: Partial<TavernSessionRecord> = {
        updatedAt: now(),
        contextSnapshot: cloneSerializable(contextSnapshot, undefined),
        buildSnapshot: cloneSerializable('buildSnapshot' in patch ? patch.buildSnapshot : existing.buildSnapshot, undefined),
        presetId: 'presetId' in patch ? String(patch.presetId || '') : existing.presetId,
        presetName: 'presetName' in patch ? String(patch.presetName || '') : existing.presetName,
        characterId: 'characterId' in patch ? String(patch.characterId || '') : String(character.id || existing.characterId || ''),
        characterName: 'characterName' in patch ? String(patch.characterName || '') : String(character.name || existing.characterName || ''),
    };
    await tavernSessionsTable.update(id, update);
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
        error: message.error === true,
        createdAt: timestamp,
        provider: 'provider' in message ? String(message.provider || '') : undefined,
        model: 'model' in message ? String(message.model || '') : undefined,
        finishReason: 'finishReason' in message ? String(message.finishReason || '') : undefined,
        providerPayload: 'providerPayload' in message ? cloneSerializable(message.providerPayload, undefined) : undefined,
        contextSnapshot: 'contextSnapshot' in message ? cloneSerializable(message.contextSnapshot, undefined) : undefined,
        buildSnapshot: 'buildSnapshot' in message ? cloneSerializable(message.buildSnapshot, undefined) : undefined,
        presetId: 'presetId' in message ? String(message.presetId || '') : undefined,
        presetName: 'presetName' in message ? String(message.presetName || '') : undefined,
        requestSnapshot: 'requestSnapshot' in message ? cloneSerializable(message.requestSnapshot, undefined) : undefined,
    };
    await db.transaction('rw', tavernMessagesTable, tavernSessionsTable, async () => {
        await tavernMessagesTable.put(record);
        await tavernSessionsTable.update(id, { updatedAt: timestamp });
    });
    return record;
}

export async function updateTavernMessage(
    sessionId = '',
    order = -1,
    patch: Partial<Pick<TavernMessageRecord, 'content' | 'error'>>,
): Promise<TavernMessageRecord | null> {
    const id = String(sessionId || '').trim();
    const messageOrder = Number(order);
    if (!id || !Number.isInteger(messageOrder) || messageOrder < 0) {return null;}
    const existing = await tavernMessagesTable.get([id, messageOrder]);
    if (!existing) {return null;}
    const update: Partial<TavernMessageRecord> = {};
    if ('content' in patch) {update.content = String(patch.content || '');}
    if ('error' in patch) {update.error = patch.error === true;}
    await tavernMessagesTable.update([id, messageOrder], update);
    await tavernSessionsTable.update(id, { updatedAt: now() });
    return await tavernMessagesTable.get([id, messageOrder]) || null;
}

export async function deleteTavernMessages(sessionId = '', orders: number[] = []): Promise<number> {
    const id = String(sessionId || '').trim();
    const uniqueOrders = [...new Set((Array.isArray(orders) ? orders : [])
        .map((order) => Number(order))
        .filter((order) => Number.isInteger(order) && order >= 0))];
    if (!id || !uniqueOrders.length) {return 0;}
    const existingKeys: Array<[string, number]> = [];
    await Promise.all(uniqueOrders.map(async (order) => {
        const existing = await tavernMessagesTable.get([id, order]);
        if (existing) {existingKeys.push([id, order]);}
    }));
    if (!existingKeys.length) {return 0;}
    await db.transaction('rw', tavernMessagesTable, tavernSessionsTable, async () => {
        await tavernMessagesTable.bulkDelete(existingKeys);
        await tavernSessionsTable.update(id, { updatedAt: now() });
    });
    return existingKeys.length;
}

export async function listTavernMessages(sessionId = ''): Promise<TavernMessageRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    return tavernMessagesTable.where('sessionId').equals(id).sortBy('order');
}

export async function upsertTavernTurnSummary(input: Partial<TavernTurnSummaryRecord> = {}): Promise<TavernTurnSummaryRecord> {
    const sessionId = String(input.sessionId || '').trim();
    const userOrder = Number(input.userOrder);
    const assistantOrder = Number(input.assistantOrder);
    if (!sessionId || !Number.isInteger(userOrder) || !Number.isInteger(assistantOrder)) {
        throw new Error('turn_summary_source_required');
    }
    const timestamp = now();
    const id = String(input.id || createTurnSummaryId(sessionId, userOrder, assistantOrder));
    const existing = await tavernTurnSummariesTable.get(id);
    const record: TavernTurnSummaryRecord = {
        id,
        sessionId,
        turn: Math.max(0, Number(input.turn ?? existing?.turn) || 0),
        userOrder,
        assistantOrder,
        episodeId: String(input.episodeId ?? existing?.episodeId ?? ''),
        summary: String(input.summary ?? existing?.summary ?? '').trim(),
        characterState: String(input.characterState ?? existing?.characterState ?? '').trim(),
        relationshipChange: String(input.relationshipChange ?? existing?.relationshipChange ?? '').trim(),
        locationTimeItems: String(input.locationTimeItems ?? existing?.locationTimeItems ?? '').trim(),
        hooks: normalizeStringArray(input.hooks ?? existing?.hooks),
        tags: normalizeStringArray(input.tags ?? existing?.tags),
        status: normalizeMemoryStatus(input.status ?? existing?.status),
        createdAt: Number(existing?.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await tavernTurnSummariesTable.put(record);
    await tavernSessionsTable.update(sessionId, { updatedAt: timestamp });
    return record;
}

export async function listTavernTurnSummaries(sessionId = '', options: {
    includeStale?: boolean;
    limit?: number;
} = {}): Promise<TavernTurnSummaryRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernTurnSummariesTable.where('sessionId').equals(id).sortBy('turn');
    const filtered = options.includeStale ? rows : rows.filter((row) => row.status !== 'stale');
    const limit = Math.max(0, Number(options.limit) || 0);
    return limit ? filtered.slice(-limit) : filtered;
}

export async function upsertTavernEpisodeSummary(input: Partial<TavernEpisodeSummaryRecord> = {}): Promise<TavernEpisodeSummaryRecord> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {throw new Error('episode_summary_session_required');}
    const timestamp = now();
    const id = String(input.id || createId('episode-summary'));
    const existing = await tavernEpisodeSummariesTable.get(id);
    const turnSummaryIds = normalizeStringArray(input.turnSummaryIds ?? existing?.turnSummaryIds, 100);
    const startTurn = Math.max(0, Number(input.startTurn ?? existing?.startTurn) || 0);
    const endTurn = Math.max(startTurn, Number(input.endTurn ?? existing?.endTurn ?? startTurn) || startTurn);
    const record: TavernEpisodeSummaryRecord = {
        id,
        sessionId,
        title: normalizeTitle(String(input.title ?? existing?.title ?? ''), '未命名阶段'),
        summary: String(input.summary ?? existing?.summary ?? '').trim(),
        startTurn,
        endTurn,
        turnSummaryIds,
        keyChanges: normalizeStringArray(input.keyChanges ?? existing?.keyChanges, 20),
        unresolved: normalizeStringArray(input.unresolved ?? existing?.unresolved, 20),
        status: normalizeMemoryStatus(input.status ?? existing?.status),
        createdAt: Number(existing?.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await tavernEpisodeSummariesTable.put(record);
    await Promise.all(turnSummaryIds.map(async (summaryId) => {
        const summary = await tavernTurnSummariesTable.get(summaryId);
        if (summary?.sessionId === sessionId) {
            await tavernTurnSummariesTable.update(summaryId, { episodeId: id, updatedAt: timestamp });
        }
    }));
    await tavernSessionsTable.update(sessionId, { updatedAt: timestamp });
    return record;
}

export async function listTavernEpisodeSummaries(sessionId = '', options: {
    includeStale?: boolean;
    limit?: number;
} = {}): Promise<TavernEpisodeSummaryRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernEpisodeSummariesTable.where('sessionId').equals(id).sortBy('updatedAt');
    const filtered = options.includeStale ? rows : rows.filter((row) => row.status !== 'stale');
    const limit = Math.max(0, Number(options.limit) || 0);
    return limit ? filtered.slice(-limit) : filtered;
}

export async function createTavernManagerRun(input: Partial<TavernManagerRunRecord> = {}): Promise<TavernManagerRunRecord> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {throw new Error('manager_run_session_required');}
    const timestamp = now();
    const record: TavernManagerRunRecord = {
        id: String(input.id || createId('manager-run')),
        sessionId,
        turn: Math.max(0, Number(input.turn) || 0),
        userOrder: Number.isInteger(Number(input.userOrder)) ? Number(input.userOrder) : -1,
        assistantOrder: Number.isInteger(Number(input.assistantOrder)) ? Number(input.assistantOrder) : -1,
        trigger: String(input.trigger || 'after_turn'),
        status: normalizeManagerRunStatus(input.status),
        provider: String(input.provider || ''),
        model: String(input.model || ''),
        inputSummary: String(input.inputSummary || ''),
        outputText: String(input.outputText || ''),
        parsedAction: String(input.parsedAction || ''),
        toolTrace: 'toolTrace' in input ? cloneSerializable(input.toolTrace, undefined) : undefined,
        changedFiles: normalizeStringArray(input.changedFiles, 100),
        error: String(input.error || ''),
        createdAt: Number(input.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await tavernManagerRunsTable.put(record);
    await tavernSessionsTable.update(sessionId, { updatedAt: timestamp });
    return record;
}

export async function updateTavernManagerRun(
    managerRunId = '',
    patch: Partial<TavernManagerRunRecord> = {},
): Promise<TavernManagerRunRecord | null> {
    const id = String(managerRunId || '').trim();
    if (!id) {return null;}
    const existing = await tavernManagerRunsTable.get(id);
    if (!existing) {return null;}
    const update: Partial<TavernManagerRunRecord> = {
        updatedAt: now(),
    };
    if ('status' in patch) {update.status = normalizeManagerRunStatus(patch.status);}
    ['provider', 'model', 'inputSummary', 'outputText', 'parsedAction', 'error', 'trigger'].forEach((key) => {
        if (key in patch) {
            (update as Record<string, unknown>)[key] = String((patch as Record<string, unknown>)[key] || '');
        }
    });
    if ('toolTrace' in patch) {update.toolTrace = cloneSerializable(patch.toolTrace, undefined);}
    if ('changedFiles' in patch) {update.changedFiles = normalizeStringArray(patch.changedFiles, 100);}
    if ('turn' in patch) {update.turn = Math.max(0, Number(patch.turn) || 0);}
    if ('userOrder' in patch) {update.userOrder = Number(patch.userOrder);}
    if ('assistantOrder' in patch) {update.assistantOrder = Number(patch.assistantOrder);}
    await tavernManagerRunsTable.update(id, update);
    await tavernSessionsTable.update(existing.sessionId, { updatedAt: now() });
    return await tavernManagerRunsTable.get(id) || null;
}

export async function listTavernManagerRuns(sessionId = '', options: {
    limit?: number;
} = {}): Promise<TavernManagerRunRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernManagerRunsTable.where('sessionId').equals(id).sortBy('updatedAt');
    const limit = Math.max(0, Number(options.limit) || 0);
    return (limit ? rows.slice(-limit) : rows).reverse();
}

export async function markTavernMemoryStaleFromOrder(sessionId = '', fromOrder = 0): Promise<number> {
    const id = String(sessionId || '').trim();
    const order = Number(fromOrder);
    if (!id || !Number.isFinite(order)) {return 0;}
    const timestamp = now();
    const summaries = await tavernTurnSummariesTable.where('sessionId').equals(id).toArray();
    const affected = summaries.filter((summary) => summary.userOrder >= order || summary.assistantOrder >= order);
    const memoryFiles = await tavernMemoryFilesTable.where('sessionId').equals(id).toArray();
    const affectedMemoryFiles = memoryFiles.filter((file) => {
        const path = String(file.path || '');
        const match = path.match(/^memory\/turns\/.+-(\d+)\.md$/);
        const pathOrder = match ? Number(match[1]) : Number(file.staleFromOrder);
        return Number.isFinite(pathOrder) && pathOrder >= order;
    });
    if (!affected.length && !affectedMemoryFiles.length) {return 0;}
    await db.transaction('rw', tavernTurnSummariesTable, tavernEpisodeSummariesTable, tavernMemoryFilesTable, tavernMemoryIndexesTable, tavernSessionsTable, async () => {
        await Promise.all(affected.map((summary) => tavernTurnSummariesTable.update(summary.id, {
            status: 'stale',
            updatedAt: timestamp,
        })));
        await Promise.all(affectedMemoryFiles.map((file) => tavernMemoryFilesTable.update([id, file.path], {
            status: 'stale',
            staleFromOrder: order,
            updatedAt: timestamp,
        })));
        const affectedIds = new Set(affected.map((summary) => summary.id));
        const episodes = await tavernEpisodeSummariesTable.where('sessionId').equals(id).toArray();
        await Promise.all(episodes
            .filter((episode) => episode.turnSummaryIds.some((summaryId) => affectedIds.has(summaryId)))
            .map((episode) => tavernEpisodeSummariesTable.update(episode.id, {
                status: 'stale',
                updatedAt: timestamp,
            })));
        await tavernMemoryIndexesTable.put({
            sessionId: id,
            kind: 'markdown-derived',
            status: 'stale',
            error: '',
            sourceFingerprint: '',
            derivedAt: timestamp,
            updatedAt: timestamp,
        });
        await tavernSessionsTable.update(id, { updatedAt: timestamp });
    });
    return affected.length + affectedMemoryFiles.length;
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
    const normalizedPreset = normalizeTavernPresetSchema(cloneSerializable({
        ...preset,
        id,
        name: normalizePresetName(preset.name),
    }, createDefaultXbTavernPreset()));
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
    return record?.preset ? normalizeTavernPresetSchema(cloneJson(record.preset)) : createDefaultXbTavernPreset();
}

export async function deriveAndActivateDefaultTavernPreset(name = '我的小白酒馆预设'): Promise<TavernPresetRecord> {
    const preset = createUserPresetFromBuiltIn(name);
    const record = await saveTavernPreset(preset, { sourcePresetId: DEFAULT_XB_TAVERN_PRESET_ID });
    await setActiveTavernPresetId(record.id);
    return record;
}

export default db;
