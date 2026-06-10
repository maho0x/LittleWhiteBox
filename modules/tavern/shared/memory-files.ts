import { applyTextEdits } from '../../agent-core/tools/text-edit.js';
import { getTavernStateToolDefinitions } from './structured-state';
import {
    listTavernMessages,
    tavernMemoryFilesTable,
    tavernMemoryIndexesTable,
    tavernSessionsTable,
    ensureTavernManagerMemorySnapshot,
    updateTavernManagerMemorySnapshotAfter,
    upsertTavernTurnSummary,
    type TavernMemoryFileRecord,
    type TavernMemoryFileStatus,
    type TavernMemoryIndexRecord,
    type TavernMessageRecord,
} from './session-db';

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

function normalizeInline(value: unknown = '', limit = 400): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeBody(value: unknown = '', limit = 20000): string {
    const text = String(value || '').replace(/\r\n/g, '\n').trim();
    return text.length > limit ? text.slice(0, limit) : text;
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

export function normalizeTavernMemoryPath(value: unknown = ''): string {
    const path = String(value || '').replace(/\\/g, '/').trim();
    if (!path) {throw new Error('memory_path_required');}
    if (!path.startsWith('memory/')) {throw new Error('memory_path_scope_required');}
    if (path.includes('\0') || path.includes('//') || path.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error('memory_path_invalid');
    }
    if (!path.endsWith('.md')) {throw new Error('memory_path_must_be_md');}
    return path;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function ymd(timestamp = Date.now()): string {
    return new Date(timestamp).toISOString().slice(0, 10).replace(/-/g, '');
}

function padOrder(order = 0): string {
    return String(Math.max(0, Number(order) || 0)).padStart(4, '0');
}

export function buildTurnMemoryPath(userOrder = 0, timestamp = Date.now()): string {
    return `memory/turns/${ymd(timestamp)}-${padOrder(userOrder)}.md`;
}

function defaultMemoryFiles(sessionId = '', characterName = ''): TavernMemoryFileRecord[] {
    const timestamp = now();
    const name = normalizeInline(characterName, 120) || '当前角色';
    const base = { sessionId, status: 'active' as TavernMemoryFileStatus, createdAt: timestamp, updatedAt: timestamp, source: 'default' };
    return [
        {
            ...base,
            path: 'memory/session.md',
            content: [
                '# 剧情脉络',
                '',
                `- 角色：${name}`,
                '- 当前剧情段：未开始',
                '',
                '## 故事为什么走到现在',
                '- 暂无。',
                '',
                '## 当前剧情压力',
                '- 暂无。',
                '',
                '## 未解决事项',
                '- 暂无。',
            ].join('\n'),
        },
        {
            ...base,
            path: 'memory/state.md',
            content: [
                '# 状态栏',
                '',
                '## 当前事实',
                '- 暂无。',
                '',
                '## 当前关系',
                '- 暂无。',
                '',
                '## 当前地点',
                '- 暂无。',
                '',
                '## 当前物品',
                '- 暂无。',
            ].join('\n'),
        },
        {
            ...base,
            path: 'memory/episodes/001.md',
            content: [
                '# 初始阶段',
                '',
                '- Range: turn 0-0',
                '',
                '## Summary',
                '暂无。',
                '',
                '## Key Changes',
                '- 暂无。',
                '',
                '## Unresolved',
                '- 暂无。',
                '',
                '## 相关流水',
                '- 暂无。',
            ].join('\n'),
        },
        {
            ...base,
            path: 'memory/inbox.md',
            content: [
                '# 管理员收件箱',
                '',
                '## 待判断',
                '- 暂无。',
                '',
                '## 失败记录',
                '- 暂无。',
            ].join('\n'),
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

export async function getTavernMemoryFile(sessionId = '', pathInput = ''): Promise<TavernMemoryFileRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    const path = normalizeTavernMemoryPath(pathInput);
    return await tavernMemoryFilesTable.get([id, path]) || null;
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
    const record: TavernMemoryIndexRecord = {
        sessionId: id,
        kind: 'markdown-derived',
        status: 'stale',
        error: String(error || ''),
        sourceFingerprint: '',
        derivedAt: timestamp,
        updatedAt: timestamp,
    };
    await tavernMemoryIndexesTable.put(record);
    return record;
}

export async function getTavernMemoryIndex(sessionId = '', kind = 'markdown-derived'): Promise<TavernMemoryIndexRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await tavernMemoryIndexesTable.get([id, kind]) || null;
}

function isTurnMemoryPath(path = ''): boolean {
    return /^memory\/turns\/.+\.md$/i.test(String(path || ''));
}

async function upsertTurnSummaryForMemoryFile(file: TavernMemoryFileRecord, options: {
    turn?: number;
    sourceUserOrder?: number;
    sourceAssistantOrder?: number;
    tags?: string[];
} = {}): Promise<void> {
    if (!isTurnMemoryPath(file.path)) {return;}
    const userOrder = Number(options.sourceUserOrder);
    const assistantOrder = Number(options.sourceAssistantOrder);
    if (!Number.isInteger(userOrder) || !Number.isInteger(assistantOrder)) {return;}
    await upsertTavernTurnSummary({
        sessionId: file.sessionId,
        turn: toNonNegativeInteger(options.turn, 0),
        userOrder,
        assistantOrder,
        summary: normalizeBody(file.content, 2000),
        tags: options.tags || [],
        status: 'active',
    });
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
        };
        await tavernMemoryIndexesTable.put(record);
        return record;
    }
}

function getToolPath(args: Record<string, unknown>): string {
    return normalizeTavernMemoryPath(args.filePath || args.path || '');
}

export function getTavernMemoryToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.LIST,
                description: [
                    'List memory Markdown files in the current session.',
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
                    'Read one current-session memory Markdown file under `memory/...`.',
                    'Returns selected raw content plus line-numbered `numberedContent` for line edits.',
                    'Best for understanding the current file before judging or changing memory.',
                    'Large files include `totalLines`, `truncated`, and `nextOffset`; continue with offset/limit, or use tail by itself for the end of a file.',
                    'This reads memory files only. Use ChatHistory for original RP chat messages.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Canonical path under memory/, for example memory/session.md, memory/state.md, memory/inbox.md, or memory/episodes/001.md.' },
                        offset: { type: 'number', description: '1-based line offset. Default 1.' },
                        limit: { type: 'number', description: 'Maximum lines to return. Default 1200, max 2000.' },
                        tail: { type: 'number', description: 'Return the final N lines. Use by itself when you need the end of a file.' },
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
                    'Create or replace one current-session memory Markdown file under `memory/...`.',
                    'Use for the current per-exchange memory file, new episode files, inbox/state/session files, or intentional whole-file rewrites where most content is new.',
                    'Read the target file first when it already exists. Write replaces the complete file, so include every original line that should survive.',
                    'Automatic after-turn managers receive the exact `memory/turns/...md` target path in the prompt and should write that file with normal Markdown.',
                    'Chat manager calls may update memory files when the user asks to fix or inspect memory.',
                    'Use MemoryEdit instead for small corrections inside an existing file.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Canonical path under memory/.' },
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
                    'Apply targeted edits to one existing current-session memory Markdown file under `memory/...`.',
                    'One call edits one file. Best for small corrections, local replacements, section edits, and insertions inside a known file.',
                    'Read the current file first unless its current text is already visible in the prompt or a recent tool result.',
                    'Use oldString/newString for local word, sentence, or paragraph fixes. Use startLine/endLine/newString for contiguous section replacement. Use insertAtLine/newString to add text before a line or at the end.',
                    'Put multiple edits in the `edits` array. `edits` must be a real, non-empty JSON array, not a quoted JSON string.',
                    'Each edit item should choose exactly one mode. Do not intentionally mix oldString edits with line-number edits in the same MemoryEdit call.',
                    'Line-number edits use line numbers from MemoryRead `numberedContent`. Use totalLines + 1 to append.',
                    'Line-range and insertion items are applied by original line numbers from bottom to top. Do not recalculate later line numbers yourself.',
                    'oldString must be a fragment present in the file; punctuation and long-whitespace tolerance exists, but it is not semantic fuzzy search. If matching fails, MemoryRead the file and anchor with exact surrounding text.',
                    'If an oldString has multiple matches, expand the fragment with more context or set replaceAll:true only when every match should change.',
                    'Set newString to an empty string to delete the matched fragment or line range.',
                    'If most of the file should change, use MemoryWrite instead of many tiny edits.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Canonical path under memory/.' },
                        edits: {
                            type: 'array',
                            description: 'Real non-empty JSON array, not a quoted JSON string. Each item should choose exactly one mode: oldString/newString, startLine/endLine/newString, or insertAtLine/newString.',
                            items: {
                                type: 'object',
                                properties: {
                                    oldString: { type: 'string', description: 'Original text fragment to replace. Use for local edits; must match the file text, with common punctuation/long-whitespace tolerance.' },
                                    startLine: { type: 'number', description: '1-based inclusive start line from MemoryRead numberedContent. Use with endLine instead of oldString.' },
                                    endLine: { type: 'number', description: '1-based inclusive end line from MemoryRead numberedContent. Use with startLine instead of oldString.' },
                                    insertAtLine: { type: 'number', description: '1-based insertion point from MemoryRead numberedContent. Inserts before this line; use totalLines + 1 to append.' },
                                    newString: { type: 'string', description: 'Replacement or inserted text. Empty string deletes the matched fragment or line range.' },
                                    replaceAll: { type: 'boolean', description: 'Replace all oldString matches. Default false.' },
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
                    'Search current-session memory Markdown files.',
                    'Uses literal text search by default; set regex/useRegex only when the pattern is intended as a regular expression.',
                    'Best for locating whether a fact, hook, character state, or unresolved item already exists in memory before reading or editing files.',
                    'Supports path/filePath scope, outputMode, offset/limit pagination, and context lines.',
                    'This searches memory files only. Use ChatHistory grep to search original RP chat history.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'Plain text keyword by default; treated as regex only when regex is true.' },
                        path: { type: 'string', description: 'Optional memory file or directory scope, for example memory/state.md or memory/episodes/.' },
                        filePath: { type: 'string', description: 'Optional exact memory file scope. Same meaning as path when it points to a file.' },
                        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '`content` returns matched lines, `files_with_matches` returns files only, and `count` returns match counts. Default content.' },
                        limit: { type: 'number', description: 'Maximum results to return. Default 100, max 100.' },
                        offset: { type: 'number', description: 'Skip this many ascending results before returning matches. Default 0.' },
                        contextLines: { type: 'number', description: 'How many context lines to include before and after each match. Default 0, max 5.' },
                        regex: { type: 'boolean', description: 'Set true only when pattern is intended as a regular expression.' },
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
        {
            type: 'function',
            function: {
                name: TAVERN_MEMORY_TOOL_NAMES.CHAT_HISTORY,
                description: [
                    'Read original RP chat history for the current session.',
                    'This is read-only and returns message order, role, and snippet or full content.',
                    'Best for checking what actually happened in the RP before correcting memory files.',
                    'Use recent for current continuity, range when you know message order, and grep when you only know a keyword.',
                    'recent reads the latest messages; offset pages backward from the newest messages.',
                    'range reads message order ascending; if startOrder is provided and endOrder is omitted, the range continues through the latest message.',
                    'grep searches message content and returns ascending earliest matches; offset/limit continue through later matches.',
                    'Results include count/truncated/nextOffset for pagination. Set full:true when exact wording or evidence matters.',
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
        || message === 'manager_aborted';
}

function sliceRecentMessages(
    messages: TavernMessageRecord[],
    offset = 0,
    limit = 12,
): TavernMessageRecord[] {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
    const end = Math.max(0, messages.length - safeOffset);
    const start = Math.max(0, end - safeLimit);
    return messages.slice(start, end);
}

function buildChatHistoryEntry(message: TavernMessageRecord, options: { full?: boolean } = {}) {
    const full = options.full === true;
    const content = normalizeBody(message.content, 8000);
    const thoughts = Array.isArray(message.thoughts)
        ? message.thoughts
            .map((thought, index) => ({
                label: normalizeInline(thought?.label || `思考 ${index + 1}`, 80),
                text: normalizeBody(thought?.text || '', 8000),
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
            const path = getToolPath(args);
            await options.beforeWriteGuard?.();
            if (options.managerRunId) {
                await ensureTavernManagerMemorySnapshot({ managerRunId: options.managerRunId, sessionId: id, path });
            }
            const file = await writeTavernMemoryFile(id, path, String(args.content || ''), { source: 'manager' });
            if (options.managerRunId) {
                await updateTavernManagerMemorySnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, path: file.path });
            }
            await upsertTurnSummaryForMemoryFile(file, options);
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
            const path = getToolPath(args);
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
                await options.beforeWriteGuard?.();
                if (options.managerRunId) {
                    await ensureTavernManagerMemorySnapshot({ managerRunId: options.managerRunId, sessionId: id, path });
                }
                await writeTavernMemoryFile(id, path, result.content, { source: 'manager' });
                if (options.managerRunId) {
                    await updateTavernManagerMemorySnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, path });
                }
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
                await upsertTurnSummaryForMemoryFile(saved, options);
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
            const messages = await listTavernMessages(id);
            if (mode === 'recent') {
                const rows = sliceRecentMessages(messages, offset, limit).map((message) => buildChatHistoryEntry(message, { full }));
                const truncated = offset + limit < messages.length;
                return {
                    ok: true,
                    summary: `共有 ${messages.length} 条原文，读取最近窗口 ${rows.length} 条。`,
                    count: messages.length,
                    truncated,
                    nextOffset: truncated ? offset + limit : 0,
                    messages: rows,
                };
            }
            if (mode === 'range') {
                const startOrder = Math.max(0, Number(args.startOrder) || 0);
                const hasExplicitEndOrder = Object.prototype.hasOwnProperty.call(args, 'endOrder')
                    && Number.isFinite(Number(args.endOrder));
                const endOrder = hasExplicitEndOrder
                    ? Math.max(startOrder, Number(args.endOrder) || startOrder)
                    : Math.max(startOrder, Number(messages[messages.length - 1]?.order) || startOrder);
                const rowsInRange = messages
                    .filter((message) => message.order >= startOrder && message.order <= endOrder);
                const rows = rowsInRange
                    .slice(offset, offset + limit)
                    .map((message) => buildChatHistoryEntry(message, { full }));
                const truncated = offset + limit < rowsInRange.length;
                return {
                    ok: true,
                    summary: `order ${startOrder}-${endOrder} 共 ${rowsInRange.length} 条原文，返回 ${rows.length} 条。`,
                    count: rowsInRange.length,
                    truncated,
                    nextOffset: truncated ? offset + limit : 0,
                    messages: rows,
                };
            }
            if (mode === 'grep') {
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
