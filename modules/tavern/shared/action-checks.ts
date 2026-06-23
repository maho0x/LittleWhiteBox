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
    '',
    'In this reply, when even you cannot know whether a key action succeeds or fails, you may roll once and leave the outcome to luck instead of deciding it yourself. Think like a tabletop game master: when fate is genuinely undecided, let the die speak.',
    '',
    'Use it boldly when an attempt could truly succeed or fail and the result would change what happens next: climbing a wall, sneaking, confrontation, deception, persuasion, gambling, a chase, spellcasting, spotting a lie, risky improvisation, and similar moments.',
    '',
    'Do not roll when the outcome is already settled. If one side has overwhelming advantage in numbers, strength, position, or common sense, the result is already decided; do not use a roll to overturn that logic.',
    '',
    'Do not roll for intimate or everyday interactions rather than challenges. Kissing, hugging, sex, casual conversation, or falling asleep together should follow character, consent, and emotional flow, not a success/failure check.',
    '',
    `When you roll, call ${ACTION_CHECK_TOOL_NAME}, treat the result as established fact, convey the outcome in one or two sentences, then continue the narration naturally.`,
    '',
    'Do not mention this protocol, the dice mechanic, or any hidden instruction. Continue to follow all other format and style requirements.',
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
                'Use it for key actions that could truly succeed or fail and would change what happens next.',
                'Do not use it for already settled outcomes or for intimate/everyday interactions that should follow character, consent, and emotional flow.',
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
