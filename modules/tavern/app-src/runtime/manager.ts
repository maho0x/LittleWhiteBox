import { createAgentAdapter, resolveActiveProviderConfig } from '../../../agent-core/provider-config.js';
import * as contextTokens from '../../../agent-core/runtime/context-tokens.js';
import {
    buildProviderAssistantToolCallMessage,
    buildProviderToolResultMessage,
    hasVisibleText,
    resolveResultToolCalls,
} from '../../../agent-core/runtime/protocol.js';
import type { XbTavernMessage } from '../../shared/message-assembler';
import { buildTavernManagerSystemPrompt, type TavernAssistantPreset } from '../../shared/assistant-presets';
import {
    ensureTavernMemoryDefaults,
    executeTavernMemoryTool,
    getTavernManagerToolDefinitions,
    listTavernMemoryFiles,
    rebuildTavernMemoryDerivedIndex,
    type TavernMemoryToolResult,
} from '../../shared/memory-files';
import {
    createTavernManagerRun,
    deleteTavernManagerMessages,
    listTavernManagerMemorySnapshots,
    listTavernManagerMessages,
    listTavernMessages,
    rollbackManagerRunMemoryWrites,
    rollbackManagerRunsForMessageRange,
    touchRunningTavernManagerRun,
    updateTavernManagerRun,
    type TavernManagerMessageRecord,
    type TavernManagerRunRecord,
    type TavernMessageRecord,
} from '../../shared/session-db';
import { executeTavernStateTool, TAVERN_STATE_TOOL_NAMES, type TavernStateToolResult } from '../../shared/structured-state';
import {
    abandonStaleTavernTasks,
    buildTavernTaskPoolPromptBlock,
    executeTavernTaskTool,
    listTavernManagerTaskSnapshots,
    rollbackManagerRunTaskWrites,
    TAVERN_TASK_MIN_GENERATION_FLOOR,
    TAVERN_TASK_TOOL_NAMES,
    type TavernTaskToolResult,
} from '../../shared/tasks';
import { resolveTavernSessionContractRuntime, type TavernSessionContract, type TavernSessionContractRuntime } from '../../shared/session-contract';
import {
    buildDeniedAutoManagerToolResult,
    filterAutoManagerToolDefinitions,
    isAutoManagerToolAllowed,
} from './contract-policy';
import { getXbTavernProviderLabel } from './provider';
import {
    applyTavernToolLoopRequestPlan,
    resolveTavernToolLoopRequestPlan,
    type TavernToolLoopResponse,
} from './tool-loop-request';

const resolveConversationTokens = (contextTokens as unknown as {
    resolveConversationTokens: (input: {
        messages?: XbTavernMessage[];
        tools?: unknown[] | null;
        providerConfig?: Record<string, unknown>;
    }) => Promise<number>;
}).resolveConversationTokens;

type TavernManagerStreamSnapshot = {
    text?: string;
    thoughts?: Array<{ label?: string; text?: string }>;
    toolCalls?: unknown[];
    toolCallDraft?: boolean;
};

export type TavernManagerProtocolEvent =
    | { type: 'assistant_tool_round'; message: XbTavernMessage }
    | { type: 'tool_result'; message: XbTavernMessage }
    | { type: 'final_assistant'; message: XbTavernMessage }
    | { type: 'clear_stream_draft' };

export interface XbTavernManagerOnceOptions {
    agentConfig: Record<string, unknown>;
    messages?: XbTavernMessage[];
    tools?: unknown[];
    toolChoice?: 'auto' | 'none' | string;
    toolResponses?: TavernToolLoopResponse[];
    finalAnswerReminderText?: string;
    signal?: AbortSignal;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
}

export interface XbTavernManagerOnceResult {
    text: string;
    provider?: string;
    model?: string;
    toolCalls?: unknown[];
    thoughts?: Array<{ label?: string; text?: string }>;
    providerPayload?: unknown;
}

export interface XbTavernManagerRunInput {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    userMessage: TavernMessageRecord;
    assistantMessage: TavernMessageRecord;
    turn: number;
    trigger?: string;
    managerRunId?: string;
    sessionContract?: TavernSessionContract;
    assistantPreset?: TavernAssistantPreset;
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onProtocolEvent?: (event: TavernManagerProtocolEvent) => void;
}

export interface XbTavernManagerRunResult {
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    changedFiles?: string[];
    changedStates?: string[];
    changedTasks?: string[];
    error?: string;
}

export interface XbTavernManagerScheduleResult {
    managerRunId: string;
    managerStatus: TavernManagerRunRecord['status'];
    completion?: Promise<XbTavernManagerRunResult>;
}

export interface XbTavernManagerChatInput {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    question: string;
    history?: TavernManagerMessageRecord[];
    turn?: number;
    trigger?: string;
    assistantPreset?: TavernAssistantPreset;
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
    onProtocolEvent?: (event: TavernManagerProtocolEvent) => void;
}

export interface XbTavernManagerChatResult {
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    text: string;
    provider: string;
    model: string;
    changedFiles: string[];
    changedStates: string[];
    changedTasks: string[];
    protocolMessages: XbTavernMessage[];
    error?: string;
}

export interface XbTavernManagerCompactionSnapshot {
    currentTokens: number;
    yieldTokens?: number;
    triggerTokens: number;
    status: string;
    preservedTurns?: number;
}

export interface EnsureTavernManagerChatBudgetInput {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    assistantPreset?: TavernAssistantPreset;
    question: string;
    history?: TavernManagerMessageRecord[];
    signal?: AbortSignal;
    onCompactionStart?: (snapshot: XbTavernManagerCompactionSnapshot) => void;
    onCompactionProgress?: (snapshot: XbTavernManagerCompactionSnapshot) => void;
    onCompactionComplete?: (snapshot: XbTavernManagerCompactionSnapshot) => void;
    onCompactionUnable?: (snapshot: XbTavernManagerCompactionSnapshot) => void;
}

export const TAVERN_MANAGER_MAX_CONTEXT_TOKENS = 188000;
export const TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS = 158000;
export const TAVERN_MANAGER_DEFAULT_PRESERVED_TURNS = 2;
export const TAVERN_MANAGER_MIN_PRESERVED_TURNS = 1;

const managerQueues = new Map<string, Promise<unknown>>();
const activeAutoManagerRuns = new Map<string, {
    controller: AbortController;
    sessionId: string;
    userOrder: number;
    assistantOrder: number;
}>();
export const MAX_MANAGER_TOOL_ROUNDS = 48;

function normalizeText(value: unknown = '', limit = 4000): string {
    const text = String(value || '').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value || '');
    }
}

function safeJsonParse(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : fallback;
    } catch {
        return fallback;
    }
}

function buildManagerSystemPrompt(
    assistantPreset: TavernAssistantPreset | undefined,
    options: { includeMemory?: boolean; includeCartography?: boolean; includeQuestOrchestration?: boolean } = {},
): string {
    return buildTavernManagerSystemPrompt(assistantPreset, options).trim();
}

function resolveSessionContractRuntime(contract?: Partial<TavernSessionContract> | null): TavernSessionContractRuntime {
    return resolveTavernSessionContractRuntime(contract);
}

function buildResidentMemoryBlock(memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>): string {
    const stateFile = memoryFiles.find((file) => file.path === 'memory/state.md');
    const blocks = [
        stateFile ? ['[memory/state.md]', stateFile.content].join('\n') : '',
    ].filter(Boolean);
    return ['[Resident Memory Files]', ...blocks].join('\n\n');
}

function buildAutoManagerUserPrompt(input: {
    turn: number;
    userMessage: TavernMessageRecord;
    assistantMessage: TavernMessageRecord;
    memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>;
    taskPoolBlock?: string;
    runtime: TavernSessionContractRuntime;
}): string {
    const allowMemory = input.runtime.managerPromptOptions.includeMemory;
    const allowMap = input.runtime.managerPromptOptions.includeCartography;
    const allowQuest = input.runtime.managerPromptOptions.includeQuestOrchestration;
    const requirements: string[] = [];
    let step = 1;
    if (allowMemory) {
        requirements.push(`${step}. Read \`memory/state.md\` and relevant \`memory/characters/<角色名>.md\` files as needed, then update memory only if this completed assistant reply changed durable memory.`);
        step += 1;
    }
    if (allowMap) {
        requirements.push(`${step}. Spatial maintenance has two layers: update \`tavern.atlas/main\` only when a location, connection, or actor location changed; update \`tavern.map/<docId>\` only when the current place layout or actor coordinates changed. Player location changes must use atlas \`move-actor\` with \`actorKey:"player"\`; map \`activate:true\` only switches the map tool doc and does not move the player.`);
        step += 1;
    }
    if (allowMemory && allowMap) {
        requirements.push(`${step}. Maintain \`memory/state.md\` for global memory and \`memory/characters/<角色名>.md\` for character memory. The map does not replace written memory.`);
        step += 1;
    } else if (allowMemory) {
        requirements.push(`${step}. Maintain \`memory/state.md\` for global memory and \`memory/characters/<角色名>.md\` for character memory.`);
        step += 1;
    } else if (allowMap) {
        requirements.push(`${step}. This contract authorizes only the map system. Do not write memory Markdown.`);
        step += 1;
    } else if (!allowQuest) {
        requirements.push(`${step}. This contract authorizes neither background memory nor map maintenance. Do not write memory or State; clearly say that you skipped it.`);
        step += 1;
    }
    if (allowQuest) {
        requirements.push(`${step}. Maintain the event pool with TaskPatch only when useful: advance or complete active directions that the reply actually addressed; after floor ${TAVERN_TASK_MIN_GENERATION_FLOOR}, create fresh active directions only when the pool is low and the hook uses established people, places, relationships, world facts, and current tone. Do not use TaskPatch for old facts, and do not generate if no good hook exists.`);
        step += 1;
    }
    requirements.push(`${step}. Close with a short result: say what you wrote, skipped, or left pending.`);

    const blocks = [
        ...(allowMemory ? [buildResidentMemoryBlock(input.memoryFiles), ''] : []),
        ...(allowQuest ? [String(input.taskPoolBlock || '[Current Event Pool]\nActive directions: unknown.').trim(), ''] : []),
        '[本轮 RP 原文]',
        '[用户消息]',
        input.userMessage.content,
        '',
        '[角色回复]',
        input.assistantMessage.content,
        '',
        '[本轮要求]',
        ...requirements,
    ];
    return blocks.join('\n');
}

function buildChatManagerUserPrompt(input: {
    question: string;
    memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>;
}): string {
    return [
        buildResidentMemoryBlock(input.memoryFiles),
        '',
        '[当前问题]',
        input.question,
    ].join('\n');
}

function buildInputSummary(input: { trigger?: string; turn?: number; userOrder?: number; assistantOrder?: number; text?: string }): string {
    if (String(input.trigger || '') === 'manager_chat') {
        return `manager chat; turn ${Math.max(0, Number(input.turn) || 0)}; question ${String(input.text || '').length} chars`;
    }
    return `turn ${Math.max(0, Number(input.turn) || 0)}; messages ${Number(input.userOrder)}/${Number(input.assistantOrder)}; user ${String(input.text || '').length} chars`;
}

async function runManagerOnceWithAdapter(
    adapter: { chat: (task: Record<string, unknown>) => Promise<Record<string, unknown>> },
    providerConfig: Record<string, unknown>,
    options: XbTavernManagerOnceOptions,
): Promise<XbTavernManagerOnceResult> {
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const task: Record<string, unknown> = {
        systemPrompt: messages[0]?.content || '',
        tools: Array.isArray(options.tools) ? options.tools : [],
        toolChoice: options.toolChoice || (options.tools?.length ? 'auto' : 'none'),
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        reasoning: {
            enabled: providerConfig.reasoningEnabled,
            effort: providerConfig.reasoningEffort,
        },
        signal: options.signal,
        onStreamProgress: (snapshot: TavernManagerStreamSnapshot) => {
            options.onStreamProgress?.({
                ...(typeof snapshot.text === 'string' ? { text: snapshot.text } : {}),
                ...(Array.isArray(snapshot.thoughts) ? { thoughts: normalizeManagerThoughtBlocks(snapshot.thoughts) } : {}),
                ...(Array.isArray(snapshot.toolCalls) ? { toolCalls: snapshot.toolCalls } : {}),
                ...(snapshot.toolCallDraft ? { toolCallDraft: true } : {}),
            });
        },
    };
    applyTavernToolLoopRequestPlan(task, resolveTavernToolLoopRequestPlan({
        supportsSessionToolLoop: (adapter as { supportsSessionToolLoop?: boolean } | null)?.supportsSessionToolLoop === true,
        messages,
        toolResponses: options.toolResponses,
        finalAnswerReminderText: options.finalAnswerReminderText,
    }));
    const result = await adapter.chat(task);
    return {
        text: String(result?.text || '').trim(),
        provider: String(result?.provider || providerConfig.provider || ''),
        model: String(result?.model || providerConfig.model || ''),
        toolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls : [],
        thoughts: normalizeManagerThoughtBlocks(result?.thoughts),
        providerPayload: result?.providerPayload,
    };
}

function summarizeToolArguments(args: Record<string, unknown> = {}): string {
    return ['filePath', 'path', 'pattern', 'mode', 'docType', 'docId', 'elementId', 'startOrder', 'endOrder']
        .map((key) => {
            const value = normalizeText(args[key], 160);
            return value ? `${key}: ${value}` : '';
        })
        .filter(Boolean)
        .join('; ');
}

function summarizeToolResult(result: TavernMemoryToolResult | TavernStateToolResult | TavernTaskToolResult): string {
    const summary = normalizeText(result.summary || result.error || '', 360);
    if (result.ok !== false) {return summary;}
    const details = (result as { details?: unknown }).details;
    if (!Array.isArray(details) || !details.length) {return summary;}
    const detailText = details
        .slice(0, 2)
        .map((item) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return normalizeText(record.hint || record.error || item, 180);
        })
        .filter(Boolean)
        .join('；');
    return normalizeText([summary, detailText].filter(Boolean).join(' '), 420);
}

function isStateToolName(name = ''): boolean {
    return Object.values(TAVERN_STATE_TOOL_NAMES).includes(name as typeof TAVERN_STATE_TOOL_NAMES[keyof typeof TAVERN_STATE_TOOL_NAMES]);
}

function isTaskToolName(name = ''): boolean {
    return Object.values(TAVERN_TASK_TOOL_NAMES).includes(name as typeof TAVERN_TASK_TOOL_NAMES[keyof typeof TAVERN_TASK_TOOL_NAMES]);
}

function hasFailedTool(toolTrace: Array<Record<string, unknown>> = []): boolean {
    return toolTrace.some((item) => item.ok === false);
}

function normalizeManagerThoughtBlocks(value: unknown): Array<{ label?: string; text?: string }> {
    if (!Array.isArray(value)) {return [];}
    const thoughts: Array<{ label: string; text: string }> = [];
    value.forEach((item, index) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const text = String(record.text || record.content || record.thinking || '').trim();
            if (!text) {return;}
            thoughts.push({
                label: String(record.label || record.summary || `思考 ${index + 1}`).trim() || `思考 ${index + 1}`,
                text,
            });
        });
    return thoughts;
}

async function persistRunningManagerToolTrace(managerRunId = '', toolTrace: Array<Record<string, unknown>> = []): Promise<void> {
    const id = String(managerRunId || '').trim();
    if (!id) {return;}
    await updateTavernManagerRun(id, {
        status: 'running',
        toolTrace: toolTrace.map((item) => ({ ...item })),
    });
}

function isManagerAbortLike(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {return true;}
    const message = error instanceof Error ? error.message : String(error || '');
    const name = error instanceof Error ? error.name : '';
    return name === 'AbortError' || /abort|aborted|cancelled|canceled/i.test(message);
}

function managerFailureStatus(error: unknown, signal?: AbortSignal): TavernManagerRunRecord['status'] {
    const message = error instanceof Error ? error.message : String(error || '');
    if (isManagerAbortLike(error, signal)) {return 'cancelled';}
    if (message === 'manager_source_messages_changed') {return 'superseded';}
    return 'failed';
}

async function rollbackManagerRunIfWroteMemory(managerRunId = ''): Promise<{
    managerRun: TavernManagerRunRecord | null;
    conflicts: string[];
} | null> {
    const [memorySnapshots, taskSnapshots] = await Promise.all([
        listTavernManagerMemorySnapshots(managerRunId),
        listTavernManagerTaskSnapshots(managerRunId),
    ]);
    const hasMemoryWrites = memorySnapshots.some((snapshot) => String(snapshot.afterHash || '').trim());
    const hasTaskWrites = taskSnapshots.some((snapshot) => String(snapshot.afterHash || '').trim());
    if (!hasMemoryWrites && !hasTaskWrites) {
        return null;
    }
    const [memoryResult, taskResult] = await Promise.all([
        hasMemoryWrites ? rollbackManagerRunMemoryWrites(managerRunId) : Promise.resolve({ rolledBack: 0, conflicts: [], skipped: 0 }),
        hasTaskWrites ? rollbackManagerRunTaskWrites(managerRunId) : Promise.resolve({ rolledBack: 0, conflicts: [], skipped: 0 }),
    ]);
    return {
        managerRun: await updateTavernManagerRun(managerRunId, {}),
        conflicts: [...memoryResult.conflicts, ...taskResult.conflicts],
    };
}

function throwIfManagerAborted(signal?: AbortSignal) {
    if (!signal?.aborted) {return;}
    const error = new Error('manager_aborted');
    error.name = 'AbortError';
    throw error;
}

async function runManagerAgentWithTools(input: {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    caller: 'auto' | 'chat';
    messages: XbTavernMessage[];
    managerRunId?: string;
    turn?: number;
    userOrder?: number;
    assistantOrder?: number;
    beforeWriteGuard?: () => Promise<void> | void;
    sessionContract?: TavernSessionContract;
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
    onProtocolEvent?: (event: TavernManagerProtocolEvent) => void;
}): Promise<{
    text: string;
    provider: string;
    model: string;
    toolTrace: Array<Record<string, unknown>>;
    changedFiles: string[];
    changedStates: string[];
    changedTasks: string[];
    protocolMessages: XbTavernMessage[];
}> {
    const providerConfig = resolveActiveProviderConfig(input.agentConfig || {}, {
        role: 'delegate',
        timeoutMs: 15 * 60 * 1000,
    });
    const defaultAdapter = input.executeManagerOnce
        ? null
        : createAgentAdapter(providerConfig, {
            missingApiKeyMessage: '请先在 API 配置里填写记忆管理员 API。',
        }) as { chat: (task: Record<string, unknown>) => Promise<Record<string, unknown>>; supportsSessionToolLoop?: boolean };
    const executeManagerOnce = input.executeManagerOnce
        || ((options: XbTavernManagerOnceOptions) => runManagerOnceWithAdapter(defaultAdapter!, providerConfig, options));
    const supportsSessionToolLoop = !!defaultAdapter?.supportsSessionToolLoop
        || (input.executeManagerOnce as { supportsSessionToolLoop?: boolean } | undefined)?.supportsSessionToolLoop === true;
    const tools = input.caller === 'auto'
        ? filterAutoManagerToolDefinitions(getTavernManagerToolDefinitions(), input.sessionContract)
        : getTavernManagerToolDefinitions();
    const toolTrace: Array<Record<string, unknown>> = [];
    const protocolMessages: XbTavernMessage[] = [];
    const changedFiles = new Set<string>();
    const changedStates = new Set<string>();
    const changedTasks = new Set<string>();
    let resultProvider = '';
    let resultModel = '';
    let reminded = false;
    let pendingToolResponses: TavernToolLoopResponse[] | null = null;
    let pendingFinalAnswerReminderText = '';
    const emitProtocolEvent = (event: TavernManagerProtocolEvent) => {
        input.onProtocolEvent?.(event);
    };

    for (let round = 1; round <= MAX_MANAGER_TOOL_ROUNDS; round += 1) {
        throwIfManagerAborted(input.signal);
        let streamText = '';
        let streamThoughts: Array<{ label?: string; text?: string }> = [];
        const requestPlan = resolveTavernToolLoopRequestPlan({
            supportsSessionToolLoop,
            messages: input.messages,
            toolResponses: pendingToolResponses,
            finalAnswerReminderText: pendingFinalAnswerReminderText,
        });
        const result = await executeManagerOnce({
            agentConfig: input.agentConfig,
            messages: requestPlan.requestMessages,
            tools,
            toolChoice: 'auto',
            ...(requestPlan.mode === 'session_tool_response_round'
                ? { toolResponses: requestPlan.toolResponses }
                : {}),
            ...(requestPlan.mode === 'session_final_reminder_round'
                ? { finalAnswerReminderText: requestPlan.finalAnswerReminderText }
                : {}),
            signal: input.signal,
            onStreamProgress: (snapshot) => {
                if (typeof snapshot.text === 'string') {streamText = snapshot.text;}
                if (Array.isArray(snapshot.thoughts)) {streamThoughts = normalizeManagerThoughtBlocks(snapshot.thoughts);}
                input.onStreamProgress?.({
                    ...(typeof snapshot.text === 'string' ? { text: snapshot.text } : {}),
                    ...(Array.isArray(snapshot.thoughts) ? { thoughts: streamThoughts } : {}),
                    ...(Array.isArray(snapshot.toolCalls) ? { toolCalls: snapshot.toolCalls } : {}),
                    ...(snapshot.toolCallDraft ? { toolCallDraft: true } : {}),
                });
            },
        });
        pendingToolResponses = null;
        pendingFinalAnswerReminderText = '';
        throwIfManagerAborted(input.signal);
        const roundVisibleText = String(result.text || streamText || '');
        const normalizedRoundText = roundVisibleText.trim();
        resultProvider = String(result.provider || resultProvider || providerConfig.provider || '');
        resultModel = String(result.model || resultModel || providerConfig.model || '');
        const resultRecord = result as unknown as Record<string, unknown>;
        const resultThoughts = normalizeManagerThoughtBlocks(result.thoughts?.length ? result.thoughts : streamThoughts);
        const toolCalls = resolveResultToolCalls(resultRecord, providerConfig, {
            fallbackPrefix: 'tavern-manager-tool',
        });
        if (!toolCalls.length) {
            if (!hasVisibleText(normalizedRoundText) && toolTrace.length && !reminded) {
                reminded = true;
                const reminder = '工具结果已经齐备，请收束为本轮处理结论。';
                if (supportsSessionToolLoop) {
                    pendingFinalAnswerReminderText = reminder;
                } else {
                    input.messages.push({
                        role: 'system',
                        content: reminder,
                    });
                }
                continue;
            }
            const finalAssistantMessage: XbTavernMessage = {
                role: 'assistant',
                content: normalizedRoundText,
                thoughts: resultThoughts,
                providerPayload: result.providerPayload,
            };
            emitProtocolEvent({ type: 'clear_stream_draft' });
            emitProtocolEvent({ type: 'final_assistant', message: finalAssistantMessage });
            return {
                text: normalizedRoundText,
                provider: resultProvider,
                model: resultModel,
                toolTrace,
                changedFiles: [...changedFiles],
                changedStates: [...changedStates],
                changedTasks: [...changedTasks],
                protocolMessages: [
                    ...protocolMessages,
                    finalAssistantMessage,
                ],
            };
        }

        const assistantToolMessage = buildProviderAssistantToolCallMessage({
            ...resultRecord,
            text: roundVisibleText,
        }, toolCalls, {
            fallbackPrefix: 'tavern-manager-tool',
        }) as unknown as XbTavernMessage;
        assistantToolMessage.thoughts = resultThoughts;
        assistantToolMessage.toolCalls = toolCalls.map((toolCall) => ({
            id: String(toolCall.id || ''),
            name: String(toolCall.name || ''),
            arguments: String(toolCall.arguments || '{}'),
        }));
        input.messages.push(assistantToolMessage);
        protocolMessages.push(assistantToolMessage);
        emitProtocolEvent({ type: 'clear_stream_draft' });
        emitProtocolEvent({ type: 'assistant_tool_round', message: assistantToolMessage });

        const toolResponses: TavernToolLoopResponse[] = [];
        for (const [toolIndex, toolCall] of toolCalls.entries()) {
            const args = safeJsonParse(toolCall.arguments, {});
            throwIfManagerAborted(input.signal);
            const traceEntry: Record<string, unknown> = {
                id: String(toolCall.id || ''),
                round,
                name: toolCall.name,
                status: 'running',
                ok: true,
                args: summarizeToolArguments(args),
                path: '',
                summary: '工具运行中，等待返回。',
                preface: toolIndex === 0 ? normalizedRoundText : '',
                thoughts: toolIndex === 0 ? resultThoughts : [],
                startedAt: Date.now(),
            };
            toolTrace.push(traceEntry);
            await persistRunningManagerToolTrace(input.managerRunId, toolTrace);
            const toolResult = input.caller === 'auto' && !isAutoManagerToolAllowed(toolCall.name, input.sessionContract)
                ? buildDeniedAutoManagerToolResult(toolCall.name, input.sessionContract)
                : isStateToolName(toolCall.name)
                    ? await executeTavernStateTool(input.sessionId, toolCall.name, args, {
                        caller: input.caller,
                        managerRunId: input.managerRunId,
                        sourceUserOrder: input.userOrder,
                        sourceAssistantOrder: input.assistantOrder,
                        beforeWriteGuard: input.beforeWriteGuard,
                    })
                    : isTaskToolName(toolCall.name)
                        ? await executeTavernTaskTool(input.sessionId, toolCall.name, args, {
                            caller: input.caller,
                            managerRunId: input.managerRunId,
                            sourceUserOrder: input.userOrder,
                            sourceAssistantOrder: input.assistantOrder,
                            beforeWriteGuard: input.beforeWriteGuard,
                        })
                        : await executeTavernMemoryTool(input.sessionId, toolCall.name, args, {
                        caller: input.caller,
                        managerRunId: input.managerRunId,
                        turn: input.turn,
                        sourceUserOrder: input.userOrder,
                        sourceAssistantOrder: input.assistantOrder,
                        beforeWriteGuard: input.beforeWriteGuard,
                    });
            const resultPath = 'path' in toolResult ? toolResult.path : '';
            const resultStateKey = 'docType' in toolResult && toolResult.docType ? `${toolResult.docType}/${toolResult.docId || ''}` : '';
            const resultTaskKey = 'taskId' in toolResult && toolResult.taskId ? `task/${toolResult.taskId}` : '';
            if (toolResult.changed && resultPath) {
                changedFiles.add(resultPath);
            }
            if (toolResult.changed && resultStateKey) {
                changedStates.add(resultStateKey);
            }
            if (toolResult.changed && resultTaskKey) {
                changedTasks.add(resultTaskKey);
            }
            Object.assign(traceEntry, {
                status: 'resolved',
                ok: toolResult.ok,
                args: summarizeToolArguments(args),
                path: resultPath || resultStateKey || resultTaskKey,
                summary: summarizeToolResult(toolResult),
                error: toolResult.error || '',
                finishedAt: Date.now(),
            });
            if (Number(traceEntry.startedAt)) {
                traceEntry.elapsedMs = Math.max(0, Number(traceEntry.finishedAt) - Number(traceEntry.startedAt));
            }
            await persistRunningManagerToolTrace(input.managerRunId, toolTrace);
            const toolMessage = buildProviderToolResultMessage({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: safeJson(toolResult),
            }) as unknown as XbTavernMessage;
            toolMessage.toolCallId = String(toolCall.id || '');
            toolMessage.toolDisplay = summarizeToolResult(toolResult);
            input.messages.push(toolMessage);
            protocolMessages.push(toolMessage);
            emitProtocolEvent({ type: 'tool_result', message: toolMessage });
            toolResponses.push({
                id: toolCall.id,
                name: toolCall.name,
                response: toolResult,
            });
        }
        if (supportsSessionToolLoop) {
            pendingToolResponses = toolResponses;
        }
    }

    throw new Error(`工具轮次达到上限（${MAX_MANAGER_TOOL_ROUNDS}），已停止。`);
}

async function assertManagerSourceMessagesCurrent(input: XbTavernManagerRunInput): Promise<void> {
    const messages = await listTavernMessages(input.sessionId);
    const userMessage = messages.find((message) => message.order === input.userMessage.order);
    const assistantMessage = messages.find((message) => message.order === input.assistantMessage.order);
    const userMatches = userMessage?.role === 'user'
        && userMessage.error !== true
        && userMessage.content === input.userMessage.content;
    const assistantMatches = assistantMessage?.role === 'assistant'
        && assistantMessage.error !== true
        && !['aborted', 'error'].includes(String(assistantMessage.finishReason || '').trim())
        && assistantMessage.content === input.assistantMessage.content;
    if (!userMatches || !assistantMatches) {
        throw new Error('manager_source_messages_changed');
    }
}

async function createOrUpdateManagerRun(input: {
    managerRunId?: string;
    sessionId: string;
    trigger: string;
    turn: number;
    userOrder?: number;
    assistantOrder?: number;
    inputSummary: string;
    agentConfig: Record<string, unknown>;
}): Promise<TavernManagerRunRecord> {
    const providerConfig = resolveActiveProviderConfig(input.agentConfig || {}, {
        role: 'delegate',
        timeoutMs: 15 * 60 * 1000,
    });
    const providerLabel = getXbTavernProviderLabel(String(providerConfig.provider || ''));
    const patch = {
        status: 'running' as const,
        provider: providerLabel,
        model: String(providerConfig.model || ''),
        inputSummary: input.inputSummary,
    };
    const record = input.managerRunId
        ? await updateTavernManagerRun(input.managerRunId, patch)
        : await createTavernManagerRun({
            sessionId: input.sessionId,
            trigger: input.trigger,
            turn: input.turn,
            userOrder: Number.isInteger(Number(input.userOrder)) ? Number(input.userOrder) : -1,
            assistantOrder: Number.isInteger(Number(input.assistantOrder)) ? Number(input.assistantOrder) : -1,
            ...patch,
        });
    if (!record) {
        throw new Error('manager_run_missing');
    }
    return record;
}

function startManagerRunHeartbeat(managerRunId = '', signal?: AbortSignal): () => void {
    const id = String(managerRunId || '').trim();
    if (!id) {return () => undefined;}
    let stopped = false;
    const timer = setInterval(() => {
        if (stopped || signal?.aborted) {return;}
        void touchRunningTavernManagerRun(id);
    }, 4000);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

async function finalizeManagerRun(record: TavernManagerRunRecord, patch: Partial<TavernManagerRunRecord>): Promise<TavernManagerRunRecord> {
    return await updateTavernManagerRun(record.id, patch) || record;
}

async function buildAutoManagerMessages(input: XbTavernManagerRunInput): Promise<XbTavernMessage[]> {
    const contractRuntime = resolveSessionContractRuntime(input.sessionContract);
    if (contractRuntime.includeMemoryFiles) {
        await ensureTavernMemoryDefaults(input.sessionId);
    }
    const memoryFiles = contractRuntime.includeMemoryFiles
        ? await listTavernMemoryFiles(input.sessionId, { includeStale: true })
        : [];
    const taskPoolBlock = contractRuntime.includeQuestOrchestration
        ? await buildTavernTaskPoolPromptBlock(input.sessionId)
        : '';
    return [
        {
            role: 'system',
            content: buildManagerSystemPrompt(input.assistantPreset, contractRuntime.managerPromptOptions),
        },
        {
            role: 'user',
            content: buildAutoManagerUserPrompt({
                turn: input.turn,
                userMessage: input.userMessage,
                assistantMessage: input.assistantMessage,
                memoryFiles,
                taskPoolBlock,
                runtime: contractRuntime,
            }),
        },
    ];
}

async function buildChatManagerMessages(input: {
    sessionId: string;
    question: string;
    assistantPreset?: TavernAssistantPreset;
    history?: TavernManagerMessageRecord[];
}): Promise<XbTavernMessage[]> {
    await ensureTavernMemoryDefaults(input.sessionId);
    const memoryFiles = await listTavernMemoryFiles(input.sessionId, { includeStale: true });
    const history = Array.isArray(input.history) ? input.history : await listTavernManagerMessages(input.sessionId);
    const messages: XbTavernMessage[] = [{ role: 'system', content: buildManagerSystemPrompt(input.assistantPreset) }];
    history.forEach((message) => {
        const canReplayToolCalls = message.role === 'assistant'
            && message.error !== true
            && !['aborted', 'error'].includes(String(message.finishReason || '').trim());
        const toolCalls = canReplayToolCalls && Array.isArray(message.toolCalls) ? message.toolCalls : [];
        messages.push({
            role: message.role,
            content: String(message.content || ''),
            ...(message.name ? { name: message.name } : {}),
            ...(Array.isArray(message.thoughts) ? { thoughts: message.thoughts } : {}),
            ...('providerPayload' in message ? { providerPayload: message.providerPayload } : {}),
            ...(toolCalls.length ? {
                toolCalls,
                tool_calls: toolCalls.map((toolCall) => ({
                    id: toolCall.id || '',
                    type: 'function',
                    function: {
                        name: toolCall.name || '',
                        arguments: toolCall.arguments || '{}',
                    },
                })),
            } : {}),
            ...(message.role === 'tool' ? {
                tool_call_id: message.toolCallId || '',
                toolName: message.toolName || '',
                toolDisplay: message.toolDisplay,
            } : {}),
        });
    });
    messages.push({
        role: 'user',
        content: buildChatManagerUserPrompt({
            question: input.question,
            memoryFiles,
        }),
    });
    return messages;
}

async function runManagerTask(input: {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    trigger: string;
    turn: number;
    messages: XbTavernMessage[];
    managerRunId?: string;
    inputSummary: string;
    caller: 'auto' | 'chat';
    requireChangedFiles: boolean;
    beforeWriteGuard?: () => Promise<void> | void;
    sessionContract?: TavernSessionContract;
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
    userOrder?: number;
    assistantOrder?: number;
    onProtocolEvent?: (event: TavernManagerProtocolEvent) => void;
}): Promise<{
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    text: string;
    provider: string;
    model: string;
    toolTrace: Array<Record<string, unknown>>;
    changedFiles: string[];
    changedStates: string[];
    changedTasks: string[];
    protocolMessages: XbTavernMessage[];
    error?: string;
}> {
    const managerRun = await createOrUpdateManagerRun({
        managerRunId: input.managerRunId,
        sessionId: input.sessionId,
        trigger: input.trigger,
        turn: input.turn,
        userOrder: input.userOrder,
        assistantOrder: input.assistantOrder,
        inputSummary: input.inputSummary,
        agentConfig: input.agentConfig,
    });

    let resultText = '';
    let resultProvider = managerRun.provider || '';
    let resultModel = managerRun.model || '';
    let toolTrace: Array<Record<string, unknown>> = [];
    let changedFiles: string[] = [];
    let changedStates: string[] = [];
    let changedTasks: string[] = [];
    let protocolMessages: XbTavernMessage[] = [];
    const stopHeartbeat = startManagerRunHeartbeat(managerRun.id, input.signal);
    try {
        const result = await runManagerAgentWithTools({
            sessionId: input.sessionId,
            agentConfig: input.agentConfig,
            caller: input.caller,
            messages: input.messages,
            managerRunId: managerRun.id,
            turn: input.turn,
            userOrder: input.userOrder,
            assistantOrder: input.assistantOrder,
            beforeWriteGuard: input.beforeWriteGuard,
            sessionContract: input.sessionContract,
            signal: input.signal,
            executeManagerOnce: input.executeManagerOnce,
            onStreamProgress: input.onStreamProgress,
            onProtocolEvent: input.onProtocolEvent,
        });
        resultText = result.text;
        resultProvider = result.provider || resultProvider;
        resultModel = result.model || resultModel;
        toolTrace = result.toolTrace;
        changedFiles = result.changedFiles;
        changedStates = result.changedStates;
        changedTasks = result.changedTasks;
        protocolMessages = result.protocolMessages;
        if (input.caller !== 'auto' && hasFailedTool(toolTrace)) {
            throw new Error('manager_memory_tool_failed');
        }
        if (input.requireChangedFiles && !changedFiles.length) {
            throw new Error('manager_memory_tool_required');
        }
        await rebuildTavernMemoryDerivedIndex(input.sessionId);
        const changedCount = changedFiles.length + changedStates.length + changedTasks.length;
        const defaultOutput = changedCount
            ? `已维护 ${changedFiles.length} 个记忆文件、${changedStates.length} 份结构化状态、${changedTasks.length} 条事件线索。`
            : '已检查并回复。';
        const completed = await finalizeManagerRun(managerRun, {
            status: 'completed',
            provider: resultProvider,
            model: resultModel,
            outputText: resultText || defaultOutput,
            parsedAction: changedCount ? 'manager_state_updated' : 'memory_checked',
            toolTrace,
            changedFiles,
            changedStates,
            changedTasks,
            error: '',
        });
        return {
            ok: true,
            managerRun: completed,
            text: resultText,
            provider: resultProvider,
            model: resultModel,
            toolTrace,
            changedFiles,
            changedStates,
            changedTasks,
            protocolMessages,
        };
    } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error || 'manager_failed');
        const status = managerFailureStatus(error, input.signal);
        const failed = await finalizeManagerRun(managerRun, {
            status,
            provider: resultProvider,
            model: resultModel,
            outputText: resultText,
            toolTrace,
            changedFiles,
            changedStates,
            changedTasks,
            error: errorText,
        });
        const rolledBack = input.caller === 'auto' || ['cancelled', 'superseded'].includes(status)
            ? await rollbackManagerRunIfWroteMemory(managerRun.id)
            : null;
        if (!rolledBack?.conflicts.length) {
            await rebuildTavernMemoryDerivedIndex(input.sessionId);
        }
        return {
            ok: false,
            managerRun: rolledBack?.managerRun || failed,
            text: resultText,
            provider: resultProvider,
            model: resultModel,
            toolTrace,
            changedFiles,
            changedStates,
            changedTasks,
            protocolMessages,
            error: errorText,
        };
    } finally {
        stopHeartbeat();
    }
}

export function splitTavernManagerMessagesIntoTurns(messages: TavernManagerMessageRecord[] = []): TavernManagerMessageRecord[][] {
    const turns: TavernManagerMessageRecord[][] = [];
    let currentTurn: TavernManagerMessageRecord[] = [];
    (messages || []).forEach((message) => {
        if (!message || !['user', 'assistant', 'tool'].includes(message.role)) {return;}
        if (message.role === 'user' && currentTurn.length) {
            turns.push(currentTurn);
            currentTurn = [message];
            return;
        }
        currentTurn.push(message);
    });
    if (currentTurn.length) {
        turns.push(currentTurn);
    }
    return turns.filter((turn) => turn.length);
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) {return;}
    const error = new Error('manager_chat_compaction_aborted');
    error.name = 'AbortError';
    throw error;
}

async function estimateManagerChatTokens(input: {
    sessionId: string;
    agentConfig: Record<string, unknown>;
    assistantPreset?: TavernAssistantPreset;
    question: string;
    history?: TavernManagerMessageRecord[];
}): Promise<number> {
    const providerConfig = resolveActiveProviderConfig(input.agentConfig || {}, {
        role: 'delegate',
        timeoutMs: 15 * 60 * 1000,
    });
    const messages = await buildChatManagerMessages(input);
    return await resolveConversationTokens({
        messages,
        tools: getTavernManagerToolDefinitions(),
        providerConfig,
    });
}

export async function ensureTavernManagerChatBudget(input: EnsureTavernManagerChatBudgetInput): Promise<{
    compacted: boolean;
    currentTokens: number;
    history: TavernManagerMessageRecord[];
    preservedTurns?: number;
}> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {
        return { compacted: false, currentTokens: 0, history: [] };
    }
    throwIfAborted(input.signal);
    const usesProvidedHistory = Array.isArray(input.history);
    let history = usesProvidedHistory
        ? [...input.history].sort((left, right) => left.order - right.order)
        : await listTavernManagerMessages(sessionId);
    let currentTokens = await estimateManagerChatTokens({
        sessionId,
        agentConfig: input.agentConfig,
        assistantPreset: input.assistantPreset,
        question: input.question,
        history,
    });
    if (currentTokens <= TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS) {
        return { compacted: false, currentTokens, history };
    }
    input.onCompactionStart?.({
        currentTokens,
        triggerTokens: TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS,
        status: '正在释放较早管理员对话，只保留最近管理上下文...',
    });

    for (const preservedTurns of [TAVERN_MANAGER_DEFAULT_PRESERVED_TURNS, TAVERN_MANAGER_MIN_PRESERVED_TURNS]) {
        throwIfAborted(input.signal);
        const turns = splitTavernManagerMessagesIntoTurns(history);
        const archiveCount = Math.max(0, turns.length - Math.min(preservedTurns, turns.length));
        if (archiveCount > 0) {
            input.onCompactionProgress?.({
                currentTokens,
                triggerTokens: TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS,
                preservedTurns,
                status: `正在只保留最近 ${preservedTurns} 轮管理员上下文...`,
            });
            const removedOrders = turns
                .slice(0, archiveCount)
                .flat()
                .map((message) => message.order);
            if (removedOrders.length) {
                await deleteTavernManagerMessages(sessionId, removedOrders);
            }
            history = usesProvidedHistory
                ? history.filter((message) => !removedOrders.includes(message.order))
                : await listTavernManagerMessages(sessionId);
        }
        const nextTokens = await estimateManagerChatTokens({
            sessionId,
            agentConfig: input.agentConfig,
            assistantPreset: input.assistantPreset,
            question: input.question,
            history,
        });
        currentTokens = nextTokens;
        const status = nextTokens <= TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS
            ? `已只保留最近 ${preservedTurns} 轮管理员上下文。`
            : '最近管理员上下文仍然过长，继续收缩...';
        input.onCompactionProgress?.({
            currentTokens,
            yieldTokens: nextTokens,
            triggerTokens: TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS,
            preservedTurns,
            status,
        });
        if (nextTokens <= TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS) {
            input.onCompactionComplete?.({
                currentTokens,
                yieldTokens: nextTokens,
                triggerTokens: TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS,
                preservedTurns,
                status,
            });
            return { compacted: true, currentTokens: nextTokens, history, preservedTurns };
        }
    }

    input.onCompactionUnable?.({
        currentTokens,
        triggerTokens: TAVERN_MANAGER_SUMMARY_TRIGGER_TOKENS,
        status: '当前管理员这一轮上下文本身已经过长，无法继续自动收缩。',
    });
    return { compacted: false, currentTokens, history };
}

export async function runXbTavernManagerAfterTurn(input: XbTavernManagerRunInput): Promise<XbTavernManagerRunResult> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {throw new Error('manager_session_required');}
    const contractRuntime = resolveSessionContractRuntime(input.sessionContract);
    if (!contractRuntime.hasAutomaticManagerWork) {
        const skipped = input.managerRunId
            ? await updateTavernManagerRun(input.managerRunId, {
                status: 'completed',
                outputText: '契约未授权后台记忆或地图维护，本轮已跳过。',
                parsedAction: 'manager_skipped_by_contract',
                error: '',
            })
            : await createTavernManagerRun({
                sessionId,
                trigger: input.trigger || 'after_turn',
                turn: input.turn,
                userOrder: input.userMessage.order,
                assistantOrder: input.assistantMessage.order,
                status: 'completed',
                inputSummary: 'contract skipped',
                outputText: '契约未授权后台记忆或地图维护，本轮已跳过。',
                parsedAction: 'manager_skipped_by_contract',
            });
        return {
            ok: true,
            managerRun: skipped!,
            changedFiles: [],
            changedStates: [],
            changedTasks: [],
        };
    }
    const inputSummary = buildInputSummary({
        trigger: input.trigger || 'after_turn',
        turn: input.turn,
        userOrder: input.userMessage.order,
        assistantOrder: input.assistantMessage.order,
        text: input.userMessage.content,
    });
    const managerRun = input.managerRunId
        ? await updateTavernManagerRun(input.managerRunId, {
            status: 'running',
            inputSummary,
        })
        : await createTavernManagerRun({
            sessionId,
            trigger: input.trigger || 'after_turn',
            turn: input.turn,
            userOrder: input.userMessage.order,
            assistantOrder: input.assistantMessage.order,
            status: 'queued',
            inputSummary,
        });
    if (!managerRun) {
        throw new Error('manager_run_missing');
    }
    try {
        await assertManagerSourceMessagesCurrent(input);
        const messages = await buildAutoManagerMessages(input);
        const result = await runManagerTask({
            sessionId,
            agentConfig: input.agentConfig,
            trigger: input.trigger || 'after_turn',
            turn: input.turn,
            userOrder: input.userMessage.order,
            assistantOrder: input.assistantMessage.order,
            inputSummary,
            messages,
            managerRunId: managerRun.id,
            caller: 'auto',
            requireChangedFiles: false,
            beforeWriteGuard: async () => {
                throwIfManagerAborted(input.signal);
                await assertManagerSourceMessagesCurrent(input);
            },
            sessionContract: input.sessionContract,
            signal: input.signal,
            executeManagerOnce: input.executeManagerOnce,
            onProtocolEvent: input.onProtocolEvent,
        });
        if (!result.ok) {
            return {
                ok: false,
                managerRun: result.managerRun,
                error: result.error,
            };
        }
        await assertManagerSourceMessagesCurrent(input);
        if (contractRuntime.includeQuestOrchestration) {
            await abandonStaleTavernTasks(sessionId, input.assistantMessage.order, {
                managerRunId: managerRun.id,
                beforeWriteGuard: async () => {
                    throwIfManagerAborted(input.signal);
                    await assertManagerSourceMessagesCurrent(input);
                },
            });
        }
        const changedFiles = [...(result.changedFiles || [])];
        const changedTasks = [...(result.changedTasks || [])];
        const completedRun = result.managerRun;
        return {
            ok: true,
            managerRun: completedRun,
            changedFiles,
            changedStates: result.changedStates,
            changedTasks,
        };
    } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error || 'manager_failed');
        const status = managerFailureStatus(error, input.signal);
        const failed = await finalizeManagerRun(managerRun, {
            status,
            error: errorText,
        });
        const rolledBack = await rollbackManagerRunIfWroteMemory(managerRun.id);
        if (!rolledBack?.conflicts.length) {
            await rebuildTavernMemoryDerivedIndex(sessionId);
        }
        return {
            ok: false,
            managerRun: rolledBack?.managerRun || failed,
            error: errorText,
        };
    }
}

export async function runXbTavernManagerChat(input: XbTavernManagerChatInput): Promise<XbTavernManagerChatResult> {
    const sessionId = String(input.sessionId || '').trim();
    const question = String(input.question || '').trim();
    if (!sessionId) {throw new Error('manager_session_required');}
    if (!question) {throw new Error('manager_question_required');}
    const history = Array.isArray(input.history) ? input.history : await listTavernManagerMessages(sessionId);
    const messages = await buildChatManagerMessages({
        sessionId,
        question,
        assistantPreset: input.assistantPreset,
        history,
    });
    const result = await runManagerTask({
        sessionId,
        agentConfig: input.agentConfig,
        trigger: input.trigger || 'manager_chat',
        turn: Math.max(0, Number(input.turn) || 0),
        inputSummary: buildInputSummary({
            trigger: 'manager_chat',
            turn: input.turn,
            text: question,
        }),
        messages,
        caller: 'chat',
        requireChangedFiles: false,
        signal: input.signal,
        executeManagerOnce: input.executeManagerOnce,
        onStreamProgress: input.onStreamProgress,
        onProtocolEvent: input.onProtocolEvent,
    });
    return {
        ok: result.ok,
        managerRun: result.managerRun,
        text: result.text,
        provider: result.provider,
        model: result.model,
        changedFiles: result.changedFiles,
        changedStates: result.changedStates,
        changedTasks: result.changedTasks,
        protocolMessages: result.protocolMessages,
        error: result.error,
    };
}

export async function scheduleXbTavernManagerAfterTurn(input: XbTavernManagerRunInput & {
    awaitCompletion?: boolean;
    onManagerRunSaved?: (run: TavernManagerRunRecord) => void | Promise<void>;
}): Promise<XbTavernManagerScheduleResult> {
    const queued = await createTavernManagerRun({
        sessionId: input.sessionId,
        turn: input.turn,
        userOrder: input.userMessage.order,
        assistantOrder: input.assistantMessage.order,
        trigger: input.trigger || 'after_turn',
        status: 'queued',
        inputSummary: buildInputSummary({
            trigger: input.trigger || 'after_turn',
            turn: input.turn,
            userOrder: input.userMessage.order,
            assistantOrder: input.assistantMessage.order,
            text: input.userMessage.content,
        }),
    });
    await input.onManagerRunSaved?.(queued);
    const controller = new AbortController();
    const abortFromInput = () => controller.abort();
    if (input.signal?.aborted) {
        controller.abort();
    } else {
        input.signal?.addEventListener('abort', abortFromInput, { once: true });
    }
    activeAutoManagerRuns.set(queued.id, {
        controller,
        sessionId: input.sessionId,
        userOrder: input.userMessage.order,
        assistantOrder: input.assistantMessage.order,
    });
    const previous = managerQueues.get(input.sessionId) || Promise.resolve();
    const completion = previous
        .catch(() => {})
        .then(async () => {
            throwIfManagerAborted(controller.signal);
            const result = await runXbTavernManagerAfterTurn({
                ...input,
                managerRunId: queued.id,
                signal: controller.signal,
            });
            await input.onManagerRunSaved?.(result.managerRun);
            return result;
        })
        .catch(async (error) => {
            const errorText = error instanceof Error ? error.message : String(error || 'manager_failed');
            const failed = await updateTavernManagerRun(queued.id, {
                status: managerFailureStatus(error, input.signal),
                error: errorText,
            }) || queued;
            await input.onManagerRunSaved?.(failed);
            return {
                ok: false,
                managerRun: failed,
                error: errorText,
            };
        });
    managerQueues.set(input.sessionId, completion);
    completion.finally(() => {
        input.signal?.removeEventListener('abort', abortFromInput);
        activeAutoManagerRuns.delete(queued.id);
        if (managerQueues.get(input.sessionId) === completion) {
            managerQueues.delete(input.sessionId);
        }
    });
    const completedResult = input.awaitCompletion ? await completion : null;
    return {
        managerRunId: queued.id,
        managerStatus: completedResult?.managerRun?.status || queued.status,
        completion,
    };
}

export async function settleTavernManagersForSession(sessionId = '', timeoutMs = 8000): Promise<{
    settled: boolean;
    timedOut: boolean;
}> {
    const id = String(sessionId || '').trim();
    if (!id) {return { settled: true, timedOut: false };}
    const queue = managerQueues.get(id);
    if (!queue) {return { settled: true, timedOut: false };}
    const timeout = Math.max(1, Number(timeoutMs) || 8000);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout);
    });
    const result = await Promise.race([
        queue.then(() => 'settled' as const).catch(() => 'settled' as const),
        timeoutPromise,
    ]);
    if (timer) {clearTimeout(timer);}
    return {
        settled: result === 'settled',
        timedOut: result === 'timeout',
    };
}

export async function cancelAndRollbackXbTavernManagersForMessageRange(sessionId = '', fromOrder = 0): Promise<{
    runIds: string[];
    rolledBack: number;
    conflicts: string[];
    skipped: number;
}> {
    const id = String(sessionId || '').trim();
    const order = Number(fromOrder);
    if (!id || !Number.isFinite(order)) {
        return { runIds: [], rolledBack: 0, conflicts: [], skipped: 0 };
    }
    activeAutoManagerRuns.forEach((run) => {
        if (run.sessionId !== id) {return;}
        if (run.userOrder >= order || run.assistantOrder >= order) {
            run.controller.abort();
        }
    });
    const memory = await rollbackManagerRunsForMessageRange(id, order);
    let taskRolledBack = 0;
    let taskSkipped = 0;
    const taskConflicts: string[] = [];
    for (const runId of memory.runIds) {
        const taskSnapshots = await listTavernManagerTaskSnapshots(runId);
        if (!taskSnapshots.some((snapshot) => String(snapshot.afterHash || '').trim())) {continue;}
        const result = await rollbackManagerRunTaskWrites(runId);
        taskRolledBack += result.rolledBack;
        taskSkipped += result.skipped;
        taskConflicts.push(...result.conflicts);
    }
    return {
        runIds: [...new Set([...memory.runIds])],
        rolledBack: memory.rolledBack + taskRolledBack,
        conflicts: [...memory.conflicts, ...taskConflicts],
        skipped: memory.skipped + taskSkipped,
    };
}
