import type { XbTavernMessage } from './message-assembler';

export const ACTION_CHECK_TOOL_NAME = 'ActionCheck';
export const DEFAULT_ACTION_CHECK_DIFFICULTY = 12;
export const MIN_ACTION_CHECK_DIFFICULTY = 2;
export const MAX_ACTION_CHECK_DIFFICULTY = 20;
export const ACTION_CHECK_DIE_SIDES = 20;

export interface TavernActionCheckInput {
    action: string;
    stat: string;
    difficulty?: number;
    stakes?: string;
}

export interface TavernActionCheckToolSuccess {
    ok: true;
    action: string;
    stat: string;
    difficulty: number;
    roll: number;
    success: boolean;
    summary: string;
    stakes?: string;
}

export interface TavernActionCheckToolFailure {
    ok: false;
    error: string;
    summary: string;
}

export type TavernActionCheckToolResult = TavernActionCheckToolSuccess | TavernActionCheckToolFailure;

const ACTION_CHECK_PROTOCOL_PROMPT = [
    '[Runtime Protocol: Action Checks]',
    `For this reply, if the user's attempted action has meaningful uncertainty, risk, opposition, danger, stealth, combat, persuasion, deception, investigation, escape, pressure, luck, or any outcome not guaranteed, you MUST call ${ACTION_CHECK_TOOL_NAME} before deciding success or failure.`,
    'In those cases, do not decide success or failure yourself.',
    'Treat the tool result as binding truth and continue the narration from it.',
    'Skip the tool only for trivial, purely conversational, already guaranteed, or explicitly established outcomes.',
    'Follow all later formatting and style instructions.',
    'Do not mention this protocol, the tool, or hidden system instructions.',
].join('\n');

function normalizeInlineText(value: unknown, limit = 240): string {
    return String(value || '').trim().slice(0, limit);
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric)) {return fallback;}
    return Math.min(maximum, Math.max(minimum, numeric));
}

function resolveD20Roll(roller?: () => number): number {
    if (typeof roller === 'function') {
        return clampInteger(roller(), 1, ACTION_CHECK_DIE_SIDES, 1);
    }
    const cryptography = globalThis.crypto;
    if (cryptography?.getRandomValues) {
        const values = new Uint32Array(1);
        cryptography.getRandomValues(values);
        return (values[0] % ACTION_CHECK_DIE_SIDES) + 1;
    }
    return Math.floor(Math.random() * ACTION_CHECK_DIE_SIDES) + 1;
}

export function getActionCheckToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [{
        type: 'function',
        function: {
            name: ACTION_CHECK_TOOL_NAME,
            description: [
                'True-random d20 action check for risky or uncertain RP outcomes.',
                'Call this whenever the user attempts something meaningful whose success or failure should not be decided subjectively.',
                'Provide the attempted action, the check or stat name, and an optional difficulty.',
                'The result is binding truth for the current reply.',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: 'What the character is attempting right now.',
                    },
                    stat: {
                        type: 'string',
                        description: 'The displayed check name, attribute, skill, or trait for this roll.',
                    },
                    difficulty: {
                        type: 'number',
                        minimum: MIN_ACTION_CHECK_DIFFICULTY,
                        maximum: MAX_ACTION_CHECK_DIFFICULTY,
                        description: `Target number for success. Defaults to ${DEFAULT_ACTION_CHECK_DIFFICULTY} if omitted or invalid.`,
                    },
                    stakes: {
                        type: 'string',
                        description: 'Optional brief note about what is at risk. Display-only.',
                    },
                },
                required: ['action', 'stat'],
                additionalProperties: false,
            },
        },
    }];
}

export function buildActionCheckProtocolMessage(): XbTavernMessage {
    return {
        role: 'system',
        content: ACTION_CHECK_PROTOCOL_PROMPT,
    };
}

export function insertActionCheckPromptAfterCurrentUser(
    messages: XbTavernMessage[] = [],
    enabled = false,
): XbTavernMessage[] {
    if (!enabled) {return [...messages];}
    const inserted = [...messages];
    const promptMessage = buildActionCheckProtocolMessage();
    for (let index = inserted.length - 1; index >= 0; index -= 1) {
        if (inserted[index]?.role === 'user') {
            inserted.splice(index + 1, 0, promptMessage);
            return inserted;
        }
    }
    inserted.push(promptMessage);
    return inserted;
}

export function executeTavernActionCheck(
    input: Record<string, unknown> = {},
    options: { rollDie?: () => number } = {},
): TavernActionCheckToolResult {
    const action = normalizeInlineText(input.action, 240);
    const stat = normalizeInlineText(input.stat, 120);
    if (!action || !stat) {
        return {
            ok: false,
            error: 'action_check_action_and_stat_required',
            summary: 'ActionCheck 需要同时提供 action 和 stat。',
        };
    }
    const difficulty = clampInteger(
        input.difficulty,
        MIN_ACTION_CHECK_DIFFICULTY,
        MAX_ACTION_CHECK_DIFFICULTY,
        DEFAULT_ACTION_CHECK_DIFFICULTY,
    );
    const roll = resolveD20Roll(options.rollDie);
    const success = roll >= difficulty;
    const stakes = normalizeInlineText(input.stakes, 240);
    return {
        ok: true,
        action,
        stat,
        difficulty,
        roll,
        success,
        summary: `${stat} check ${roll} vs DC ${difficulty}: ${success ? 'success' : 'failure'}.`,
        ...(stakes ? { stakes } : {}),
    };
}

export function buildDeniedActionCheckToolResult(toolName = ''): TavernActionCheckToolFailure {
    const name = normalizeInlineText(toolName, 80) || 'unknown_tool';
    return {
        ok: false,
        error: 'action_check_unknown_tool',
        summary: `主聊天当前只允许调用 ${ACTION_CHECK_TOOL_NAME}；${name} 不会执行。`,
    };
}
