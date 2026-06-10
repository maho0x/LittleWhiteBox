import { createAgentAdapter, resolveActiveProviderConfig } from '../../../agent-core/provider-config.js';
import * as contextTokens from '../../../agent-core/runtime/context-tokens.js';
import {
    buildProviderAssistantToolCallMessage,
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
    buildTurnMemoryPath,
    type TavernMemoryToolResult,
} from '../../shared/memory-files';
import {
    createTavernManagerRun,
    deleteTavernManagerMessages,
    listTavernManagerMemorySnapshots,
    listTavernManagerStateSnapshots,
    listTavernManagerMessages,
    listTavernMessages,
    rollbackManagerRunMemoryWrites,
    rollbackManagerRunStateWrites,
    rollbackManagerRunsForMessageRange,
    rollbackManagerStateRunsForMessageRange,
    touchRunningTavernManagerRun,
    updateTavernManagerRun,
    type TavernEpisodeSummaryRecord,
    type TavernManagerMessageRecord,
    type TavernManagerRunRecord,
    type TavernMessageRecord,
    type TavernTurnSummaryRecord,
} from '../../shared/session-db';
import { executeTavernStateTool, TAVERN_STATE_TOOL_NAMES, type TavernStateToolResult } from '../../shared/structured-state';
import { getXbTavernProviderLabel } from './provider';

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

export interface XbTavernManagerOnceOptions {
    agentConfig: Record<string, unknown>;
    messages?: XbTavernMessage[];
    tools?: unknown[];
    toolChoice?: 'auto' | 'none' | string;
    toolResponses?: Array<{ id?: string; name?: string; response?: unknown }>;
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
    recentTurnSummaries?: TavernTurnSummaryRecord[];
    recentEpisodeSummaries?: TavernEpisodeSummaryRecord[];
    assistantPreset?: TavernAssistantPreset;
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
}

export interface XbTavernManagerRunResult {
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    turnSummary?: TavernTurnSummaryRecord;
    episodeSummary?: TavernEpisodeSummaryRecord;
    changedFiles?: string[];
    changedStates?: string[];
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
}

export interface XbTavernManagerChatResult {
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    text: string;
    provider: string;
    model: string;
    changedFiles: string[];
    changedStates: string[];
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
const MAX_MANAGER_TOOL_ROUNDS = 8;

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

function buildManagerSystemPrompt(assistantPreset: TavernAssistantPreset | undefined): string {
    return buildTavernManagerSystemPrompt(assistantPreset).trim();
}

function selectActiveEpisodeBlock(memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>): string {
    const activeEpisode = memoryFiles
        .filter((file) => file.status !== 'stale' && file.path.startsWith('memory/episodes/'))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!activeEpisode) {return '';}
    return ['[active_episode]', activeEpisode.path, activeEpisode.content].join('\n');
}

function buildResidentMemoryBlock(memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>): string {
    const sessionFile = memoryFiles.find((file) => file.path === 'memory/session.md');
    const stateFile = memoryFiles.find((file) => file.path === 'memory/state.md');
    const inboxFile = memoryFiles.find((file) => file.path === 'memory/inbox.md');
    const blocks = [
        sessionFile ? ['[memory/session.md]', sessionFile.content].join('\n') : '',
        stateFile ? ['[memory/state.md]', stateFile.content].join('\n') : '',
        selectActiveEpisodeBlock(memoryFiles),
        inboxFile ? ['[memory/inbox.md]', inboxFile.content].join('\n') : '',
    ].filter(Boolean);
    return ['[常驻记忆档案]', ...blocks].join('\n\n');
}

function buildAutoManagerUserPrompt(input: {
    turn: number;
    turnMemoryPath: string;
    userMessage: TavernMessageRecord;
    assistantMessage: TavernMessageRecord;
    memoryFiles: Array<{ path: string; status: string; updatedAt: number; content: string }>;
}): string {
    return [
        buildResidentMemoryBlock(input.memoryFiles),
        '',
        '[本轮 RP 原文]',
        `建议流水路径：${input.turnMemoryPath}`,
        '',
        '[用户消息]',
        input.userMessage.content,
        '',
        '[角色回复]',
        input.assistantMessage.content,
        '',
        '[本轮要求]',
        '1. 先按需读取相关记忆文件，再维护本轮记忆。',
        '2. 如需记录本轮流水，优先写入上面的建议路径；正文写法由助手预设决定，不需要固定标题。',
        '3. 必要时同步更新 session/state/episode/inbox 和结构化状态。',
        '4. 最终只用自然语言简短交代结果。',
    ].join('\n');
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

function resolveTurnMemoryPath(input: Pick<XbTavernManagerRunInput, 'userMessage' | 'assistantMessage'>): string {
    return buildTurnMemoryPath(
        input.userMessage.order,
        Number(input.assistantMessage.createdAt) || Number(input.userMessage.createdAt) || Date.now(),
    );
}

async function runManagerOnceWithAdapter(
    adapter: { chat: (task: Record<string, unknown>) => Promise<Record<string, unknown>> },
    providerConfig: Record<string, unknown>,
    options: XbTavernManagerOnceOptions,
): Promise<XbTavernManagerOnceResult> {
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const task: Record<string, unknown> = {
        systemPrompt: messages[0]?.content || '',
        messages,
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
    if (Array.isArray(options.toolResponses) && options.toolResponses.length) {
        task.toolResponses = options.toolResponses;
    }
    if (String(options.finalAnswerReminderText || '').trim()) {
        task.finalAnswerReminderText = String(options.finalAnswerReminderText || '').trim();
    }
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

function summarizeToolResult(result: TavernMemoryToolResult | TavernStateToolResult): string {
    return normalizeText(result.summary || result.error || '', 240);
}

function isStateToolName(name = ''): boolean {
    return Object.values(TAVERN_STATE_TOOL_NAMES).includes(name as typeof TAVERN_STATE_TOOL_NAMES[keyof typeof TAVERN_STATE_TOOL_NAMES]);
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
    const snapshots = await listTavernManagerMemorySnapshots(managerRunId);
    const stateSnapshots = await listTavernManagerStateSnapshots(managerRunId);
    if (!snapshots.some((snapshot) => String(snapshot.afterHash || '').trim())
        && !stateSnapshots.some((snapshot) => String(snapshot.afterHash || '').trim())) {
        return null;
    }
    const memoryResult = await rollbackManagerRunMemoryWrites(managerRunId);
    const stateResult = await rollbackManagerRunStateWrites(managerRunId);
    return {
        managerRun: await updateTavernManagerRun(managerRunId, {}),
        conflicts: [...memoryResult.conflicts, ...stateResult.conflicts],
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
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
}): Promise<{
    text: string;
    provider: string;
    model: string;
    toolTrace: Array<Record<string, unknown>>;
    changedFiles: string[];
    changedStates: string[];
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
    const tools = getTavernManagerToolDefinitions();
    const toolTrace: Array<Record<string, unknown>> = [];
    const protocolMessages: XbTavernMessage[] = [];
    const changedFiles = new Set<string>();
    const changedStates = new Set<string>();
    let finalText = '';
    let resultProvider = '';
    let resultModel = '';
    let reminded = false;
    let pendingToolResponses: Array<{ id?: string; name?: string; response?: unknown }> | null = null;
    let pendingFinalAnswerReminderText = '';

    for (let round = 1; round <= MAX_MANAGER_TOOL_ROUNDS; round += 1) {
        throwIfManagerAborted(input.signal);
        let streamText = '';
        let streamThoughts: Array<{ label?: string; text?: string }> = [];
        const result = await executeManagerOnce({
            agentConfig: input.agentConfig,
            messages: input.messages,
            tools,
            toolChoice: 'auto',
            ...(supportsSessionToolLoop && Array.isArray(pendingToolResponses) && pendingToolResponses.length
                ? { toolResponses: pendingToolResponses }
                : {}),
            ...(supportsSessionToolLoop && pendingFinalAnswerReminderText
                ? { finalAnswerReminderText: pendingFinalAnswerReminderText }
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
        finalText = String(result.text || streamText || '').trim();
        resultProvider = String(result.provider || resultProvider || providerConfig.provider || '');
        resultModel = String(result.model || resultModel || providerConfig.model || '');
        const resultRecord = result as unknown as Record<string, unknown>;
        const resultThoughts = normalizeManagerThoughtBlocks(result.thoughts?.length ? result.thoughts : streamThoughts);
        const toolCalls = resolveResultToolCalls(resultRecord, providerConfig, {
            fallbackPrefix: 'tavern-manager-tool',
        });
        if (!toolCalls.length) {
            if (!hasVisibleText(finalText) && toolTrace.length && !reminded) {
                reminded = true;
                const reminder = '你已经拿到了工具结果。现在不要继续调用工具，直接简短说明本轮处理结论。';
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
            return {
                text: finalText,
                provider: resultProvider,
                model: resultModel,
                toolTrace,
                changedFiles: [...changedFiles],
                changedStates: [...changedStates],
                protocolMessages: [
                    ...protocolMessages,
                    {
                        role: 'assistant',
                        content: finalText,
                        thoughts: resultThoughts,
                        providerPayload: result.providerPayload,
                    },
                ],
            };
        }

        const assistantToolMessage = buildProviderAssistantToolCallMessage(resultRecord, toolCalls, {
            fallbackPrefix: 'tavern-manager-tool',
        }) as unknown as XbTavernMessage;
        assistantToolMessage.thoughts = resultThoughts;
        input.messages.push(assistantToolMessage);
        protocolMessages.push(assistantToolMessage);

        const toolResponses: Array<{ id?: string; name?: string; response?: unknown }> = [];
        for (const toolCall of toolCalls) {
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
                preface: finalText,
                thoughts: resultThoughts,
                startedAt: Date.now(),
            };
            toolTrace.push(traceEntry);
            await persistRunningManagerToolTrace(input.managerRunId, toolTrace);
            const toolResult = isStateToolName(toolCall.name)
                ? await executeTavernStateTool(input.sessionId, toolCall.name, args, {
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
            if (toolResult.changed && resultPath) {
                changedFiles.add(resultPath);
            }
            if (toolResult.changed && resultStateKey) {
                changedStates.add(resultStateKey);
            }
            Object.assign(traceEntry, {
                status: 'resolved',
                ok: toolResult.ok,
                args: summarizeToolArguments(args),
                path: resultPath || resultStateKey,
                summary: summarizeToolResult(toolResult),
                error: toolResult.error || '',
                finishedAt: Date.now(),
            });
            if (Number(traceEntry.startedAt)) {
                traceEntry.elapsedMs = Math.max(0, Number(traceEntry.finishedAt) - Number(traceEntry.startedAt));
            }
            await persistRunningManagerToolTrace(input.managerRunId, toolTrace);
            const toolMessage: XbTavernMessage = {
                role: 'tool',
                tool_call_id: toolCall.id,
                toolName: toolCall.name,
                content: safeJson(toolResult),
            };
            input.messages.push(toolMessage);
            protocolMessages.push(toolMessage);
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

    throw new Error('manager_tool_round_limit');
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
    await ensureTavernMemoryDefaults(input.sessionId);
    const memoryFiles = await listTavernMemoryFiles(input.sessionId, { includeStale: true });
    const turnMemoryPath = resolveTurnMemoryPath(input);
    return [
        { role: 'system', content: buildManagerSystemPrompt(input.assistantPreset) },
        {
            role: 'user',
            content: buildAutoManagerUserPrompt({
                turn: input.turn,
                turnMemoryPath,
                userMessage: input.userMessage,
                assistantMessage: input.assistantMessage,
                memoryFiles,
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
    signal?: AbortSignal;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
    onStreamProgress?: (snapshot: TavernManagerStreamSnapshot) => void;
    userOrder?: number;
    assistantOrder?: number;
}): Promise<{
    ok: boolean;
    managerRun: TavernManagerRunRecord;
    text: string;
    provider: string;
    model: string;
    toolTrace: Array<Record<string, unknown>>;
    changedFiles: string[];
    changedStates: string[];
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
            signal: input.signal,
            executeManagerOnce: input.executeManagerOnce,
            onStreamProgress: input.onStreamProgress,
        });
        resultText = result.text;
        resultProvider = result.provider || resultProvider;
        resultModel = result.model || resultModel;
        toolTrace = result.toolTrace;
        changedFiles = result.changedFiles;
        changedStates = result.changedStates;
        protocolMessages = result.protocolMessages;
        if (input.caller !== 'auto' && hasFailedTool(toolTrace)) {
            throw new Error('manager_memory_tool_failed');
        }
        if (input.requireChangedFiles && !changedFiles.length) {
            throw new Error('manager_memory_tool_required');
        }
        await rebuildTavernMemoryDerivedIndex(input.sessionId);
        const completed = await finalizeManagerRun(managerRun, {
            status: 'completed',
            provider: resultProvider,
            model: resultModel,
            outputText: resultText || (changedFiles.length || changedStates.length ? `已维护 ${changedFiles.length} 个记忆文件、${changedStates.length} 份结构化状态。` : '已检查并回复。'),
            parsedAction: changedFiles.length || changedStates.length ? 'manager_state_updated' : 'memory_checked',
            toolTrace,
            changedFiles,
            changedStates,
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
            signal: input.signal,
            executeManagerOnce: input.executeManagerOnce,
        });
        if (!result.ok) {
            return {
                ok: false,
                managerRun: result.managerRun,
                error: result.error,
            };
        }
        await assertManagerSourceMessagesCurrent(input);
        const changedFiles = [...(result.changedFiles || [])];
        const completedRun = result.managerRun;
        return {
            ok: true,
            managerRun: completedRun,
            changedFiles,
            changedStates: result.changedStates,
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
    });
    return {
        ok: result.ok,
        managerRun: result.managerRun,
        text: result.text,
        provider: result.provider,
        model: result.model,
        changedFiles: result.changedFiles,
        changedStates: result.changedStates,
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
    const state = await rollbackManagerStateRunsForMessageRange(id, order);
    return {
        runIds: [...new Set([...memory.runIds, ...state.runIds])],
        rolledBack: memory.rolledBack + state.rolledBack,
        conflicts: [...memory.conflicts, ...state.conflicts],
        skipped: memory.skipped + state.skipped,
    };
}
