import db, {
    getLatestTavernAssistantOrder,
    tavernManagerRunsTable,
    tavernManagerTaskSnapshotsTable,
    tavernMessagesTable,
    tavernSessionsTable,
    tavernTaskFingerprintStatesTable,
    tavernTaskSnapshotsTable,
    tavernTasksTable,
    type TavernManagerTaskSnapshotRecord,
    type TavernTaskRecord,
    type TavernTaskSnapshotRecord,
} from './session-db';

export const TAVERN_TASK_TOOL_NAMES = {
    INSPECT: 'EventInspect',
    PATCH: 'EventPatch',
} as const;

const LEGACY_TAVERN_TASK_TOOL_NAMES = {
    PATCH: 'TaskPatch',
} as const;

function normalizeTavernTaskToolName(toolName = ''): string {
    const name = String(toolName || '').trim();
    if (name === LEGACY_TAVERN_TASK_TOOL_NAMES.PATCH) {return TAVERN_TASK_TOOL_NAMES.PATCH;}
    return name;
}

export const TAVERN_TASK_BASELINE_FLOOR = -1;
export const TAVERN_TASK_MIN_GENERATION_FLOOR = 5;
export const TAVERN_TASK_MAX_ACTIVE = 3;
export const TAVERN_TASK_AUTO_CREATE_MAX_ACTIVE = 1;
export const TAVERN_TASK_STALE_FLOOR_THRESHOLD = 8;
const MAX_ABANDONED_FINGERPRINTS = 200;
const TASK_HOOK_META_WORD_PATTERN = /(?:任务|目标|子目标|远景|已完成|\bquest\b|\btask\b|\bgoal\b|\bobjective\b|\bcomplete(?:d|s|ion)?\b)|(?:完成|完成剧情)(?=任务|目标|子目标|远景)|完成任务|任务完成|目标完成|子目标完成|任务已完成|目标已完成|子目标已完成/i;

export interface TavernTaskToolResult {
    ok: boolean;
    summary: string;
    changed?: boolean;
    eventId?: string;
    op?: string;
    error?: string;
    warnings?: string[];
    events?: Array<Pick<TavernTaskRecord, 'id' | 'status' | 'title' | 'horizon' | 'current' | 'doneWhen' | 'updatedOrder'>>;
}

export interface TavernTaskPatchOptions {
    caller?: 'auto' | 'chat';
    managerRunId?: string;
    sourceUserOrder?: number;
    sourceAssistantOrder?: number;
    beforeWriteGuard?: () => Promise<void> | void;
}

function now(): number {
    return Date.now();
}

function createId(prefix = 'task'): string {
    return `${prefix}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeText(value: unknown = '', limit = 1200): string {
    const text = String(value || '').replace(/\r\n/g, '\n').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeEventTitle(value: unknown = ''): string {
    return normalizeText(value, 40).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTaskId(value: unknown = ''): string {
    const text = String(value || '').trim();
    return /^[\w:.-]{1,120}$/i.test(text) ? text : '';
}

function normalizeEventPatchOp(value: unknown = ''): string {
    const op = String(value || '').trim();
    if (op === 'upsert-task') {return 'upsert-event';}
    if (op === 'advance-task') {return 'advance-event';}
    if (op === 'complete-task') {return 'complete-event';}
    if (op === 'abandon-task') {return 'abandon-event';}
    return op;
}

function getPatchEventId(args: Record<string, unknown> = {}): string {
    return normalizeTaskId(args.eventId || args.taskId || args.id);
}

function normalizeFingerprint(value: unknown = ''): string {
    return normalizeText(value, 240);
}

function deriveTaskTitle(task: Pick<TavernTaskRecord, 'title' | 'current'>): string {
    return normalizeEventTitle(task.title || task.current).slice(0, 8) || '未命名方向';
}

function validateEventTitle(title = ''): string {
    const length = Array.from(title).length;
    if (length < 2) {return 'task_title_too_short';}
    if (length > 12) {return 'task_title_too_long';}
    return '';
}

function buildEventFingerprint(title = '', horizon = '', current = ''): string {
    return hashText([
        normalizeEventTitle(title),
        normalizeText(horizon, 500),
        normalizeText(current, 500),
    ].join('\n'));
}

function hasTaskHookMetaWords(value = ''): boolean {
    return TASK_HOOK_META_WORD_PATTERN.test(String(value || ''));
}

function normalizeOrder(value: unknown, fallback = -1): number {
    const order = Number(value);
    return Number.isFinite(order) ? Math.floor(order) : fallback;
}

function taskHashPayload(tasks: TavernTaskRecord[] = [], fingerprints: string[] = []): string {
    return JSON.stringify({
        tasks: [...tasks]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((task) => ({
                id: task.id,
                sessionId: task.sessionId,
                status: task.status,
                title: deriveTaskTitle(task),
                horizon: task.horizon,
                current: task.current,
                doneWhen: task.doneWhen,
                hookForModel: task.hookForModel,
                fingerprint: task.fingerprint,
                createdOrder: task.createdOrder,
                updatedOrder: task.updatedOrder,
                lastAdvancedOrder: task.lastAdvancedOrder,
                completedOrder: task.completedOrder ?? null,
                abandonedOrder: task.abandonedOrder ?? null,
                sourceManagerRunId: task.sourceManagerRunId || '',
            })),
        abandonedFingerprints: [...new Set(fingerprints)].sort(),
    });
}

function hashText(value: unknown = ''): string {
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

function mergeTaskRollbackError(existing = '', conflicts: string[] = []): string {
    const current = String(existing || '').trim();
    if (!conflicts.length) {return current;}
    const prefix = 'rollback_conflict:';
    const currentConflicts = current.startsWith(prefix)
        ? current.slice(prefix.length).split(',').map((item) => item.trim()).filter(Boolean)
        : [];
    const merged = [...new Set([...currentConflicts, ...conflicts])];
    return `${prefix}${merged.join(',')}`;
}

async function taskPoolHash(sessionId = ''): Promise<string> {
    const [tasks, fingerprints] = await Promise.all([
        listTavernTasks(sessionId, { includeAbandoned: true, includeCompleted: true }),
        getAbandonedTaskFingerprints(sessionId),
    ]);
    return hashText(taskHashPayload(tasks, fingerprints));
}

async function resolveTaskSnapshotFloor(sessionId = '', floorInput?: number): Promise<number> {
    const explicit = Number(floorInput);
    if (Number.isFinite(explicit)) {return Math.floor(explicit);}
    const latestOrder = await getLatestTavernAssistantOrder(sessionId);
    return latestOrder ?? TAVERN_TASK_BASELINE_FLOOR;
}

function snapshotFingerprint(snapshot: TavernTaskSnapshotRecord | null | undefined): string {
    return hashText(taskHashPayload(snapshot?.tasks || [], snapshot?.abandonedFingerprints || []));
}

export async function listTavernTasks(sessionId = '', options: {
    includeCompleted?: boolean;
    includeAbandoned?: boolean;
} = {}): Promise<TavernTaskRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const rows = await tavernTasksTable.where('sessionId').equals(id).sortBy('updatedAt');
    return rows
        .filter((task) => options.includeCompleted || task.status !== 'completed')
        .filter((task) => options.includeAbandoned || task.status !== 'abandoned')
        .sort((left, right) => Number(right.updatedOrder) - Number(left.updatedOrder) || Number(right.updatedAt) - Number(left.updatedAt));
}

export async function getTavernTask(sessionId = '', taskId = ''): Promise<TavernTaskRecord | null> {
    const id = String(sessionId || '').trim();
    const normalizedTaskId = normalizeTaskId(taskId);
    if (!id || !normalizedTaskId) {return null;}
    return await tavernTasksTable.get([id, normalizedTaskId]) || null;
}

export async function getAbandonedTaskFingerprints(sessionId = ''): Promise<string[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const record = await tavernTaskFingerprintStatesTable.get(id);
    return Array.isArray(record?.abandonedFingerprints)
        ? record.abandonedFingerprints.map((item) => normalizeFingerprint(item)).filter(Boolean)
        : [];
}

async function putAbandonedTaskFingerprints(sessionId = '', fingerprints: string[] = []): Promise<string[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const normalized = [...new Set(fingerprints.map((item) => normalizeFingerprint(item)).filter(Boolean))]
        .slice(-MAX_ABANDONED_FINGERPRINTS);
    await tavernTaskFingerprintStatesTable.put({
        sessionId: id,
        abandonedFingerprints: normalized,
        updatedAt: now(),
    });
    return normalized;
}

async function rememberAbandonedFingerprint(sessionId = '', fingerprint = ''): Promise<void> {
    const normalized = normalizeFingerprint(fingerprint);
    if (!normalized) {return;}
    const existing = await getAbandonedTaskFingerprints(sessionId);
    await putAbandonedTaskFingerprints(sessionId, [...existing.filter((item) => item !== normalized), normalized]);
}

export async function saveTavernTaskSnapshot(sessionId = '', floorInput?: number): Promise<TavernTaskSnapshotRecord | null> {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    return await db.transaction('rw', tavernTasksTable, tavernTaskSnapshotsTable, tavernTaskFingerprintStatesTable, async () => {
        const [tasks, abandonedFingerprints] = await Promise.all([
            listTavernTasks(id, { includeAbandoned: true, includeCompleted: true }),
            getAbandonedTaskFingerprints(id),
        ]);
        const floor = await resolveTaskSnapshotFloor(id, floorInput);
        if (floor === TAVERN_TASK_BASELINE_FLOOR && !tasks.length && !abandonedFingerprints.length) {
            return null;
        }
        const latest = await getLatestTavernTaskSnapshot(id);
        const currentFingerprint = hashText(taskHashPayload(tasks, abandonedFingerprints));
        if (latest && snapshotFingerprint(latest) === currentFingerprint) {
            return null;
        }
        const record: TavernTaskSnapshotRecord = {
            sessionId: id,
            floor,
            tasks: tasks.map((task) => cloneJson(task)),
            abandonedFingerprints: [...abandonedFingerprints],
            createdAt: now(),
        };
        await tavernTaskSnapshotsTable.put(record);
        return record;
    });
}

export async function resolveAcceptedSnapshotFloor(sessionId = '', floorInput?: number): Promise<number> {
    return resolveTaskSnapshotFloor(sessionId, floorInput);
}

export async function listTavernTaskSnapshots(sessionId = ''): Promise<TavernTaskSnapshotRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    return (await tavernTaskSnapshotsTable.where('sessionId').equals(id).sortBy('floor'))
        .sort((left, right) => left.floor - right.floor || left.createdAt - right.createdAt);
}

export async function getLatestTavernTaskSnapshot(sessionId = '', targetFloor = Number.POSITIVE_INFINITY): Promise<TavernTaskSnapshotRecord | null> {
    const id = String(sessionId || '').trim();
    const floor = Number(targetFloor);
    if (!id) {return null;}
    const snapshots = await listTavernTaskSnapshots(id);
    return snapshots
        .filter((snapshot) => Number(snapshot.floor) <= floor || floor === Number.POSITIVE_INFINITY)
        .sort((left, right) => Number(right.floor) - Number(left.floor) || Number(right.createdAt) - Number(left.createdAt))[0]
        || null;
}

export async function trimTavernTaskSnapshotsFromFloor(sessionId = '', fromFloor = 0): Promise<number> {
    const id = String(sessionId || '').trim();
    const floor = Number(fromFloor);
    if (!id || !Number.isFinite(floor)) {return 0;}
    return await db.transaction('rw', tavernTaskSnapshotsTable, async () => {
        const snapshots = await listTavernTaskSnapshots(id);
        const affected = snapshots.filter((snapshot) => Number(snapshot.floor) >= floor);
        if (!affected.length) {return 0;}
        await tavernTaskSnapshotsTable.bulkDelete(affected.map((snapshot) => [snapshot.sessionId, snapshot.floor]));
        return affected.length;
    });
}

export async function restoreTavernTasksToFloor(sessionId = '', targetFloor = -1): Promise<TavernTaskRecord[]> {
    const id = String(sessionId || '').trim();
    if (!id) {throw new Error('task_session_required');}
    return await db.transaction('rw', tavernTasksTable, tavernTaskSnapshotsTable, tavernTaskFingerprintStatesTable, async () => {
        const snapshot = await getLatestTavernTaskSnapshot(id, targetFloor);
        const currentTasks = await tavernTasksTable.where('sessionId').equals(id).toArray();
        if (currentTasks.length) {
            await tavernTasksTable.bulkDelete(currentTasks.map((task) => [task.sessionId, task.id]));
        }
        if (!snapshot) {
            await putAbandonedTaskFingerprints(id, []);
            return [];
        }
        const restoredTasks = (snapshot.tasks || []).map((task) => ({
            ...cloneJson(task),
            sessionId: id,
        }));
        if (restoredTasks.length) {
            await tavernTasksTable.bulkPut(restoredTasks);
        }
        await putAbandonedTaskFingerprints(id, snapshot.abandonedFingerprints || []);
        return restoredTasks;
    });
}

export async function ensureTavernManagerTaskSnapshot(managerRunId = '', sessionId = ''): Promise<TavernManagerTaskSnapshotRecord | null> {
    const runId = String(managerRunId || '').trim();
    const id = String(sessionId || '').trim();
    if (!runId || !id) {return null;}
    const existing = await tavernManagerTaskSnapshotsTable.get(runId);
    if (existing) {return existing;}
    const [tasks, fingerprints] = await Promise.all([
        listTavernTasks(id, { includeAbandoned: true, includeCompleted: true }),
        getAbandonedTaskFingerprints(id),
    ]);
    const record: TavernManagerTaskSnapshotRecord = {
        managerRunId: runId,
        sessionId: id,
        beforeTasks: tasks.map((task) => cloneJson(task)),
        beforeFingerprints: [...fingerprints],
        beforeHash: hashText(taskHashPayload(tasks, fingerprints)),
        afterHash: '',
        rollbackStatus: 'pending',
        error: '',
        createdAt: now(),
        updatedAt: now(),
    };
    await tavernManagerTaskSnapshotsTable.put(record);
    return record;
}

export async function updateTavernManagerTaskSnapshotAfter(managerRunId = '', sessionId = ''): Promise<TavernManagerTaskSnapshotRecord | null> {
    const snapshot = await ensureTavernManagerTaskSnapshot(managerRunId, sessionId);
    if (!snapshot) {return null;}
    await tavernManagerTaskSnapshotsTable.update(snapshot.managerRunId, {
        afterHash: await taskPoolHash(snapshot.sessionId),
        updatedAt: now(),
    });
    return await tavernManagerTaskSnapshotsTable.get(snapshot.managerRunId) || null;
}

export async function listTavernManagerTaskSnapshots(managerRunId = ''): Promise<TavernManagerTaskSnapshotRecord[]> {
    const id = String(managerRunId || '').trim();
    if (!id) {return [];}
    const snapshot = await tavernManagerTaskSnapshotsTable.get(id);
    return snapshot ? [snapshot] : [];
}

export async function rollbackManagerRunTaskWrites(managerRunId = ''): Promise<{
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const runId = String(managerRunId || '').trim();
    if (!runId) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    const snapshot = await tavernManagerTaskSnapshotsTable.get(runId);
    const run = await tavernManagerRunsTable.get(runId);
    if (!snapshot || !run) {return { rolledBack: 0, conflicts: [], skipped: 0 };}
    if (snapshot.rollbackStatus === 'rolled_back' || snapshot.rollbackStatus === 'skipped') {
        return { rolledBack: 0, conflicts: [], skipped: 1 };
    }
    if (!snapshot.afterHash) {
        await tavernManagerTaskSnapshotsTable.update(runId, {
            rollbackStatus: 'skipped',
            error: 'snapshot_after_hash_missing',
            updatedAt: now(),
        });
        return { rolledBack: 0, conflicts: [], skipped: 1 };
    }
    const currentHash = await taskPoolHash(snapshot.sessionId);
    if (currentHash !== snapshot.afterHash) {
        await tavernManagerTaskSnapshotsTable.update(runId, {
            rollbackStatus: 'conflict',
            error: 'rollback_conflict_current_tasks_changed',
            updatedAt: now(),
        });
        await tavernManagerRunsTable.update(runId, {
            status: 'rolled_back',
            error: mergeTaskRollbackError(run.error, ['tasks']),
            updatedAt: now(),
        });
        return { rolledBack: 0, conflicts: ['tasks'], skipped: 0 };
    }
    await db.transaction('rw', tavernTasksTable, tavernTaskFingerprintStatesTable, tavernManagerTaskSnapshotsTable, tavernManagerRunsTable, async () => {
        const currentTasks = await tavernTasksTable.where('sessionId').equals(snapshot.sessionId).toArray();
        if (currentTasks.length) {
            await tavernTasksTable.bulkDelete(currentTasks.map((task) => [task.sessionId, task.id]));
        }
        if (snapshot.beforeTasks.length) {
            await tavernTasksTable.bulkPut(snapshot.beforeTasks.map((task) => cloneJson(task)));
        }
        await putAbandonedTaskFingerprints(snapshot.sessionId, snapshot.beforeFingerprints || []);
        await tavernManagerTaskSnapshotsTable.update(runId, {
            rollbackStatus: 'rolled_back',
            error: '',
            updatedAt: now(),
        });
        await tavernManagerRunsTable.update(runId, {
            status: 'rolled_back',
            updatedAt: now(),
        });
    });
    return { rolledBack: 1, conflicts: [], skipped: 0 };
}

async function findTaskForPatch(sessionId = '', args: Record<string, unknown> = {}): Promise<TavernTaskRecord | null> {
    const directId = getPatchEventId(args);
    if (directId) {return getTavernTask(sessionId, directId);}
    return null;
}

async function findTaskByFingerprint(sessionId = '', fingerprint = ''): Promise<TavernTaskRecord | null> {
    const normalized = normalizeFingerprint(fingerprint);
    if (!normalized) {return null;}
    const rows = await listTavernTasks(sessionId, { includeCompleted: true });
    return rows.find((task) => (task.status === 'active' || task.status === 'completed') && task.fingerprint === normalized) || null;
}

function summarizeTask(task: TavernTaskRecord): Pick<TavernTaskRecord, 'id' | 'status' | 'title' | 'horizon' | 'current' | 'doneWhen' | 'updatedOrder'> {
    return {
        id: task.id,
        status: task.status,
        title: deriveTaskTitle(task),
        horizon: task.horizon,
        current: task.current,
        doneWhen: task.doneWhen,
        updatedOrder: task.updatedOrder,
    };
}

async function runTaskMutation<T>(sessionId: string, options: TavernTaskPatchOptions, mutate: () => Promise<T>): Promise<T> {
    return await db.transaction('rw', tavernTasksTable, tavernTaskFingerprintStatesTable, tavernManagerTaskSnapshotsTable, tavernMessagesTable, tavernSessionsTable, async () => {
        await options.beforeWriteGuard?.();
        if (options.managerRunId) {
            await ensureTavernManagerTaskSnapshot(options.managerRunId, sessionId);
        }
        const result = await mutate();
        if (options.managerRunId) {
            await updateTavernManagerTaskSnapshotAfter(options.managerRunId, sessionId);
        }
        return result;
    });
}

export async function executeTavernTaskTool(
    sessionId = '',
    toolName = '',
    args: Record<string, unknown> = {},
    options: TavernTaskPatchOptions = {},
): Promise<TavernTaskToolResult> {
    const id = String(sessionId || '').trim();
    if (!id) {return { ok: false, summary: '缺少 sessionId。', changed: false, error: 'task_session_required' };}
    const normalizedToolName = normalizeTavernTaskToolName(toolName);
    if (normalizedToolName === TAVERN_TASK_TOOL_NAMES.INSPECT) {
        const status = String(args.status || '').trim();
        const includeCompleted = status === 'completed' || status === 'all' || status === '';
        const eventId = getPatchEventId(args);
        const tasks = await listTavernTasks(id, { includeCompleted });
        const visible = tasks
            .filter((task) => task.status === 'active' || task.status === 'completed')
            .filter((task) => !eventId || task.id === eventId)
            .filter((task) => !status || status === 'all' || task.status === status)
            .sort((left, right) => {
                if (left.status !== right.status) {return left.status === 'active' ? -1 : 1;}
                return Number(right.updatedOrder) - Number(left.updatedOrder) || Number(right.updatedAt) - Number(left.updatedAt);
            });
        const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const page = visible.slice(offset, offset + limit);
        return {
            ok: true,
            summary: `找到 ${visible.length} 条事件线索，返回 ${page.length} 条。`,
            changed: false,
            events: page.map(summarizeTask),
            warnings: visible.length > page.length ? ['event_inspect_truncated'] : [],
        };
    }
    if (normalizedToolName !== TAVERN_TASK_TOOL_NAMES.PATCH) {
        return { ok: false, summary: `未知事件工具：${toolName}`, changed: false, error: 'task_tool_unknown' };
    }
    const op = normalizeEventPatchOp(args.op);
    const order = normalizeOrder(options.sourceAssistantOrder, normalizeOrder(args.order, -1));
    if (!['upsert-event', 'advance-event', 'complete-event', 'abandon-event'].includes(op)) {
        return { ok: false, summary: 'EventPatch op 只能是 upsert-event、advance-event、complete-event、abandon-event。', changed: false, error: 'task_op_invalid' };
    }
    if (op === 'upsert-event') {
        const directExisting = await findTaskForPatch(id, args);
        const horizon = normalizeText(args.horizon ?? directExisting?.horizon, 500);
        const current = normalizeText(args.current ?? directExisting?.current, 500);
        const doneWhen = normalizeText(args.doneWhen ?? directExisting?.doneWhen, 500);
        const title = args.title !== undefined
            ? normalizeEventTitle(args.title)
            : directExisting ? deriveTaskTitle(directExisting) : options.caller ? '' : normalizeEventTitle(current).slice(0, 8);
        const hookForModel = normalizeText(args.hookForModel ?? directExisting?.hookForModel, 500);
        if (!title || !horizon || !current || !doneWhen || !hookForModel) {
            return { ok: false, summary: 'upsert-event 需要 title、horizon、current、doneWhen、hookForModel。', changed: false, error: 'task_fields_required' };
        }
        const titleError = validateEventTitle(title);
        if (titleError) {
            return {
                ok: false,
                summary: titleError === 'task_title_too_short' ? 'title 需要至少 2 个字。' : 'title 不能超过 12 个字。',
                changed: false,
                error: titleError,
            };
        }
        if (hasTaskHookMetaWords(hookForModel)) {
            return { ok: false, summary: 'hookForModel 必须是无元叙事词的软句。', changed: false, error: 'task_hook_meta_words' };
        }
        const candidateFingerprint = buildEventFingerprint(title, horizon, current);
        const abandoned = await getAbandonedTaskFingerprints(id);
        if (abandoned.includes(candidateFingerprint)) {
            return { ok: false, summary: '这个方向已经被放弃过，本轮不再重建。', changed: false, error: 'task_fingerprint_abandoned' };
        }
        const existing = directExisting || await findTaskByFingerprint(id, candidateFingerprint);
        if (existing?.status === 'abandoned') {
            return { ok: false, summary: '这个方向已经被放弃过，本轮不再重建。', changed: false, error: 'task_fingerprint_abandoned' };
        }
        if (existing?.status === 'completed') {
            return { ok: false, summary: '这个方向已经完成过，本轮不再重建。', changed: false, error: 'task_fingerprint_completed' };
        }
        const taskId = getPatchEventId(args) || existing?.id || createId('quest-event');
        const isNew = !existing;
        if (options.caller === 'auto' && isNew && order < TAVERN_TASK_MIN_GENERATION_FLOOR) {
            return { ok: false, summary: `第 ${TAVERN_TASK_MIN_GENERATION_FLOOR} 楼前不创建事件线索。`, changed: false, error: 'task_floor_too_early' };
        }
        if (options.caller === 'auto' && isNew) {
            const activeCount = (await listTavernTasks(id)).filter((task) => task.status === 'active').length;
            if (activeCount > TAVERN_TASK_AUTO_CREATE_MAX_ACTIVE) {
                return { ok: false, summary: `自动新建仅允许 active 池有 ${TAVERN_TASK_AUTO_CREATE_MAX_ACTIVE} 条或以下时创建新线索，当前已有 ${activeCount} 条。`, changed: false, error: 'task_auto_create_pool_busy' };
            }
        }
        if (isNew) {
            const activeCount = (await listTavernTasks(id)).filter((task) => task.status === 'active').length;
            if (activeCount >= TAVERN_TASK_MAX_ACTIVE) {
                return { ok: false, summary: `事件线索池已满（最多 ${TAVERN_TASK_MAX_ACTIVE} 条 active）。`, changed: false, error: 'task_active_pool_full' };
            }
        }
        const task = await runTaskMutation(id, options, async () => {
            const timestamp = now();
            const record: TavernTaskRecord = {
                id: taskId,
                sessionId: id,
                status: 'active',
                title,
                horizon,
                current,
                doneWhen,
                hookForModel,
                fingerprint: existing?.fingerprint || candidateFingerprint,
                createdOrder: isNew ? order : normalizeOrder(existing.createdOrder, order),
                updatedOrder: order,
                lastAdvancedOrder: isNew ? order : normalizeOrder(existing.lastAdvancedOrder, order),
                sourceManagerRunId: String(options.managerRunId || existing?.sourceManagerRunId || ''),
                createdAt: isNew ? timestamp : Number(existing.createdAt) || timestamp,
                updatedAt: timestamp,
            };
            await tavernTasksTable.put(record);
            return record;
        });
        return { ok: true, summary: `${isNew ? '已创建' : '已更新'}事件方向：${deriveTaskTitle(task)}`, changed: true, eventId: task.id, op, events: [summarizeTask(task)] };
    }
    const existing = await findTaskForPatch(id, args);
    if (!existing) {
        return { ok: false, summary: '找不到要更新的事件线索。', changed: false, error: 'task_not_found' };
    }
    if (op === 'advance-event') {
        const current = normalizeText(args.current ?? existing.current, 500);
        const horizon = normalizeText(args.horizon ?? existing.horizon, 500);
        const doneWhen = normalizeText(args.doneWhen ?? existing.doneWhen, 500);
        const title = args.title !== undefined ? normalizeEventTitle(args.title) : deriveTaskTitle(existing);
        const hookForModel = normalizeText(args.hookForModel ?? existing.hookForModel, 500);
        if (!title || !horizon || !current || !doneWhen || !hookForModel) {
            return { ok: false, summary: 'advance-event 需要保留 title、horizon、current、doneWhen、hookForModel。', changed: false, error: 'task_fields_required' };
        }
        const titleError = validateEventTitle(title);
        if (titleError) {
            return {
                ok: false,
                summary: titleError === 'task_title_too_short' ? 'title 需要至少 2 个字。' : 'title 不能超过 12 个字。',
                changed: false,
                error: titleError,
            };
        }
        if (hasTaskHookMetaWords(hookForModel)) {
            return { ok: false, summary: 'hookForModel 必须是无元叙事词的软句。', changed: false, error: 'task_hook_meta_words' };
        }
        const task = await runTaskMutation(id, options, async () => {
            const updated: TavernTaskRecord = {
                ...existing,
                status: 'active',
                title,
                horizon,
                current,
                doneWhen,
                hookForModel,
                fingerprint: existing.fingerprint,
                updatedOrder: order,
                lastAdvancedOrder: order,
                completedOrder: undefined,
                abandonedOrder: undefined,
                updatedAt: now(),
            };
            await tavernTasksTable.put(updated);
            return updated;
        });
        return { ok: true, summary: `已推进事件方向：${deriveTaskTitle(task)}`, changed: true, eventId: task.id, op, events: [summarizeTask(task)] };
    }
    if (op === 'complete-event') {
        const task = await runTaskMutation(id, options, async () => {
            const updated: TavernTaskRecord = {
                ...existing,
                status: 'completed',
                updatedOrder: order,
                completedOrder: order,
                updatedAt: now(),
            };
            await tavernTasksTable.put(updated);
            return updated;
        });
        return { ok: true, summary: `已完成事件方向：${deriveTaskTitle(task)}`, changed: true, eventId: task.id, op, events: [summarizeTask(task)] };
    }
    const task = await runTaskMutation(id, options, async () => {
        const updated: TavernTaskRecord = {
            ...existing,
            status: 'abandoned',
            updatedOrder: order,
            abandonedOrder: order,
            updatedAt: now(),
        };
        await tavernTasksTable.put(updated);
        await rememberAbandonedFingerprint(id, updated.fingerprint);
        return updated;
    });
    return { ok: true, summary: `已放弃事件方向：${deriveTaskTitle(task)}`, changed: true, eventId: task.id, op, events: [summarizeTask(task)] };
}

export async function abandonStaleTavernTasks(sessionId = '', assistantOrder = -1, options: {
    threshold?: number;
    managerRunId?: string;
    beforeWriteGuard?: () => Promise<void> | void;
} = {}): Promise<TavernTaskRecord[]> {
    const id = String(sessionId || '').trim();
    const order = normalizeOrder(assistantOrder, -1);
    if (!id || order < 0) {return [];}
    const threshold = Math.max(1, Math.floor(Number(options.threshold) || TAVERN_TASK_STALE_FLOOR_THRESHOLD));
    const tasks = await listTavernTasks(id);
    const stale = tasks.filter((task) => task.status === 'active'
        && order - normalizeOrder(task.lastAdvancedOrder, task.createdOrder) > threshold);
    if (!stale.length) {return [];}
    return await runTaskMutation(id, {
        managerRunId: options.managerRunId,
        sourceAssistantOrder: order,
        beforeWriteGuard: options.beforeWriteGuard,
    }, async () => {
        const abandoned: TavernTaskRecord[] = [];
        for (const task of stale) {
            const updated: TavernTaskRecord = {
                ...task,
                status: 'abandoned',
                updatedOrder: order,
                abandonedOrder: order,
                updatedAt: now(),
            };
            await tavernTasksTable.put(updated);
            await rememberAbandonedFingerprint(id, updated.fingerprint);
            abandoned.push(updated);
        }
        return abandoned;
    });
}

export async function getLatestQuestHooksForPrompt(sessionId = '', limit = 1): Promise<string[]> {
    const id = String(sessionId || '').trim();
    if (!id) {return [];}
    const tasks = await listTavernTasks(id);
    return tasks
        .filter((task) => task.status === 'active')
        .sort((left, right) => Number(right.updatedOrder) - Number(left.updatedOrder) || Number(right.updatedAt) - Number(left.updatedAt))
        .map((task) => normalizeText(task.hookForModel, 500))
        .filter((hook) => !hasTaskHookMetaWords(hook))
        .filter(Boolean)
        .slice(0, Math.max(1, Math.min(3, Math.floor(Number(limit) || 1))));
}

export async function buildTavernTaskPoolPromptBlock(sessionId = ''): Promise<string> {
    const id = String(sessionId || '').trim();
    if (!id) {return '[Current Event Pool]\nNo session.';}
    const tasks = await listTavernTasks(id, { includeCompleted: true });
    const active = tasks.filter((task) => task.status === 'active');
    const completed = tasks.filter((task) => task.status === 'completed').slice(0, 5);
    const lines = [
        '[Current Event Pool]',
        `Active count: ${active.length}/${TAVERN_TASK_MAX_ACTIVE}`,
        active.length ? 'Active directions:' : 'Active directions: none.',
        ...active.map((task) => [
            `- id: ${task.id}`,
            `  title: ${deriveTaskTitle(task)}`,
            `  current: ${task.current}`,
            `  horizon: ${task.horizon}`,
            `  done when: ${task.doneWhen}`,
            `  last advanced floor: ${task.lastAdvancedOrder}`,
        ].join('\n')),
        completed.length ? 'Recently completed:' : '',
        ...completed.map((task) => `- id: ${task.id}; title: ${deriveTaskTitle(task)}; current: ${task.current}; done when: ${task.doneWhen}; completed floor: ${task.completedOrder ?? task.updatedOrder}`),
        'Abandoned directions are hidden.',
    ].filter(Boolean);
    return lines.join('\n');
}

export function getTavernTaskToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [
        {
            type: 'function',
            function: {
                name: TAVERN_TASK_TOOL_NAMES.INSPECT,
                description: [
                    'Inspect the current RP session event direction pool.',
                    'Returns active and recently completed event directions only. Abandoned directions are not shown.',
                    'Use before EventPatch when you need to advance, complete, or decide whether the active pool is low.',
                    'This is not memory and not a map.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', enum: ['active', 'completed', 'all'], description: 'Optional status filter. Default returns active plus recently completed.' },
                        eventId: { type: 'string', description: 'Optional event direction id filter.' },
                        id: { type: 'string', description: 'Alias for eventId.' },
                        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
                        limit: { type: 'number', description: 'Maximum directions to return. Default 20, max 50.' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_TASK_TOOL_NAMES.PATCH,
                description: [
                    'Maintain the current RP session event direction pool.',
                    'Allowed ops: upsert-event, advance-event, complete-event, abandon-event.',
                    `Auto managers may create new directions only at floor ${TAVERN_TASK_MIN_GENERATION_FLOOR} or later, and only when active count is ${TAVERN_TASK_AUTO_CREATE_MAX_ACTIVE} or lower. Active pool max is ${TAVERN_TASK_MAX_ACTIVE}. Earlier auto upserts fail with task_floor_too_early.`,
                    'New upsert-event requires title, horizon, current, doneWhen, and hookForModel. The tool generates its duplicate guard internally.',
                    'title: short single-line UI title. Aim for 2-8 characters; hard limit 12.',
                    'horizon: larger not-yet-happened pull.',
                    'current: immediate playable entrance.',
                    'doneWhen: concrete observable story event that marks this direction as reached, not an abstract state.',
                    'hookForModel: one soft in-world sentence for RP injection; no meta planning words such as quest, task, goal, objective, completed, 任务, 目标, 完成.',
                    'Examples:',
                    '{"op":"upsert-event","title":"城东母亲","horizon":"莉娜的家庭压力把你们牵进城东旧屋。","current":"莉娜提到母亲一个人住在城东，最近需要人修房子。","doneWhen":"角色亲自到达城东旧屋并见到莉娜的母亲。","hookForModel":"莉娜提过她母亲一个人住在城东，最近似乎想找人帮忙修房子。"}',
                    '{"op":"advance-event","eventId":"quest-event-1","current":"城东旧屋的门锁被人从外面换过。","doneWhen":"角色查清是谁更换了旧屋门锁。","hookForModel":"莉娜母亲家的门锁看起来像是最近才被人换过。"}',
                    '{"op":"complete-event","eventId":"quest-event-1"}',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: ['upsert-event', 'advance-event', 'complete-event', 'abandon-event'] },
                        eventId: { type: 'string', description: 'Existing event direction id. Required for advance/complete/abandon. Optional for upsert.' },
                        id: { type: 'string', description: 'Alias for eventId.' },
                        title: { type: 'string', description: 'Short single-line event direction title. Aim for 2-8 characters; hard limit 12. Required for new upsert-event.' },
                        horizon: { type: 'string', description: 'User-facing larger not-yet-happened direction.' },
                        current: { type: 'string', description: 'User-facing immediate playable entrance.' },
                        doneWhen: { type: 'string', description: 'Objective completion condition, written as a concrete observable event in the story, not an abstract state.' },
                        hookForModel: { type: 'string', description: 'Soft in-world prompt sentence for RP injection; no meta planning language.' },
                    },
                    required: ['op'],
                    additionalProperties: false,
                },
            },
        },
    ];
}
