import Dexie, { type DexieTable } from '../../../libs/dexie.mjs';
import type {
    XbTavernBuildSnapshot,
    XbTavernContext,
    XbTavernMessage,
    XbTavernNativeWorldInfoTimedEffect,
    XbTavernNativeWorldInfoTimedState,
    TavernChatPromptPresetBundle,
    XbTavernWorldEntryState,
} from './message-assembler';
import {
    createDefaultTavernAssistantPreset,
    DEFAULT_TAVERN_ASSISTANT_PRESET_ID,
    normalizeTavernAssistantPreset,
    type TavernAssistantPreset,
} from './assistant-presets';
import {
    createFallbackTavernChatPromptPresetBundle,
    FALLBACK_TAVERN_CHAT_PRESET_ID,
    normalizeTavernChatPromptPresetBundle,
} from './chat-presets';
import {
    createSeedMapDocument,
    TAVERN_MAP_DOC_ID,
    TAVERN_MAP_DOC_TYPE,
} from './map-state-seed';
import {
    hasTavernSessionContractOverride,
    mergeTavernSessionContract,
    normalizeTavernSessionContract,
    type TavernSessionContract,
} from './session-contract';
import {
    normalizeTavernRuntimeEvents,
    type TavernRuntimeEvent,
} from './runtime-events';

export interface TavernSessionRecord {
    id: string;
    title: string;
    characterId?: string;
    characterName?: string;
    createdAt: number;
    updatedAt: number;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    chatPresetId?: string;
    chatPresetName?: string;
    presetId?: string;
    presetName?: string;
    summary?: string;
    state?: TavernSessionState;
}

export interface TavernSessionState {
    turn?: number;
    contract?: TavernSessionContract;
    worldEntryStates?: Record<string, XbTavernWorldEntryState>;
    nativeWorldInfoTimedState?: XbTavernNativeWorldInfoTimedState;
    lastBuildSnapshot?: XbTavernBuildSnapshot;
    lastRequestSnapshot?: unknown;
    lastProvider?: string;
    lastModel?: string;
    [key: string]: unknown;
}

export type TavernMemoryRecordStatus = 'active' | 'stale';
export type TavernManagerRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded' | 'rolled_back';

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
    thoughts?: Array<{ label?: string; text?: string }>;
    providerPayload?: unknown;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    chatPresetId?: string;
    chatPresetName?: string;
    presetId?: string;
    presetName?: string;
    requestSnapshot?: unknown;
    runtimeEvents?: TavernRuntimeEvent[];
}

export interface TavernManagerMessageRecord {
    sessionId: string;
    order: number;
    role: XbTavernMessage['role'];
    content: string;
    name?: string;
    error?: boolean;
    createdAt: number;
    updatedAt: number;
    provider?: string;
    model?: string;
    finishReason?: string;
    thoughts?: Array<{ label?: string; text?: string }>;
    providerPayload?: unknown;
    toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>;
    toolCallId?: string;
    toolName?: string;
    toolDisplay?: unknown;
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
    changedStates?: string[];
    error?: string;
    createdAt: number;
    updatedAt: number;
}

export type TavernMemoryFileStatus = 'active' | 'stale';
export type TavernMemoryIndexStatus = 'ready' | 'stale' | 'failed';
export type TavernStructuredStateStatus = 'active' | 'stale';
export type TavernStructuredStateDocType = 'tavern.map';

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

export type TavernManagerMemorySnapshotStatus = 'pending' | 'rolled_back' | 'conflict' | 'skipped';

export interface TavernManagerMemorySnapshotRecord {
    managerRunId: string;
    sessionId: string;
    path: string;
    beforeExists: boolean;
    beforeFile?: TavernMemoryFileRecord;
    beforeHash: string;
    afterHash?: string;
    rollbackStatus: TavernManagerMemorySnapshotStatus;
    error?: string;
    createdAt: number;
    updatedAt: number;
}

export interface TavernStructuredStateDocumentRecord {
    sessionId: string;
    docType: TavernStructuredStateDocType;
    docId: string;
    title: string;
    revision: number;
    data: unknown;
    digest: string;
    status: TavernStructuredStateStatus;
    source?: string;
    staleFromOrder?: number;
    createdAt: number;
    updatedAt: number;
}

export interface TavernStructuredStatePatchRecord {
    id: string;
    sessionId: string;
    docType: TavernStructuredStateDocType;
    docId: string;
    revision: number;
    status?: 'active' | 'rolled_back';
    managerRunId?: string;
    sourceUserOrder?: number;
    sourceAssistantOrder?: number;
    source?: string;
    summary?: string;
    ops?: unknown[];
    changedIds?: string[];
    removedElements?: unknown[];
    createdAt: number;
    updatedAt: number;
}

export type TavernManagerStateSnapshotStatus = 'pending' | 'rolled_back' | 'conflict' | 'skipped';

export interface TavernManagerStateSnapshotRecord {
    managerRunId: string;
    sessionId: string;
    docType: TavernStructuredStateDocType;
    docId: string;
    beforeExists: boolean;
    beforeDocument?: TavernStructuredStateDocumentRecord;
    beforeHash: string;
    afterHash?: string;
    rollbackStatus: TavernManagerStateSnapshotStatus;
    error?: string;
    createdAt: number;
    updatedAt: number;
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
    thoughts?: Array<{ label?: string; text?: string }>;
    providerPayload?: unknown;
    contextSnapshot?: XbTavernContext;
    buildSnapshot?: XbTavernBuildSnapshot;
    chatPresetId?: string;
    chatPresetName?: string;
    presetId?: string;
    presetName?: string;
    requestSnapshot?: unknown;
    runtimeEvents?: TavernRuntimeEvent[];
};

export type TavernAppendManagerMessageInput = {
    role: XbTavernMessage['role'];
    content: string;
    name?: string;
    error?: boolean;
    provider?: string;
    model?: string;
    finishReason?: string;
    thoughts?: Array<{ label?: string; text?: string }>;
    providerPayload?: unknown;
    toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>;
    tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
            name?: string;
            arguments?: string;
        };
    }>;
    toolCallId?: string;
    tool_call_id?: string;
    toolName?: string;
    toolDisplay?: unknown;
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
    preset: TavernChatPromptPresetBundle;
}

export interface TavernAssistantPresetRecord {
    id: string;
    name: string;
    description?: string;
    version?: string;
    isBuiltIn?: boolean;
    createdAt: number;
    updatedAt: number;
    preset: TavernAssistantPreset;
}

class TavernDatabase extends Dexie {
    sessions!: DexieTable<TavernSessionRecord>;
    messages!: DexieTable<TavernMessageRecord>;
    managerMessages!: DexieTable<TavernManagerMessageRecord>;
    meta!: DexieTable<TavernMetaRecord>;
    presets!: DexieTable<TavernPresetRecord>;
    turnSummaries!: DexieTable<TavernTurnSummaryRecord>;
    episodeSummaries!: DexieTable<TavernEpisodeSummaryRecord>;
    managerRuns!: DexieTable<TavernManagerRunRecord>;
    memoryFiles!: DexieTable<TavernMemoryFileRecord>;
    memoryIndexes!: DexieTable<TavernMemoryIndexRecord>;
    assistantPresets!: DexieTable<TavernAssistantPresetRecord>;
    managerMemorySnapshots!: DexieTable<TavernManagerMemorySnapshotRecord>;
    stateDocuments!: DexieTable<TavernStructuredStateDocumentRecord>;
    statePatches!: DexieTable<TavernStructuredStatePatchRecord>;
    managerStateSnapshots!: DexieTable<TavernManagerStateSnapshotRecord>;

    constructor() {
        super('LittleWhiteBox_Tavern');
        this.version(1).stores({
            sessions: 'id, updatedAt, characterId, characterName',
            messages: '[sessionId+order], sessionId, order',
            managerMessages: '[sessionId+order], sessionId, order',
            meta: 'key',
            presets: 'id, updatedAt, sourcePresetId',
            turnSummaries: 'id, sessionId, episodeId, turn, userOrder, assistantOrder, status, updatedAt',
            episodeSummaries: 'id, sessionId, status, updatedAt, startTurn, endTurn',
            managerRuns: 'id, sessionId, status, turn, updatedAt',
            memoryFiles: '[sessionId+path], sessionId, path, status, updatedAt',
            memoryIndexes: '[sessionId+kind], sessionId, kind, status, updatedAt',
            assistantPresets: 'id, updatedAt',
            managerMemorySnapshots: '[managerRunId+path], managerRunId, sessionId, path, updatedAt',
            stateDocuments: '[sessionId+docType+docId], sessionId, docType, docId, status, updatedAt',
            statePatches: 'id, sessionId, docType, docId, managerRunId, revision, status, updatedAt',
            managerStateSnapshots: '[managerRunId+docType+docId], managerRunId, sessionId, docType, docId, updatedAt',
        });
    }
}

const db = new TavernDatabase();

export const tavernSessionsTable = db.sessions;
export const tavernMessagesTable = db.messages;
export const tavernManagerMessagesTable = db.managerMessages;
export const tavernMetaTable = db.meta;
export const tavernPresetsTable = db.presets;
export const tavernTurnSummariesTable = db.turnSummaries;
export const tavernEpisodeSummariesTable = db.episodeSummaries;
export const tavernManagerRunsTable = db.managerRuns;
export const tavernMemoryFilesTable = db.memoryFiles;
export const tavernMemoryIndexesTable = db.memoryIndexes;
export const tavernAssistantPresetsTable = db.assistantPresets;
export const tavernManagerMemorySnapshotsTable = db.managerMemorySnapshots;
export const tavernStateDocumentsTable = db.stateDocuments;
export const tavernStatePatchesTable = db.statePatches;
export const tavernManagerStateSnapshotsTable = db.managerStateSnapshots;

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

function cleanSessionDisplayText(value = ''): string {
    const cleaned = String(value || '')
        .replace(/\s*[·-]\s*小白酒馆\s*$/g, '')
        .replace(/\s*[·-]\s*会话\s*$/g, '')
        .replace(/^小白酒馆会话$/g, '')
        .replace(/\s*·\s*第\s*\d+\s*轮\s*·\s*\d+\s*条可用消息\s*$/g, '')
        .trim();
    return /^(sillytavern\s+system|system)\b/i.test(cleaned) ? '' : cleaned;
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

function normalizePresetName(value = '', fallback = '酒馆聊天预设'): string {
    const normalized = String(value || '').trim();
    return normalized.slice(0, 120) || fallback;
}

function normalizeTavernPresetSchema(preset: TavernChatPromptPresetBundle = {}): TavernChatPromptPresetBundle {
    return normalizeTavernChatPromptPresetBundle(preset);
}

function normalizeStringArray(value: unknown, limit = 12): string[] {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return items
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeManagerMessageRole(value: unknown): XbTavernMessage['role'] {
    const role = String(value || '').trim();
    return role === 'assistant' || role === 'tool' || role === 'system' ? role : 'user';
}

function normalizeManagerToolCalls(input: TavernAppendManagerMessageInput | Partial<TavernManagerMessageRecord>): Array<{ id?: string; name?: string; arguments?: string }> | undefined {
    const direct = Array.isArray(input.toolCalls) ? input.toolCalls : [];
    const provider = 'tool_calls' in input && Array.isArray(input.tool_calls) ? input.tool_calls : [];
    const normalized = [
        ...direct.map((toolCall) => ({
            id: String(toolCall?.id || ''),
            name: String(toolCall?.name || ''),
            arguments: String(toolCall?.arguments || '{}'),
        })),
        ...provider.map((toolCall) => ({
            id: String(toolCall?.id || ''),
            name: String(toolCall?.function?.name || ''),
            arguments: String(toolCall?.function?.arguments || '{}'),
        })),
    ].filter((toolCall) => toolCall.name);
    return normalized.length ? normalized : undefined;
}

function normalizeMessageRuntimeEvents(value: unknown): TavernRuntimeEvent[] {
    return normalizeTavernRuntimeEvents(value);
}

function normalizeStoredTavernMessageRecord(record: TavernMessageRecord): TavernMessageRecord {
    return {
        ...record,
        runtimeEvents: normalizeMessageRuntimeEvents(record.runtimeEvents),
    };
}

function createTurnSummaryId(sessionId = '', userOrder = -1, assistantOrder = -1): string {
    return `turn-summary-${sessionId}-${userOrder}-${assistantOrder}`;
}

function normalizeMemoryStatus(value: unknown): TavernMemoryRecordStatus {
    return value === 'stale' ? 'stale' : 'active';
}

function normalizeManagerRunStatus(value: unknown): TavernManagerRunStatus {
    return ['queued', 'running', 'completed', 'failed', 'cancelled', 'superseded', 'rolled_back'].includes(String(value || ''))
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

function normalizeNativeWorldInfoTimedEffect(value: unknown): XbTavernNativeWorldInfoTimedEffect | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return null;}
    const source = value as Record<string, unknown>;
    const normalized: XbTavernNativeWorldInfoTimedEffect = {};
    const hash = Number(source.hash);
    const start = Number(source.start);
    const end = Number(source.end);
    if (Number.isFinite(hash)) {normalized.hash = hash;}
    if (Number.isFinite(start)) {normalized.start = start;}
    if (Number.isFinite(end)) {normalized.end = end;}
    if (source.protected === true) {normalized.protected = true;}
    return (normalized.hash !== undefined || normalized.start !== undefined || normalized.end !== undefined || normalized.protected)
        ? normalized
        : null;
}

function normalizeNativeWorldInfoTimedState(value: unknown): XbTavernNativeWorldInfoTimedState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { sticky: {}, cooldown: {} };
    }
    const source = value as Record<string, unknown>;
    const normalizeBucket = (bucket: unknown): Record<string, XbTavernNativeWorldInfoTimedEffect> => {
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {return {};}
        const result: Record<string, XbTavernNativeWorldInfoTimedEffect> = {};
        Object.entries(bucket as Record<string, unknown>).forEach(([key, item]) => {
            const normalized = normalizeNativeWorldInfoTimedEffect(item);
            if (key && normalized) {
                result[key] = normalized;
            }
        });
        return result;
    };
    return {
        sticky: normalizeBucket(source.sticky),
        cooldown: normalizeBucket(source.cooldown),
    };
}

export function normalizeTavernSessionState(value: unknown): TavernSessionState {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
        ...source,
        turn: Math.max(0, Number(source.turn) || 0),
        contract: normalizeTavernSessionContract(source.contract),
        worldEntryStates: normalizeWorldEntryStates(source.worldEntryStates),
        nativeWorldInfoTimedState: normalizeNativeWorldInfoTimedState(source.nativeWorldInfoTimedState),
    };
}

function hasOwnStateField(value: unknown, key: keyof TavernSessionState): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);
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
    const characterName = cleanSessionDisplayText(input.characterName || '');
    const title = cleanSessionDisplayText(input.title || '');
    const session: TavernSessionRecord = {
        id: String(input.id || createId()),
        title: normalizeTitle(title, characterName || '未选择角色'),
        characterId: String(input.characterId || ''),
        characterName,
        createdAt: Number(input.createdAt) || timestamp,
        updatedAt: timestamp,
        contextSnapshot: cloneSerializable(input.contextSnapshot, undefined),
        buildSnapshot: cloneSerializable(input.buildSnapshot, undefined),
        chatPresetId: String(input.chatPresetId || input.presetId || ''),
        chatPresetName: String(input.chatPresetName || input.presetName || ''),
        presetId: String(input.presetId || ''),
        presetName: String(input.presetName || ''),
        summary: String(input.summary || ''),
        state: cloneSerializable(normalizeTavernSessionState(input.state || {}), {}),
    };
    await db.transaction('rw', tavernSessionsTable, tavernMetaTable, tavernStateDocumentsTable, async () => {
        await tavernSessionsTable.put(session);
        await tavernMetaTable.put({ key: 'selectedSessionId', value: session.id, updatedAt: timestamp });
        await ensureSeedStructuredStateDocument(session.id, { touchSession: false });
    });
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

export async function deleteTavernSession(sessionId = ''): Promise<number> {
    const id = String(sessionId || '').trim();
    if (!id) {return 0;}
    const existing = await getTavernSession(id);
    if (!existing) {return 0;}
    await db.transaction(
        'rw',
        tavernSessionsTable,
        tavernMessagesTable,
        tavernManagerMessagesTable,
        tavernTurnSummariesTable,
        tavernEpisodeSummariesTable,
        tavernManagerRunsTable,
        tavernManagerMemorySnapshotsTable,
        tavernManagerStateSnapshotsTable,
        tavernMemoryFilesTable,
        tavernMemoryIndexesTable,
        tavernStateDocumentsTable,
        tavernStatePatchesTable,
        tavernMetaTable,
        async () => {
            const [messages, managerMessages, turns, episodes, runs, snapshots, stateSnapshots, files, indexes, stateDocuments, statePatches] = await Promise.all([
                tavernMessagesTable.where('sessionId').equals(id).toArray(),
                tavernManagerMessagesTable.where('sessionId').equals(id).toArray(),
                tavernTurnSummariesTable.where('sessionId').equals(id).toArray(),
                tavernEpisodeSummariesTable.where('sessionId').equals(id).toArray(),
                tavernManagerRunsTable.where('sessionId').equals(id).toArray(),
                tavernManagerMemorySnapshotsTable.where('sessionId').equals(id).toArray(),
                tavernManagerStateSnapshotsTable.where('sessionId').equals(id).toArray(),
                tavernMemoryFilesTable.where('sessionId').equals(id).toArray(),
                tavernMemoryIndexesTable.where('sessionId').equals(id).toArray(),
                tavernStateDocumentsTable.where('sessionId').equals(id).toArray(),
                tavernStatePatchesTable.where('sessionId').equals(id).toArray(),
            ]);
            await Promise.all([
                messages.length ? tavernMessagesTable.bulkDelete(messages.map((message) => [message.sessionId, message.order])) : 0,
                managerMessages.length ? tavernManagerMessagesTable.bulkDelete(managerMessages.map((message) => [message.sessionId, message.order])) : 0,
                turns.length ? tavernTurnSummariesTable.bulkDelete(turns.map((summary) => summary.id)) : 0,
                episodes.length ? tavernEpisodeSummariesTable.bulkDelete(episodes.map((episode) => episode.id)) : 0,
                runs.length ? tavernManagerRunsTable.bulkDelete(runs.map((run) => run.id)) : 0,
                snapshots.length ? tavernManagerMemorySnapshotsTable.bulkDelete(snapshots.map((snapshot) => [snapshot.managerRunId, snapshot.path])) : 0,
                stateSnapshots.length ? tavernManagerStateSnapshotsTable.bulkDelete(stateSnapshots.map((snapshot) => [snapshot.managerRunId, snapshot.docType, snapshot.docId])) : 0,
                files.length ? tavernMemoryFilesTable.bulkDelete(files.map((file) => [file.sessionId, file.path])) : 0,
                indexes.length ? tavernMemoryIndexesTable.bulkDelete(indexes.map((index) => [index.sessionId, index.kind])) : 0,
                stateDocuments.length ? tavernStateDocumentsTable.bulkDelete(stateDocuments.map((document) => [document.sessionId, document.docType, document.docId])) : 0,
                statePatches.length ? tavernStatePatchesTable.bulkDelete(statePatches.map((patch) => patch.id)) : 0,
            ]);
            await tavernSessionsTable.delete(id);
            const selected = await tavernMetaTable.get('selectedSessionId');
            if (String(selected?.value || '') === id) {
                const [nextSession] = await tavernSessionsTable.orderBy('updatedAt').reverse().toArray();
                await tavernMetaTable.put({
                    key: 'selectedSessionId',
                    value: nextSession?.id || '',
                    updatedAt: now(),
                });
            }
        },
    );
    return 1;
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
        contract: hasOwnStateField(patch, 'contract')
            ? mergeTavernSessionContract(currentState.contract, hasTavernSessionContractOverride(patch.contract) ? patch.contract : undefined)
            : currentState.contract,
        worldEntryStates: mergeWorldEntryStates(currentState.worldEntryStates || {}, patchState.worldEntryStates || {}),
        nativeWorldInfoTimedState: hasOwnStateField(patch, 'nativeWorldInfoTimedState')
            ? patchState.nativeWorldInfoTimedState
            : currentState.nativeWorldInfoTimedState,
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
    const currentState = normalizeTavernSessionState(existing.state || {});
    const normalized = normalizeTavernSessionState(stateInput);
    const state: TavernSessionState = {
        ...stateInput,
        turn: Math.max(0, Number(normalized.turn) || 0),
        contract: hasOwnStateField(stateInput, 'contract')
            ? mergeTavernSessionContract(currentState.contract, hasTavernSessionContractOverride(stateInput.contract) ? stateInput.contract : undefined)
            : currentState.contract,
        worldEntryStates: normalized.worldEntryStates || {},
        nativeWorldInfoTimedState: normalized.nativeWorldInfoTimedState,
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
    chatPresetId?: string;
    chatPresetName?: string;
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
        chatPresetId: 'chatPresetId' in patch ? String(patch.chatPresetId || '') : existing.chatPresetId,
        chatPresetName: 'chatPresetName' in patch ? String(patch.chatPresetName || '') : existing.chatPresetName,
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
        thoughts: 'thoughts' in message ? cloneSerializable(message.thoughts, undefined) : undefined,
        providerPayload: 'providerPayload' in message ? cloneSerializable(message.providerPayload, undefined) : undefined,
        contextSnapshot: 'contextSnapshot' in message ? cloneSerializable(message.contextSnapshot, undefined) : undefined,
        buildSnapshot: 'buildSnapshot' in message ? cloneSerializable(message.buildSnapshot, undefined) : undefined,
        chatPresetId: 'chatPresetId' in message ? String(message.chatPresetId || '') : String(message.presetId || ''),
        chatPresetName: 'chatPresetName' in message ? String(message.chatPresetName || '') : String(message.presetName || ''),
        presetId: 'presetId' in message ? String(message.presetId || '') : undefined,
        presetName: 'presetName' in message ? String(message.presetName || '') : undefined,
        requestSnapshot: 'requestSnapshot' in message ? cloneSerializable(message.requestSnapshot, undefined) : undefined,
        runtimeEvents: 'runtimeEvents' in message ? normalizeMessageRuntimeEvents(message.runtimeEvents) : [],
    };
    await db.transaction('rw', tavernMessagesTable, tavernSessionsTable, async () => {
        await tavernMessagesTable.put(record);
        await tavernSessionsTable.update(id, { updatedAt: timestamp });
    });
    return normalizeStoredTavernMessageRecord(record);
}

export async function updateTavernMessage(
    sessionId = '',
    order = -1,
    patch: Partial<Pick<TavernMessageRecord, 'content' | 'error' | 'thoughts' | 'runtimeEvents'>>,
): Promise<TavernMessageRecord | null> {
    const id = String(sessionId || '').trim();
    const messageOrder = Number(order);
    if (!id || !Number.isInteger(messageOrder) || messageOrder < 0) {return null;}
    const existing = await tavernMessagesTable.get([id, messageOrder]);
    if (!existing) {return null;}
    const update: Partial<TavernMessageRecord> = {};
    if ('content' in patch) {update.content = String(patch.content || '');}
    if ('error' in patch) {update.error = patch.error === true;}
    if ('thoughts' in patch) {update.thoughts = cloneSerializable(patch.thoughts, undefined);}
    if ('runtimeEvents' in patch) {update.runtimeEvents = normalizeMessageRuntimeEvents(patch.runtimeEvents);}
    await tavernMessagesTable.update([id, messageOrder], update);
    await tavernSessionsTable.update(id, { updatedAt: now() });
    const updated = await tavernMessagesTable.get([id, messageOrder]);
    return updated ? normalizeStoredTavernMessageRecord(updated) : null;
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
    return (await tavernMessagesTable.where('sessionId').equals(id).sortBy('order'))
        .map(normalizeStoredTavernMessageRecord);
}

export async function appendTavernManagerMessage(
    sessionId: string,
    message: TavernAppendManagerMessageInput,
): Promise<TavernManagerMessageRecord> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('session_required');}
    const existing = await tavernManagerMessagesTable.where('sessionId').equals(id).toArray();
    const order = Math.max(-1, ...existing.map((item) => Number(item.order) || 0)) + 1;
    const timestamp = now();
    const record: TavernManagerMessageRecord = {
        sessionId: id,
        order,
        role: normalizeManagerMessageRole(message.role),
        content: String(message.content || ''),
        name: message.name ? String(message.name) : undefined,
        error: message.error === true,
        createdAt: timestamp,
        updatedAt: timestamp,
        provider: 'provider' in message ? String(message.provider || '') : undefined,
        model: 'model' in message ? String(message.model || '') : undefined,
        finishReason: 'finishReason' in message ? String(message.finishReason || '') : undefined,
        thoughts: 'thoughts' in message ? cloneSerializable(message.thoughts, undefined) : undefined,
        providerPayload: 'providerPayload' in message ? cloneSerializable(message.providerPayload, undefined) : undefined,
        toolCalls: normalizeManagerToolCalls(message),
        toolCallId: String(message.toolCallId || message.tool_call_id || '').trim() || undefined,
        toolName: String(message.toolName || '').trim() || undefined,
        toolDisplay: 'toolDisplay' in message ? cloneSerializable(message.toolDisplay, undefined) : undefined,
    };
    await db.transaction('rw', tavernManagerMessagesTable, tavernSessionsTable, async () => {
        await tavernManagerMessagesTable.put(record);
        await tavernSessionsTable.update(id, { updatedAt: timestamp });
    });
    return record;
}

export async function updateTavernManagerMessage(
    sessionId = '',
    order = -1,
    patch: Partial<Pick<TavernManagerMessageRecord, 'content' | 'error' | 'provider' | 'model' | 'finishReason' | 'thoughts' | 'providerPayload' | 'toolCalls' | 'toolCallId' | 'toolName' | 'toolDisplay'>> & {
        clearProtocolPayload?: boolean;
    },
): Promise<TavernManagerMessageRecord | null> {
    const id = String(sessionId || '').trim();
    const messageOrder = Number(order);
    if (!id || !Number.isInteger(messageOrder) || messageOrder < 0) {return null;}
    const existing = await tavernManagerMessagesTable.get([id, messageOrder]);
    if (!existing) {return null;}
    const timestamp = now();
    const update: Partial<TavernManagerMessageRecord> = {
        updatedAt: timestamp,
    };
    if ('content' in patch) {update.content = String(patch.content || '');}
    if ('error' in patch) {update.error = patch.error === true;}
    if ('provider' in patch) {update.provider = String(patch.provider || '');}
    if ('model' in patch) {update.model = String(patch.model || '');}
    if ('finishReason' in patch) {update.finishReason = String(patch.finishReason || '');}
    if ('thoughts' in patch) {update.thoughts = cloneSerializable(patch.thoughts, undefined);}
    if ('providerPayload' in patch) {update.providerPayload = cloneSerializable(patch.providerPayload, undefined);}
    if ('toolCalls' in patch) {update.toolCalls = normalizeManagerToolCalls(patch);}
    if ('toolCallId' in patch) {update.toolCallId = String(patch.toolCallId || '').trim();}
    if ('toolName' in patch) {update.toolName = String(patch.toolName || '').trim();}
    if ('toolDisplay' in patch) {update.toolDisplay = cloneSerializable(patch.toolDisplay, undefined);}
    if (patch.clearProtocolPayload === true) {
        update.providerPayload = undefined;
        update.toolCalls = undefined;
        update.toolCallId = undefined;
        update.toolName = undefined;
        update.toolDisplay = undefined;
    }
    await tavernManagerMessagesTable.update([id, messageOrder], update);
    await tavernSessionsTable.update(id, { updatedAt: timestamp });
    return await tavernManagerMessagesTable.get([id, messageOrder]) || null;
}

export async function deleteTavernManagerMessages(sessionId = '', orders: number[] = []): Promise<number> {
    const id = String(sessionId || '').trim();
    const uniqueOrders = [...new Set((Array.isArray(orders) ? orders : [])
        .map((order) => Number(order))
        .filter((order) => Number.isInteger(order) && order >= 0))];
    if (!id || !uniqueOrders.length) {return 0;}
    const existingKeys: Array<[string, number]> = [];
    await Promise.all(uniqueOrders.map(async (order) => {
        const existing = await tavernManagerMessagesTable.get([id, order]);
        if (existing) {existingKeys.push([id, order]);}
    }));
    if (!existingKeys.length) {return 0;}
    await db.transaction('rw', tavernManagerMessagesTable, tavernSessionsTable, async () => {
        await tavernManagerMessagesTable.bulkDelete(existingKeys);
        await tavernSessionsTable.update(id, { updatedAt: now() });
    });
    return existingKeys.length;
}

export async function listTavernManagerMessages(sessionId = ''): Promise<TavernManagerMessageRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    return tavernManagerMessagesTable.where('sessionId').equals(id).sortBy('order');
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
        changedStates: normalizeStringArray(input.changedStates, 100),
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
    if ('changedStates' in patch) {update.changedStates = normalizeStringArray(patch.changedStates, 100);}
    if ('turn' in patch) {update.turn = Math.max(0, Number(patch.turn) || 0);}
    if ('userOrder' in patch) {update.userOrder = Number(patch.userOrder);}
    if ('assistantOrder' in patch) {update.assistantOrder = Number(patch.assistantOrder);}
    await tavernManagerRunsTable.update(id, update);
    await tavernSessionsTable.update(existing.sessionId, { updatedAt: now() });
    return await tavernManagerRunsTable.get(id) || null;
}

export async function touchRunningTavernManagerRun(managerRunId = ''): Promise<TavernManagerRunRecord | null> {
    const id = String(managerRunId || '').trim();
    if (!id) {return null;}
    const existing = await tavernManagerRunsTable.get(id);
    if (!existing || existing.status !== 'running') {return existing || null;}
    const timestamp = now();
    await tavernManagerRunsTable.update(id, { updatedAt: timestamp });
    await tavernSessionsTable.update(existing.sessionId, { updatedAt: timestamp });
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

function hashMemorySnapshot(file?: Pick<TavernMemoryFileRecord, 'content' | 'status' | 'source' | 'staleFromOrder'> | null): string {
    const text = JSON.stringify({
        content: String(file?.content || ''),
        status: String(file?.status || ''),
        source: String(file?.source || ''),
        staleFromOrder: Number.isFinite(Number(file?.staleFromOrder)) ? Number(file?.staleFromOrder) : null,
    });
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16);
}

function hashSerializableState(value: unknown): string {
    const text = JSON.stringify(value ?? null);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16);
}

function hashStateSnapshot(document?: TavernStructuredStateDocumentRecord | null): string {
    return hashSerializableState(document ? {
        docType: document.docType,
        docId: document.docId,
        title: String(document.title || ''),
        revision: Number(document.revision) || 0,
        data: document.data ?? null,
        digest: String(document.digest || ''),
        status: String(document.status || ''),
        source: String(document.source || ''),
        staleFromOrder: Number.isFinite(Number(document.staleFromOrder)) ? Number(document.staleFromOrder) : null,
    } : null);
}

function mergeRollbackError(existing = '', conflicts: string[] = []): string {
    const current = String(existing || '').trim();
    if (!conflicts.length) {return current;}
    const prefix = 'rollback_conflict:';
    const currentConflicts = current.startsWith(prefix)
        ? current.slice(prefix.length).split(',').map((item) => item.trim()).filter(Boolean)
        : [];
    const merged = [...new Set([...currentConflicts, ...conflicts])];
    return `${prefix}${merged.join(',')}`;
}

export async function listTavernStructuredStateDocuments(sessionId = '', options: {
    docType?: TavernStructuredStateDocType | string;
    includeStale?: boolean;
} = {}): Promise<TavernStructuredStateDocumentRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernStateDocumentsTable.where('sessionId').equals(id).sortBy('updatedAt');
    const type = String(options.docType || '').trim();
    return rows
        .filter((row) => !type || row.docType === type)
        .filter((row) => options.includeStale || row.status !== 'stale');
}

export async function getTavernStructuredStateDocument(
    sessionId = '',
    docType: TavernStructuredStateDocType | string = 'tavern.map',
    docId = 'main',
): Promise<TavernStructuredStateDocumentRecord | null> {
    const id = String(sessionId || '').trim();
    const type = String(docType || '').trim() as TavernStructuredStateDocType;
    const documentId = String(docId || 'main').trim() || 'main';
    if (!id || !type || !documentId) {return null;}
    return await tavernStateDocumentsTable.get([id, type, documentId]) || null;
}

export async function ensureSeedStructuredStateDocument(
    sessionId = '',
    options: {
        touchSession?: boolean;
    } = {},
): Promise<TavernStructuredStateDocumentRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await db.transaction('rw', tavernStateDocumentsTable, tavernSessionsTable, async () => {
        const existing = await tavernStateDocumentsTable.get([id, TAVERN_MAP_DOC_TYPE, TAVERN_MAP_DOC_ID]);
        if (existing) {return existing;}
        const timestamp = now();
        const record: TavernStructuredStateDocumentRecord = {
            sessionId: id,
            docType: TAVERN_MAP_DOC_TYPE,
            docId: TAVERN_MAP_DOC_ID,
            title: '地图',
            revision: 0,
            data: createSeedMapDocument(),
            digest: '',
            status: 'active',
            source: 'system-seed',
            staleFromOrder: undefined,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        await tavernStateDocumentsTable.put(record);
        if (options.touchSession !== false) {
            await tavernSessionsTable.update(id, { updatedAt: timestamp });
        }
        return record;
    });
}

export async function putTavernStructuredStateDocument(
    document: TavernStructuredStateDocumentRecord,
): Promise<TavernStructuredStateDocumentRecord> {
    const timestamp = now();
    const record: TavernStructuredStateDocumentRecord = {
        ...cloneSerializable(document, document),
        sessionId: String(document.sessionId || '').trim(),
        docType: String(document.docType || 'tavern.map') as TavernStructuredStateDocType,
        docId: String(document.docId || 'main').trim() || 'main',
        title: String(document.title || ''),
        revision: Math.max(0, Number(document.revision) || 0),
        digest: String(document.digest || ''),
        status: document.status === 'stale' ? 'stale' : 'active',
        createdAt: Number(document.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    if (!record.sessionId) {throw new Error('state_session_required');}
    await tavernStateDocumentsTable.put(record);
    await tavernSessionsTable.update(record.sessionId, { updatedAt: timestamp });
    return record;
}

export async function appendTavernStructuredStatePatch(input: Partial<TavernStructuredStatePatchRecord> = {}): Promise<TavernStructuredStatePatchRecord> {
    const sessionId = String(input.sessionId || '').trim();
    const docType = String(input.docType || 'tavern.map') as TavernStructuredStateDocType;
    const docId = String(input.docId || 'main').trim() || 'main';
    if (!sessionId) {throw new Error('state_patch_session_required');}
    const timestamp = now();
    const record: TavernStructuredStatePatchRecord = {
        id: String(input.id || createId('state-patch')),
        sessionId,
        docType,
        docId,
        revision: Math.max(0, Number(input.revision) || 0),
        status: input.status === 'rolled_back' ? 'rolled_back' : 'active',
        managerRunId: String(input.managerRunId || ''),
        sourceUserOrder: Number.isFinite(Number(input.sourceUserOrder)) ? Number(input.sourceUserOrder) : undefined,
        sourceAssistantOrder: Number.isFinite(Number(input.sourceAssistantOrder)) ? Number(input.sourceAssistantOrder) : undefined,
        source: String(input.source || ''),
        summary: String(input.summary || ''),
        ops: Array.isArray(input.ops) ? cloneSerializable(input.ops, []) : [],
        changedIds: normalizeStringArray(input.changedIds, 200),
        removedElements: Array.isArray(input.removedElements) ? cloneSerializable(input.removedElements, []) : [],
        createdAt: Number(input.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await tavernStatePatchesTable.put(record);
    await tavernSessionsTable.update(sessionId, { updatedAt: timestamp });
    return record;
}

export async function listTavernStructuredStatePatches(input: {
    sessionId?: string;
    docType?: TavernStructuredStateDocType | string;
    docId?: string;
    limit?: number;
    includeRolledBack?: boolean;
} = {}): Promise<TavernStructuredStatePatchRecord[]> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {return [];}
    const docType = String(input.docType || '').trim();
    const docId = String(input.docId || '').trim();
    const rows = await tavernStatePatchesTable.where('sessionId').equals(sessionId).sortBy('revision');
    const filtered = rows.filter((row) => (!docType || row.docType === docType)
        && (!docId || row.docId === docId)
        && (input.includeRolledBack || row.status !== 'rolled_back'));
    const limit = Math.max(0, Number(input.limit) || 0);
    return limit ? filtered.slice(-limit) : filtered;
}

export async function ensureTavernManagerMemorySnapshot(input: {
    managerRunId?: string;
    sessionId?: string;
    path?: string;
}): Promise<TavernManagerMemorySnapshotRecord | null> {
    const managerRunId = String(input.managerRunId || '').trim();
    const sessionId = String(input.sessionId || '').trim();
    const path = String(input.path || '').trim();
    if (!managerRunId || !sessionId || !path) {return null;}
    const existingSnapshot = await tavernManagerMemorySnapshotsTable.get([managerRunId, path]);
    if (existingSnapshot) {return existingSnapshot;}
    const timestamp = now();
    const beforeFile = await tavernMemoryFilesTable.get([sessionId, path]) || null;
    const snapshot: TavernManagerMemorySnapshotRecord = {
        managerRunId,
        sessionId,
        path,
        beforeExists: !!beforeFile,
        beforeFile: beforeFile ? cloneSerializable(beforeFile, undefined) : undefined,
        beforeHash: hashMemorySnapshot(beforeFile),
        afterHash: '',
        rollbackStatus: 'pending',
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    await tavernManagerMemorySnapshotsTable.put(snapshot);
    return snapshot;
}

export async function updateTavernManagerMemorySnapshotAfter(input: {
    managerRunId?: string;
    sessionId?: string;
    path?: string;
}): Promise<TavernManagerMemorySnapshotRecord | null> {
    const managerRunId = String(input.managerRunId || '').trim();
    const sessionId = String(input.sessionId || '').trim();
    const path = String(input.path || '').trim();
    if (!managerRunId || !sessionId || !path) {return null;}
    const snapshot = await ensureTavernManagerMemorySnapshot({ managerRunId, sessionId, path });
    if (!snapshot) {return null;}
    const afterFile = await tavernMemoryFilesTable.get([sessionId, path]) || null;
    await tavernManagerMemorySnapshotsTable.update([managerRunId, path], {
        afterHash: hashMemorySnapshot(afterFile),
        updatedAt: now(),
    });
    return await tavernManagerMemorySnapshotsTable.get([managerRunId, path]) || null;
}

export async function ensureTavernManagerStateSnapshot(input: {
    managerRunId?: string;
    sessionId?: string;
    docType?: TavernStructuredStateDocType | string;
    docId?: string;
}): Promise<TavernManagerStateSnapshotRecord | null> {
    const managerRunId = String(input.managerRunId || '').trim();
    const sessionId = String(input.sessionId || '').trim();
    const docType = String(input.docType || 'tavern.map') as TavernStructuredStateDocType;
    const docId = String(input.docId || 'main').trim() || 'main';
    if (!managerRunId || !sessionId || !docType || !docId) {return null;}
    const existingSnapshot = await tavernManagerStateSnapshotsTable.get([managerRunId, docType, docId]);
    if (existingSnapshot) {return existingSnapshot;}
    const timestamp = now();
    const beforeDocument = await getTavernStructuredStateDocument(sessionId, docType, docId);
    const snapshot: TavernManagerStateSnapshotRecord = {
        managerRunId,
        sessionId,
        docType,
        docId,
        beforeExists: !!beforeDocument,
        beforeDocument: beforeDocument ? cloneSerializable(beforeDocument, undefined) : undefined,
        beforeHash: hashStateSnapshot(beforeDocument),
        afterHash: '',
        rollbackStatus: 'pending',
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    await tavernManagerStateSnapshotsTable.put(snapshot);
    return snapshot;
}

export async function updateTavernManagerStateSnapshotAfter(input: {
    managerRunId?: string;
    sessionId?: string;
    docType?: TavernStructuredStateDocType | string;
    docId?: string;
}): Promise<TavernManagerStateSnapshotRecord | null> {
    const managerRunId = String(input.managerRunId || '').trim();
    const sessionId = String(input.sessionId || '').trim();
    const docType = String(input.docType || 'tavern.map') as TavernStructuredStateDocType;
    const docId = String(input.docId || 'main').trim() || 'main';
    if (!managerRunId || !sessionId || !docType || !docId) {return null;}
    const snapshot = await ensureTavernManagerStateSnapshot({ managerRunId, sessionId, docType, docId });
    if (!snapshot) {return null;}
    const afterDocument = await getTavernStructuredStateDocument(sessionId, docType, docId);
    await tavernManagerStateSnapshotsTable.update([managerRunId, docType, docId], {
        afterHash: hashStateSnapshot(afterDocument),
        updatedAt: now(),
    });
    return await tavernManagerStateSnapshotsTable.get([managerRunId, docType, docId]) || null;
}

export async function listTavernManagerMemorySnapshots(managerRunId = ''): Promise<TavernManagerMemorySnapshotRecord[]> {
    const id = String(managerRunId || '').trim();
    if (!id) {return [];}
    return await tavernManagerMemorySnapshotsTable.where('managerRunId').equals(id).sortBy('updatedAt');
}

export async function listTavernManagerStateSnapshots(managerRunId = ''): Promise<TavernManagerStateSnapshotRecord[]> {
    const id = String(managerRunId || '').trim();
    if (!id) {return [];}
    return await tavernManagerStateSnapshotsTable.where('managerRunId').equals(id).sortBy('updatedAt');
}

export async function rollbackManagerRunMemoryWrites(managerRunId = ''): Promise<{
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const id = String(managerRunId || '').trim();
    if (!id) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    const run = await tavernManagerRunsTable.get(id);
    if (!run) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    const snapshots = (await listTavernManagerMemorySnapshots(id)).reverse();
    let rolledBack = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    for (const snapshot of snapshots) {
        if (snapshot.rollbackStatus === 'rolled_back' || snapshot.rollbackStatus === 'skipped') {
            skipped += 1;
            continue;
        }
        if (snapshot.rollbackStatus === 'conflict') {
            conflicts.push(snapshot.path);
            skipped += 1;
            continue;
        }
        const current = await tavernMemoryFilesTable.get([snapshot.sessionId, snapshot.path]) || null;
        if (!snapshot.afterHash) {
            skipped += 1;
            await tavernManagerMemorySnapshotsTable.update([snapshot.managerRunId, snapshot.path], {
                rollbackStatus: 'skipped',
                error: 'snapshot_after_hash_missing',
                updatedAt: now(),
            });
            continue;
        }
        if (hashMemorySnapshot(current) !== snapshot.afterHash) {
            conflicts.push(snapshot.path);
            await tavernManagerMemorySnapshotsTable.update([snapshot.managerRunId, snapshot.path], {
                rollbackStatus: 'conflict',
                error: 'rollback_conflict_current_file_changed',
                updatedAt: now(),
            });
            continue;
        }
        if (snapshot.beforeExists && snapshot.beforeFile) {
            await tavernMemoryFilesTable.put(cloneSerializable(snapshot.beforeFile, snapshot.beforeFile));
        } else {
            await tavernMemoryFilesTable.delete([snapshot.sessionId, snapshot.path]);
        }
        rolledBack += 1;
        await tavernManagerMemorySnapshotsTable.update([snapshot.managerRunId, snapshot.path], {
            rollbackStatus: 'rolled_back',
            error: '',
            updatedAt: now(),
        });
    }
    await tavernMemoryIndexesTable.put({
        sessionId: run.sessionId,
        kind: 'markdown-derived',
        status: 'stale',
        error: conflicts.length ? `rollback_conflict:${conflicts.join(',')}` : '',
        sourceFingerprint: '',
        derivedAt: now(),
        updatedAt: now(),
    });
    if (Number.isInteger(Number(run.userOrder)) && Number.isInteger(Number(run.assistantOrder))) {
        const summaries = await tavernTurnSummariesTable.where('sessionId').equals(run.sessionId).toArray();
        await Promise.all(summaries
            .filter((summary) => summary.userOrder === run.userOrder && summary.assistantOrder === run.assistantOrder)
            .map((summary) => tavernTurnSummariesTable.update(summary.id, {
                status: 'stale',
                updatedAt: now(),
            })));
    }
    await updateTavernManagerRun(id, {
        status: 'rolled_back',
        error: mergeRollbackError(run.error, conflicts),
    });
    await tavernSessionsTable.update(run.sessionId, { updatedAt: now() });
    return { rolledBack, conflicts, skipped };
}

export async function rollbackManagerRunStateWrites(managerRunId = ''): Promise<{
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const id = String(managerRunId || '').trim();
    if (!id) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    const run = await tavernManagerRunsTable.get(id);
    if (!run) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    const snapshots = (await listTavernManagerStateSnapshots(id)).reverse();
    let rolledBack = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    for (const snapshot of snapshots) {
        const key = `${snapshot.docType}/${snapshot.docId}`;
        if (snapshot.rollbackStatus === 'rolled_back' || snapshot.rollbackStatus === 'skipped') {
            skipped += 1;
            continue;
        }
        if (snapshot.rollbackStatus === 'conflict') {
            conflicts.push(key);
            skipped += 1;
            continue;
        }
        const current = await getTavernStructuredStateDocument(snapshot.sessionId, snapshot.docType, snapshot.docId);
        if (!snapshot.afterHash) {
            skipped += 1;
            await tavernManagerStateSnapshotsTable.update([snapshot.managerRunId, snapshot.docType, snapshot.docId], {
                rollbackStatus: 'skipped',
                error: 'snapshot_after_hash_missing',
                updatedAt: now(),
            });
            continue;
        }
        if (hashStateSnapshot(current) !== snapshot.afterHash) {
            conflicts.push(key);
            await tavernManagerStateSnapshotsTable.update([snapshot.managerRunId, snapshot.docType, snapshot.docId], {
                rollbackStatus: 'conflict',
                error: 'rollback_conflict_current_state_changed',
                updatedAt: now(),
            });
            continue;
        }
        if (snapshot.beforeExists && snapshot.beforeDocument) {
            await tavernStateDocumentsTable.put(cloneSerializable(snapshot.beforeDocument, snapshot.beforeDocument));
        } else {
            await tavernStateDocumentsTable.delete([snapshot.sessionId, snapshot.docType, snapshot.docId]);
        }
        const patches = await tavernStatePatchesTable.where('managerRunId').equals(snapshot.managerRunId).toArray();
        await Promise.all(patches
            .filter((patch) => patch.docType === snapshot.docType && patch.docId === snapshot.docId)
            .map((patch) => tavernStatePatchesTable.update(patch.id, {
                status: 'rolled_back',
                updatedAt: now(),
            })));
        rolledBack += 1;
        await tavernManagerStateSnapshotsTable.update([snapshot.managerRunId, snapshot.docType, snapshot.docId], {
            rollbackStatus: 'rolled_back',
            error: '',
            updatedAt: now(),
        });
    }
    await updateTavernManagerRun(id, {
        status: 'rolled_back',
        error: mergeRollbackError(run.error, conflicts),
    });
    await tavernSessionsTable.update(run.sessionId, { updatedAt: now() });
    return { rolledBack, conflicts, skipped };
}

export async function rollbackManagerRunsForMessageRange(sessionId = '', fromOrder = 0): Promise<{
    runIds: string[];
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const id = String(sessionId || '').trim();
    const order = Number(fromOrder);
    if (!id || !Number.isFinite(order)) {
        return { runIds: [], rolledBack: 0, conflicts: [], skipped: 0 };
    }
    const runs = (await tavernManagerRunsTable.where('sessionId').equals(id).toArray())
        .filter((run) => run.trigger === 'after_turn'
            && (Number(run.userOrder) >= order || Number(run.assistantOrder) >= order))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    let rolledBack = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    for (const run of runs) {
        const snapshots = await listTavernManagerMemorySnapshots(run.id);
        const hasWrittenSnapshot = snapshots.some((snapshot) => String(snapshot.afterHash || '').trim());
        if (hasWrittenSnapshot) {
            const result = await rollbackManagerRunMemoryWrites(run.id);
            rolledBack += result.rolledBack;
            skipped += result.skipped;
            conflicts.push(...result.conflicts);
            continue;
        }
        await updateTavernManagerRun(run.id, {
            status: ['queued', 'running'].includes(run.status) ? 'cancelled' : 'superseded',
            error: 'manager_source_messages_superseded',
        });
    }
    return {
        runIds: runs.map((run) => run.id),
        rolledBack,
        conflicts,
        skipped,
    };
}

export async function rollbackManagerStateRunsForMessageRange(sessionId = '', fromOrder = 0): Promise<{
    runIds: string[];
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const id = String(sessionId || '').trim();
    const order = Number(fromOrder);
    if (!id || !Number.isFinite(order)) {
        return { runIds: [], rolledBack: 0, conflicts: [], skipped: 0 };
    }
    const runs = (await tavernManagerRunsTable.where('sessionId').equals(id).toArray())
        .filter((run) => run.trigger === 'after_turn'
            && (Number(run.userOrder) >= order || Number(run.assistantOrder) >= order))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    let rolledBack = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    for (const run of runs) {
        const snapshots = await listTavernManagerStateSnapshots(run.id);
        const hasWrittenSnapshot = snapshots.some((snapshot) => String(snapshot.afterHash || '').trim());
        if (!hasWrittenSnapshot) {continue;}
        const result = await rollbackManagerRunStateWrites(run.id);
        rolledBack += result.rolledBack;
        skipped += result.skipped;
        conflicts.push(...result.conflicts);
    }
    return {
        runIds: runs.map((run) => run.id),
        rolledBack,
        conflicts,
        skipped,
    };
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

export function createUserPresetFromBuiltIn(name = '酒馆聊天预设'): TavernChatPromptPresetBundle {
    return normalizeTavernChatPromptPresetBundle({
        ...createFallbackTavernChatPromptPresetBundle(),
        name: normalizePresetName(name),
    });
}

export async function saveTavernPreset(preset: TavernChatPromptPresetBundle, options: {
    sourcePresetId?: string;
    isBuiltIn?: boolean;
} = {}): Promise<TavernPresetRecord> {
    const timestamp = now();
    const normalizedPreset = normalizeTavernPresetSchema(cloneSerializable({
        ...preset,
        id: FALLBACK_TAVERN_CHAT_PRESET_ID,
        name: normalizePresetName(preset.name),
    }, createFallbackTavernChatPromptPresetBundle()));
    return {
        id: FALLBACK_TAVERN_CHAT_PRESET_ID,
        name: normalizePresetName(normalizedPreset.name),
        description: String(normalizedPreset.description || ''),
        version: String(normalizedPreset.version || ''),
        sourcePresetId: String(options.sourcePresetId || FALLBACK_TAVERN_CHAT_PRESET_ID),
        isBuiltIn: options.isBuiltIn === true,
        createdAt: timestamp,
        updatedAt: timestamp,
        preset: normalizedPreset,
    };
}

export async function listUserTavernPresets(): Promise<TavernPresetRecord[]> {
    return [];
}

export async function getActiveTavernPresetId(): Promise<string> {
    return FALLBACK_TAVERN_CHAT_PRESET_ID;
}

export async function setActiveTavernPresetId(presetId = FALLBACK_TAVERN_CHAT_PRESET_ID): Promise<string> {
    void presetId;
    await tavernMetaTable.delete('activePresetId');
    return FALLBACK_TAVERN_CHAT_PRESET_ID;
}

export async function loadActiveTavernPreset(): Promise<TavernChatPromptPresetBundle> {
    return createFallbackTavernChatPromptPresetBundle();
}

export async function deriveAndActivateDefaultTavernPreset(name = '酒馆聊天预设'): Promise<TavernPresetRecord> {
    const preset = createUserPresetFromBuiltIn(name);
    return saveTavernPreset(preset, { sourcePresetId: FALLBACK_TAVERN_CHAT_PRESET_ID });
}

export async function getActiveTavernAssistantPresetId(): Promise<string> {
    const entry = await tavernMetaTable.get('activeAssistantPresetId');
    return String(entry?.value || DEFAULT_TAVERN_ASSISTANT_PRESET_ID).trim() || DEFAULT_TAVERN_ASSISTANT_PRESET_ID;
}

export async function setActiveTavernAssistantPresetId(
    presetId = DEFAULT_TAVERN_ASSISTANT_PRESET_ID,
): Promise<string> {
    const value = String(presetId || DEFAULT_TAVERN_ASSISTANT_PRESET_ID).trim()
        || DEFAULT_TAVERN_ASSISTANT_PRESET_ID;
    await tavernMetaTable.put({ key: 'activeAssistantPresetId', value, updatedAt: now() });
    return value;
}

export async function saveTavernAssistantPreset(
    preset: Partial<TavernAssistantPreset>,
    options: { isBuiltIn?: boolean } = {},
): Promise<TavernAssistantPresetRecord> {
    const timestamp = now();
    const id = String(preset.id || createId('assistant-preset'));
    const existing = await tavernAssistantPresetsTable.get(id);
    const normalized = normalizeTavernAssistantPreset({
        ...preset,
        id,
        updatedAt: timestamp,
    });
    const record: TavernAssistantPresetRecord = {
        id,
        name: normalized.name,
        description: normalized.description,
        version: '',
        isBuiltIn: options.isBuiltIn === true,
        createdAt: Number(existing?.createdAt) || timestamp,
        updatedAt: timestamp,
        preset: normalized,
    };
    await tavernAssistantPresetsTable.put(record);
    return record;
}

export async function ensureDefaultTavernAssistantPreset(): Promise<TavernAssistantPresetRecord> {
    const existing = await tavernAssistantPresetsTable.get(DEFAULT_TAVERN_ASSISTANT_PRESET_ID);
    if (existing) {return existing;}
    return saveTavernAssistantPreset(createDefaultTavernAssistantPreset(), { isBuiltIn: true });
}

export async function listTavernAssistantPresets(): Promise<TavernAssistantPresetRecord[]> {
    await ensureDefaultTavernAssistantPreset();
    return tavernAssistantPresetsTable.orderBy('updatedAt').reverse().toArray();
}

export async function loadActiveTavernAssistantPreset(): Promise<TavernAssistantPreset> {
    await ensureDefaultTavernAssistantPreset();
    const activeId = await getActiveTavernAssistantPresetId();
    const record = await tavernAssistantPresetsTable.get(activeId)
        || await tavernAssistantPresetsTable.get(DEFAULT_TAVERN_ASSISTANT_PRESET_ID);
    return normalizeTavernAssistantPreset(record?.preset || createDefaultTavernAssistantPreset());
}

export default db;
