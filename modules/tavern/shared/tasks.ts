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
    PATCH: 'TaskPatch',
} as const;

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
    taskId?: string;
    op?: string;
    error?: string;
    warnings?: string[];
    tasks?: Array<Pick<TavernTaskRecord, 'id' | 'status' | 'horizon' | 'current' | 'doneWhen' | 'hookForUser' | 'updatedOrder'>>;
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

function normalizeTaskId(value: unknown = ''): string {
    const text = String(value || '').trim();
    return /^[\w:.-]{1,120}$/i.test(text) ? text : '';
}

function normalizeFingerprint(value: unknown = ''): string {
    return normalizeText(value, 240);
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
                horizon: task.horizon,
                current: task.current,
                doneWhen: task.doneWhen,
                hookForUser: task.hookForUser,
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
    const directId = normalizeTaskId(args.taskId || args.id);
    if (directId) {return getTavernTask(sessionId, directId);}
    const fingerprint = normalizeFingerprint(args.fingerprint);
    if (!fingerprint) {return null;}
    const rows = await listTavernTasks(sessionId, { includeAbandoned: true, includeCompleted: true });
    return rows.find((task) => task.fingerprint === fingerprint) || null;
}

function summarizeTask(task: TavernTaskRecord): Pick<TavernTaskRecord, 'id' | 'status' | 'horizon' | 'current' | 'doneWhen' | 'hookForUser' | 'updatedOrder'> {
    return {
        id: task.id,
        status: task.status,
        horizon: task.horizon,
        current: task.current,
        doneWhen: task.doneWhen,
        hookForUser: task.hookForUser,
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
    if (toolName !== TAVERN_TASK_TOOL_NAMES.PATCH) {
        return { ok: false, summary: `未知任务工具：${toolName}`, changed: false, error: 'task_tool_unknown' };
    }
    const op = String(args.op || '').trim();
    const order = normalizeOrder(options.sourceAssistantOrder, normalizeOrder(args.order, -1));
    if (!['upsert-task', 'advance-task', 'complete-task', 'abandon-task'].includes(op)) {
        return { ok: false, summary: 'TaskPatch op 只能是 upsert-task、advance-task、complete-task、abandon-task。', changed: false, error: 'task_op_invalid' };
    }
    if (op === 'upsert-task') {
        const fingerprint = normalizeFingerprint(args.fingerprint);
        if (!fingerprint) {return { ok: false, summary: 'upsert-task 需要 fingerprint。', changed: false, error: 'task_fingerprint_required' };}
        const abandoned = await getAbandonedTaskFingerprints(id);
        if (abandoned.includes(fingerprint)) {
            return { ok: false, summary: '这个方向已经被放弃过，本轮不再重建。', changed: false, error: 'task_fingerprint_abandoned' };
        }
        const existing = await findTaskForPatch(id, args);
        const taskId = normalizeTaskId(args.taskId || args.id) || existing?.id || createId('quest-task');
        const isNew = !existing;
        if (options.caller === 'auto' && isNew && order < TAVERN_TASK_MIN_GENERATION_FLOOR) {
            return { ok: false, summary: `第 ${TAVERN_TASK_MIN_GENERATION_FLOOR} 楼前不创建事件线索。`, changed: false, error: 'task_floor_too_early' };
        }
        const horizon = normalizeText(args.horizon ?? existing?.horizon, 500);
        const current = normalizeText(args.current ?? existing?.current, 500);
        const doneWhen = normalizeText(args.doneWhen ?? existing?.doneWhen, 500);
        const hookForUser = normalizeText(args.hookForUser ?? existing?.hookForUser, 500);
        const hookForModel = normalizeText(args.hookForModel ?? existing?.hookForModel, 500);
        if (!horizon || !current || !doneWhen || !hookForUser || !hookForModel) {
            return { ok: false, summary: 'upsert-task 需要 horizon、current、doneWhen、hookForUser、hookForModel。', changed: false, error: 'task_fields_required' };
        }
        if (hasTaskHookMetaWords(hookForModel)) {
            return { ok: false, summary: 'hookForModel 必须是无元叙事词的软句。', changed: false, error: 'task_hook_meta_words' };
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
                horizon,
                current,
                doneWhen,
                hookForUser,
                hookForModel,
                fingerprint,
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
        return { ok: true, summary: `${isNew ? '已创建' : '已更新'}事件线索：${task.current}`, changed: true, taskId: task.id, op, tasks: [summarizeTask(task)] };
    }
    const existing = await findTaskForPatch(id, args);
    if (!existing) {
        return { ok: false, summary: '找不到要更新的事件线索。', changed: false, error: 'task_not_found' };
    }
    if (op === 'advance-task') {
        const current = normalizeText(args.current ?? existing.current, 500);
        const horizon = normalizeText(args.horizon ?? existing.horizon, 500);
        const doneWhen = normalizeText(args.doneWhen ?? existing.doneWhen, 500);
        const hookForUser = normalizeText(args.hookForUser ?? existing.hookForUser, 500);
        const hookForModel = normalizeText(args.hookForModel ?? existing.hookForModel, 500);
        if (!horizon || !current || !doneWhen || !hookForUser || !hookForModel) {
            return { ok: false, summary: 'advance-task 需要保留 horizon、current、doneWhen、hookForUser、hookForModel。', changed: false, error: 'task_fields_required' };
        }
        if (hasTaskHookMetaWords(hookForModel)) {
            return { ok: false, summary: 'hookForModel 必须是无元叙事词的软句。', changed: false, error: 'task_hook_meta_words' };
        }
        const task = await runTaskMutation(id, options, async () => {
            const updated: TavernTaskRecord = {
                ...existing,
                status: 'active',
                horizon,
                current,
                doneWhen,
                hookForUser,
                hookForModel,
                updatedOrder: order,
                lastAdvancedOrder: order,
                completedOrder: undefined,
                abandonedOrder: undefined,
                updatedAt: now(),
            };
            await tavernTasksTable.put(updated);
            return updated;
        });
        return { ok: true, summary: `已推进事件线索：${task.current}`, changed: true, taskId: task.id, op, tasks: [summarizeTask(task)] };
    }
    if (op === 'complete-task') {
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
        return { ok: true, summary: `已完成事件线索：${task.current}`, changed: true, taskId: task.id, op, tasks: [summarizeTask(task)] };
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
    return { ok: true, summary: `已放弃事件线索：${task.current}`, changed: true, taskId: task.id, op, tasks: [summarizeTask(task)] };
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
            `  current: ${task.current}`,
            `  horizon: ${task.horizon}`,
            `  done when: ${task.doneWhen}`,
            `  user hook: ${task.hookForUser}`,
            `  fingerprint: ${task.fingerprint}`,
            `  last advanced floor: ${task.lastAdvancedOrder}`,
        ].join('\n')),
        completed.length ? 'Recently completed:' : '',
        ...completed.map((task) => `- id: ${task.id}; current: ${task.current}; done when: ${task.doneWhen}; completed floor: ${task.completedOrder ?? task.updatedOrder}; fingerprint: ${task.fingerprint}`),
        'Abandoned directions are hidden; TaskPatch will reject abandoned fingerprints.',
    ].filter(Boolean);
    return lines.join('\n');
}

export function getTavernTaskToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [{
        type: 'function',
        function: {
            name: TAVERN_TASK_TOOL_NAMES.PATCH,
            description: [
                'Maintain the current RP session event direction engine. This is not memory, not a map, and not a random encounter.',
                'Use this only for forward-looking directions that could give the user something fresh to play when the story needs a hook. Do not use it to surface existing foreshadowing.',
                'Use only established people, places, relationships, world facts, and current tone.',
                'Create fresh possible directions only after the story has enough material. Recombine established material into an unplayed person, place, faction, or situation that opens a new interaction space.',
                'Reach new directions by extending a known character relationship, adjacent place, faction branch, social obligation, secret pressure, or user taste.',
                'Use the current tone and the user\'s demonstrated tastes as the engine for boldness. Do not create generic hooks, obvious continuations, repeated memory, existing foreshadowing, or outside random events.',
                'If no good hook exists, do not call this tool.',
                'Do not record old events, close existing memory, or force surprises. Advance or complete only when the completed assistant reply actually moved or resolved that direction.',
                '`horizon` is the larger not-yet-happened pull. `current` is the immediate playable entrance the user can act on now. `doneWhen` is the objective completion condition: a concrete observable event that happens in the story, not an abstract state.',
                '`hookForUser` is direct UI text. `hookForModel` is a soft in-world sentence for RP injection, without meta words like task, goal, objective, or completed.',
                'Allowed ops: upsert-task, advance-task, complete-task, abandon-task.',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['upsert-task', 'advance-task', 'complete-task', 'abandon-task'] },
                    taskId: { type: 'string', description: 'Existing task id. Optional for upsert; required for advance/complete/abandon unless fingerprint uniquely matches.' },
                    id: { type: 'string', description: 'Alias for taskId.' },
                    fingerprint: { type: 'string', description: 'Stable short fingerprint of this narrative direction. Required for upsert.' },
                    horizon: { type: 'string', description: 'User-facing larger not-yet-happened direction.' },
                    current: { type: 'string', description: 'User-facing immediate playable entrance.' },
                    doneWhen: { type: 'string', description: 'Objective completion condition, written as a concrete observable event in the story, not an abstract state.' },
                    hookForUser: { type: 'string', description: 'Plain UI explanation.' },
                    hookForModel: { type: 'string', description: 'Soft in-world prompt sentence for RP injection; no task/goal/completed meta language.' },
                },
                required: ['op'],
                additionalProperties: false,
            },
        },
    }];
}
