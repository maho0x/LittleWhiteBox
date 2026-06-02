import { createAgentAdapter } from '../../../agent-core/provider-config.js';
import {
    type XbTavernBuildSnapshot,
    type XbTavernContext,
    type XbTavernMessage,
    type XbTavernMessageBuildResult,
    type XbTavernPreset,
    type XbTavernRuntimeState,
} from '../../shared/message-assembler';
import {
    appendTavernMessage,
    createTavernSession,
    deleteTavernMessages,
    getTavernSession,
    listTavernMessages,
    markTavernMemoryStaleFromOrder,
    mergeWorldEntryStates,
    normalizeTavernSessionState,
    replaceTavernSessionState,
    updateTavernSessionState,
    updateTavernSessionSnapshot,
    type TavernMessageRecord,
    type TavernSessionRecord,
    type TavernSessionState,
} from '../../shared/session-db';
import { buildXbTavernBrain } from '../../shared/brain';
import {
    buildXbTavernMemoryIgnoredTerms,
    buildXbTavernMemoryQuery,
    retrieveXbTavernMemoryContext,
} from '../../shared/memory-retrieval';
import { createXbTavernAgentRuntime } from './agent-runtime';
import {
    scheduleXbTavernManagerAfterTurn,
    type XbTavernManagerOnceOptions,
    type XbTavernManagerOnceResult,
} from './manager';
import { assertXbTavernProviderReady, resolveXbTavernProviderConfig } from './provider';

export interface TavernRunOnceOptions {
    agentConfig: Record<string, unknown>;
    messages: XbTavernMessage[];
    signal?: AbortSignal;
    onStreamProgress?: (snapshot: { text?: string; thoughts?: Array<{ label?: string; text?: string }> }) => void;
}

export interface TavernRequestInspection {
    provider?: string;
    model?: string;
    transport?: string;
    request?: unknown;
    [key: string]: unknown;
}

export interface TavernRequestSnapshot {
    presetName: string;
    provider: string;
    providerLabel: string;
    model: string;
    toolMode: string;
    messageCount: number;
    messageChars: number;
    rawMessagesJson: string;
    rawRequestJson: string;
    requestKind: 'actual' | 'simulated' | 'fallback';
    capturedAt: number;
    requestInspection?: TavernRequestInspection;
}

export interface TavernRunOnceResult {
    text: string;
    thoughts?: Array<{ label?: string; text?: string }>;
    model?: string;
    provider?: string;
    finishReason?: string;
    providerPayload?: unknown;
    requestSnapshot: TavernRequestSnapshot;
}

export interface TavernDiagnostics {
    ok?: boolean;
    message?: string;
    worldbookErrors?: Array<{ name: string; error: string }>;
}

export interface XbTavernRunTurnInput {
    sessionId?: string;
    agentConfig: Record<string, unknown>;
    contextSnapshot: XbTavernContext;
    preset: XbTavernPreset;
    currentUserMessage: string;
    runtimeState?: TavernSessionState;
    diagnostics?: TavernDiagnostics;
    historyMode?: XbTavernRuntimeState['historyMode'];
    signal?: AbortSignal;
    onStreamProgress?: (snapshot: { text?: string; thoughts?: Array<{ label?: string; text?: string }> }) => void;
    onUserMessageSaved?: (sessionId: string, message: TavernMessageRecord) => void | Promise<void>;
    onAssistantMessageSaved?: (sessionId: string, message: TavernMessageRecord) => void | Promise<void>;
    onManagerRunSaved?: (sessionId: string, managerRunId: string) => void | Promise<void>;
    reuseUserMessageOrder?: number;
    awaitManager?: boolean;
    runManager?: boolean;
    executeRunOnce?: (options: TavernRunOnceOptions) => Promise<TavernRunOnceResult>;
    executeManagerOnce?: (options: XbTavernManagerOnceOptions) => Promise<XbTavernManagerOnceResult>;
}

export interface XbTavernRunResult {
    sessionId: string;
    userMessage: TavernMessageRecord;
    assistantMessage?: TavernMessageRecord;
    errorMessage?: TavernMessageRecord;
    buildResult: XbTavernMessageBuildResult;
    buildSnapshot: XbTavernBuildSnapshot;
    requestSnapshot: TavernRequestSnapshot;
    provider: string;
    model: string;
    finishReason?: string;
    previewMatchesRequest: boolean;
    nextTurn: number;
    managerRunId?: string;
    managerStatus?: string;
    error?: string;
}

export interface XbTavernSimulateRequestInput {
    sessionId?: string;
    agentConfig: Record<string, unknown>;
    contextSnapshot: XbTavernContext;
    preset: XbTavernPreset;
    currentUserMessage: string;
    runtimeState?: TavernSessionState;
    diagnostics?: TavernDiagnostics;
    historyMode?: XbTavernRuntimeState['historyMode'];
}

export interface XbTavernSimulateRequestResult {
    buildResult: XbTavernMessageBuildResult;
    buildSnapshot: XbTavernBuildSnapshot;
    requestSnapshot: TavernRequestSnapshot;
    provider: string;
    model: string;
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {return true;}
    if (!error || typeof error !== 'object') {return false;}
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    const name = String(record.name || '');
    const code = String(record.code || '');
    const message = String(record.message || '');
    return name === 'AbortError'
        || code === 'ABORT_ERR'
        || /abort|aborted|cancelled|canceled/i.test(message);
}

async function notifyRunCallback(callback: (() => void | Promise<void>) | undefined): Promise<void> {
    if (!callback) {return;}
    try {
        await callback();
    } catch (error) {
        console.warn('[小白酒馆] run callback failed', error);
    }
}

async function persistRunSessionState(
    sessionId: string,
    state: Partial<TavernSessionState>,
    options: { replace?: boolean } = {},
): Promise<TavernSessionRecord | null> {
    return options.replace
        ? await replaceTavernSessionState(sessionId, state)
        : await updateTavernSessionState(sessionId, state);
}

export function buildTavernRequestSnapshot(
    agentConfig: Record<string, unknown> = {},
    messages: XbTavernMessage[] = [],
    override: Partial<Pick<TavernRequestSnapshot, 'provider' | 'model' | 'requestKind'>> & {
        requestInspection?: TavernRequestInspection | null;
    } = {},
): TavernRequestSnapshot {
    const providerConfig = resolveXbTavernProviderConfig(agentConfig);
    const requestInspection = override.requestInspection || null;
    const rawMessagesJson = JSON.stringify(messages, null, 2);
    const requestForJson = requestInspection || {
        provider: String(override.provider || providerConfig.provider || ''),
        model: String(override.model || providerConfig.model || ''),
        transport: 'unavailable',
        request: {
            messages,
        },
    };
    return {
        presetName: providerConfig.currentPresetName,
        provider: String(override.provider || providerConfig.provider || ''),
        providerLabel: providerConfig.providerLabel,
        model: String(override.model || providerConfig.model || ''),
        toolMode: providerConfig.toolMode,
        messageCount: messages.length,
        messageChars: messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
        rawMessagesJson,
        rawRequestJson: JSON.stringify(requestForJson, null, 2),
        requestKind: override.requestKind || 'actual',
        capturedAt: Date.now(),
        ...(requestInspection ? { requestInspection } : {}),
    };
}

async function inspectTavernRequest(input: {
    agentConfig: Record<string, unknown>;
    messages: XbTavernMessage[];
    signal?: AbortSignal;
    onStreamProgress?: TavernRunOnceOptions['onStreamProgress'];
    requestKind?: TavernRequestSnapshot['requestKind'];
}): Promise<{
    task: ReturnType<ReturnType<typeof createXbTavernAgentRuntime>['buildChatTask']>;
    adapter: { chat: (task: unknown) => Promise<Record<string, unknown>>; inspectRequest?: (task: unknown) => Promise<TavernRequestInspection> | TavernRequestInspection };
    providerConfig: ReturnType<typeof assertXbTavernProviderReady>;
    requestSnapshot: TavernRequestSnapshot;
}> {
    const providerConfig = assertXbTavernProviderReady(input.agentConfig);
    const runtime = createXbTavernAgentRuntime(providerConfig);
    const adapter = createAgentAdapter(providerConfig as unknown as Record<string, unknown>, {
        missingApiKeyMessage: '请先在 API 配置里选择模型/填写 Key。',
    }) as {
        chat: (task: unknown) => Promise<Record<string, unknown>>;
        inspectRequest?: (task: unknown) => Promise<TavernRequestInspection> | TavernRequestInspection;
    };
    const task = runtime.buildChatTask({
        messages: input.messages,
        signal: input.signal,
        onStreamProgress: input.onStreamProgress,
    });
    const requestInspection = typeof adapter.inspectRequest === 'function'
        ? await adapter.inspectRequest(task)
        : null;
    return {
        task,
        adapter,
        providerConfig,
        requestSnapshot: buildTavernRequestSnapshot(input.agentConfig, input.messages, {
            provider: String(requestInspection?.provider || providerConfig.provider || ''),
            model: String(requestInspection?.model || providerConfig.model || ''),
            requestInspection,
            requestKind: input.requestKind || 'actual',
        }),
    };
}

export function buildContextHistory(messages: TavernMessageRecord[] = []): XbTavernMessage[] {
    return messages
        .filter((message) => !message.error)
        .map((message) => ({
            role: ['system', 'user', 'assistant', 'tool'].includes(message.role)
                ? message.role as XbTavernMessage['role']
                : 'assistant',
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
        }));
}

function findCompletedAssistantForUser(messages: TavernMessageRecord[] = [], userIndex = -1): TavernMessageRecord | null {
    if (userIndex < 0) {return null;}
    for (let index = userIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === 'user') {break;}
        if (message.role === 'assistant' && !message.error && String(message.content || '').trim()) {
            return message;
        }
    }
    return null;
}

export function deriveTavernSessionStateFromMessages(input: {
    messages?: TavernMessageRecord[];
    contextSnapshot?: XbTavernContext;
    preset: XbTavernPreset;
    historyMode?: XbTavernRuntimeState['historyMode'];
    diagnostics?: TavernDiagnostics;
}): TavernSessionState {
    const sorted = [...(input.messages || [])].sort((left, right) => left.order - right.order);
    const contextSnapshot = input.contextSnapshot || {};
    const priorMessages: TavernMessageRecord[] = [];
    let turn = 0;
    let worldEntryStates: NonNullable<TavernSessionState['worldEntryStates']> = {};
    let lastBuildSnapshot: XbTavernBuildSnapshot | undefined;
    let lastRequestSnapshot: unknown;
    let lastProvider = '';
    let lastModel = '';

    sorted.forEach((message, index) => {
        if (message.role !== 'user' || message.error || !String(message.content || '').trim()) {
            priorMessages.push(message);
            return;
        }
        const assistant = findCompletedAssistantForUser(sorted, index);
        if (assistant) {
            const brain = buildXbTavernBrain({
                context: {
                    ...contextSnapshot,
                    history: buildContextHistory(priorMessages),
                },
                preset: input.preset,
                currentUserMessage: message.content,
                historyMode: input.historyMode || 'squash',
                turn,
                entryStates: worldEntryStates,
                diagnostics: input.diagnostics || {},
            });
            worldEntryStates = mergeWorldEntryStates(
                worldEntryStates,
                brain.buildResult.meta.worldEntryStateUpdates,
            );
            turn += 1;
            lastBuildSnapshot = brain.buildSnapshot;
            lastRequestSnapshot = assistant.requestSnapshot || message.requestSnapshot;
            lastProvider = String(assistant.provider || '');
            lastModel = String(assistant.model || '');
        }
        priorMessages.push(message);
    });

    const lastMessage = sorted[sorted.length - 1];
    return {
        turn,
        worldEntryStates,
        lastBuildSnapshot,
        lastRequestSnapshot,
        lastProvider,
        lastModel,
        lastError: lastMessage?.error ? String(lastMessage.content || '') : '',
    };
}

async function ensureRunSession(input: XbTavernRunTurnInput, buildSnapshot?: XbTavernBuildSnapshot): Promise<TavernSessionRecord> {
    const existing = await getTavernSession(input.sessionId || '');
    if (existing) {return existing;}
    const contextSnapshot = input.contextSnapshot || {};
    const character = contextSnapshot.character || {};
    return await createTavernSession({
        title: String(character.name || '未选择角色'),
        characterId: String(character.id || ''),
        characterName: String(character.name || '未选择角色'),
        contextSnapshot,
        buildSnapshot,
        presetId: String(input.preset.id || ''),
        presetName: String(input.preset.name || ''),
        state: {
            turn: 0,
            worldEntryStates: {},
        },
    });
}

export async function runTavernOnce(options: TavernRunOnceOptions): Promise<TavernRunOnceResult> {
    const inspected = await inspectTavernRequest({
        agentConfig: options.agentConfig,
        messages: options.messages,
        signal: options.signal,
        onStreamProgress: options.onStreamProgress,
        requestKind: 'actual',
    });
    let result: Record<string, unknown>;
    try {
        result = await inspected.adapter.chat(inspected.task);
    } catch (error) {
        const requestInspection = (error as { requestInspection?: TavernRequestInspection } | null)?.requestInspection;
        if (requestInspection && error && typeof error === 'object') {
            (error as { requestSnapshot?: TavernRequestSnapshot }).requestSnapshot = buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                provider: String(requestInspection.provider || inspected.providerConfig.provider || ''),
                model: String(requestInspection.model || inspected.providerConfig.model || ''),
                requestInspection,
                requestKind: 'actual',
            });
        }
        throw error;
    }
    const finalInspection = (result?.requestInspection || inspected.requestSnapshot.requestInspection || null) as TavernRequestInspection | null;
    const text = String(result?.text || '');
    const provider = String(result?.provider || finalInspection?.provider || inspected.providerConfig.provider || '');
    const model = String(result?.model || finalInspection?.model || inspected.providerConfig.model || '');
    return {
        text,
        thoughts: result?.thoughts as Array<{ label?: string; text?: string }> | undefined,
        model,
        provider,
        finishReason: result?.finishReason as string | undefined,
        providerPayload: result?.providerPayload,
        requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
            provider,
            model,
            requestInspection: finalInspection,
            requestKind: 'actual',
        }),
    };
}

export async function simulateXbTavernRequest(input: XbTavernSimulateRequestInput): Promise<XbTavernSimulateRequestResult> {
    const session = input.sessionId ? await getTavernSession(input.sessionId) : null;
    const sessionMessages = session ? await listTavernMessages(session.id) : [];
    const lockedContext = session?.contextSnapshot || input.contextSnapshot || {};
    const sessionState = normalizeTavernSessionState(session?.state || input.runtimeState || {});
    const contextForBuild: XbTavernContext = {
        ...lockedContext,
        history: session ? buildContextHistory(sessionMessages) : (input.contextSnapshot.history || []),
    };
    const memoryQuery = buildXbTavernMemoryQuery(contextForBuild, input.currentUserMessage);
    const brain = buildXbTavernBrain({
        context: contextForBuild,
        preset: input.preset,
        currentUserMessage: input.currentUserMessage,
        historyMode: input.historyMode || 'squash',
        turn: sessionState.turn,
        entryStates: sessionState.worldEntryStates,
        memoryContext: session
            ? await retrieveXbTavernMemoryContext({
                sessionId: session.id,
                queryText: memoryQuery,
                ignoredTerms: buildXbTavernMemoryIgnoredTerms(contextForBuild),
            })
            : undefined,
        diagnostics: input.diagnostics || {},
    });
    const inspected = await inspectTavernRequest({
        agentConfig: input.agentConfig,
        messages: brain.buildResult.messages,
        onStreamProgress: () => {},
        requestKind: 'simulated',
    });
    const provider = inspected.requestSnapshot.provider;
    const model = inspected.requestSnapshot.model;
    return {
        buildResult: brain.buildResult,
        buildSnapshot: brain.buildSnapshot,
        requestSnapshot: inspected.requestSnapshot,
        provider,
        model,
    };
}

export async function runXbTavernTurn(input: XbTavernRunTurnInput): Promise<XbTavernRunResult> {
    const baseSession = await ensureRunSession(input);
    let sessionMessages = await listTavernMessages(baseSession.id);
    const lockedContext = baseSession.contextSnapshot || input.contextSnapshot || {};
    const reusedOrder = Number(input.reuseUserMessageOrder);
    const reusedUserMessage = Number.isInteger(reusedOrder) && reusedOrder >= 0
        ? sessionMessages.find((message) => message.order === reusedOrder && message.role === 'user' && !message.error) || null
        : null;
    if (reusedUserMessage) {
        await markTavernMemoryStaleFromOrder(baseSession.id, reusedUserMessage.order);
        await deleteTavernMessages(
            baseSession.id,
            sessionMessages
                .filter((message) => message.order > reusedUserMessage.order)
                .map((message) => message.order),
        );
        sessionMessages = await listTavernMessages(baseSession.id);
    }
    const historyMessages = reusedUserMessage
        ? sessionMessages.filter((message) => message.order < reusedUserMessage.order)
        : sessionMessages;
    const sessionState = reusedUserMessage
        ? normalizeTavernSessionState(deriveTavernSessionStateFromMessages({
            messages: historyMessages,
            contextSnapshot: lockedContext,
            preset: input.preset,
            historyMode: input.historyMode || 'squash',
            diagnostics: input.diagnostics,
        }))
        : normalizeTavernSessionState(baseSession.state || input.runtimeState || {});
    const shouldReplaceSessionState = !!reusedUserMessage;
    const currentUserMessage = reusedUserMessage?.content || input.currentUserMessage;
    const contextForBuild: XbTavernContext = {
        ...lockedContext,
        history: buildContextHistory(historyMessages),
    };
    const memoryQuery = buildXbTavernMemoryQuery(contextForBuild, currentUserMessage);
    const brain = buildXbTavernBrain({
        context: contextForBuild,
        preset: input.preset,
        currentUserMessage,
        historyMode: input.historyMode || 'squash',
        turn: sessionState.turn,
        entryStates: sessionState.worldEntryStates,
        memoryContext: await retrieveXbTavernMemoryContext({
            sessionId: baseSession.id,
            queryText: memoryQuery,
            ignoredTerms: buildXbTavernMemoryIgnoredTerms(contextForBuild),
        }),
        diagnostics: input.diagnostics || {},
    });
    const { buildResult, buildSnapshot } = brain;
    const session = baseSession.buildSnapshot
        ? baseSession
        : await updateTavernSessionSnapshot(baseSession.id, {
            contextSnapshot: lockedContext,
            buildSnapshot,
            presetId: String(input.preset.id || baseSession.presetId || ''),
            presetName: String(input.preset.name || baseSession.presetName || ''),
        }) || baseSession;

    let latestStreamText = '';
    const handleStreamProgress = (snapshot: { text?: string; thoughts?: Array<{ label?: string; text?: string }> }) => {
        if (typeof snapshot.text === 'string') {latestStreamText = snapshot.text;}
        input.onStreamProgress?.(snapshot);
    };

    let requestSnapshot = buildTavernRequestSnapshot(input.agentConfig, buildResult.messages);
    try {
        requestSnapshot = (await inspectTavernRequest({
            agentConfig: input.agentConfig,
            messages: buildResult.messages,
            onStreamProgress: handleStreamProgress,
            requestKind: 'actual',
        })).requestSnapshot;
    } catch {
        requestSnapshot = buildTavernRequestSnapshot(input.agentConfig, buildResult.messages, {
            requestKind: 'fallback',
        });
    }
    const presetId = String(input.preset.id || session.presetId || '');
    const presetName = String(input.preset.name || session.presetName || '');
    const userMessage = reusedUserMessage || await appendTavernMessage(session.id, {
            role: 'user',
            content: currentUserMessage,
            contextSnapshot: lockedContext,
            buildSnapshot,
            presetId,
            presetName,
            requestSnapshot,
    });
    await notifyRunCallback(() => input.onUserMessageSaved?.(session.id, userMessage));

    try {
        const executeRunOnce = input.executeRunOnce || runTavernOnce;
        const result = await executeRunOnce({
            agentConfig: input.agentConfig,
            messages: buildResult.messages,
            signal: input.signal,
            onStreamProgress: handleStreamProgress,
        });
        const assistantMessage = await appendTavernMessage(session.id, {
            role: 'assistant',
            content: result.text,
            providerPayload: result.providerPayload,
            contextSnapshot: lockedContext,
            buildSnapshot,
            presetId,
            presetName,
            requestSnapshot: result.requestSnapshot,
            provider: result.provider || '',
            model: result.model || '',
            finishReason: result.finishReason || '',
        });
        await notifyRunCallback(() => input.onAssistantMessageSaved?.(session.id, assistantMessage));
        const nextTurn = Number(sessionState.turn || 0) + 1;
        await persistRunSessionState(session.id, {
            turn: nextTurn,
            worldEntryStates: shouldReplaceSessionState
                ? mergeWorldEntryStates(sessionState.worldEntryStates || {}, buildResult.meta.worldEntryStateUpdates)
                : buildResult.meta.worldEntryStateUpdates,
            lastBuildSnapshot: buildSnapshot,
            lastRequestSnapshot: result.requestSnapshot,
            lastProvider: result.provider || '',
            lastModel: result.model || '',
        }, {
            replace: shouldReplaceSessionState,
        });
        let managerRunId = '';
        let managerStatus = '';
        if (input.runManager === true && !assistantMessage.error) {
            const manager = await scheduleXbTavernManagerAfterTurn({
                sessionId: session.id,
                agentConfig: input.agentConfig,
                userMessage,
                assistantMessage,
                turn: nextTurn,
                awaitCompletion: input.awaitManager === true,
                executeManagerOnce: input.executeManagerOnce,
                onManagerRunSaved: async (run) => {
                    await notifyRunCallback(() => input.onManagerRunSaved?.(session.id, run.id));
                },
            });
            managerRunId = manager.managerRunId;
            managerStatus = manager.managerStatus;
        }
        return {
            sessionId: session.id,
            userMessage,
            assistantMessage,
            buildResult,
            buildSnapshot,
            requestSnapshot: result.requestSnapshot,
            provider: result.provider || '',
            model: result.model || '',
            finishReason: result.finishReason,
            previewMatchesRequest: buildResult.meta.rawMessagesJson === result.requestSnapshot.rawMessagesJson,
            nextTurn,
            managerRunId,
            managerStatus,
        };
    } catch (error) {
        const failedRequestSnapshot = (error as { requestSnapshot?: TavernRequestSnapshot } | null)?.requestSnapshot;
        if (failedRequestSnapshot) {
            requestSnapshot = failedRequestSnapshot;
        }
        const aborted = isAbortLikeError(error, input.signal);
        const partialText = String(latestStreamText || '').trim();
        if (aborted && partialText) {
            const errorMessage = await appendTavernMessage(session.id, {
                role: 'assistant',
                content: partialText,
                error: false,
                contextSnapshot: lockedContext,
                buildSnapshot,
                presetId,
                presetName,
                requestSnapshot,
                provider: requestSnapshot.provider,
                model: requestSnapshot.model,
                finishReason: 'aborted',
            });
            await notifyRunCallback(() => input.onAssistantMessageSaved?.(session.id, errorMessage));
            const nextTurn = Number(sessionState.turn || 0) + 1;
            await persistRunSessionState(session.id, {
                turn: nextTurn,
                worldEntryStates: shouldReplaceSessionState
                    ? mergeWorldEntryStates(sessionState.worldEntryStates || {}, buildResult.meta.worldEntryStateUpdates)
                    : buildResult.meta.worldEntryStateUpdates,
                lastBuildSnapshot: buildSnapshot,
                lastRequestSnapshot: requestSnapshot,
                lastProvider: requestSnapshot.provider,
                lastModel: requestSnapshot.model,
            }, {
                replace: shouldReplaceSessionState,
            });
            let managerRunId = '';
            let managerStatus = '';
            if (input.runManager === true) {
                const manager = await scheduleXbTavernManagerAfterTurn({
                    sessionId: session.id,
                    agentConfig: input.agentConfig,
                    userMessage,
                    assistantMessage: errorMessage,
                    turn: nextTurn,
                    awaitCompletion: input.awaitManager === true,
                    executeManagerOnce: input.executeManagerOnce,
                    onManagerRunSaved: async (run) => {
                        await notifyRunCallback(() => input.onManagerRunSaved?.(session.id, run.id));
                    },
                });
                managerRunId = manager.managerRunId;
                managerStatus = manager.managerStatus;
            }
            return {
                sessionId: session.id,
                userMessage,
                assistantMessage: errorMessage,
                buildResult,
                buildSnapshot,
                requestSnapshot,
                provider: requestSnapshot.provider,
                model: requestSnapshot.model,
                finishReason: 'aborted',
                previewMatchesRequest: buildResult.meta.rawMessagesJson === requestSnapshot.rawMessagesJson,
                nextTurn,
                managerRunId,
                managerStatus,
            };
        }
        const errorText = error instanceof Error ? error.message : String(error || 'run_failed');
        const errorMessage = await appendTavernMessage(session.id, {
            role: 'assistant',
            content: aborted ? '已停止生成。' : errorText,
            error: true,
            contextSnapshot: lockedContext,
            buildSnapshot,
            presetId,
            presetName,
            requestSnapshot,
            provider: requestSnapshot.provider,
            model: requestSnapshot.model,
            finishReason: aborted ? 'aborted' : 'error',
        });
        await notifyRunCallback(() => input.onAssistantMessageSaved?.(session.id, errorMessage));
        await persistRunSessionState(session.id, {
            turn: Number(sessionState.turn || 0),
            worldEntryStates: shouldReplaceSessionState ? sessionState.worldEntryStates || {} : {},
            lastBuildSnapshot: buildSnapshot,
            lastRequestSnapshot: requestSnapshot,
            lastProvider: requestSnapshot.provider,
            lastModel: requestSnapshot.model,
            lastError: aborted ? '已停止生成。' : errorText,
        }, {
            replace: shouldReplaceSessionState,
        });
        return {
            sessionId: session.id,
            userMessage,
            errorMessage,
            buildResult,
            buildSnapshot,
            requestSnapshot,
            provider: requestSnapshot.provider,
            model: requestSnapshot.model,
            finishReason: aborted ? 'aborted' : 'error',
            previewMatchesRequest: buildResult.meta.rawMessagesJson === requestSnapshot.rawMessagesJson,
            nextTurn: Number(sessionState.turn || 0),
            error: aborted ? '已停止生成。' : errorText,
        };
    }
}
