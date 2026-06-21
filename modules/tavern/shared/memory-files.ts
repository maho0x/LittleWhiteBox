import { applyTextEdits } from '../../agent-core/tools/text-edit.js';

import { getTavernStateToolDefinitions } from './structured-state';
import { getTavernTaskToolDefinitions } from './tasks';
import db, {
    getLatestTavernAssistantOrder,
    getLatestTavernMessage,
    listTavernMessages,
    listLatestTavernMessagesWithCount,
    listTavernMessagesInRangeWithCount,
    tavernMemoryFilesTable,
    tavernMemorySnapshotsTable,
    tavernMemoryIndexesTable,
    tavernManagerMemorySnapshotsTable,
    tavernMessagesTable,
    tavernSessionsTable,
    ensureTavernManagerMemorySnapshot,
    updateTavernManagerMemorySnapshotAfter,
    type TavernMemoryFileListEntry,
    type TavernMemoryFileRecord,
    type TavernMemoryIndexFileEntry,
    type TavernMemoryFileStatus,
    type TavernMemoryIndexRecord,
    type TavernMemorySnapshotRecord,
    type TavernMessageRecord,
} from './session-db';

export const MEMORY_BASELINE_FLOOR = -1;

export const TAVERN_MEMORY_TOOL_NAMES = {
    LIST: 'MemoryList',
    READ: 'MemoryRead',
    WRITE: 'MemoryWrite',
    EDIT: 'MemoryEdit',
    GREP: 'MemoryGrep',
    CHAT_HISTORY: 'ChatHistory',
} as const;

export type TavernManagerToolCaller = 'auto' | 'chat';

export interface TavernMemoryToolResult {
    ok: boolean;
    summary: string;
    path?: string;
    files?: Array<Pick<TavernMemoryFileRecord, 'path' | 'status' | 'updatedAt'>>;
    content?: string;
    numberedContent?: string;
    lineStart?: number;
    lineEnd?: number;
    totalLines?: number;
    count?: number;
    truncated?: boolean;
    nextOffset?: number;
    matches?: Array<{ path: string; line?: number; text?: string; context?: string; count?: number }>;
    messages?: Array<{
        order: number;
        role: string;
        snippet?: string;
        reasoningSnippet?: string;
        content?: string;
        thoughts?: Array<{ label?: string; text?: string }>;
    }>;
    changed?: boolean;
    partial?: boolean;
    appliedCount?: number;
    satisfiedCount?: number;
    successCount?: number;
    failedCount?: number;
    error?: string;
    warning?: string;
    details?: unknown;
}

const DEFAULT_MEMORY_READ_LIMIT = 1200;
const MAX_MEMORY_READ_LIMIT = 2000;
const DEFAULT_MEMORY_GREP_LIMIT = 100;
const MAX_MEMORY_GREP_LIMIT = 100;

function now(): number {
    return Date.now();
}

function memoryFileTitleFromPath(path = ''): string {
    if (path === 'memory/state.md') {return '会话记忆';}
    const characterName = getCharacterNameFromMemoryPath(path);
    if (characterName) {return characterName;}
    return String(path || '').replace(/^memory\//, '').replace(/\.md$/i, '') || '记忆档案';
}

function normalizeInline(value: unknown = '', limit = 400): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeBody(value: unknown = '', limit?: number): string {
    const text = String(value || '').replace(/\r\n/g, '\n').trim();
    return typeof limit === 'number' && limit > 0 && text.length > limit ? text.slice(0, limit) : text;
}

function splitLines(text = ''): string[] {
    return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function numberLines(lines: string[] = [], startLine = 1): string {
    return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function toPositiveInteger(value: unknown, fallback = 1): number {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toNonNegativeInteger(value: unknown, fallback = 0): number {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number <= 0) {return fallback;}
    return Math.min(max, number);
}

function normalizeOutputMode(value: unknown = ''): 'content' | 'files_with_matches' | 'count' {
    const text = String(value || 'content')
        .trim()
        .replace(/[\s-]/g, '_')
        .replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (text === 'files_with_matches' || text === 'fileswithmatches') {return 'files_with_matches';}
    if (text === 'count') {return 'count';}
    return 'content';
}

export function isStateMemoryPath(path = ''): boolean {
    return String(path || '').replace(/\\/g, '/').trim() === 'memory/state.md';
}

function normalizeMemoryCharacterName(value: unknown = ''): string {
    const name = String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!name) {throw new Error('memory_character_name_required');}
    if (name === '.' || name === '..') {throw new Error('memory_character_name_invalid');}
    if (/[\x00-\x1F\x7F/\\:*?"<>|]/u.test(name)) {throw new Error('memory_character_name_invalid');}
    return name;
}

export function isReservedUserMemoryCharacterName(value: unknown = ''): boolean {
    const key = String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .toLowerCase()
        .replace(/[\s_-]+/g, '')
        .trim();
    return new Set([
        'user',
        'users',
        'player',
        'players',
        'pc',
        'you',
        'me',
        'myself',
        'self',
        'host',
        'dm',
        'gm',
        'narrator',
        'operator',
        'protagonist',
        '用户',
        '玩家',
        '主控',
        '我',
        '你',
        '自己',
        '本人',
        '我方',
        '主人翁',
        '叙述者',
        '主持人',
    ]).has(key);
}

export function normalizeCharacterMemoryPath(characterName: unknown = ''): string {
    return `memory/characters/${normalizeMemoryCharacterName(characterName)}.md`;
}

export function getCharacterNameFromMemoryPath(pathInput = ''): string {
    const path = String(pathInput || '').replace(/\\/g, '/').trim();
    if (!path.startsWith('memory/characters/') || !path.endsWith('.md')) {return '';}
    const rest = path.slice('memory/characters/'.length, -'.md'.length);
    if (!rest || rest.includes('/')) {return '';}
    try {
        return normalizeMemoryCharacterName(rest);
    } catch {
        return '';
    }
}

export function isCharacterMemoryPath(path = ''): boolean {
    return !!getCharacterNameFromMemoryPath(path);
}

export function normalizeTavernMemoryPath(value: unknown = ''): string {
    const path = String(value || '').replace(/\\/g, '/').trim();
    if (!path) {throw new Error('memory_path_required');}
    if (isStateMemoryPath(path)) {return 'memory/state.md';}
    const characterName = getCharacterNameFromMemoryPath(path);
    if (characterName) {return normalizeCharacterMemoryPath(characterName);}
    if (!path.startsWith('memory/')) {throw new Error('memory_path_scope_required');}
    if (!path.endsWith('.md')) {throw new Error('memory_path_must_be_md');}
    throw new Error('memory_path_invalid');
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function buildDefaultTavernMemoryStateContent(characterName = ''): string {
    const name = normalizeInline(characterName, 120) || '当前角色';
    return [
        '# 会话记忆',
        '',
        '## 剧情脉络',
        '',
        '### 当前主线',
        '- 未开始。',
        '',
        '### 长期压力',
        '- 暂无。',
        '',
        '### 未解伏笔',
        '- 暂无。',
        '',
        '### 关系态势',
        '- 只保留影响主线或当前局面的关系摘要；人物细节放入对应人物记忆。',
        '',
        '## 当前状态',
        '- 时间：未明确',
        '- 地点：未明确',
        `- 在场人物：${name}`,
        '- 关键物品：暂无',
        '- 身体/情绪/约束状态：暂无',
        '## 近期连续事件',
        '- 暂无。',
    ].join('\n');
}

export function buildDefaultTavernCharacterMemoryContent(characterName = ''): string {
    const name = normalizeMemoryCharacterName(characterName);
    return [
        `# ${name}`,
        '',
        '## 当前状态',
        '- 位置/是否在场：未明确',
        '- 身体/情绪/约束：暂无',
        '- 公开目标：未明确',
        '- 隐藏动机/秘密：未明确',
        '',
        '## 关系',
        '- 对玩家：未明确',
        '- 对其他人物：未明确',
        '',
        '## 人物弧光',
        '- 已发生的长期变化：暂无',
        '- 尚未解决的内在矛盾：暂无',
        '',
        '## 承诺、债务与风险',
        '- 承诺：暂无',
        '- 欠债：暂无',
        '- 风险：暂无',
        '',
        '## 近期相关事件',
        '- 暂无。',
    ].join('\n');
}

function defaultMemoryFiles(sessionId = '', characterName = ''): TavernMemoryFileRecord[] {
    const timestamp = now();
    const base = { sessionId, status: 'active' as TavernMemoryFileStatus, createdAt: timestamp, updatedAt: timestamp, source: 'default' };
    return [
        {
            ...base,
            path: 'memory/state.md',
            content: buildDefaultTavernMemoryStateContent(characterName),
        },
    ];
}

export async function ensureTavernMemoryDefaults(sessionId = '', options: { characterName?: string } = {}): Promise<TavernMemoryFileRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('memory_session_required');}
    const existing = await tavernMemoryFilesTable.where('sessionId').equals(id).toArray();
    if (existing.length) {return existing.sort((left, right) => left.path.localeCompare(right.path));}
    const files = defaultMemoryFiles(id, options.characterName);
    await tavernMemoryFilesTable.bulkPut(files);
    await tavernSessionsTable.update(id, { updatedAt: now() });
    return files;
}

export async function listTavernMemoryFiles(sessionId = '', options: {
    includeStale?: boolean;
} = {}): Promise<TavernMemoryFileRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernMemoryFilesTable.where('sessionId').equals(id).sortBy('path');
    return options.includeStale ? rows : rows.filter((row) => row.status !== 'stale');
}

function buildMemoryFilePreview(file: Pick<TavernMemoryFileRecord, 'path' | 'content'>): string {
    return normalizeBody(file.content, 1200);
}

function buildMemoryFileListEntry(file: TavernMemoryFileRecord): TavernMemoryFileListEntry {
    return {
        path: file.path,
        status: file.status,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        source: file.source,
        staleFromOrder: file.staleFromOrder,
        contentLength: String(file.content || '').length,
        preview: buildMemoryFilePreview(file),
    };
}

function buildMemoryIndexFileEntry(file: TavernMemoryFileRecord): TavernMemoryIndexFileEntry {
    const entry = buildMemoryFileListEntry(file);
    return {
        ...entry,
        title: memoryFileTitleFromPath(file.path),
        searchText: normalizeBody([
            file.path,
            memoryFileTitleFromPath(file.path),
            file.content || '',
        ].filter(Boolean).join('\n'), 20000),
    };
}

export async function getTavernMemoryFile(sessionId = '', pathInput = ''): Promise<TavernMemoryFileRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    const path = normalizeTavernMemoryPath(pathInput);
    return await tavernMemoryFilesTable.get([id, path]) || null;
}

async function resolveMemorySnapshotFloor(sessionId = '', floorInput?: number): Promise<number> {
    const explicit = Number(floorInput);
    if (Number.isFinite(explicit)) {return Math.floor(explicit);}
    return await getLatestTavernAssistantOrder(sessionId) ?? MEMORY_BASELINE_FLOOR;
}

function isDefaultMemoryFileCollection(files: TavernMemoryFileRecord[] = [], characterName = ''): boolean {
    const activeFiles = files.filter((file) => file.status !== 'stale').sort((left, right) => left.path.localeCompare(right.path));
    return activeFiles.length === 1
        && activeFiles[0]?.path === 'memory/state.md'
        && activeFiles[0]?.content === buildDefaultTavernMemoryStateContent(characterName);
}

function hashSnapshotText(value: unknown): string {
    const text = String(value || '');
    let left = 2166136261;
    let right = 2166136261 ^ 0x9e3779b9;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        left ^= code;
        left = Math.imul(left, 16777619) >>> 0;
        right ^= code + index;
        right = Math.imul(right, 16777619) >>> 0;
    }
    return `${text.length.toString(36)}:${left.toString(16)}${right.toString(16)}`;
}

function memorySnapshotFileFingerprint(file: Pick<TavernMemoryFileRecord, 'path' | 'content' | 'status' | 'source' | 'staleFromOrder'>): string {
    return [
        normalizeTavernMemoryPath(file.path),
        String(file.status || ''),
        String(file.source || ''),
        Number.isFinite(Number(file.staleFromOrder)) ? String(Number(file.staleFromOrder)) : '',
        String(file.content || '').length,
        hashSnapshotText(file.content || ''),
    ].join('\u001f');
}

function memorySnapshotCollectionFingerprint(files: Array<Pick<TavernMemoryFileRecord, 'path' | 'content' | 'status' | 'source' | 'staleFromOrder'>> = []): string {
    const payload = [...files]
        .sort((left, right) => normalizeTavernMemoryPath(left.path).localeCompare(normalizeTavernMemoryPath(right.path)))
        .map(memorySnapshotFileFingerprint)
        .join('\u001e');
    return `${files.length}:${hashSnapshotText(payload)}`;
}

function memorySnapshotRecordFingerprint(snapshot: TavernMemorySnapshotRecord | null | undefined): string {
    return memorySnapshotCollectionFingerprint((snapshot?.files || []).map((entry) => entry.file));
}

export async function saveTavernMemorySnapshot(
    sessionId = '',
    floorInput?: number,
): Promise<TavernMemorySnapshotRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await db.transaction(
        'rw',
        tavernMemoryFilesTable,
        tavernMemorySnapshotsTable,
        tavernMessagesTable,
        tavernSessionsTable,
        async () => {
            const files = await listTavernMemoryFiles(id, { includeStale: true });
            if (!files.length) {return null;}
            const floor = await resolveMemorySnapshotFloor(id, floorInput);
            if (floor === MEMORY_BASELINE_FLOOR) {
                const session = await tavernSessionsTable.get(id);
                if (isDefaultMemoryFileCollection(files, session?.characterName || '')) {
                    return null;
                }
            }
            const currentFingerprint = memorySnapshotCollectionFingerprint(files);
            const latest = await getLatestTavernMemorySnapshot(id);
            if (latest && memorySnapshotRecordFingerprint(latest) === currentFingerprint) {
                return null;
            }
            const record: TavernMemorySnapshotRecord = {
                sessionId: id,
                floor,
                files: files
                    .sort((left, right) => left.path.localeCompare(right.path))
                    .map((file) => ({
                        path: file.path,
                        file: cloneJson(file),
                    })),
                createdAt: now(),
            };
            await tavernMemorySnapshotsTable.put(record);
            return record;
        }
    );
}

export async function listTavernMemorySnapshots(sessionId = ''): Promise<TavernMemorySnapshotRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    return (await tavernMemorySnapshotsTable.where('sessionId').equals(id).sortBy('floor'))
        .sort((left, right) => left.floor - right.floor || left.createdAt - right.createdAt);
}

export async function getLatestTavernMemorySnapshot(
    sessionId = '',
    targetFloor = Number.POSITIVE_INFINITY,
): Promise<TavernMemorySnapshotRecord | null> {
    const id = String(sessionId || '').trim();
    const floor = Number(targetFloor);
    if (!id) {return null;}
    const snapshots = await listTavernMemorySnapshots(id);
    return snapshots
        .filter((snapshot) => Number(snapshot.floor) <= floor || floor === Number.POSITIVE_INFINITY)
        .sort((left, right) => Number(right.floor) - Number(left.floor) || Number(right.createdAt) - Number(left.createdAt))[0]
        || null;
}

export async function trimTavernMemorySnapshotsFromFloor(sessionId = '', fromFloor = 0): Promise<number> {
    const id = String(sessionId || '').trim();
    const floor = Number(fromFloor);
    if (!id || !Number.isFinite(floor)) {return 0;}
    return await db.transaction('rw', tavernMemorySnapshotsTable, async () => {
        const snapshots = await listTavernMemorySnapshots(id);
        const affected = snapshots.filter((snapshot) => Number(snapshot.floor) >= floor);
        if (!affected.length) {return 0;}
        await tavernMemorySnapshotsTable.bulkDelete(affected.map((snapshot) => [snapshot.sessionId, snapshot.floor]));
        return affected.length;
    });
}

export async function restoreTavernMemoryToFloor(sessionId = '', targetFloor = -1): Promise<TavernMemoryFileRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('memory_session_required');}
    return await db.transaction(
        'rw',
        tavernMemoryFilesTable,
        tavernMemorySnapshotsTable,
        tavernMemoryIndexesTable,
        tavernSessionsTable,
        async () => {
            const snapshot = await getLatestTavernMemorySnapshot(id, targetFloor);
            if (snapshot?.files) {
                const timestamp = now();
                const currentFiles = await listTavernMemoryFiles(id, { includeStale: true });
                const snapshotFiles = snapshot.files;
                const snapshotPaths = new Set(snapshotFiles.map((entry) => normalizeTavernMemoryPath(entry.path)));
                const deleteKeys = currentFiles
                    .filter((file) => !snapshotPaths.has(file.path))
                    .map((file) => [file.sessionId, file.path]);
                const restoredFiles = snapshotFiles.map((entry) => {
                    const file = cloneJson(entry.file);
                    return {
                        ...file,
                        sessionId: id,
                        path: normalizeTavernMemoryPath(entry.path),
                        updatedAt: timestamp,
                    };
                });
                if (deleteKeys.length) {
                    await tavernMemoryFilesTable.bulkDelete(deleteKeys);
                }
                if (restoredFiles.length) {
                    await tavernMemoryFilesTable.bulkPut(restoredFiles);
                }
                await tavernSessionsTable.update(id, { updatedAt: timestamp });
                await markTavernMemoryIndexStale(id);
                return restoredFiles;
            }
            const timestamp = now();
            const session = await tavernSessionsTable.get(id);
            const currentFiles = await listTavernMemoryFiles(id, { includeStale: true });
            const deleteKeys = currentFiles
                .filter((file) => file.path !== 'memory/state.md')
                .map((file) => [file.sessionId, file.path]);
            if (deleteKeys.length) {
                await tavernMemoryFilesTable.bulkDelete(deleteKeys);
            }
            const existing = await tavernMemoryFilesTable.get([id, 'memory/state.md']);
            const stateFile: TavernMemoryFileRecord = {
                sessionId: id,
                path: 'memory/state.md',
                content: buildDefaultTavernMemoryStateContent(session?.characterName || ''),
                status: 'active',
                source: 'default',
                createdAt: Number(existing?.createdAt) || timestamp,
                updatedAt: timestamp,
            };
            await tavernMemoryFilesTable.put(stateFile);
            await tavernSessionsTable.update(id, { updatedAt: timestamp });
            await markTavernMemoryIndexStale(id);
            return [stateFile];
        }
    );
}

export async function writeTavernMemoryFile(sessionId = '', pathInput = '', contentInput = '', options: {
    source?: string;
    staleFromOrder?: number;
} = {}): Promise<TavernMemoryFileRecord> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('memory_session_required');}
    const path = normalizeTavernMemoryPath(pathInput);
    const timestamp = now();
    const existing = await tavernMemoryFilesTable.get([id, path]);
    const record: TavernMemoryFileRecord = {
        sessionId: id,
        path,
        content: String(contentInput || '').replace(/\r\n/g, '\n'),
        status: 'active',
        source: String(options.source || existing?.source || 'manager'),
        staleFromOrder: Number.isFinite(Number(options.staleFromOrder)) ? Number(options.staleFromOrder) : existing?.staleFromOrder,
        createdAt: Number(existing?.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await tavernMemoryFilesTable.put(record);
    await tavernSessionsTable.update(id, { updatedAt: timestamp });
    await markTavernMemoryIndexStale(id);
    return record;
}

export async function markTavernMemoryIndexStale(sessionId = '', error = ''): Promise<TavernMemoryIndexRecord> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('memory_session_required');}
    const timestamp = now();
    const existing = await tavernMemoryIndexesTable.get([id, 'markdown-derived']);
    const record: TavernMemoryIndexRecord = {
        sessionId: id,
        kind: 'markdown-derived',
        status: 'stale',
        error: String(error || ''),
        sourceFingerprint: '',
        derivedAt: timestamp,
        updatedAt: timestamp,
        files: Array.isArray(existing?.files) ? existing.files : [],
    };
    await tavernMemoryIndexesTable.put(record);
    return record;
}

export async function getTavernMemoryIndex(sessionId = '', kind = 'markdown-derived'): Promise<TavernMemoryIndexRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await tavernMemoryIndexesTable.get([id, kind]) || null;
}

function buildFingerprint(files: TavernMemoryFileRecord[]): string {
    const payload = files.map((file) => `${file.path}\u001f${file.status}\u001f${file.updatedAt}\u001f${file.content.length}`).join('\u001e');
    let hash = 2166136261;
    for (let index = 0; index < payload.length; index += 1) {
        hash ^= payload.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${files.length}:${hash.toString(16)}`;
}

export async function rebuildTavernMemoryDerivedIndex(sessionId = ''): Promise<TavernMemoryIndexRecord> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('memory_session_required');}
    const timestamp = now();
    try {
        const files = await listTavernMemoryFiles(id, { includeStale: true });
        const record: TavernMemoryIndexRecord = {
            sessionId: id,
            kind: 'markdown-derived',
            status: 'ready',
            error: '',
            sourceFingerprint: buildFingerprint(files),
            derivedAt: timestamp,
            updatedAt: timestamp,
            files: files.map(buildMemoryIndexFileEntry),
        };
        await tavernMemoryIndexesTable.put(record);
        return record;
    } catch (error) {
        const record: TavernMemoryIndexRecord = {
            sessionId: id,
            kind: 'markdown-derived',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error || 'memory_index_failed'),
            sourceFingerprint: '',
            derivedAt: timestamp,
            updatedAt: timestamp,
            files: [],
        };
        await tavernMemoryIndexesTable.put(record);
        return record;
    }
}

export async function listTavernMemoryFileEntries(sessionId = ''): Promise<TavernMemoryFileListEntry[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    let index = await getTavernMemoryIndex(id);
    if (!index || index.status !== 'ready' || !Array.isArray(index.files)) {
        index = await rebuildTavernMemoryDerivedIndex(id);
    }
    return Array.isArray(index.files)
        ? index.files.map((file) => ({
            path: file.path,
            status: file.status,
            createdAt: Number(file.createdAt) || Number(file.updatedAt) || 0,
            updatedAt: Number(file.updatedAt) || 0,
            source: String(file.source || ''),
            staleFromOrder: Number.isFinite(Number(file.staleFromOrder)) ? Number(file.staleFromOrder) : undefined,
            contentLength: Math.max(0, Number(file.contentLength) || 0),
            preview: String(file.preview || ''),
        }))
        : [];
}

function getToolPath(args: Record<string, unknown>): string {
    return normalizeTavernMemoryPath(args.filePath || args.path || '');
}

function validateWritableMemoryPath(path = ''): string {
    const normalized = normalizeTavernMemoryPath(path);
    const characterName = getCharacterNameFromMemoryPath(normalized);
    if (characterName && isReservedUserMemoryCharacterName(characterName)) {
        throw new Error('memory_character_user_reserved');
    }
    return normalized;
}

export function getTavernMemoryToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.LIST,
                description: [
                    'List memory Markdown files in the current RP session.',
                    'Returns paths, status, and timestamps only; it does not read file bodies.',
                    'Best for discovering which memory files exist before choosing MemoryRead, MemoryGrep, MemoryWrite, or MemoryEdit.',
                    'Scope is fixed to the current session and `memory/...`; it cannot inspect RP chat history, character cards, world books, settings, or plugin source code.',
                ].join('\n'),
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.READ,
                description: [
                    'Read a memory Markdown file in the current RP session.',
                    'Returns raw `content` plus line-numbered `numberedContent`. Large files include continuation hints.',
                    'Use `tail` by itself when you need the end of a file. Do not combine `tail` with `offset` or `limit`.',
                    'The argument name is `filePath`, not `path`. Use `memory/state.md` for global state and `memory/characters/<角色名>.md` for entity memory.',
                    'This reads memory files only. Use ChatHistory for original RP chat messages.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Memory file path. Use `memory/state.md` or `memory/characters/<角色名>.md`.' },
                        offset: { type: 'number', description: '1-based line offset. Default 1.' },
                        limit: { type: 'number', description: 'Maximum lines to return. Default 1200, max 2000.' },
                        tail: { type: 'number', description: 'Return the final N lines. Use by itself when you need the end of a file; do not combine it with offset or limit.' },
                    },
                    required: ['filePath'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.WRITE,
                description: [
                    'Write a complete memory Markdown file in the current RP session.',
                    'Use `memory/state.md` for global state and `memory/characters/<角色名>.md` for one character/entity.',
                    'Character filenames are entity names. Do not create index files or turn/session files.',
                    'Do not create or maintain a character file for the message author or generic user/player labels such as User, Player, 用户, or 玩家; put player-side durable state in `memory/state.md` when needed.',
                    'Use for creating a real character memory file, complete file rewrites, or rewrites where most of the target memory file is new.',
                    'Read the target file first when it already exists. Write overwrites the entire file, so include all original content you want to keep.',
                    'The argument names are `filePath` and `content`. Write replaces the complete target file content.',
                    'Use MemoryEdit instead for small corrections inside an existing file.',
                    'Writable paths are exactly `memory/state.md` and `memory/characters/<角色名>.md`.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Target memory file path. Must be `memory/state.md` or `memory/characters/<角色名>.md`.' },
                        content: { type: 'string', description: 'Complete Markdown file content to save.' },
                    },
                    required: ['filePath', 'content'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.EDIT,
                description: [
                    'Edit one existing memory Markdown file in the current RP session by replacing original text fragments, replacing inclusive line ranges, inserting text at line positions, or removing text with empty replacements.',
                    'One call edits one file.',
                    'Use oldString/newString for in-sentence, small-paragraph, or multi-spot local revisions. Use startLine/endLine/newString for contiguous section replacement where copying oldString would be fragile. Use insertAtLine/newString to add new text before a line or at the end without replacing existing text. Use MemoryWrite instead for creating files or whole-file rewrites where most content is new.',
                    'Read the target file first unless the exact current text is already available in the conversation or a recent tool result. Line-range and insertion edits must use line numbers from the latest MemoryRead result.',
                    'Put multiple edits in the edits array. Line-range and insertion items may share one call when they use line numbers from the same MemoryRead result. Keep oldString edits separate from line-number edits unless the whole change can be expressed with line numbers.',
                    'The `edits` argument must be a non-empty array value, not a JSON-stringified string. Correct: `"edits":[{"startLine":10,"endLine":50,"newString":"..."}]`. Wrong: `"edits":"[{\\"startLine\\":10,\\"endLine\\":50,\\"newString\\":\\"...\\"}]"`.',
                    'Each edit item should choose exactly one mode. Omit unused mode fields when possible. If the provider/tool channel adds stray optional fields, MemoryEdit normalizes by priority: complete startLine/endLine wins, then insertAtLine, then oldString.',
                    'Correct line-range item: `{"startLine":10,"endLine":50,"newString":"..."}`. If a polluted item also contains oldString or insertAtLine, the complete startLine/endLine range is used and stray fields are ignored.',
                    'Do not issue multiple MemoryEdit tool calls for the same file in one assistant turn. Combine same-file changes into one call, or wait for the first result before editing that file again.',
                    '',
                    '## Matching Rules',
                    'oldString must be an exact fragment present in the file, including spaces and newlines. To remove the matched word, sentence, or fragment, set newString to an empty string.',
                    'Common punctuation equivalence is supported, such as straight/curly quotes and ASCII/full-width comma or period. Replacements preserve the file punctuation style when possible.',
                    'For long oldString fragments, MemoryEdit can also tolerate whitespace-only differences such as indentation, line wrapping, or extra/missing blank lines.',
                    'Each oldString must be unique by default. Multiple matches return line numbers and context.',
                    'Line-range edits use 1-based inclusive startLine/endLine from MemoryRead output. A line range replaces the entire inclusive range with any length of newString; use an empty newString to remove the range. Replacement line count does not need to match the original range.',
                    'Insertion edits use 1-based insertAtLine from MemoryRead output. insertAtLine inserts before that line; use totalLines + 1 to append to the end of the file.',
                    'Line-range and insertion items in one call are applied by original MemoryRead line numbers from bottom to top automatically to avoid line-number shifts; do not adjust later line numbers yourself. If an insertion falls inside a line range being replaced, merge it into that line-range replacement.',
                    'Do not intentionally mix oldString edits with line-number edits in one MemoryEdit call. If one item is polluted by stray optional fields, the tool will still choose one mode by priority instead of failing.',
                    '',
                    '## Failure Handling',
                    'Not found: check whether oldString exactly matches the file content.',
                    'Multiple matches: expand oldString with more context to make it unique, or set `replaceAll: true` only if every match should change.',
                    '',
                    '## Notes',
                    'oldString edits execute in order. Line-range and insertion edits execute bottom-to-top by original line numbers. Do not let a later oldString match text just inserted by an earlier newString.',
                    'If two changes overlap, merge them into one replacement for the larger fragment instead of splitting them into separate edits.',
                    'Use MemoryWrite for complete file rewrites, or when most of the file should be replaced.',
                    'Editable paths are exactly `memory/state.md` and `memory/characters/<角色名>.md`.',
                    'Do not edit character files for the message author or generic user/player labels such as User, Player, 用户, or 玩家; keep player-side durable state in `memory/state.md`.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Canonical path. Must be `memory/state.md` or `memory/characters/<角色名>.md`.' },
                        edits: {
                            type: 'array',
                            description: 'List of edits as a real, non-empty JSON array, not a quoted JSON string. Each item should use exactly one mode: oldString/newString, startLine/endLine/newString, or insertAtLine/newString. Stray optional fields are ignored by mode priority when possible.',
                            items: {
                                type: 'object',
                                properties: {
                                    oldString: { type: 'string', description: 'Original text fragment to replace. Must match exactly, with common punctuation/long-whitespace tolerance. Do not use an empty oldString; use MemoryWrite for full rewrites.' },
                                    startLine: { type: 'number', description: '1-based inclusive start line from the latest MemoryRead result. Use with endLine instead of oldString.' },
                                    endLine: { type: 'number', description: '1-based inclusive end line from the latest MemoryRead result. Use with startLine instead of oldString.' },
                                    insertAtLine: { type: 'number', description: '1-based insertion point from the latest MemoryRead result. Inserts before this line. Use totalLines + 1 to append to the end of the file.' },
                                    newString: { type: 'string', description: 'Replacement, inserted text, or an empty string to delete the matched fragment or line range.' },
                                    replaceAll: { type: 'boolean', description: 'Whether to replace all matches. Default false.' },
                                },
                                required: ['newString'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['filePath', 'edits'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.GREP,
                description: [
                    'Search text inside memory Markdown files for the current RP session.',
                    'Uses literal text search by default and returns matching files plus line-level snippets.',
                    'Use before reading many files to locate facts, hooks, character state, unresolved items, or summaries.',
                    '`path` can be a search directory or one exact file like `memory/state.md` or `memory/characters/<角色名>.md`; `filePath` is an alias for exact-file scope. For regex search, explicitly pass `regex: true` or `useRegex: true`.',
                    'Supports path/filePath scope, outputMode, offset/limit pagination, and context lines.',
                    'This searches memory files only. Use ChatHistory grep to search original RP chat history.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'Search pattern. Treated as literal text by default; use regex/useRegex only when you intentionally need regex.' },
                        path: { type: 'string', description: 'Optional search scope. Use `memory/state.md`, `memory/characters/<角色名>.md`, or `memory/characters/`.' },
                        filePath: { type: 'string', description: 'Optional exact file scope. Alias for path when targeting one memory file.' },
                        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '`content` returns matched lines, `files_with_matches` returns files only, and `count` returns match counts. Default content.' },
                        limit: { type: 'number', description: 'Maximum results to return. Default 100, max 100.' },
                        offset: { type: 'number', description: 'Skip this many ascending results before returning matches. Default 0.' },
                        contextLines: { type: 'number', description: 'How many context lines to include before and after each match. Default 0, max 5.' },
                        regex: { type: 'boolean', description: 'Whether to treat pattern as a regex. Default false; omit it for literal text search.' },
                        useRegex: { type: 'boolean', description: 'Alias for regex; kept for JSON compatibility with ebook-style calls.' },
                    },
                    required: ['pattern'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

export function getTavernManagerToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [
        ...getTavernMemoryToolDefinitions(),
        ...getTavernStateToolDefinitions(),
        ...getTavernTaskToolDefinitions(),
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.CHAT_HISTORY,
                description: [
                    'Read original RP chat history for the current session.',
                    'This is read-only and returns message order, role, and snippet or full content.',
                    'Best for checking what actually happened in the RP before correcting memory files.',
                    'Message order is an evidence coordinate, not in-world story time.',
                    'Use recent for current continuity, range when you know message order, and grep when you only know a keyword.',
                    'recent reads the latest messages; offset pages backward from the newest messages.',
                    'range reads message order ascending; if startOrder is provided and endOrder is omitted, the range continues through the latest message.',
                    'grep searches message content and returns ascending earliest matches; offset/limit continue through later matches.',
                    'Results include count/truncated/nextOffset for pagination. Set full:true to return the complete single-message content and thoughts without truncation, when exact wording or evidence matters.',
                    'This does not search memory Markdown files. Use MemoryGrep for memory files.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        mode: {
                            type: 'string',
                            enum: ['recent', 'range', 'grep'],
                            description: 'recent reads the latest messages; range reads messages by order; grep searches message content by keyword.',
                        },
                        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum messages to return. Defaults to 12.' },
                        offset: { type: 'number', minimum: 0, description: 'Pagination offset. In recent mode it pages backward from the newest messages; in range/grep it skips earlier ascending results.' },
                        startOrder: { type: 'number', minimum: 0, description: 'First message order for range mode. If endOrder is omitted, the range continues through the latest message.' },
                        endOrder: { type: 'number', minimum: 0, description: 'Last message order for range mode, inclusive. Omit to read from startOrder through the latest message.' },
                        pattern: { type: 'string', description: 'Keyword for grep mode. Plain text by default.' },
                        regex: { type: 'boolean', description: 'Set true only when pattern is intended as a regular expression.' },
                        useRegex: { type: 'boolean', description: 'Alias for regex; kept for JSON compatibility with ebook-style calls.' },
                        full: { type: 'boolean', description: 'Return full message content instead of snippets when exact wording or source evidence matters.' },
                    },
                    required: ['mode'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

function isManagerControlError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    const name = error instanceof Error ? error.name : '';
    return name === 'AbortError'
        || message === 'manager_source_messages_changed'
        || message === 'manager_epoch_expired'
        || message === 'manager_aborted';
}

function buildChatHistoryEntry(message: TavernMessageRecord, options: { full?: boolean } = {}) {
    const full = options.full === true;
    const content = full
        ? normalizeBody(message.content)
        : normalizeBody(message.content, 8000);
    const thoughts = Array.isArray(message.thoughts)
        ? message.thoughts
            .map((thought, index) => ({
                label: normalizeInline(thought?.label || `思考 ${index + 1}`, 80),
                text: normalizeBody(thought?.text || '', full ? undefined : 8000),
            }))
            .filter((thought) => thought.text)
        : [];
    return {
        order: message.order,
        role: String(message.role || ''),
        snippet: normalizeInline(message.content, 320),
        reasoningSnippet: thoughts.length ? normalizeInline(thoughts.map((thought) => thought.text).join('\n'), 320) : undefined,
        content: full ? content : undefined,
        thoughts: full && thoughts.length ? thoughts : undefined,
    };
}

export async function executeTavernMemoryTool(
    sessionId = '',
    toolName = '',
    args: Record<string, unknown> = {},
    options: {
        caller?: TavernManagerToolCaller;
        managerRunId?: string;
        turn?: number;
        sourceUserOrder?: number;
        sourceAssistantOrder?: number;
        beforeWriteGuard?: () => Promise<void> | void;
    } = {},
): Promise<TavernMemoryToolResult> {
    const id = String(sessionId || '').trim();
    if (!id) {return { ok: false, summary: '缺少 sessionId。', error: 'memory_session_required' };}
    await ensureTavernMemoryDefaults(id);
    try {
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.LIST) {
            const files = await listTavernMemoryFiles(id, { includeStale: true });
            return {
                ok: true,
                summary: `找到 ${files.length} 个记忆文件。`,
                files: files.map((file) => ({ path: file.path, status: file.status, updatedAt: file.updatedAt })),
            };
        }
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.READ) {
            const path = getToolPath(args);
            const file = await getTavernMemoryFile(id, path);
            if (!file) {return { ok: false, summary: `${path} 不存在。`, path, error: 'memory_file_not_found' };}
            const lines = splitLines(file.content);
            const tail = Math.floor(Number(args.tail) || 0);
            let startLine = toPositiveInteger(args.offset, 1);
            let limit = clampLimit(args.limit, DEFAULT_MEMORY_READ_LIMIT, MAX_MEMORY_READ_LIMIT);
            if (tail > 0) {
                limit = Math.min(MAX_MEMORY_READ_LIMIT, tail);
                startLine = Math.max(1, lines.length - limit + 1);
            }
            const startIndex = Math.max(0, startLine - 1);
            const selected = lines.slice(startIndex, startIndex + limit);
            const nextOffset = startIndex + limit < lines.length ? startIndex + limit + 1 : 0;
            return {
                ok: true,
                summary: `读取 ${path} 第 ${startIndex + 1}-${startIndex + selected.length} 行，共 ${lines.length} 行。`,
                path,
                content: selected.join('\n'),
                numberedContent: numberLines(selected, startIndex + 1),
                lineStart: startIndex + 1,
                lineEnd: startIndex + selected.length,
                totalLines: lines.length,
                truncated: nextOffset > 0,
                nextOffset,
            };
        }
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.WRITE) {
            const pathInput = String(args.filePath || args.path || '');
            const path = validateWritableMemoryPath(pathInput);
            const file = await db.transaction(
                'rw',
                tavernMemoryFilesTable,
                tavernMemoryIndexesTable,
                tavernManagerMemorySnapshotsTable,
                tavernMessagesTable,
                tavernSessionsTable,
                async () => {
                    await options.beforeWriteGuard?.();
                    if (options.managerRunId) {
                        await ensureTavernManagerMemorySnapshot({ managerRunId: options.managerRunId, sessionId: id, path });
                    }
                    const savedFile = await writeTavernMemoryFile(id, path, String(args.content || ''), {
                        source: 'manager',
                    });
                    if (options.managerRunId) {
                        await updateTavernManagerMemorySnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, path: savedFile.path });
                    }
                    return savedFile;
                },
            ) as TavernMemoryFileRecord;
            const saved = await getTavernMemoryFile(id, file.path);
            if (!saved || saved.content !== file.content) {
                return {
                    ok: false,
                    summary: `已生成 ${file.path} 的写入结果，但保存校验未通过；请重新读取文件确认当前内容。`,
                    path: file.path,
                    changed: false,
                    error: 'memory_write_verification_failed',
                };
            }
            return { ok: true, summary: `已写入 ${file.path}。`, path: file.path, changed: true };
        }
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.EDIT) {
            const pathInput = String(args.filePath || args.path || '');
            const path = validateWritableMemoryPath(pathInput);
            const file = await getTavernMemoryFile(id, path);
            if (!file) {return { ok: false, summary: `${path} 不存在。`, path, error: 'memory_file_not_found' };}
            const result = applyTextEdits(file.content, args.edits) as {
                ok: boolean;
                partial?: boolean;
                content: string;
                warning?: string;
                results?: Array<{ ok?: boolean; satisfied?: boolean; message?: string; error?: string }>;
            };
            const editResults = Array.isArray(result.results) ? result.results : [];
            const appliedCount = editResults.filter((item) => item.ok && !item.satisfied).length;
            const satisfiedCount = editResults.filter((item) => item.ok && item.satisfied).length;
            const successCount = appliedCount + satisfiedCount;
            const failedCount = Math.max(0, editResults.length - successCount);
            const changed = result.content !== file.content;
            if (changed) {
                await db.transaction(
                    'rw',
                    tavernMemoryFilesTable,
                    tavernMemoryIndexesTable,
                    tavernManagerMemorySnapshotsTable,
                    tavernMessagesTable,
                    tavernSessionsTable,
                    async () => {
                        await options.beforeWriteGuard?.();
                        if (options.managerRunId) {
                            await ensureTavernManagerMemorySnapshot({ managerRunId: options.managerRunId, sessionId: id, path });
                        }
                        await writeTavernMemoryFile(id, path, result.content, {
                            source: 'manager',
                        });
                        if (options.managerRunId) {
                            await updateTavernManagerMemorySnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, path });
                        }
                    },
                );
                const saved = await getTavernMemoryFile(id, path);
                if (!saved || saved.content !== result.content) {
                    return {
                        ok: false,
                        partial: true,
                        summary: `已生成 ${path} 的修改结果，但保存校验未通过；请重新读取文件确认当前内容。`,
                        path,
                        changed: false,
                        appliedCount,
                        satisfiedCount: satisfiedCount || undefined,
                        successCount,
                        failedCount,
                        warning: result.warning,
                        error: 'memory_edit_persistence_verification_failed',
                        details: editResults,
                    };
                }
            }
            return {
                ok: !!result.ok,
                partial: !!result.partial,
                summary: result.ok
                    ? changed
                        ? satisfiedCount > 0
                            ? `已修改 ${path}，应用 ${appliedCount} 项，另有 ${satisfiedCount} 项已是目标状态。`
                            : `已修改 ${path}，应用 ${appliedCount} 项。`
                        : `已确认 ${path} 的 ${satisfiedCount || appliedCount} 项修改已是目标状态，无需重复写入。`
                    : changed
                        ? `已部分修改 ${path}：成功 ${successCount} 项，失败 ${failedCount} 项。`
                        : `未修改 ${path}：${editResults.find((item) => !item.ok)?.message || editResults.find((item) => !item.ok)?.error || 'Edit failed'}。`,
                path,
                changed,
                appliedCount,
                satisfiedCount: satisfiedCount || undefined,
                successCount,
                failedCount,
                warning: result.warning,
                error: result.ok ? '' : 'memory_edit_failed',
                details: editResults,
            };
        }
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.GREP) {
            const pattern = String(args.pattern || '').trim();
            if (!pattern) {return { ok: false, summary: '缺少搜索词。', error: 'memory_grep_pattern_required' };}
            const matcher = args.regex === true || args.useRegex === true
                ? new RegExp(pattern, 'iu')
                : null;
            const lower = pattern.toLowerCase();
            const outputMode = normalizeOutputMode(args.outputMode);
            const limit = clampLimit(args.limit, DEFAULT_MEMORY_GREP_LIMIT, MAX_MEMORY_GREP_LIMIT);
            const offset = toNonNegativeInteger(args.offset, 0);
            const contextLines = Math.min(5, toNonNegativeInteger(args.contextLines, 0));
            const rawScope = String(args.filePath || args.path || '').trim();
            const normalizedFileScope = rawScope && rawScope.endsWith('.md')
                ? normalizeTavernMemoryPath(rawScope)
                : '';
            const directoryScope = rawScope && !normalizedFileScope
                ? String(rawScope || '').replace(/\\/g, '/').trim()
                : '';
            if (directoryScope && (!directoryScope.startsWith('memory/') || directoryScope.includes('..'))) {
                throw new Error('memory_path_scope_required');
            }
            const matches: Array<{ path: string; line?: number; text?: string; context?: string; count?: number }> = [];
            const files = (await listTavernMemoryFiles(id, { includeStale: true }))
                .filter((file) => {
                    if (normalizedFileScope) {return file.path === normalizedFileScope;}
                    if (directoryScope) {return file.path.startsWith(directoryScope.endsWith('/') ? directoryScope : `${directoryScope}/`);}
                    return true;
                });
            files.forEach((file) => {
                const lines = splitLines(file.content);
                let matchCount = 0;
                lines.forEach((line, index) => {
                    if (matcher) {matcher.lastIndex = 0;}
                    const ok = matcher ? matcher.test(line) : line.toLowerCase().includes(lower);
                    if (ok) {
                        matchCount += 1;
                        if (outputMode === 'content') {
                            const start = Math.max(0, index - contextLines);
                            const end = Math.min(lines.length, index + contextLines + 1);
                            matches.push({
                                path: file.path,
                                line: index + 1,
                                text: line.trim(),
                                context: contextLines > 0 ? numberLines(lines.slice(start, end), start + 1) : undefined,
                            });
                        }
                    }
                });
                if (outputMode === 'files_with_matches' && matchCount > 0) {
                    matches.push({ path: file.path });
                } else if (outputMode === 'count' && matchCount > 0) {
                    matches.push({ path: file.path, count: matchCount });
                }
            });
            const page = matches.slice(offset, offset + limit);
            return {
                ok: true,
                summary: `搜索到 ${matches.length} 项，返回 ${page.length} 项。`,
                count: matches.length,
                truncated: offset + limit < matches.length,
                nextOffset: offset + limit < matches.length ? offset + limit : 0,
                matches: page,
            };
        }
        if (toolName === TAVERN_MEMORY_TOOL_NAMES.CHAT_HISTORY) {
            const mode = String(args.mode || '').trim();
            const limit = Math.max(1, Math.min(100, Number(args.limit) || 12));
            const offset = Math.max(0, Number(args.offset) || 0);
            const full = args.full === true;
            if (mode === 'recent') {
                const { messages, total } = await listLatestTavernMessagesWithCount(id, limit, offset);
                const rows = messages.map((message) => buildChatHistoryEntry(message, { full }));
                const truncated = offset + limit < total;
                return {
                    ok: true,
                    summary: `共有 ${total} 条原文，读取最近窗口 ${rows.length} 条。`,
                    count: total,
                    truncated,
                    nextOffset: truncated ? offset + limit : 0,
                    messages: rows,
                };
            }
            if (mode === 'range') {
                const startOrder = Math.max(0, Number(args.startOrder) || 0);
                const hasExplicitEndOrder = Object.prototype.hasOwnProperty.call(args, 'endOrder')
                    && Number.isFinite(Number(args.endOrder));
                const latestMessage = hasExplicitEndOrder ? null : await getLatestTavernMessage(id);
                const endOrder = hasExplicitEndOrder
                    ? Math.max(startOrder, Number(args.endOrder) || startOrder)
                    : Math.max(startOrder, Number(latestMessage?.order) || startOrder);
                const { messages: rowsInRange, total } = await listTavernMessagesInRangeWithCount(id, startOrder, endOrder, limit, offset);
                const rows = rowsInRange.map((message) => buildChatHistoryEntry(message, { full }));
                const truncated = offset + limit < total;
                return {
                    ok: true,
                    summary: `order ${startOrder}-${endOrder} 共 ${total} 条原文，返回 ${rows.length} 条。`,
                    count: total,
                    truncated,
                    nextOffset: truncated ? offset + limit : 0,
                    messages: rows,
                };
            }
            if (mode === 'grep') {
                const messages = await listTavernMessages(id);
                const pattern = String(args.pattern || '').trim();
                if (!pattern) {return { ok: false, summary: '缺少搜索词。', error: 'chat_history_pattern_required' };}
                const matcher = args.regex === true || args.useRegex === true ? new RegExp(pattern, 'iu') : null;
                const lower = pattern.toLowerCase();
                const matchedRows = messages
                    .filter((message) => {
                        if (matcher) {matcher.lastIndex = 0;}
                        return matcher ? matcher.test(message.content) : message.content.toLowerCase().includes(lower);
                    });
                const rows = matchedRows
                    .slice(offset, offset + limit)
                    .map((message) => buildChatHistoryEntry(message, { full }));
                const truncated = offset + limit < matchedRows.length;
                return {
                    ok: true,
                    summary: `搜索到 ${matchedRows.length} 条原文，返回 ${rows.length} 条。`,
                    count: matchedRows.length,
                    truncated,
                    nextOffset: truncated ? offset + limit : 0,
                    messages: rows,
                };
            }
            return { ok: false, summary: `不支持的 ChatHistory 模式：${mode || 'empty'}`, error: 'chat_history_mode_invalid' };
        }
        return { ok: false, summary: `${toolName} 不可用。`, error: 'memory_tool_not_available' };
    } catch (error) {
        if (isManagerControlError(error)) {
            throw error;
        }
        return {
            ok: false,
            summary: error instanceof Error ? error.message : String(error || 'memory_tool_failed'),
            error: error instanceof Error ? error.message : String(error || 'memory_tool_failed'),
        };
    }
}

export function cloneMemoryFile(file: TavernMemoryFileRecord): TavernMemoryFileRecord {
    return cloneJson(file);
}
