import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { OpenAIResponsesAdapter } from './adapters/openai-responses.js';
import { SillyTavernOpenAICompatibleAdapter } from './adapters/sillytavern-openai-compatible.js';
import { DEFAULT_PRESET_NAME, buildDefaultPreset, cloneDefaultModelConfigs, normalizeAgentConfig, normalizePresetName } from './config.js';
import { normalizeTavilyApiKey, normalizeTavilyBaseUrl } from './tavily-search.js';

export const AGENT_REQUEST_TIMEOUT_MS = 180000;

export const TOOL_MODE_OPTIONS = Object.freeze([
    { value: 'native', label: '原生 Tool Calling' },
    { value: 'tagged-json', label: 'Tagged JSON 兼容模式' },
]);

export const REASONING_EFFORT_OPTIONS = Object.freeze([
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
]);

export const PROVIDER_OPTIONS = Object.freeze([
    { value: 'openai-responses', label: 'OpenAI Responses' },
    { value: 'openai-compatible', label: 'OpenAI-Compatible' },
    { value: 'sillytavern-openai-compatible', label: 'SillyTavern OpenAI-Compatible' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google AI' },
]);

export function normalizeReasoningEffort(value = '') {
    return REASONING_EFFORT_OPTIONS.some((item) => item.value === value) ? value : 'medium';
}

export function getProviderLabel(provider = '', labels = {}) {
    if (labels && typeof labels === 'object' && labels[provider]) {
        return labels[provider];
    }
    return PROVIDER_OPTIONS.find((item) => item.value === provider)?.label || provider || '未配置';
}

export function getToolModeLabel(providerConfig = {}) {
    const provider = String(providerConfig.provider || '').trim();
    if (provider === 'openai-compatible' || provider === 'sillytavern-openai-compatible') {
        return providerConfig.toolMode === 'tagged-json'
            ? 'Tagged JSON 兼容模式'
            : '原生 Tool Calling';
    }
    return 'Provider 原生工具';
}

export function resolveActiveProviderConfig(configValue = {}, options = {}) {
    const config = normalizeAgentConfig(configValue || {});
    if (options.role === 'delegate' && config.delegateConfig) {
        const provider = config.delegateConfig.provider || 'openai-compatible';
        const modelConfigs = config.delegateConfig.modelConfigs || cloneDefaultModelConfigs();
        const providerConfig = modelConfigs[provider] || cloneDefaultModelConfigs()[provider] || {};
        return {
            currentPresetName: String(config.delegatePresetName || config.currentPresetName || ''),
            provider,
            baseUrl: String(providerConfig.baseUrl || ''),
            model: String(providerConfig.model || ''),
            apiKey: String(providerConfig.apiKey || ''),
            tavilyApiKey: normalizeTavilyApiKey(config.tavilyApiKey),
            tavilyBaseUrl: normalizeTavilyBaseUrl(config.tavilyBaseUrl),
            temperature: Number(providerConfig.temperature ?? 0.2),
            maxTokens: provider === 'anthropic' ? 32000 : null,
            timeoutMs: Number(options.timeoutMs) || AGENT_REQUEST_TIMEOUT_MS,
            toolMode: providerConfig.toolMode || 'native',
            reasoningEnabled: Boolean(providerConfig.reasoningEnabled),
            reasoningEffort: normalizeReasoningEffort(providerConfig.reasoningEffort),
        };
    }

    const requestedPresetName = normalizePresetName(
        options.presetName
            || (options.role === 'delegate' ? config.delegatePresetName : config.currentPresetName)
            || DEFAULT_PRESET_NAME,
    );
    const activePresetName = config.presets?.[requestedPresetName]
        ? requestedPresetName
        : (config.presets?.[config.currentPresetName] ? config.currentPresetName : DEFAULT_PRESET_NAME);
    const currentPreset = config.presets?.[activePresetName] || buildDefaultPreset();
    const provider = currentPreset.provider || config.provider || 'openai-compatible';
    const modelConfigs = currentPreset.modelConfigs || config.modelConfigs || cloneDefaultModelConfigs();
    const providerConfig = modelConfigs[provider] || cloneDefaultModelConfigs()[provider] || {};
    return {
        currentPresetName: String(activePresetName || ''),
        provider,
        baseUrl: String(providerConfig.baseUrl || ''),
        model: String(providerConfig.model || ''),
        apiKey: String(providerConfig.apiKey || ''),
        tavilyApiKey: normalizeTavilyApiKey(config.tavilyApiKey),
        tavilyBaseUrl: normalizeTavilyBaseUrl(config.tavilyBaseUrl),
        temperature: Number(providerConfig.temperature ?? 0.2),
        maxTokens: provider === 'anthropic' ? 32000 : null,
        timeoutMs: Number(options.timeoutMs) || AGENT_REQUEST_TIMEOUT_MS,
        toolMode: providerConfig.toolMode || 'native',
        reasoningEnabled: Boolean(providerConfig.reasoningEnabled),
        reasoningEffort: normalizeReasoningEffort(providerConfig.reasoningEffort),
    };
}

export function createAgentAdapter(providerConfig = {}, options = {}) {
    if (!providerConfig.apiKey && providerConfig.provider !== 'sillytavern-openai-compatible') {
        throw new Error(options.missingApiKeyMessage || '请先填写当前模型配置的 API Key。');
    }
    switch (providerConfig.provider) {
        case 'sillytavern-openai-compatible':
            return new SillyTavernOpenAICompatibleAdapter(providerConfig);
        case 'openai-responses':
            return new OpenAIResponsesAdapter(providerConfig);
        case 'anthropic':
            return new AnthropicAdapter(providerConfig);
        case 'google':
            return new GoogleAdapter(providerConfig);
        case 'openai-compatible':
        default:
            return new OpenAICompatibleAdapter(providerConfig);
    }
}
