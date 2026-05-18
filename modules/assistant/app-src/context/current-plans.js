import { createPlanLedger } from '../../shared/plan-ledger.js';

const CURRENT_PLAN_STATUSES = ['in_progress', 'blocked', 'pending'];
const CURRENT_PLAN_STATUS_ORDER = new Map(CURRENT_PLAN_STATUSES.map((status, index) => [status, index]));
const MAX_CURRENT_PLANS = 5;

function normalizeInlineText(value = '', limit = 400) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function normalizePlanForContext(plan = {}) {
    const id = normalizeInlineText(plan.id, 160);
    const status = String(plan.status || '').trim();
    const title = normalizeInlineText(plan.title, 400);
    const updatedAt = Number(plan.updatedAt) || 0;
    const blockedBy = Array.isArray(plan.blockedBy)
        ? plan.blockedBy.map((item) => normalizeInlineText(item, 160)).filter(Boolean)
        : [];
    if (!id || !title || !CURRENT_PLAN_STATUS_ORDER.has(status)) return null;
    return {
        id,
        status,
        title,
        updatedAt,
        blockedBy,
    };
}

export function formatCurrentPlansContextText(plans = []) {
    const items = (Array.isArray(plans) ? plans : [])
        .map(normalizePlanForContext)
        .filter(Boolean)
        .sort((left, right) => {
            const statusDelta = CURRENT_PLAN_STATUS_ORDER.get(left.status) - CURRENT_PLAN_STATUS_ORDER.get(right.status);
            if (statusDelta) return statusDelta;
            return right.updatedAt - left.updatedAt;
        })
        .slice(0, MAX_CURRENT_PLANS);
    if (!items.length) return '';

    const lines = [
        '[Current plans]',
        '当前会话未完成计划。继续多步工作时优先参考；如果本轮无关，可以忽略。',
    ];
    items.forEach((plan) => {
        const blockedByText = plan.blockedBy.length ? `; blocked by ${plan.blockedBy.join(', ')}` : '';
        lines.push(`- ${plan.id} ${plan.status}: ${plan.title}${blockedByText}`);
    });
    return lines.join('\n').trim();
}

export async function buildCurrentPlansContextText(options = {}) {
    const sessionId = String(options.sessionId || '').trim();
    if (!sessionId) return '';
    const ledger = options.ledger || createPlanLedger();
    const results = await Promise.all(CURRENT_PLAN_STATUSES.map(async (status) => {
        const result = await ledger.listPlans(sessionId, {
            status,
            limit: MAX_CURRENT_PLANS,
        });
        return result?.ok && Array.isArray(result.plans) ? result.plans : [];
    }));
    return formatCurrentPlansContextText(results.flat());
}
