import {
    buildHostOpenAICompatibleGeneratePayload,
    createHostChatCompletion,
    streamHostChatCompletion,
} from '../../../shared/host-llm/chat-completions/client.js';
import {
    accumulateStreamedAssistantSnapshot,
    applyToolCallDelta,
    buildToolCallResultsFromOpenAI,
    buildNativeMessages,
    buildProviderPayload,
    buildReplayableAssistantMessage,
    buildTaggedMessages,
    extractTaggedToolCalls,
    extractThinkTaggedContent,
    extractThoughtsFromMessage,
    flattenTextContent,
} from './openai-compatible.js';

function emitStreamProgress(task, payload) {
    if (typeof task.onStreamProgress !== 'function') return;
    task.onStreamProgress({
        ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
        ...(Array.isArray(payload.thoughts) ? { thoughts: payload.thoughts } : {}),
    });
}

function cleanTextForToolMode(content, standardToolCalls = []) {
    const thinkTagged = extractThinkTaggedContent(content);
    return {
        thinkTagged,
        cleanedText: standardToolCalls.length
            ? thinkTagged.cleaned
            : thinkTagged.cleaned
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
                .trim(),
    };
}

function isMalformedNativeToolHostError(error) {
    const message = String(error?.message || error || '');
    return /Cannot read properties of null \(reading ['"]function['"]\)/i.test(message)
        || /reading ['"]function['"]/i.test(message)
        || /badresponsestatuscode/i.test(message);
}

export class SillyTavernOpenAICompatibleAdapter {
    constructor(config) {
        this.config = config;
    }

    buildMessages(task) {
        const toolMode = this.config.toolMode || 'native';
        const isTaggedMode = toolMode === 'tagged-json' && Array.isArray(task.tools) && task.tools.length > 0;
        return isTaggedMode
            ? buildTaggedMessages(task)
            : buildNativeMessages(task, this.config.model);
    }

    async streamChat(task, payload) {
        const snapshot = {
            content: '',
            toolCalls: [],
        };
        const assistantSnapshot = {
            role: 'assistant',
        };
        let lastFinishReason = 'stop';
        let lastModel = this.config.model;

        await streamHostChatCompletion(payload, (event) => {
            lastModel = event?.model || lastModel;
            const choice = event?.choices?.[0] || {};
            const delta = choice.delta || {};
            accumulateStreamedAssistantSnapshot(assistantSnapshot, choice);

            if (choice.finish_reason) {
                lastFinishReason = choice.finish_reason;
            }
            if (typeof delta.content === 'string') {
                snapshot.content += delta.content;
            }
            if (Array.isArray(delta.tool_calls)) {
                delta.tool_calls.forEach((toolCallDelta) => {
                    applyToolCallDelta(snapshot, toolCallDelta);
                });
            }

            const standardToolCalls = snapshot.toolCalls.filter((item) => item?.function?.name);
            const { thinkTagged, cleanedText } = cleanTextForToolMode(snapshot.content, standardToolCalls);
            emitStreamProgress(task, {
                text: cleanedText,
                thoughts: extractThoughtsFromMessage(assistantSnapshot, choice).concat(thinkTagged.thoughts),
            });
        }, { signal: task.signal });

        const standardToolCalls = buildToolCallResultsFromOpenAI(snapshot.toolCalls, 'st-openai-tool');
        const { thinkTagged, cleanedText } = cleanTextForToolMode(snapshot.content, standardToolCalls);
        const thoughts = extractThoughtsFromMessage(assistantSnapshot, {});
        thinkTagged.thoughts.forEach((item) => thoughts.push(item));
        const taggedToolCalls = standardToolCalls.length ? [] : extractTaggedToolCalls(thinkTagged.cleaned);

        return {
            text: cleanedText,
            toolCalls: [...standardToolCalls, ...taggedToolCalls],
            thoughts,
            finishReason: lastFinishReason,
            model: lastModel,
            provider: 'sillytavern-openai-compatible',
            providerPayload: buildProviderPayload(assistantSnapshot),
        };
    }

    async nonStreamingChat(task, payload) {
        const response = await createHostChatCompletion(payload, { signal: task.signal });
        const choice = response.choices?.[0] || {};
        const message = choice.message || {};
        const thoughts = extractThoughtsFromMessage(message, choice);
        const standardToolCalls = buildToolCallResultsFromOpenAI(message.tool_calls || [], 'st-openai-tool');
        const contentText = flattenTextContent(message.content);
        const { thinkTagged, cleanedText } = cleanTextForToolMode(contentText, standardToolCalls);
        thinkTagged.thoughts.forEach((item) => thoughts.push(item));
        const taggedToolCalls = standardToolCalls.length ? [] : extractTaggedToolCalls(thinkTagged.cleaned);
        const replayableMessage = buildReplayableAssistantMessage(message, choice);

        return {
            text: cleanedText,
            toolCalls: [...standardToolCalls, ...taggedToolCalls],
            thoughts,
            finishReason: choice.finish_reason || 'stop',
            model: response.model || this.config.model,
            provider: 'sillytavern-openai-compatible',
            providerPayload: buildProviderPayload(replayableMessage),
        };
    }

    async chat(task) {
        const toolMode = this.config.toolMode || 'native';
        const isTaggedMode = toolMode === 'tagged-json' && Array.isArray(task.tools) && task.tools.length > 0;
        const hasTools = Array.isArray(task.tools) && task.tools.length > 0;
        const buildPayload = (taggedMode) => {
            const messages = taggedMode
                ? buildTaggedMessages(task)
                : buildNativeMessages(task, this.config.model);
            return buildHostOpenAICompatibleGeneratePayload(
                this.config,
                taggedMode
                    ? {
                        ...task,
                        tools: undefined,
                        toolChoice: undefined,
                    }
                    : task,
                messages,
                typeof task.onStreamProgress === 'function',
            );
        };
        const run = async (payload) => {
            if (typeof task.onStreamProgress === 'function') {
                return await this.streamChat(task, payload);
            }
            return await this.nonStreamingChat(task, payload);
        };
        const payload = buildPayload(isTaggedMode);

        try {
            return await run(payload);
        } catch (error) {
            if (isTaggedMode || !hasTools || !isMalformedNativeToolHostError(error)) {
                throw error;
            }
        }

        const fallbackPayload = buildPayload(true);
        return await run(fallbackPayload);
    }
}
