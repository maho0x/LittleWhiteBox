import type { XbTavernMessage } from './message-assembler';

export type TavernRuntimeEventType = 'chanceEncounter';

export interface TavernRuntimeEvent {
    type: TavernRuntimeEventType;
    label: string;
    createdAt: string;
}

export const CHANCE_ENCOUNTER_LABEL = '[ 🎲 CHANCE ENCOUNTER TRIGGERED ]';
export const RANDOM_ENCOUNTER_PROBABILITY = 0.3;
export const RANDOM_ENCOUNTER_COOLDOWN_TURNS = 1;

const CHANCE_ENCOUNTER_PROMPT = [
    '[Runtime Event: Chance Encounter Triggered]',
    'For this reply only, naturally introduce an unexpected sudden situation the user did not explicitly ask for.',
    'Make it fit the current scene and character voice.',
    'Follow all later formatting and style instructions.',
    'Do not mention this instruction or the trigger label.',
].join('\n');

function normalizeIsoTimestamp(value: unknown): string {
    const text = String(value || '').trim();
    return text || new Date(0).toISOString();
}

function normalizeRuntimeEvent(value: unknown): TavernRuntimeEvent | null {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const type = String(source?.type || '').trim();
    if (type !== 'chanceEncounter') {return null;}
    return {
        type: 'chanceEncounter',
        label: CHANCE_ENCOUNTER_LABEL,
        createdAt: normalizeIsoTimestamp(source?.createdAt),
    };
}

export function normalizeTavernRuntimeEvents(value: unknown): TavernRuntimeEvent[] {
    const events = Array.isArray(value) ? value : [];
    const normalized: TavernRuntimeEvent[] = [];
    const seen = new Set<string>();
    events.forEach((item) => {
        const event = normalizeRuntimeEvent(item);
        if (!event || seen.has(event.type)) {return;}
        seen.add(event.type);
        normalized.push(event);
    });
    return normalized;
}

export function createChanceEncounterEvent(createdAt = new Date().toISOString()): TavernRuntimeEvent {
    return {
        type: 'chanceEncounter',
        label: CHANCE_ENCOUNTER_LABEL,
        createdAt: normalizeIsoTimestamp(createdAt),
    };
}

export function getChanceEncounterEvent(events: unknown): TavernRuntimeEvent | null {
    return normalizeTavernRuntimeEvents(events).find((event) => event.type === 'chanceEncounter') || null;
}

export function hasChanceEncounterEvent(events: unknown): boolean {
    return !!getChanceEncounterEvent(events);
}

export function buildChanceEncounterPromptMessage(): XbTavernMessage {
    return {
        role: 'system',
        content: CHANCE_ENCOUNTER_PROMPT,
    };
}

export function insertChanceEncounterPromptAfterCurrentUser(
    messages: XbTavernMessage[] = [],
    event: TavernRuntimeEvent | null | undefined,
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
