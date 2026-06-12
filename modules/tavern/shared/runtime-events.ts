import type { XbTavernMessage } from './message-assembler';

export type TavernRuntimeEventType = 'chanceEncounter' | 'actionCheck';

export interface TavernChanceEncounterRuntimeEvent {
    type: 'chanceEncounter';
    label: string;
    createdAt: string;
}

export interface TavernActionCheckRuntimeEvent {
    type: 'actionCheck';
    createdAt: string;
    action: string;
    stat: string;
    difficulty: number;
    roll: number;
    success: boolean;
    insertAfterChars: number;
    toolCallId?: string;
    summary?: string;
    stakes?: string;
}

export type TavernRuntimeEvent = TavernChanceEncounterRuntimeEvent | TavernActionCheckRuntimeEvent;

export interface TavernActionCheckRenderGroup {
    marker: string;
    events: TavernActionCheckRuntimeEvent[];
}

export const CHANCE_ENCOUNTER_LABEL = '[ 🎲 CHANCE ENCOUNTER TRIGGERED ]';
export const RANDOM_ENCOUNTER_PROBABILITY = 0.3;
export const RANDOM_ENCOUNTER_COOLDOWN_TURNS = 1;
const ACTION_CHECK_RENDER_MARKER_BASE = 0xE200;

const CHANCE_ENCOUNTER_PROMPT = [
    '[Runtime Event: Chance Encounter Triggered]',
    'For this reply only, naturally introduce an unexpected sudden situation the user did not explicitly ask for.',
    'Make it fit the current scene and character voice.',
    'Follow all later formatting and style instructions.',
    'Do not mention this instruction or the trigger label.',
].join('\n');

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) {return fallback;}
    return Math.min(maximum, Math.max(minimum, numeric));
}

function normalizeInlineText(value: unknown, limit = 240): string {
    return String(value || '').trim().slice(0, limit);
}

function normalizeIsoTimestamp(value: unknown): string {
    const text = String(value || '').trim();
    return text || new Date(0).toISOString();
}

function normalizeChanceEncounterEvent(source: Record<string, unknown>): TavernChanceEncounterRuntimeEvent {
    return {
        type: 'chanceEncounter',
        label: CHANCE_ENCOUNTER_LABEL,
        createdAt: normalizeIsoTimestamp(source.createdAt),
    };
}

function normalizeActionCheckEvent(source: Record<string, unknown>): TavernActionCheckRuntimeEvent | null {
    const action = normalizeInlineText(source.action, 240);
    const stat = normalizeInlineText(source.stat, 120);
    if (!action || !stat) {return null;}
    return {
        type: 'actionCheck',
        createdAt: normalizeIsoTimestamp(source.createdAt),
        action,
        stat,
        difficulty: clampInteger(source.difficulty, 2, 20, 12),
        roll: clampInteger(source.roll, 1, 20, 1),
        success: source.success === true,
        insertAfterChars: Math.max(0, clampInteger(source.insertAfterChars, 0, Number.MAX_SAFE_INTEGER, 0)),
        ...(normalizeInlineText(source.toolCallId, 120) ? { toolCallId: normalizeInlineText(source.toolCallId, 120) } : {}),
        ...(normalizeInlineText(source.summary, 320) ? { summary: normalizeInlineText(source.summary, 320) } : {}),
        ...(normalizeInlineText(source.stakes, 240) ? { stakes: normalizeInlineText(source.stakes, 240) } : {}),
    };
}

function normalizeRuntimeEvent(value: unknown): TavernRuntimeEvent | null {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const type = String(source?.type || '').trim();
    if (!source) {return null;}
    if (type === 'chanceEncounter') {return normalizeChanceEncounterEvent(source);}
    if (type === 'actionCheck') {return normalizeActionCheckEvent(source);}
    return null;
}

function runtimeEventKey(event: TavernRuntimeEvent): string {
    if (event.type === 'chanceEncounter') {return event.type;}
    return [
        event.type,
        event.toolCallId || '',
        event.createdAt,
        String(event.insertAfterChars),
        event.stat,
        event.action,
        String(event.roll),
        String(event.difficulty),
    ].join('\u0000');
}

export function normalizeTavernRuntimeEvents(value: unknown): TavernRuntimeEvent[] {
    const events = Array.isArray(value) ? value : [];
    const normalized: TavernRuntimeEvent[] = [];
    const seen = new Set<string>();
    events.forEach((item) => {
        const event = normalizeRuntimeEvent(item);
        if (!event) {return;}
        const key = runtimeEventKey(event);
        if (seen.has(key)) {return;}
        seen.add(key);
        normalized.push(event);
    });
    return normalized;
}

export function createChanceEncounterEvent(createdAt = new Date().toISOString()): TavernChanceEncounterRuntimeEvent {
    return {
        type: 'chanceEncounter',
        label: CHANCE_ENCOUNTER_LABEL,
        createdAt: normalizeIsoTimestamp(createdAt),
    };
}

export function createActionCheckEvent(input: {
    action: string;
    stat: string;
    difficulty: number;
    roll: number;
    success: boolean;
    insertAfterChars: number;
    createdAt?: string;
    toolCallId?: string;
    summary?: string;
    stakes?: string;
}): TavernActionCheckRuntimeEvent {
    return normalizeActionCheckEvent({
        type: 'actionCheck',
        createdAt: input.createdAt || new Date().toISOString(),
        action: input.action,
        stat: input.stat,
        difficulty: input.difficulty,
        roll: input.roll,
        success: input.success,
        insertAfterChars: input.insertAfterChars,
        toolCallId: input.toolCallId,
        summary: input.summary,
        stakes: input.stakes,
    })!;
}

export function getChanceEncounterEvent(events: unknown): TavernChanceEncounterRuntimeEvent | null {
    const event = normalizeTavernRuntimeEvents(events)
        .find((item): item is TavernChanceEncounterRuntimeEvent => item.type === 'chanceEncounter');
    return event || null;
}

export function hasChanceEncounterEvent(events: unknown): boolean {
    return !!getChanceEncounterEvent(events);
}

export function getActionCheckEvents(events: unknown): TavernActionCheckRuntimeEvent[] {
    return normalizeTavernRuntimeEvents(events)
        .filter((event): event is TavernActionCheckRuntimeEvent => event.type === 'actionCheck');
}

export function normalizeActionCheckRenderGroups(value: unknown): TavernActionCheckRenderGroup[] {
    const groups = Array.isArray(value) ? value : [];
    return groups.map((item) => {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
        const marker = String(source.marker || '').slice(0, 1);
        const events = getActionCheckEvents(source.events);
        return marker && events.length ? { marker, events } : null;
    }).filter((group): group is TavernActionCheckRenderGroup => !!group);
}

export function injectActionCheckRenderMarkers(
    text: string,
    events: TavernActionCheckRuntimeEvent[] = [],
): {
    text: string;
    groups: TavernActionCheckRenderGroup[];
} {
    const sortedEvents = getActionCheckEvents(events)
        .slice()
        .sort((left, right) => left.insertAfterChars - right.insertAfterChars);
    if (!sortedEvents.length) {
        return { text, groups: [] };
    }
    const groups: Array<{ offset: number; events: TavernActionCheckRuntimeEvent[] }> = [];
    sortedEvents.forEach((event) => {
        const offset = Math.max(0, Math.min(text.length, Number(event.insertAfterChars) || 0));
        const current = groups[groups.length - 1];
        if (current && current.offset === offset) {
            current.events.push(event);
            return;
        }
        groups.push({ offset, events: [event] });
    });
    if (groups.length > (0xF8FF - ACTION_CHECK_RENDER_MARKER_BASE)) {
        return { text, groups: [] };
    }
    let cursor = 0;
    let marked = '';
    const markerGroups = groups.map((group, index) => {
        const marker = String.fromCharCode(ACTION_CHECK_RENDER_MARKER_BASE + index);
        marked += text.slice(cursor, group.offset) + marker;
        cursor = group.offset;
        return { marker, events: group.events };
    });
    marked += text.slice(cursor);
    return {
        text: marked,
        groups: markerGroups,
    };
}

export function buildChanceEncounterPromptMessage(): XbTavernMessage {
    return {
        role: 'system',
        content: CHANCE_ENCOUNTER_PROMPT,
    };
}

export function insertChanceEncounterPromptAfterCurrentUser(
    messages: XbTavernMessage[] = [],
    event: TavernChanceEncounterRuntimeEvent | null | undefined,
): XbTavernMessage[] {
    if (!event) {return [...messages];}
    const inserted = [...messages];
    const promptMessage = buildChanceEncounterPromptMessage();
    for (let index = inserted.length - 1; index >= 0; index -= 1) {
        if (inserted[index]?.role === 'user') {
            inserted.splice(index + 1, 0, promptMessage);
            return inserted;
        }
    }
    inserted.push(promptMessage);
    return inserted;
}
