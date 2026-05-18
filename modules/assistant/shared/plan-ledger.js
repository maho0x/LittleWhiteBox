import { plansTable } from './session-db.js';

export const PLAN_TOOL_NAMES = Object.freeze({
    CREATE: 'PlanCreate',
    UPDATE: 'PlanUpdate',
    LIST: 'PlanList',
    GET: 'PlanGet',
});

export const PLAN_STATUSES = Object.freeze([
    'pending',
    'in_progress',
    'blocked',
    'completed',
    'failed',
    'cancelled',
]);

export const PLAN_PRIORITIES = Object.freeze([
    'low',
    'normal',
    'high',
    'urgent',
]);

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const COMPLETED_STATUS = 'completed';

function createDefaultId(prefix = 'plan') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value = '', limit = 4000) {
    const text = String(value || '').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeSessionId(value = '') {
    return normalizeText(value, 160);
}

function normalizeStatus(value = '', fallback = 'pending') {
    const normalized = normalizeText(value, 32);
    return PLAN_STATUSES.includes(normalized) ? normalized : fallback;
}

function normalizePriority(value = '', fallback = 'normal') {
    const normalized = normalizeText(value, 32);
    return PLAN_PRIORITIES.includes(normalized) ? normalized : fallback;
}

function normalizeOwner(value = '') {
    return normalizeText(value || 'assistant', 120) || 'assistant';
}

function normalizeBlockedBy(value = []) {
    if (typeof value === 'string') {
        const id = normalizeText(value, 160);
        return id ? [id] : [];
    }
    if (!Array.isArray(value)) return [];
    const ids = value
        .map((item) => normalizeText(item, 160))
        .filter(Boolean);
    return Array.from(new Set(ids));
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function parseStatusArg(value) {
    const status = normalizeText(value, 32);
    if (!PLAN_STATUSES.includes(status)) {
        return { ok: false, error: 'plan_status_invalid', value: status };
    }
    return { ok: true, status };
}

function parsePriorityArg(value) {
    const priority = normalizeText(value, 32);
    if (!PLAN_PRIORITIES.includes(priority)) {
        return { ok: false, error: 'plan_priority_invalid', value: priority };
    }
    return { ok: true, priority };
}

function parseBlockedByArg(value = []) {
    if (value === undefined || value === null || value === '') {
        return { ok: true, blockedBy: [] };
    }
    if (typeof value !== 'string' && !Array.isArray(value)) {
        return { ok: false, error: 'plan_blocked_by_invalid' };
    }
    if (Array.isArray(value) && value.some((item) => item && typeof item === 'object')) {
        return { ok: false, error: 'plan_blocked_by_invalid' };
    }
    return { ok: true, blockedBy: normalizeBlockedBy(value) };
}

function normalizeNotes(value = []) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeText(item, 2000)).filter(Boolean);
    }
    const note = normalizeText(value, 2000);
    return note ? [note] : [];
}

function clonePlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    return {
        id: String(plan.id || ''),
        sessionId: String(plan.sessionId || ''),
        title: String(plan.title || ''),
        detail: String(plan.detail || ''),
        status: normalizeStatus(plan.status),
        priority: normalizePriority(plan.priority),
        owner: normalizeOwner(plan.owner),
        blockedBy: normalizeBlockedBy(plan.blockedBy),
        notes: normalizeNotes(plan.notes),
        result: String(plan.result || ''),
        error: String(plan.error || ''),
        createdAt: Number(plan.createdAt) || 0,
        updatedAt: Number(plan.updatedAt) || 0,
        completedAt: Number(plan.completedAt) || 0,
    };
}

function buildPlanError(error, extra = {}) {
    return {
        ok: false,
        error,
        ...extra,
    };
}

function isCompletedPlan(plan) {
    return normalizeStatus(plan?.status) === COMPLETED_STATUS;
}

async function getPlansByIds(sessionId, ids = []) {
    const uniqueIds = normalizeBlockedBy(ids);
    const entries = await Promise.all(uniqueIds.map(async (id) => await plansTable.get([sessionId, id])));
    return entries.map((plan, index) => ({
        id: uniqueIds[index],
        plan: clonePlan(plan),
    }));
}

async function resolveBlockers(sessionId, blockedBy = []) {
    const entries = await getPlansByIds(sessionId, blockedBy);
    return entries
        .filter((entry) => !isCompletedPlan(entry.plan))
        .map((entry) => ({
            id: entry.id,
            title: entry.plan?.title || '',
            status: entry.plan?.status || 'missing',
        }));
}

function normalizeCreateArgs(args = {}) {
    const title = normalizeText(args.title, 400);
    const detail = normalizeText(args.detail, 4000);
    const blockedByResult = parseBlockedByArg(args.blockedBy);
    if (!blockedByResult.ok) return blockedByResult;
    const priorityResult = hasOwn(args, 'priority')
        ? parsePriorityArg(args.priority)
        : { ok: true, priority: 'normal' };
    if (!priorityResult.ok) return priorityResult;
    return {
        ok: true,
        title,
        detail,
        blockedBy: blockedByResult.blockedBy,
        priority: priorityResult.priority,
        owner: normalizeOwner(args.owner),
        note: normalizeText(args.note || args.notes, 2000),
    };
}

function normalizeUpdateArgs(args = {}) {
    const id = normalizeText(args.id, 160);
    const hasBlockedBy = hasOwn(args, 'blockedBy');
    const hasStatus = hasOwn(args, 'status');
    const hasPriority = hasOwn(args, 'priority');
    const statusResult = hasStatus ? parseStatusArg(args.status) : { ok: true, status: undefined };
    if (!statusResult.ok) return { id, ...statusResult };
    const priorityResult = hasPriority ? parsePriorityArg(args.priority) : { ok: true, priority: undefined };
    if (!priorityResult.ok) return { id, ...priorityResult };
    const blockedByResult = hasBlockedBy ? parseBlockedByArg(args.blockedBy) : { ok: true, blockedBy: undefined };
    if (!blockedByResult.ok) return { id, ...blockedByResult };
    return {
        ok: true,
        id,
        title: hasOwn(args, 'title') ? normalizeText(args.title, 400) : undefined,
        detail: hasOwn(args, 'detail') ? normalizeText(args.detail, 4000) : undefined,
        status: statusResult.status,
        priority: priorityResult.priority,
        owner: hasOwn(args, 'owner') ? normalizeOwner(args.owner) : undefined,
        blockedBy: blockedByResult.blockedBy,
        note: hasOwn(args, 'note') ? normalizeText(args.note, 2000) : '',
        result: hasOwn(args, 'result') ? normalizeText(args.result, 4000) : undefined,
        error: hasOwn(args, 'error') ? normalizeText(args.error, 4000) : undefined,
    };
}

export function isPlanToolName(name = '') {
    return Object.values(PLAN_TOOL_NAMES).includes(String(name || ''));
}

export function createPlanLedger(options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const createId = typeof options.createId === 'function' ? options.createId : createDefaultId;

    async function createPlan(sessionIdValue, args = {}) {
        const sessionId = normalizeSessionId(sessionIdValue);
        if (!sessionId) return buildPlanError('assistant_session_required');

        const normalized = normalizeCreateArgs(args);
        if (!normalized.ok) return buildPlanError(normalized.error, { value: normalized.value || '' });
        if (!normalized.title) return buildPlanError('plan_title_required');

        const blockers = await resolveBlockers(sessionId, normalized.blockedBy);
        const createdAt = now();
        const plan = {
            id: createId('plan'),
            sessionId,
            title: normalized.title,
            detail: normalized.detail,
            status: blockers.length ? 'blocked' : 'pending',
            priority: normalized.priority,
            owner: normalized.owner,
            blockedBy: normalized.blockedBy,
            notes: normalized.note ? [normalized.note] : [],
            result: '',
            error: '',
            createdAt,
            updatedAt: createdAt,
            completedAt: 0,
        };

        await plansTable.put(plan);
        return {
            ok: true,
            plan: clonePlan(plan),
            blockers,
        };
    }

    async function updatePlan(sessionIdValue, args = {}) {
        const sessionId = normalizeSessionId(sessionIdValue);
        if (!sessionId) return buildPlanError('assistant_session_required');

        const normalized = normalizeUpdateArgs(args);
        if (!normalized.ok) return buildPlanError(normalized.error, { id: normalized.id || '', value: normalized.value || '' });
        if (!normalized.id) return buildPlanError('plan_id_required');

        const current = clonePlan(await plansTable.get([sessionId, normalized.id]));
        if (!current) return buildPlanError('plan_not_found', { id: normalized.id });

        const next = {
            ...current,
            updatedAt: now(),
        };
        if (normalized.title !== undefined) next.title = normalized.title;
        if (normalized.detail !== undefined) next.detail = normalized.detail;
        if (normalized.priority !== undefined && normalized.priority) next.priority = normalized.priority;
        if (normalized.owner !== undefined) next.owner = normalized.owner;
        if (normalized.blockedBy !== undefined) {
            if (normalized.blockedBy.includes(next.id)) {
                return buildPlanError('plan_self_blocked', { id: next.id });
            }
            next.blockedBy = normalized.blockedBy;
        }
        if (normalized.note) next.notes = [...normalizeNotes(next.notes), normalized.note];
        if (normalized.result !== undefined) next.result = normalized.result;
        if (normalized.error !== undefined) next.error = normalized.error;

        const blockers = await resolveBlockers(sessionId, next.blockedBy);
        if (normalized.status === 'in_progress' && blockers.length) {
            return buildPlanError('plan_blocked', {
                id: next.id,
                blockers,
            });
        }

        if (normalized.status) {
            next.status = normalized.status;
        } else if (normalized.blockedBy !== undefined && ['pending', 'blocked'].includes(next.status)) {
            next.status = blockers.length ? 'blocked' : 'pending';
        }

        if (TERMINAL_STATUSES.has(next.status)) {
            next.completedAt = next.completedAt || next.updatedAt;
        } else {
            next.completedAt = 0;
        }

        await plansTable.put(next);
        return {
            ok: true,
            plan: clonePlan(next),
            blockers,
        };
    }

    async function listPlans(sessionIdValue, args = {}) {
        const sessionId = normalizeSessionId(sessionIdValue);
        if (!sessionId) return buildPlanError('assistant_session_required');

        const statusResult = hasOwn(args, 'status') ? parseStatusArg(args.status) : { ok: true, status: '' };
        if (!statusResult.ok) return buildPlanError(statusResult.error, { value: statusResult.value || '' });
        const priorityResult = hasOwn(args, 'priority') ? parsePriorityArg(args.priority) : { ok: true, priority: '' };
        if (!priorityResult.ok) return buildPlanError(priorityResult.error, { value: priorityResult.value || '' });
        const status = statusResult.status;
        const priority = priorityResult.priority;
        const owner = hasOwn(args, 'owner')
            ? normalizeText(args.owner, 120)
            : '';
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));

        let plans = (await plansTable.where('sessionId').equals(sessionId).toArray())
            .map(clonePlan)
            .filter(Boolean);
        if (status) plans = plans.filter((plan) => plan.status === status);
        if (priority) plans = plans.filter((plan) => plan.priority === priority);
        if (owner) plans = plans.filter((plan) => plan.owner === owner);
        plans.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

        return {
            ok: true,
            count: plans.length,
            plans: plans.slice(0, limit),
            truncated: plans.length > limit,
        };
    }

    async function getPlan(sessionIdValue, args = {}) {
        const sessionId = normalizeSessionId(sessionIdValue);
        if (!sessionId) return buildPlanError('assistant_session_required');

        const id = normalizeText(args.id, 160);
        if (!id) return buildPlanError('plan_id_required');

        const plan = clonePlan(await plansTable.get([sessionId, id]));
        if (!plan) return buildPlanError('plan_not_found', { id });
        const blockers = await resolveBlockers(sessionId, plan.blockedBy);
        return {
            ok: true,
            plan,
            blockers,
        };
    }

    async function clearSessionPlans(sessionIdValue) {
        const sessionId = normalizeSessionId(sessionIdValue);
        if (!sessionId) return 0;
        return await plansTable.where('sessionId').equals(sessionId).delete();
    }

    async function execute(name, sessionId, args = {}) {
        switch (name) {
            case PLAN_TOOL_NAMES.CREATE:
                return await createPlan(sessionId, args);
            case PLAN_TOOL_NAMES.UPDATE:
                return await updatePlan(sessionId, args);
            case PLAN_TOOL_NAMES.LIST:
                return await listPlans(sessionId, args);
            case PLAN_TOOL_NAMES.GET:
                return await getPlan(sessionId, args);
            default:
                throw new Error(`unsupported_plan_tool:${name}`);
        }
    }

    return {
        clearSessionPlans,
        createPlan,
        execute,
        getPlan,
        listPlans,
        updatePlan,
    };
}
