import { createAgentAdapter, resolveActiveProviderConfig } from '../../../agent-core/provider-config.js';
import type { XbTavernMessage } from '../../shared/message-assembler';

export interface TavernRunOnceOptions {
    agentConfig: Record<string, unknown>;
    messages: XbTavernMessage[];
    signal?: AbortSignal;
    onStreamProgress?: (snapshot: { text?: string; thoughts?: Array<{ label?: string; text?: string }> }) => void;
}

export interface TavernRunOnceResult {
    text: string;
    thoughts?: Array<{ label?: string; text?: string }>;
    model?: string;
    provider?: string;
    finishReason?: string;
    providerPayload?: unknown;
    requestSnapshot: {
        provider: string;
        model: string;
        messageCount: number;
        messageChars: number;
        rawMessagesJson: string;
    };
}

export async function runTavernOnce(options: TavernRunOnceOptions): Promise<TavernRunOnceResult> {
    const providerConfig = resolveActiveProviderConfig(options.agentConfig || {}, {
        timeoutMs: 15 * 60 * 1000,
    });
    const adapter = createAgentAdapter(providerConfig, {
        missingApiKeyMessage: '请先在小白助手模型配置里填写 API Key。',
    });
    const result = await adapter.chat({
        systemPrompt: '',
        messages: options.messages,
        tools: [],
        toolChoice: 'none',
        temperature: providerConfig.temperature,
        maxTokens: providerConfig.maxTokens,
        signal: options.signal,
        onStreamProgress: options.onStreamProgress,
    });
    return {
        text: String(result?.text || ''),
        thoughts: result?.thoughts,
        model: result?.model,
        provider: result?.provider,
        finishReason: result?.finishReason,
        providerPayload: result?.providerPayload,
        requestSnapshot: {
            provider: String(result?.provider || providerConfig.provider || ''),
            model: String(result?.model || providerConfig.model || ''),
            messageCount: options.messages.length,
            messageChars: options.messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
            rawMessagesJson: JSON.stringify(options.messages, null, 2),
        },
    };
}
