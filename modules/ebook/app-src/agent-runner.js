import { buildCurrentPlansContextText } from '../../agent-core/current-plans.js';
import { createDelegateRunner } from '../../agent-core/runtime/delegate-runner.js';
import {
    buildProviderMessagesFromHistory,
    filterThoughtsForTurn,
    hasVisibleText,
    mergeThoughtBlocks,
    normalizeThoughtBlocks,
    normalizeToolCalls,
    resolveResultToolCalls,
} from '../../agent-core/runtime/protocol.js';
import { createStreamingMessageController } from '../../agent-core/runtime/streaming-messages.js';
import { buildTavilySearchTracePayload, isTavilyConfigured } from '../../agent-core/tavily-search.js';
import { upsertBookFile } from '../shared/ebook-db.js';
import {
    EBOOK_TOOL_NAMES,
    buildEbookToolFailureResult,
    createBookToolRuntime,
    describeEbookToolCall,
    ebookPlanLedger,
    formatEbookToolResult,
    getEbookToolDefinitions,
} from '../shared/book-tools.js';
import { createEbookHistoryCompactionController, splitEbookMessagesIntoTurns } from './history-compaction.js';
import {
    buildBookContextPrompt,
    buildDelegateBookContextPrompt,
    EBOOK_DELEGATE_PROMPT,
    EBOOK_SYSTEM_PROMPT,
} from './prompts.js';
import { safeJsonParse, safeJsonStringify } from './text-utils.js';

const MAX_TOOL_ROUNDS = 48;

function findLastUserMessageIndex(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') return index;
    }
    return -1;
}

function buildStoredAssistantToolCallMessage(result = {}, toolCalls = []) {
    return {
        role: 'assistant',
        content: String(result.text || ''),
        toolCalls: normalizeToolCalls(toolCalls),
        thoughts: normalizeThoughtBlocks(result.thoughts),
        providerPayload: result.providerPayload,
    };
}

function buildToolResultMessage({ toolCallId = '', toolName = '', toolResult, toolDisplay = null } = {}) {
    const message = {
        role: 'tool',
        toolCallId: String(toolCallId || ''),
        toolName: String(toolName || ''),
        content: safeJsonStringify(toolResult),
    };
    if (toolDisplay && typeof toolDisplay === 'object') {
        message.toolDisplay = toolDisplay;
    }
    return message;
}

export function buildEbookProviderMessagesFromHistory(messages = []) {
    return buildProviderMessagesFromHistory(messages);
}

function buildToolTraceEntry(toolCall = {}, args = {}, result = {}) {
    const isDelegate = toolCall.name === EBOOK_TOOL_NAMES.DELEGATE_RUN;
    const isWebSearch = toolCall.name === EBOOK_TOOL_NAMES.WEB_SEARCH;
    return {
        id: String(toolCall.id || ''),
        name: toolCall.name,
        round: Number(toolCall.round) || 0,
        title: describeEbookToolCall(toolCall.name, args),
        ok: !(result && typeof result === 'object' && result.ok === false),
        summary: formatEbookToolResult(result),
        payload: isDelegate
            ? buildDelegateTracePayload(args)
            : isWebSearch
                ? buildTavilySearchTracePayload(result)
                : [],
    };
}

function buildDelegateTracePayload(args = {}) {
    return [
        ['任务', args.task],
        ['背景', args.context],
        ['交付', args.deliverable],
    ]
        .map(([label, value]) => ({
            label,
            text: String(value || '').trim(),
        }))
        .filter((item) => item.text);
}

function buildRunningToolTraceEntry(toolCall = {}, args = {}, round = 0) {
    const isDelegate = toolCall.name === EBOOK_TOOL_NAMES.DELEGATE_RUN;
    const isWebSearch = toolCall.name === EBOOK_TOOL_NAMES.WEB_SEARCH;
    return {
        id: String(toolCall.id || ''),
        name: toolCall.name,
        round: Number(round) || Number(toolCall.round) || 0,
        title: describeEbookToolCall(toolCall.name, args),
        ok: true,
        status: 'running',
        startedAt: Date.now(),
        summary: isDelegate
            ? '审稿分身工作中，等待返回。'
            : isWebSearch
                ? '联网搜索中，等待返回。'
                : '工具运行中，等待返回。',
        payload: isDelegate
            ? buildDelegateTracePayload(args)
            : isWebSearch
                ? buildTavilySearchTracePayload({ query: args.query })
                : [],
    };
}

function resolveRunningToolTraceEntry(entry = {}, toolCall = {}, args = {}, result = {}) {
    Object.assign(entry, buildToolTraceEntry(toolCall, args, result), {
        status: 'resolved',
        finishedAt: Date.now(),
    });
    if (Number(entry.startedAt)) {
        entry.elapsedMs = Math.max(0, Number(entry.finishedAt) - Number(entry.startedAt));
    }
    return entry;
}

function buildToolDisplayFromTrace(entry = {}) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        title: String(entry.title || entry.name || ''),
        status: entry.status === 'running' ? 'running' : 'resolved',
        payload: Array.isArray(entry.payload) ? entry.payload : [],
        elapsedMs: Number(entry.elapsedMs) || 0,
    };
}

function isAbortError(error) {
    return error?.name === 'AbortError' || /aborted|assistant_aborted/i.test(String(error?.message || error || ''));
}

function findTurnUserMessageIndex(messages = [], fromIndex = 0) {
    for (let index = Math.min(fromIndex, messages.length - 1); index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') return index;
    }
    return -1;
}

export function createEbookAgentRunner(deps = {}) {
    const {
        state,
        refreshBooksAndFiles,
        render,
        showToast,
        persistConversation,
        isEditorDirty,
        getActiveProviderConfig,
        createAdapter,
    } = deps;

    async function buildCurrentPlansContext(bookId = state.book?.id) {
        if (!bookId) return '';
        return await buildCurrentPlansContextText({
            sessionId: bookId,
            ledger: ebookPlanLedger,
        });
    }

    function buildMessagesForRun(currentPlansText = '', options = {}) {
        const book = options.book || state.book;
        const contextPrompt = buildBookContextPrompt({
            book,
            files: state.files,
            selectedPath: state.selectedPath,
            selectedText: '',
            currentPlansText,
            historySummary: state.historySummary,
        });
        const extraSystemMessages = [
            String(options.lightBrakeText || '').trim(),
            String(options.finalAnswerReminderText || '').trim(),
        ]
            .filter(Boolean)
            .map((content) => ({ role: 'system', content }));
        const history = buildEbookProviderMessagesFromHistory(state.messages);
        return [
            { role: 'system', content: EBOOK_SYSTEM_PROMPT },
            { role: 'system', content: contextPrompt },
            ...extraSystemMessages,
            ...history,
        ];
    }

    const compactionController = createEbookHistoryCompactionController({
        state,
        render,
        showToast,
        persistConversation,
        getActiveProviderConfig,
        buildProviderMessages: () => buildMessagesForRun(''),
    });

    const delegateRunner = createDelegateRunner({
        createAdapter,
        executeToolCall: async (toolCall, args, parentRun = {}) => {
            const runtime = createBookToolRuntime({
                getBookId: () => parentRun.bookId || state.book?.id,
                getSearchConfig: () => getActiveProviderConfig({ role: 'delegate' }),
                signal: parentRun?.controller?.signal,
                readOnly: true,
                isAbortError,
            });
            try {
                return await runtime.execute(toolCall.name, args);
            } catch (error) {
                if (isAbortError(error)) throw error;
                return buildEbookToolFailureResult(toolCall.name, args, error);
            }
        },
        getActiveProviderConfig,
        getDelegateProviderConfig: () => getActiveProviderConfig({ role: 'delegate' }),
        getSystemPrompt: () => EBOOK_DELEGATE_PROMPT,
        resolveToolDefinitions: () => getEbookToolDefinitions({
            readOnly: true,
            webSearchEnabled: isTavilyConfigured(getActiveProviderConfig({ role: 'delegate' })),
        }),
        safeJsonParse,
        isAbortError,
        TOOL_NAMES: EBOOK_TOOL_NAMES,
        maxRounds: 16,
    });

    async function runDelegate(args = {}, parentRun = {}) {
        let currentPlansText = '';
        try {
            currentPlansText = await buildCurrentPlansContext(parentRun.bookId || state.book?.id);
        } catch {
            currentPlansText = '';
        }
        const autoContext = buildDelegateBookContextPrompt({
            book: parentRun.book || state.book,
            files: state.files,
            currentPlansText,
            historySummary: state.historySummary,
        });
        const callerContext = String(args.context || '').trim();
        const context = [
            autoContext,
            callerContext ? `[主助手本次补充]\n${callerContext}` : '',
        ].filter(Boolean).join('\n\n');
        return await delegateRunner.runDelegate({ ...args, context }, parentRun);
    }

    async function runAgent(userText = '', options = {}) {
        const taskText = String(userText || '').trim();
        if (!taskText || state.isBusy || !state.book) return;
        const appendUserMessage = options.appendUserMessage !== false;
        const runBook = { ...state.book };
        const runBookId = runBook.id;
        state.isBusy = true;
        state.status = 'AI 正在阅读作品...';
        state.agentAutoScroll = true;
        state.toolTrace = [];
        state.liveToolTurn = null;
        state.editingMessageIndex = -1;
        if (appendUserMessage) {
            state.messages.push({ role: 'user', content: taskText });
        }
        state.activeTurnStartIndex = findLastUserMessageIndex(state.messages);
        await persistConversation?.(runBookId);
        render();

        const controller = new AbortController();
        state.activeController = controller;
        const providerConfig = getActiveProviderConfig();
        let streamingAssistantMessage = null;

        function removeStreamingAssistantMessage(message = streamingAssistantMessage) {
            if (!message) return;
            const index = state.messages.indexOf(message);
            if (index >= 0) {
                state.messages.splice(index, 1);
            }
            if (message === streamingAssistantMessage) {
                streamingAssistantMessage = null;
            }
        }

        function filterThoughtsForCurrentTurn(thoughts = [], currentMessage = null) {
            const turns = splitEbookMessagesIntoTurns(state.messages);
            const currentTurn = turns.length ? turns[turns.length - 1] : [];
            return filterThoughtsForTurn(thoughts, currentTurn, {
                currentMessage,
            });
        }

        const {
            createStreamingAssistantMessage,
            finalizeStreamingAssistantMessage,
            scheduleStreamRender,
            updateStreamingAssistantMessage: updateStreamingMessage,
        } = createStreamingMessageController({
            state,
            render,
            persistSession: () => {
                void persistConversation?.(runBookId);
            },
            filterThoughtsForCurrentTurn,
        });

        try {
            const adapter = createAdapter(providerConfig);
            if (isEditorDirty() && state.selectedPath) {
                await upsertBookFile(runBookId, state.selectedPath, state.editorContent);
                await refreshBooksAndFiles();
            }
            const runtime = createBookToolRuntime({
                getBookId: () => runBookId,
                onFilesChanged: refreshBooksAndFiles,
                getSearchConfig: () => providerConfig,
                signal: controller.signal,
                isAbortError,
                runDelegate: async (args) => await runDelegate(args, { controller, bookId: runBookId, book: runBook }),
            });
            const tools = runtime.getToolDefinitions();
            const allowedToolNames = new Set(tools.map((definition) => definition.function.name));
            let sawToolExecution = false;
            let finalAnswerReminderSent = false;
            let pendingToolResponses = null;
            let pendingFinalAnswerReminderText = '';
            const providerMessageOptions = {
                finalAnswerReminderText: '',
            };
            const toolErrorLightBrake = {
                key: '',
                count: 0,
                message: '',
            };

            function recordToolErrorForLightBrake(toolName = '', errorCode = '') {
                const name = String(toolName || '').trim();
                const code = String(errorCode || 'tool_failed').trim() || 'tool_failed';
                if (!name) return;
                const nextKey = `${name}::${code}`;
                if (toolErrorLightBrake.key === nextKey) {
                    toolErrorLightBrake.count += 1;
                } else {
                    toolErrorLightBrake.key = nextKey;
                    toolErrorLightBrake.count = 1;
                }
                if (toolErrorLightBrake.count >= 3) {
                    toolErrorLightBrake.message = [
                        `[工具失败提示] ${name} 已连续 ${toolErrorLightBrake.count} 次因为 ${code} 失败。`,
                        '不要继续原样重复同一个工具调用；先换路径、换参数、用 LS / Glob / Grep / Read 重新定位，或直接告诉用户当前阻塞点。',
                    ].join('\n');
                }
            }

            function resetToolErrorLightBrake() {
                toolErrorLightBrake.key = '';
                toolErrorLightBrake.count = 0;
                toolErrorLightBrake.message = '';
            }

            function recordToolResultForLightBrake(toolCall = {}, toolResult = {}) {
                if (toolResult && typeof toolResult === 'object' && toolResult.ok === false) {
                    recordToolErrorForLightBrake(toolCall.name, toolResult.error || toolResult.message || 'tool_failed');
                    return;
                }
                resetToolErrorLightBrake();
            }

            async function buildReplayMessages() {
                let currentPlansText = '';
                try {
                    currentPlansText = await buildCurrentPlansContext(runBookId);
                } catch {
                    currentPlansText = '';
                }
                const messages = buildMessagesForRun(currentPlansText, {
                    book: runBook,
                    lightBrakeText: toolErrorLightBrake.message,
                    finalAnswerReminderText: providerMessageOptions.finalAnswerReminderText,
                });
                providerMessageOptions.finalAnswerReminderText = '';
                return messages;
            }

            function dropStreamingAssistantMessage() {
                removeStreamingAssistantMessage(streamingAssistantMessage);
            }

            function updateStreamingAssistantMessage(snapshot = {}) {
                const hasText = typeof snapshot.text === 'string';
                const hasThoughts = Array.isArray(snapshot.thoughts);
                if (!hasText && !hasThoughts) return;
                if (!streamingAssistantMessage) {
                    streamingAssistantMessage = createStreamingAssistantMessage();
                }
                updateStreamingMessage(streamingAssistantMessage, {
                    ...(hasText ? { content: snapshot.text } : {}),
                    ...(hasThoughts ? { thoughts: mergeThoughtBlocks(snapshot.thoughts) } : {}),
                });
                scheduleStreamRender();
            }

            for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
                state.status = round === 1 ? 'AI 正在思考...' : `AI 正在处理工具结果（${round}/${MAX_TOOL_ROUNDS}）...`;
                render();
                let result;
                try {
                    const requestTask = {
                        systemPrompt: EBOOK_SYSTEM_PROMPT,
                        tools,
                        toolChoice: 'auto',
                        temperature: providerConfig.temperature,
                        maxTokens: providerConfig.maxTokens,
                        reasoning: {
                            enabled: providerConfig.reasoningEnabled,
                            effort: providerConfig.reasoningEffort,
                        },
                        signal: controller.signal,
                        onStreamProgress: updateStreamingAssistantMessage,
                    };

                    if (Array.isArray(pendingToolResponses) && pendingToolResponses.length && adapter?.supportsSessionToolLoop) {
                        requestTask.toolResponses = pendingToolResponses;
                    } else if (pendingFinalAnswerReminderText && adapter?.supportsSessionToolLoop) {
                        requestTask.finalAnswerReminderText = pendingFinalAnswerReminderText;
                        pendingFinalAnswerReminderText = '';
                    } else {
                        await compactionController.ensureContextBudget(adapter, controller.signal);
                        requestTask.messages = await buildReplayMessages();
                    }

                    console.info('[Ebook][ModelRequest] round:start', {
                        round,
                        provider: String(providerConfig?.provider || ''),
                        model: String(providerConfig?.model || ''),
                        toolMode: String(providerConfig?.toolMode || ''),
                        usesSessionToolLoop: !!adapter?.supportsSessionToolLoop,
                        usesToolResponses: Array.isArray(requestTask.toolResponses) && requestTask.toolResponses.length > 0,
                        toolResponseCount: Array.isArray(requestTask.toolResponses) ? requestTask.toolResponses.length : 0,
                        usesFinalAnswerReminder: !!requestTask.finalAnswerReminderText,
                        messageCount: Array.isArray(requestTask.messages) ? requestTask.messages.length : 0,
                    });
                    result = await adapter.chat(requestTask);
                    console.info('[Ebook][ModelRequest] round:result', {
                        round,
                        provider: String(providerConfig?.provider || ''),
                        finishReason: String(result?.finishReason || ''),
                        textLength: typeof result?.text === 'string' ? result.text.length : 0,
                        toolCallCount: Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0,
                        hasProviderPayload: !!(result?.providerPayload && typeof result.providerPayload === 'object'),
                    });
                } catch (error) {
                    console.error('[Ebook][ModelRequest] round:error', {
                        round,
                        provider: String(providerConfig?.provider || ''),
                        model: String(providerConfig?.model || ''),
                        message: error instanceof Error ? error.message : String(error || ''),
                    });
                    if (streamingAssistantMessage) {
                        finalizeStreamingAssistantMessage(streamingAssistantMessage);
                        streamingAssistantMessage = null;
                    }
                    throw error;
                }

                const toolCalls = resolveResultToolCalls(result, providerConfig, {
                    fallbackPrefix: 'ebook-tool',
                });
                if (toolCalls.length) {
                    pendingToolResponses = null;
                    sawToolExecution = true;
                    const visibleText = String(result.text || streamingAssistantMessage?.content || '');
                    const visibleThoughts = filterThoughtsForCurrentTurn(
                        mergeThoughtBlocks(streamingAssistantMessage?.thoughts, result.thoughts),
                        streamingAssistantMessage,
                    );
                    dropStreamingAssistantMessage();
                    const storedAssistantToolMessage = buildStoredAssistantToolCallMessage({
                        ...result,
                        text: visibleText,
                        thoughts: visibleThoughts,
                    }, toolCalls);
                    state.liveToolTurn = storedAssistantToolMessage;
                    render();
                    const storedToolMessages = [];
                    const toolResponses = [];
                    for (const toolCall of toolCalls) {
                        if (controller.signal.aborted) throw new Error('assistant_aborted');
                        const args = safeJsonParse(toolCall.arguments, {});
                        const isDelegateTool = toolCall.name === EBOOK_TOOL_NAMES.DELEGATE_RUN;
                        const liveTraceEntry = isDelegateTool ? buildRunningToolTraceEntry(toolCall, args, round) : null;
                        if (liveTraceEntry) {
                            state.toolTrace.push(liveTraceEntry);
                            render();
                        }
                        let toolResult;
                        if (!allowedToolNames.has(toolCall.name)) {
                            toolResult = {
                                ok: false,
                                error: 'ebook_tool_not_available',
                                message: `${toolCall.name} 不在电纸书工具表中。`,
                            };
                        } else {
                            try {
                                toolResult = await runtime.execute(toolCall.name, args);
                            } catch (error) {
                                if (isAbortError(error)) throw error;
                                toolResult = buildEbookToolFailureResult(toolCall.name, args, error);
                            }
                        }
                        const traceEntry = liveTraceEntry
                            ? resolveRunningToolTraceEntry(liveTraceEntry, { ...toolCall, round }, args, toolResult)
                            : buildToolTraceEntry({ ...toolCall, round }, args, toolResult);
                        if (!liveTraceEntry) {
                            state.toolTrace.push(traceEntry);
                        }
                        const toolMessage = buildToolResultMessage({
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            toolResult,
                            toolDisplay: isDelegateTool ? buildToolDisplayFromTrace(traceEntry) : null,
                        });
                        storedToolMessages.push(toolMessage);
                        toolResponses.push({
                            id: toolCall.id,
                            name: toolCall.name,
                            response: toolResult,
                        });
                        recordToolResultForLightBrake(toolCall, toolResult);
                        await refreshBooksAndFiles();
                        render();
                    }
                    state.messages.push(storedAssistantToolMessage, ...storedToolMessages);
                    await persistConversation?.(runBookId);
                    state.toolTrace = [];
                    state.liveToolTurn = null;
                    if (adapter?.supportsSessionToolLoop) {
                        pendingToolResponses = toolResponses;
                    }
                    continue;
                }

                pendingToolResponses = null;
                if (!hasVisibleText(result?.text) && sawToolExecution && !finalAnswerReminderSent) {
                    finalAnswerReminderSent = true;
                    const reminder = '你已经拿到了本轮全部工具结果。现在不要再调用任何工具，直接给出电纸书操作结论。';
                    dropStreamingAssistantMessage();
                    if (adapter?.supportsSessionToolLoop) {
                        pendingFinalAnswerReminderText = reminder;
                    } else {
                        providerMessageOptions.finalAnswerReminderText = reminder;
                    }
                    continue;
                }

                const text = String(result?.text || streamingAssistantMessage?.content || '').trim();
                if (!text) {
                    dropStreamingAssistantMessage();
                    throw new Error('模型没有返回有效结论。');
                }
                const finalMessage = {
                    role: 'assistant',
                    content: text,
                    thoughts: filterThoughtsForCurrentTurn(
                        mergeThoughtBlocks(streamingAssistantMessage?.thoughts, result.thoughts),
                        streamingAssistantMessage,
                    ),
                    providerPayload: result.providerPayload,
                };
                if (streamingAssistantMessage) {
                    finalizeStreamingAssistantMessage(streamingAssistantMessage, finalMessage);
                    streamingAssistantMessage = null;
                } else {
                    state.messages.push(finalMessage);
                }
                state.status = '就绪';
                await refreshBooksAndFiles();
                await persistConversation?.(runBookId);
                return;
            }
            throw new Error('工具轮次达到上限，已停止。');
        } catch (error) {
            if (streamingAssistantMessage) {
                finalizeStreamingAssistantMessage(streamingAssistantMessage);
                streamingAssistantMessage = null;
            } else {
                const staleStreamingMessage = state.messages.find((message) => message?.streaming);
                if (staleStreamingMessage) finalizeStreamingAssistantMessage(staleStreamingMessage);
            }
            const message = isAbortError(error) ? '已取消本次操作。' : `AI 操作失败：${error?.message || error}`;
            state.messages.push({ role: 'assistant', content: message, error: true });
            state.status = '就绪';
            await persistConversation?.(runBookId);
        } finally {
            state.isBusy = false;
            state.activeController = null;
            state.toolTrace = [];
            state.liveToolTurn = null;
            state.activeTurnStartIndex = -1;
            await refreshBooksAndFiles().catch(() => {});
            render();
        }
    }

    function cancelActiveRun() {
        state.activeController?.abort();
    }

    async function rerunFromMessageIndex(messageIndex = -1) {
        if (state.isBusy || !state.book) return {
            ok: false,
            error: 'ebook_busy',
        };
        const index = Number(messageIndex);
        if (!Number.isInteger(index) || index < 0) return {
            ok: false,
            error: 'message_index_invalid',
        };
        const turnUserIndex = findTurnUserMessageIndex(state.messages, index - 1);
        const latestUserMessage = turnUserIndex >= 0 ? state.messages[turnUserIndex] : null;
        const taskText = String(latestUserMessage?.content || '').trim();
        if (!taskText) return {
            ok: false,
            error: 'rerun_user_message_missing',
        };
        state.messages = state.messages.slice(0, turnUserIndex + 1);
        state.toolTrace = [];
        state.liveToolTurn = null;
        state.editingMessageIndex = -1;
        await persistConversation?.(state.book.id);
        render();
        await runAgent(taskText, { appendUserMessage: false });
        return { ok: true };
    }

    return {
        cancelActiveRun,
        rerunFromMessageIndex,
        runAgent,
        runDelegate,
    };
}
