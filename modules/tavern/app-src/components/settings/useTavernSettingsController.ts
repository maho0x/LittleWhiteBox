import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import { createAgentSettingsPanel } from '../../../../agent-core/ui/settings-panel.js';
import { buildAgentSettingsPanelMarkup } from '../../../../agent-core/ui/settings-markup.js';
import { normalizeAgentConfig } from '../../../../agent-core/config.js';
import {
    createDefaultTavernAssistantPreset,
    DEFAULT_TAVERN_ASSISTANT_PRESET_ID,
    normalizeTavernAssistantPreset,
    type TavernAssistantPreset,
} from '../../../shared/assistant-presets';
import {
    createFallbackTavernChatPromptPresetBundle,
    normalizeTavernChatPromptPresetBundle,
} from '../../../shared/chat-presets';
import type { TavernChatPromptPresetBundle, XbTavernContext } from '../../../shared/message-assembler';
import {
    deleteTavernAssistantPreset,
    getActiveTavernAssistantPresetId,
    listTavernAssistantPresets,
    loadActiveTavernAssistantPreset,
    saveTavernAssistantPreset,
    setActiveTavernAssistantPresetId,
    type TavernAssistantPresetRecord,
} from '../../../shared/session-db';
import { resolveXbTavernProviderConfig } from '../../runtime/provider';
import type { TavernSettingsNavItem } from '../TavernSettingsSidebar.vue';
import type {
    TavernAssistantPresetItemRow,
    TavernChatPresetOptionRow,
    TavernRegexGroupDisplayRow,
    TavernRegexGroupRow,
    TavernRegexScriptDraft,
    TavernRegexScriptRow,
    TavernWorldbookOptionRow,
    TavernWorldbookPreviewRow,
} from '../tavern-app-context';

export type TavernSettingsWorkspaceKey = 'api' | 'chatPreset' | 'worldbooks' | 'regex' | 'assistantPreset';

interface TavernSettingsControllerOptions {
    activeView: Ref<string>;
    activeSettingsWorkspace: Ref<TavernSettingsWorkspaceKey>;
    agentConfig: Ref<Record<string, unknown>>;
    effectiveContext: ComputedRef<XbTavernContext>;
    homeThemeDark: Ref<boolean>;
    isRunning: Ref<boolean>;
    describeError: (error: unknown) => string;
    postToHost: (type: string, payload?: Record<string, unknown>) => void;
    requestHost: (type: string, payload?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Record<string, unknown>>;
    shortText: (value?: string, limit?: number) => string;
}

interface PromptEditorRow {
    identifier: string;
    name: string;
    role: string;
    content: string;
    enabled: boolean;
    marker: boolean;
    systemPrompt: boolean;
    injectionPosition: number;
    injectionDepth: number | string;
    source: string;
    orderEntry: Record<string, unknown>;
    prompt: Record<string, unknown>;
    listed: boolean;
    searchCorpus?: string;
}

interface AssistantPresetSectionRow {
    key: 'storyArcPrompt' | 'statePrompt' | 'turnPrompt';
    label: string;
    summary: string;
}

interface WorldbookPreviewEntryRow {
    uid: string;
    name: string;
    keys: string[];
    secondaryKeys: string[];
    contentPreview: string;
    enabled: boolean;
    constant: boolean;
    order: number;
}

const CHAT_PRESET_SOURCE_BATCH_SIZE = 48;
const ASSISTANT_PRESET_BATCH_SIZE = 48;
const PROMPT_EDITOR_BATCH_SIZE = 80;
const WORLDBOOK_BATCH_SIZE = 80;
const WORLDBOOK_PREVIEW_BATCH_SIZE = 24;
const REGEX_GROUP_BATCH_SIZE = 60;

const assistantPresetSections: AssistantPresetSectionRow[] = [
    { key: 'storyArcPrompt', label: '剧情脉络', summary: '长期脉络档案' },
    { key: 'statePrompt', label: '状态栏', summary: '当前状态档案' },
    { key: 'turnPrompt', label: '楼层小记', summary: '按楼层轻量记录' },
];

const placementLabels: Record<string, string> = {
    top: '最前面',
    beforeCharacter: '角色卡前',
    afterCharacter: '角色卡后',
    beforeHistory: '历史前',
    afterHistory: '历史后',
    assistantPrefill: '回复开头',
};

function promptRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clonePromptJson<T>(value: T): T {
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

function normalizedSearchText(value = '') {
    return String(value || '').trim().toLocaleLowerCase();
}

function includesSearch(text: string, query: string) {
    if (!query) {return true;}
    return normalizedSearchText(text).includes(query);
}

function buildSearchCorpus(parts: unknown[], perPartLimit = 1600) {
    return parts
        .map((part) => String(part ?? '').slice(0, perPartLimit))
        .filter(Boolean)
        .join('\n');
}

function snapshotNativeDraft(value: unknown) {
    return JSON.stringify(value || {});
}

function normalizeWorldbookPreview(value: unknown): TavernWorldbookPreviewRow {
    const record = promptRecord(value);
    const entries = Array.isArray(record.entries)
        ? record.entries.map((entry) => {
            const entryRecord = promptRecord(entry);
            return {
                uid: String(entryRecord.uid || ''),
                name: String(entryRecord.name || '未命名条目'),
                keys: Array.isArray(entryRecord.keys) ? entryRecord.keys.map((item) => String(item || '')).filter(Boolean) : [],
                secondaryKeys: Array.isArray(entryRecord.secondaryKeys) ? entryRecord.secondaryKeys.map((item) => String(item || '')).filter(Boolean) : [],
                contentPreview: String(entryRecord.contentPreview || ''),
                enabled: entryRecord.enabled !== false,
                constant: entryRecord.constant === true,
                order: Number.isFinite(Number(entryRecord.order)) ? Number(entryRecord.order) : 100,
            } as WorldbookPreviewEntryRow;
        })
        : [];
    return {
        name: String(record.name || ''),
        entryCount: Number.isFinite(Number(record.entryCount)) ? Number(record.entryCount) : entries.length,
        enabledCount: Number.isFinite(Number(record.enabledCount)) ? Number(record.enabledCount) : entries.filter((entry) => entry.enabled).length,
        constantCount: Number.isFinite(Number(record.constantCount)) ? Number(record.constantCount) : entries.filter((entry) => entry.constant).length,
        disabledCount: Number.isFinite(Number(record.disabledCount)) ? Number(record.disabledCount) : entries.filter((entry) => !entry.enabled).length,
        keywordCount: Number.isFinite(Number(record.keywordCount)) ? Number(record.keywordCount) : entries.reduce((sum, entry) => sum + entry.keys.length + entry.secondaryKeys.length, 0),
        totalChars: Number.isFinite(Number(record.totalChars)) ? Number(record.totalChars) : entries.reduce((sum, entry) => sum + entry.contentPreview.length, 0),
        entries,
    };
}

function normalizeRegexDraft(input: unknown = {}): TavernRegexScriptDraft {
    const source = promptRecord(input);
    return {
        ...source,
        id: String(source.id || ''),
        scriptName: String(source.scriptName || ''),
        findRegex: String(source.findRegex || ''),
        replaceString: String(source.replaceString || ''),
        trimStrings: Array.isArray(source.trimStrings) ? source.trimStrings.map((item) => String(item || '')).filter(Boolean) : [],
        placement: Array.isArray(source.placement) ? source.placement.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [],
        disabled: source.disabled === true,
        markdownOnly: source.markdownOnly === true,
        promptOnly: source.promptOnly === true,
        runOnEdit: source.runOnEdit === true,
        substituteRegex: Number.isFinite(Number(source.substituteRegex)) ? Number(source.substituteRegex) : 0,
        minDepth: source.minDepth === null || source.minDepth === '' || source.minDepth === undefined ? null : Number(source.minDepth),
        maxDepth: source.maxDepth === null || source.maxDepth === '' || source.maxDepth === undefined ? null : Number(source.maxDepth),
    };
}

export function readInitialSettingsWorkspace(): TavernSettingsWorkspaceKey {
    const hash = String(window.location.hash || '').replace(/^#\/?/, '');
    const key = hash.split('/')[1];
    if (key === 'api' || key === 'chatPreset' || key === 'worldbooks' || key === 'regex' || key === 'assistantPreset') {return key;}
    return 'api';
}

export function useTavernSettingsController(options: TavernSettingsControllerOptions) {
    const initialChatPreset = createFallbackTavernChatPromptPresetBundle();
    const initialAssistantPreset: TavernAssistantPreset = createDefaultTavernAssistantPreset();
    const apiSettingsRootRef = ref<HTMLElement | null>(null);
    const apiConfigSave = ref({ status: 'idle', requestId: '', error: '' });
    const apiConfigStatus = ref('');
    const preset = ref<TavernChatPromptPresetBundle>(initialChatPreset);
    const activeChatPreset = ref<TavernChatPromptPresetBundle>(initialChatPreset);
    const chatPresetList = ref<Record<string, unknown>>({});
    const presetStatus = ref('');
    const savedPresetJson = ref(JSON.stringify(initialChatPreset));
    const selectedPromptIdentifier = ref('');
    const assistantPreset = ref<TavernAssistantPreset>(initialAssistantPreset);
    const activeAssistantPreset = ref<TavernAssistantPreset>(initialAssistantPreset);
    const assistantPresets = ref<TavernAssistantPresetRecord[]>([]);
    const activeAssistantPresetId = ref('');
    const assistantPresetStatus = ref('');
    const savedAssistantPresetJson = ref(JSON.stringify(initialAssistantPreset));
    const selectedPresetSourceId = ref('');
    const selectedAssistantPresetItemId = ref('storyArcPrompt');
    const worldbookList = ref<Record<string, unknown>>({});
    const selectedWorldbookName = ref('');
    const worldbookStatus = ref('');
    const worldbookPreview = ref<TavernWorldbookPreviewRow | null>(null);
    const worldbookPreviewStatus = ref('');
    const chatPresetSourceSearchText = ref('');
    const chatPresetSourceVisibleLimit = ref(CHAT_PRESET_SOURCE_BATCH_SIZE);
    const assistantPresetSearchText = ref('');
    const assistantPresetVisibleLimit = ref(ASSISTANT_PRESET_BATCH_SIZE);
    const promptSearchText = ref('');
    const promptVisibleLimit = ref(PROMPT_EDITOR_BATCH_SIZE);
    const worldbookSearchText = ref('');
    const worldbookVisibleLimit = ref(WORLDBOOK_BATCH_SIZE);
    const worldbookPreviewVisibleLimit = ref(WORLDBOOK_PREVIEW_BATCH_SIZE);
    const regexSearchText = ref('');
    const regexGroupVisibleLimits = ref<Record<string, number>>({});
    const regexList = ref<Record<string, unknown>>({});
    const selectedRegexKey = ref('');
    const regexDraft = ref<TavernRegexScriptDraft>({});
    const activeRegexScriptJson = ref(snapshotNativeDraft(regexDraft.value));
    const regexStatus = ref('');

    const apiSettingsPanelState: Record<string, unknown> = {
        config: {},
        configDraft: null,
        configFormSyncPending: true,
        configPage: 'main',
        configSave: apiConfigSave.value,
        pullStateByProvider: {},
        modelOptionsByProvider: {},
    };
    let apiSettingsPanel: ReturnType<typeof createAgentSettingsPanel> | null = null;

    const snapshotPreset = (value = preset.value) => JSON.stringify(value || {});
    const snapshotAssistantPreset = (value = assistantPreset.value) => JSON.stringify(value || {});
    const presetDirty = computed(() => snapshotPreset(preset.value) !== savedPresetJson.value);
    const assistantPresetDirty = computed(() => snapshotAssistantPreset(assistantPreset.value) !== savedAssistantPresetJson.value);
    const resolvedProviderConfig = computed(() => resolveXbTavernProviderConfig(options.agentConfig.value));
    const apiReady = computed(() => resolvedProviderConfig.value.readiness.ok);
    const apiReadyDetail = computed(() => resolvedProviderConfig.value.readiness.message);
    const apiRuntimeLine = computed(() => {
        const config = resolvedProviderConfig.value;
        return `预设「${config.currentPresetName || '默认'}」 · ${config.providerLabel} / ${config.model || '未选择模型'}`;
    });

    const chatPresetOptions = computed<TavernChatPresetOptionRow[]>(() => {
        const components = promptRecord(chatPresetList.value.components);
        const names = Array.isArray(components.promptManager) ? components.promptManager : [];
        const activeName = String(preset.value.promptManager?.name || preset.value.name || '').trim();
        const seen = new Set<string>();
        return [activeName, ...names]
            .map((item) => {
                if (typeof item === 'string') {return item.trim();}
                const record = promptRecord(item);
                return String(record.name || record.label || record.id || '').trim();
            })
            .filter((name) => {
                if (!name || seen.has(name)) {return false;}
                seen.add(name);
                return true;
            })
            .map((name) => ({ name, label: name }));
    });
    const filteredChatPresetOptions = computed<TavernChatPresetOptionRow[]>(() => {
        const query = normalizedSearchText(chatPresetSourceSearchText.value);
        if (!query) {return chatPresetOptions.value;}
        return chatPresetOptions.value.filter((item) => includesSearch(item.label || item.name, query));
    });
    const visibleChatPresetOptions = computed(() => {
        const visible = filteredChatPresetOptions.value.slice(0, chatPresetSourceVisibleLimit.value);
        const selectedName = String(selectedPresetSourceId.value || preset.value.promptManager?.name || preset.value.name || '').trim();
        if (!selectedName || visible.some((item) => item.name === selectedName)) {return visible;}
        const selected = chatPresetOptions.value.find((item) => item.name === selectedName);
        return selected ? [selected, ...visible] : visible;
    });
    const hiddenChatPresetOptionCount = computed(() => Math.max(
        0,
        filteredChatPresetOptions.value.length - Math.min(filteredChatPresetOptions.value.length, chatPresetSourceVisibleLimit.value),
    ));
    const worldbookOptions = computed<TavernWorldbookOptionRow[]>(() => {
        const books = Array.isArray(worldbookList.value.books) ? worldbookList.value.books : [];
        return books.map((item) => {
            const record = promptRecord(item);
            return {
                name: String(record.name || '').trim(),
                globalActive: record.globalActive === true,
            };
        }).filter((item) => item.name);
    });
    const filteredWorldbookOptions = computed<TavernWorldbookOptionRow[]>(() => {
        const query = normalizedSearchText(worldbookSearchText.value);
        if (!query) {return worldbookOptions.value;}
        return worldbookOptions.value.filter((item) => includesSearch(item.name, query));
    });
    const visibleWorldbookOptions = computed(() => {
        const visible = filteredWorldbookOptions.value.slice(0, worldbookVisibleLimit.value);
        const selectedName = String(selectedWorldbookName.value || '').trim();
        if (!selectedName || visible.some((item) => item.name === selectedName)) {return visible;}
        const selected = worldbookOptions.value.find((item) => item.name === selectedName);
        return selected ? [selected, ...visible] : visible;
    });
    const hiddenWorldbookCount = computed(() => Math.max(
        0,
        filteredWorldbookOptions.value.length - Math.min(filteredWorldbookOptions.value.length, worldbookVisibleLimit.value),
    ));
    const selectedWorldbook = computed<TavernWorldbookOptionRow | null>(() => (
        worldbookOptions.value.find((item) => item.name === selectedWorldbookName.value) || null
    ));
    const worldbookGlobalCount = computed(() => worldbookOptions.value.filter((item) => item.globalActive).length);
    const hiddenWorldbookPreviewEntryCount = computed(() => {
        const preview = worldbookPreview.value;
        if (!preview || preview.name !== selectedWorldbookName.value) {return 0;}
        return Math.max(0, preview.entryCount - preview.entries.length);
    });
    const regexGroups = computed<TavernRegexGroupRow[]>(() => {
        const groups = Array.isArray(regexList.value.groups) ? regexList.value.groups : [];
        return groups.map((group) => {
            const record = promptRecord(group);
            const scripts = Array.isArray(record.scripts) ? record.scripts.map((script) => promptRecord(script) as TavernRegexScriptDraft) : [];
            return {
                key: String(record.key || ''),
                label: String(record.label || record.key || ''),
                scriptType: Number(record.scriptType),
                scripts,
                allowed: record.allowed === true,
            };
        }).filter((group) => group.key && Number.isFinite(group.scriptType));
    });
    const regexScriptRows = computed<TavernRegexScriptRow[]>(() => regexGroups.value.flatMap((group) => (
        group.scripts.map((script, index) => {
            const row: TavernRegexScriptRow = {
                key: `${group.scriptType}:${String(script.id || index)}`,
                groupKey: group.key,
                groupLabel: group.label,
                scriptType: group.scriptType,
                script,
            };
            row.searchCorpus = normalizedSearchText(buildSearchCorpus([
                row.groupLabel,
                row.script.scriptName,
                row.script.findRegex,
                row.script.replaceString,
                row.script.trimStrings,
                row.script.placement,
                row.key,
            ], 1200));
            return row;
        })
    )));
    function regexVisibleLimitForGroup(groupKey = '') {
        const value = Number(regexGroupVisibleLimits.value[groupKey]);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : REGEX_GROUP_BATCH_SIZE;
    }
    function expandRegexGroup(groupKey = '') {
        const current = regexVisibleLimitForGroup(groupKey);
        regexGroupVisibleLimits.value = {
            ...regexGroupVisibleLimits.value,
            [groupKey]: current + REGEX_GROUP_BATCH_SIZE,
        };
    }
    const regexGroupsForDisplay = computed<TavernRegexGroupDisplayRow[]>(() => {
        const query = normalizedSearchText(regexSearchText.value);
        const selectedKey = String(selectedRegexKey.value || '').trim();
        return regexGroups.value
            .map((group) => {
                const rows = regexScriptRows.value.filter((item) => item.groupKey === group.key);
                const filtered = query
                    ? rows.filter((row) => String(row.searchCorpus || '').includes(query))
                    : rows;
                const limit = regexVisibleLimitForGroup(group.key);
                const visibleRows = filtered.slice(0, limit);
                if (selectedKey && !visibleRows.some((row) => row.key === selectedKey)) {
                    const selected = rows.find((row) => row.key === selectedKey);
                    if (selected) {visibleRows.unshift(selected);}
                }
                return {
                    ...group,
                    visibleRows,
                    totalCount: rows.length,
                    filteredCount: filtered.length,
                    hiddenCount: Math.max(0, filtered.length - Math.min(filtered.length, limit)),
                };
            })
            .filter((group) => group.filteredCount || !query);
    });
    const selectedRegexRow = computed(() => regexScriptRows.value.find((row) => row.key === selectedRegexKey.value) || null);
    const regexDirty = computed(() => snapshotNativeDraft(regexDraft.value) !== activeRegexScriptJson.value);
    const settingsNavItems = computed<TavernSettingsNavItem[]>(() => [
        {
            key: 'worldbooks',
            label: '世界书',
            mobileLabel: '世界',
            badge: worldbookGlobalCount.value ? `${worldbookGlobalCount.value} 本全局` : '',
        },
        {
            key: 'chatPreset',
            label: '聊天预设',
            mobileLabel: '聊天预设',
            badge: presetDirty.value ? '未保存' : '',
        },
        {
            key: 'assistantPreset',
            label: '助手预设',
            mobileLabel: '助手',
            badge: assistantPresetDirty.value ? '未保存' : '',
        },
        {
            key: 'regex',
            label: '正则',
            badge: regexDirty.value ? '未保存' : '',
        },
        {
            key: 'api',
            label: 'API 配置',
            mobileLabel: 'API',
        },
    ]);
    const assistantPresetItems = computed<TavernAssistantPresetItemRow[]>(() => {
        return assistantPresetSections.map((section) => ({
            id: section.key,
            key: section.key,
            label: section.label,
            summary: section.summary,
            content: String(assistantPreset.value[section.key] || ''),
        }));
    });
    const filteredAssistantPresetRecords = computed<TavernAssistantPresetRecord[]>(() => {
        const query = normalizedSearchText(assistantPresetSearchText.value);
        if (!query) {return assistantPresets.value;}
        return assistantPresets.value.filter((item) => normalizedSearchText(buildSearchCorpus([
            item.name,
            item.description,
            item.id,
            item.preset?.name,
            item.preset?.description,
        ], 1200)).includes(query));
    });
    const visibleAssistantPresetRecords = computed(() => {
        const visible = filteredAssistantPresetRecords.value.slice(0, assistantPresetVisibleLimit.value);
        const selectedId = String(activeAssistantPresetId.value || assistantPreset.value.id || '').trim();
        if (!selectedId || visible.some((item) => item.id === selectedId)) {return visible;}
        const selected = assistantPresets.value.find((item) => item.id === selectedId);
        return selected ? [selected, ...visible] : visible;
    });
    const hiddenAssistantPresetCount = computed(() => Math.max(
        0,
        filteredAssistantPresetRecords.value.length - Math.min(filteredAssistantPresetRecords.value.length, assistantPresetVisibleLimit.value),
    ));
    const activeAssistantPresetRecord = computed(() => assistantPresets.value.find((item) => item.id === activeAssistantPresetId.value) || null);
    const selectedAssistantPresetItem = computed(() => (
        assistantPresetItems.value.find((item) => item.id === selectedAssistantPresetItemId.value)
        || assistantPresetItems.value[0]
        || null
    ));
    const canEditPromptOrder = computed(() => Boolean(getActivePromptCharacterId()));
    const promptEditorRows = computed<PromptEditorRow[]>(() => {
        const prompts = getPromptArrayDraft();
        const promptById = new Map(prompts.map((prompt, index) => [
            String(prompt.identifier || prompt.id || `prompt-${index + 1}`).trim(),
            prompt,
        ]));
        const order = getActivePromptOrderDraft();
        const seen = new Set<string>();
        const rows: PromptEditorRow[] = [];

        order.forEach((entry) => {
            const identifier = String(entry.identifier || '').trim();
            if (!identifier || seen.has(identifier)) {return;}
            const prompt = promptById.get(identifier) || { identifier, name: identifier };
            seen.add(identifier);
            rows.push({
                identifier,
                name: String(prompt.name || prompt.label || identifier),
                role: String(prompt.role || 'system'),
                content: String(prompt.content || ''),
                enabled: entry.enabled !== false,
                marker: prompt.marker === true,
                systemPrompt: prompt.system_prompt === true,
                injectionPosition: Number(prompt.injection_position ?? 0),
                injectionDepth: Number.isFinite(Number(prompt.injection_depth)) ? Number(prompt.injection_depth) : '',
                source: prompt.extension ? '扩展' : prompt.system_prompt ? '系统' : '预设',
                orderEntry: entry,
                prompt,
                listed: true,
                searchCorpus: normalizedSearchText(buildSearchCorpus([
                    prompt.name || prompt.label || identifier,
                    prompt.role || 'system',
                    prompt.extension ? '扩展' : prompt.system_prompt ? '系统' : '预设',
                    identifier,
                    prompt.content || '',
                ])),
            });
        });

        return rows;
    });
    const filteredPromptEditorRows = computed<PromptEditorRow[]>(() => {
        const query = normalizedSearchText(promptSearchText.value);
        if (!query) {return promptEditorRows.value;}
        return promptEditorRows.value.filter((row) => String(row.searchCorpus || '').includes(query));
    });
    const visiblePromptEditorRows = computed(() => {
        const visible = filteredPromptEditorRows.value.slice(0, promptVisibleLimit.value);
        const selectedId = String(selectedPromptIdentifier.value || '').trim();
        if (!selectedId || visible.some((row) => row.identifier === selectedId)) {return visible;}
        const selected = promptEditorRows.value.find((row) => row.identifier === selectedId);
        return selected ? [selected, ...visible] : visible;
    });
    const hiddenPromptCount = computed(() => Math.max(
        0,
        filteredPromptEditorRows.value.length - Math.min(filteredPromptEditorRows.value.length, promptVisibleLimit.value),
    ));
    const promptEditorRowIndexById = computed(() => new Map(promptEditorRows.value.map((row, index) => [row.identifier, index])));
    const selectedPromptRow = computed(() => promptEditorRows.value.find((row) => row.identifier === selectedPromptIdentifier.value) || promptEditorRows.value[0] || null);
    const activePromptOrderLabel = computed(() => {
        const activeCharacterId = getActivePromptCharacterId();
        return activeCharacterId ? '当前角色顺序' : '未读取到当前角色顺序';
    });
    const presetRows = computed(() => (preset.value.sections || [])
        .map((section, index) => ({
            ...section,
            previewId: section.id || `chat-preset-section-${index}`,
            previewLabel: section.label || section.source || `提示词 ${index + 1}`,
            previewPlacement: section.source === 'promptManager'
                ? (section.marker ? '酒馆标记' : '酒馆顺序')
                : (placementLabels[section.placement || 'beforeHistory'] || section.placement || '历史前'),
            sectionIndex: index,
            chars: String(section.content || '').length,
        }))
        .filter((row) => (row.content || row.marker) && row.enabled !== false));
    const presetTotalChars = computed(() => presetRows.value.reduce((sum, row) => sum + row.chars, 0));

    function worldbookSourceSummary(item: TavernWorldbookOptionRow): string {
        return item.globalActive ? '全局世界书' : '';
    }
    function promptRowIndex(identifier: string) {
        return promptEditorRowIndexById.value.get(identifier) ?? -1;
    }
    function getPromptManagerDraft(): Record<string, unknown> {
        return promptRecord(preset.value.promptManager);
    }
    function getRawPresetDraft(): Record<string, unknown> {
        const manager = getPromptManagerDraft();
        return promptRecord(manager.rawPreset);
    }
    function getPromptArrayDraft(): Record<string, unknown>[] {
        const raw = getRawPresetDraft();
        const manager = getPromptManagerDraft();
        const source = Array.isArray(raw.prompts)
            ? raw.prompts
            : Array.isArray(manager.prompts)
                ? manager.prompts
                : [];
        return source.map((item) => promptRecord(item)).filter((item) => String(item.identifier || item.id || '').trim());
    }
    function getPromptOrderContainersDraft(): Record<string, unknown>[] {
        const raw = getRawPresetDraft();
        const manager = getPromptManagerDraft();
        const source = Array.isArray(raw.prompt_order)
            ? raw.prompt_order
            : Array.isArray(manager.promptOrder)
                ? manager.promptOrder
                : [];
        return source.map((item) => promptRecord(item));
    }
    function getActivePromptOrderDraft(): Record<string, unknown>[] {
        const manager = getPromptManagerDraft();
        const activeOrder = Array.isArray(manager.activeOrder) ? manager.activeOrder.map((item) => promptRecord(item)) : [];
        if (activeOrder.length) {return activeOrder;}
        const activeCharacterId = String(manager.activeCharacterId ?? '').trim();
        if (!activeCharacterId) {return [];}
        const containers = getPromptOrderContainersDraft();
        const activeContainer = containers.find((item) => String(item.character_id ?? '') === activeCharacterId);
        return Array.isArray(activeContainer?.order) ? activeContainer.order.map((item) => promptRecord(item)) : [];
    }
    function getActivePromptCharacterId(): string {
        return String(getPromptManagerDraft().activeCharacterId ?? '').trim();
    }
    function applyActiveChatPreset(next: Partial<TavernChatPromptPresetBundle> = {}, applyOptions: { replaceDraft?: boolean } = {}) {
        const normalized = normalizeTavernChatPromptPresetBundle(next);
        activeChatPreset.value = normalized;
        savedPresetJson.value = snapshotPreset(normalized);
        selectedPresetSourceId.value = String(normalized.promptManager?.name || normalized.name || '').trim();
        if (applyOptions.replaceDraft !== false) {
            preset.value = normalized;
        }
    }
    function applyActiveRegexScript(row: TavernRegexScriptRow | null) {
        if (!row) {
            regexDraft.value = {};
            activeRegexScriptJson.value = snapshotNativeDraft({});
            selectedRegexKey.value = '';
            return;
        }
        const normalized = normalizeRegexDraft(row.script);
        regexDraft.value = normalized;
        activeRegexScriptJson.value = snapshotNativeDraft(normalized);
        selectedRegexKey.value = row.key;
    }
    function applyActiveAssistantPreset(next: Partial<TavernAssistantPreset> = {}, applyOptions: { replaceDraft?: boolean } = {}) {
        const normalized = normalizeTavernAssistantPreset(next);
        activeAssistantPreset.value = normalized;
        savedAssistantPresetJson.value = snapshotAssistantPreset(normalized);
        if (applyOptions.replaceDraft !== false) {
            assistantPreset.value = normalized;
        }
    }
    function confirmDiscardDraft(label: string, action = '继续？') {
        return window.confirm(`当前${label}有未保存修改，${action}会放弃这些草稿。继续？`);
    }
    async function refreshPresets() {
        if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '刷新')) {
            assistantPresetStatus.value = '';
            return;
        }
        const [loadedAssistantPresets, activeAssistantId, loadedAssistantPreset] = await Promise.all([
            listTavernAssistantPresets(),
            getActiveTavernAssistantPresetId(),
            loadActiveTavernAssistantPreset(),
        ]);
        assistantPresets.value = loadedAssistantPresets;
        activeAssistantPresetId.value = activeAssistantId || loadedAssistantPreset.id;
        applyActiveAssistantPreset(loadedAssistantPreset, { replaceDraft: !assistantPresetDirty.value });
    }
    async function syncChatPresetFromHost() {
        if (presetDirty.value) {
            presetStatus.value = '';
            return;
        }
        presetStatus.value = '正在同步';
        try {
            const result = await options.requestHost('xb-tavern:list-chat-presets');
            const payload = (result.result || result) as Record<string, unknown>;
            chatPresetList.value = payload;
            applyActiveChatPreset(payload.active as Partial<TavernChatPromptPresetBundle>);
            presetStatus.value = '';
        } catch (error) {
            presetStatus.value = error instanceof Error ? error.message : String(error || '读取失败');
        }
    }
    async function selectChatPresetFromHost(name = selectedPresetSourceId.value) {
        const presetName = String(name || '').trim();
        const currentName = String(preset.value.promptManager?.name || preset.value.name || '').trim();
        if (!presetName) {
            selectedPresetSourceId.value = currentName;
            return;
        }
        if (presetName === currentName) {
            selectedPresetSourceId.value = currentName;
            return;
        }
        if (presetDirty.value && !confirmDiscardDraft('聊天预设', '切换')) {
            selectedPresetSourceId.value = currentName;
            return;
        }
        presetStatus.value = '正在切换';
        try {
            const result = await options.requestHost('xb-tavern:select-chat-preset', {
                payload: { promptManagerName: presetName },
            });
            const nextPreset = (result.result || result) as Partial<TavernChatPromptPresetBundle>;
            applyActiveChatPreset(nextPreset);
            presetStatus.value = '';
            options.postToHost('xb-tavern:refresh-context', {});
        } catch (error) {
            selectedPresetSourceId.value = currentName;
            presetStatus.value = error instanceof Error ? error.message : String(error || '切换失败');
        }
    }
    async function saveCurrentPreset() {
        if (!canEditPromptOrder.value) {
            presetStatus.value = '未读取到当前角色顺序，请刷新后再保存';
            return;
        }
        if (!presetDirty.value) {
            return;
        }
        presetStatus.value = '正在保存';
        const result = await options.requestHost('xb-tavern:save-chat-preset', {
            payload: preset.value as unknown as Record<string, unknown>,
        });
        if (result.ok === false) {
            presetStatus.value = String(result.error || '保存失败');
            return;
        }
        applyActiveChatPreset(result.result as Partial<TavernChatPromptPresetBundle>);
        presetStatus.value = '';
        options.postToHost('xb-tavern:refresh-context', {});
    }
    async function syncWorldbooksFromHost(syncOptions: { keepSelection?: boolean } = {}) {
        worldbookStatus.value = '正在同步';
        try {
            const result = await options.requestHost('xb-tavern:list-worldbook-sources', {
                payload: {
                    context: options.effectiveContext.value,
                },
            });
            const payload = (result.result || result) as Record<string, unknown>;
            worldbookList.value = payload;
            const currentName = String(selectedWorldbookName.value || '').trim();
            const selectedStillExists = !!currentName
                && worldbookOptions.value.some((item) => item.name === currentName);
            const preferredName = worldbookOptions.value.find((item) => item.globalActive)?.name
                || worldbookOptions.value[0]?.name
                || '';
            selectedWorldbookName.value = syncOptions.keepSelection && selectedStillExists
                ? selectedWorldbookName.value
                : preferredName;
            worldbookStatus.value = '';
            void loadSelectedWorldbookPreview(selectedWorldbookName.value);
        } catch (error) {
            worldbookStatus.value = error instanceof Error ? error.message : String(error || '读取失败');
        }
    }
    async function loadSelectedWorldbookPreview(name = selectedWorldbookName.value) {
        const targetName = String(name || '').trim();
        if (!targetName) {
            worldbookPreview.value = null;
            worldbookPreviewStatus.value = '';
            return;
        }
        const requestName = targetName;
        worldbookPreviewStatus.value = '正在读取预览';
        try {
            const result = await options.requestHost('xb-tavern:get-worldbook-preview', {
                payload: {
                    name: requestName,
                    limit: worldbookPreviewVisibleLimit.value,
                },
            });
            if (String(selectedWorldbookName.value || '').trim() !== requestName) {return;}
            worldbookPreview.value = normalizeWorldbookPreview(result.result || result);
            worldbookPreviewStatus.value = '';
        } catch (error) {
            if (String(selectedWorldbookName.value || '').trim() !== requestName) {return;}
            worldbookPreview.value = null;
            worldbookPreviewStatus.value = error instanceof Error ? error.message : String(error || '预览读取失败');
        }
    }
    function showMoreWorldbookPreviewEntries() {
        if (!selectedWorldbookName.value) {return;}
        worldbookPreviewVisibleLimit.value += WORLDBOOK_PREVIEW_BATCH_SIZE;
        void loadSelectedWorldbookPreview(selectedWorldbookName.value);
    }
    async function openSelectedWorldbookEditor(name = selectedWorldbookName.value) {
        const targetName = String(name || '').trim();
        if (!targetName) {return;}
        worldbookStatus.value = '正在打开酒馆编辑器';
        try {
            await options.requestHost('xb-tavern:open-worldbook-editor', {
                payload: { name: targetName },
            });
            worldbookStatus.value = '';
            options.postToHost('xb-tavern:close');
        } catch (error) {
            worldbookStatus.value = error instanceof Error ? error.message : String(error || '打开失败');
        }
    }
    async function refreshRegexFromHost() {
        if (regexDirty.value && !confirmDiscardDraft('正则', '刷新')) {
            regexStatus.value = '';
            return;
        }
        regexStatus.value = '正在读取';
        try {
            const result = await options.requestHost('xb-tavern:list-regex-scripts');
            regexList.value = (result.result || result) as Record<string, unknown>;
            const current = regexScriptRows.value.find((row) => row.key === selectedRegexKey.value);
            applyActiveRegexScript(current || regexScriptRows.value[0] || null);
            regexStatus.value = '';
        } catch (error) {
            regexStatus.value = error instanceof Error ? error.message : String(error || '读取失败');
        }
    }
    function selectRegexScript(row: TavernRegexScriptRow) {
        if (regexDirty.value && !confirmDiscardDraft('正则', '切换')) {
            return;
        }
        applyActiveRegexScript(row);
    }
    function createRegexScript(group: TavernRegexGroupRow) {
        if (regexDirty.value && !confirmDiscardDraft('正则', '新建')) {
            return;
        }
        const draft = normalizeRegexDraft({
            scriptName: '新正则',
            findRegex: '',
            replaceString: '',
            trimStrings: [],
            placement: [],
            disabled: false,
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: false,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        });
        regexDraft.value = draft;
        activeRegexScriptJson.value = '';
        selectedRegexKey.value = `${group.scriptType}:new`;
    }
    function updateRegexPatch(patch: Partial<TavernRegexScriptDraft>) {
        regexDraft.value = normalizeRegexDraft({
            ...regexDraft.value,
            ...patch,
        });
    }
    function toggleRegexPlacement(value: number, checked: boolean) {
        const current = new Set((regexDraft.value.placement || []).map((item) => Number(item)));
        if (checked) {
            current.add(value);
        } else {
            current.delete(value);
        }
        updateRegexPatch({ placement: [...current] });
    }
    async function saveCurrentRegexScript() {
        const scriptType = selectedRegexRow.value?.scriptType || Number(selectedRegexKey.value.split(':')[0]);
        if (!Number.isFinite(scriptType)) {return;}
        if (!regexDirty.value) {
            return;
        }
        regexStatus.value = '正在保存';
        try {
            const result = await options.requestHost('xb-tavern:save-regex-script', {
                payload: {
                    scriptType,
                    script: regexDraft.value,
                },
            });
            const payload = (result.result || result) as Record<string, unknown>;
            regexList.value = payload;
            const savedId = String(payload.savedScriptId || regexDraft.value.id || '');
            const savedType = Number(payload.savedScriptType ?? scriptType);
            const nextRow = regexScriptRows.value.find((row) => row.scriptType === savedType && savedId && row.script.id === savedId)
                || regexScriptRows.value.find((row) => row.script.scriptName === regexDraft.value.scriptName)
                || regexScriptRows.value[0]
                || null;
            applyActiveRegexScript(nextRow);
            regexStatus.value = '';
        } catch (error) {
            regexStatus.value = error instanceof Error ? error.message : String(error || '保存失败');
        }
    }
    async function deleteCurrentRegexScript() {
        const row = selectedRegexRow.value;
        if (row) {
            await deleteRegexScript(row);
            return;
        }
        const id = String(regexDraft.value.id || '');
        const scriptType = Number(selectedRegexKey.value.split(':')[0]);
        if (!id || !Number.isFinite(scriptType)) {return;}
        await deleteRegexScript({
            key: `${scriptType}:${id}`,
            groupKey: '',
            groupLabel: '',
            scriptType,
            script: regexDraft.value,
        });
    }
    async function deleteRegexScript(row: TavernRegexScriptRow) {
        if (regexDirty.value && selectedRegexKey.value !== row.key && !confirmDiscardDraft('正则', '删除')) {
            return;
        }
        const id = String(row?.script.id || '');
        const scriptType = row?.scriptType;
        if (!id || !Number.isFinite(scriptType)) {return;}
        if (!window.confirm('删除这个正则脚本？')) {return;}
        regexStatus.value = '正在删除';
        try {
            const result = await options.requestHost('xb-tavern:delete-regex-script', {
                payload: { scriptType, id },
            });
            regexList.value = (result.result || result) as Record<string, unknown>;
            applyActiveRegexScript(regexScriptRows.value[0] || null);
            regexStatus.value = '';
        } catch (error) {
            regexStatus.value = error instanceof Error ? error.message : String(error || '删除失败');
        }
    }
    async function discardPresetChanges() {
        if (!presetDirty.value) {return;}
        preset.value = normalizeTavernChatPromptPresetBundle(activeChatPreset.value);
        savedPresetJson.value = snapshotPreset(activeChatPreset.value);
        presetStatus.value = '';
    }
    function updateChatPresetComponent(
        key: 'promptManager' | 'systemPrompt' | 'contextTemplate' | 'instructTemplate',
        patch: Record<string, unknown>,
    ) {
        preset.value = normalizeTavernChatPromptPresetBundle({
            ...preset.value,
            [key]: {
                ...((preset.value[key] || {}) as Record<string, unknown>),
                ...patch,
            },
        });
    }
    function commitPromptManagerDraft(rawPreset: Record<string, unknown>, patch: Record<string, unknown> = {}) {
        const prompts = Array.isArray(rawPreset.prompts) ? rawPreset.prompts : [];
        const promptOrder = Array.isArray(rawPreset.prompt_order) ? rawPreset.prompt_order : [];
        updateChatPresetComponent('promptManager', {
            rawPreset,
            prompts,
            promptOrder,
            ...patch,
        });
    }
    function updatePromptByIdentifier(identifier: string, patch: Record<string, unknown>) {
        const targetId = String(identifier || '').trim();
        if (!targetId) {return;}
        const rawPreset = clonePromptJson(getRawPresetDraft());
        const prompts = getPromptArrayDraft().map((prompt) => ({ ...prompt }));
        const index = prompts.findIndex((prompt) => String(prompt.identifier || prompt.id || '').trim() === targetId);
        if (index >= 0) {
            prompts[index] = {
                ...prompts[index],
                ...patch,
                identifier: targetId,
            };
        } else {
            prompts.push({
                identifier: targetId,
                name: targetId,
                role: 'system',
                content: '',
                ...patch,
            });
        }
        rawPreset.prompts = prompts;
        commitPromptManagerDraft(rawPreset);
    }
    function setActivePromptOrder(nextOrder: Record<string, unknown>[]) {
        const rawPreset = clonePromptJson(getRawPresetDraft());
        const manager = getPromptManagerDraft();
        const containers = getPromptOrderContainersDraft().map((item) => ({ ...item }));
        const activeCharacterId = String(manager.activeCharacterId ?? '').trim();
        if (!activeCharacterId) {
            presetStatus.value = '未读取到当前角色顺序，请刷新后再保存';
            return;
        }
        let targetIndex = containers.findIndex((item) => String(item.character_id ?? '') === activeCharacterId);
        if (targetIndex < 0) {
            targetIndex = containers.length;
            containers.push({
                character_id: activeCharacterId,
                order: [],
            });
        }
        containers[targetIndex] = {
            ...containers[targetIndex],
            order: nextOrder,
        };
        rawPreset.prompt_order = containers;
        commitPromptManagerDraft(rawPreset, { activeOrder: nextOrder });
    }
    function buildCurrentPromptOrderFromRows(rows = promptEditorRows.value): Record<string, unknown>[] {
        return rows
            .filter((row) => row.listed)
            .map((row) => ({
                ...row.orderEntry,
                identifier: row.identifier,
                enabled: row.enabled,
            }));
    }
    function updatePromptOrderEntry(identifier: string, patch: Record<string, unknown>) {
        const targetId = String(identifier || '').trim();
        if (!canEditPromptOrder.value) {
            presetStatus.value = '未读取到当前角色顺序，请刷新后再保存';
            return;
        }
        if (!targetId) {return;}
        const rows = promptEditorRows.value;
        const nextOrder = buildCurrentPromptOrderFromRows(rows).map((entry) => (
            String(entry.identifier || '').trim() === targetId
                ? { ...entry, ...patch, identifier: targetId }
                : entry
        ));
        setActivePromptOrder(nextOrder);
    }
    function movePromptRow(identifier: string, direction: -1 | 1) {
        if (!canEditPromptOrder.value) {
            presetStatus.value = '未读取到当前角色顺序，请刷新后再保存';
            return;
        }
        const rows = promptEditorRows.value;
        const index = rows.findIndex((row) => row.identifier === identifier);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) {return;}
        const nextRows = rows.slice();
        const [item] = nextRows.splice(index, 1);
        if (!item) {return;}
        nextRows.splice(nextIndex, 0, item);
        setActivePromptOrder(buildCurrentPromptOrderFromRows(nextRows));
        selectedPromptIdentifier.value = identifier;
    }
    function togglePromptRow(identifier: string, enabled: boolean) {
        updatePromptOrderEntry(identifier, { enabled });
    }
    function promptRoleDisplay(role = ''): string {
        const labels: Record<string, string> = {
            system: '系统',
            user: '用户',
            assistant: '助手',
        };
        const key = String(role || 'system').trim();
        return labels[key] || key || '系统';
    }
    function linesFromList(value: unknown): string {
        if (Array.isArray(value)) {
            return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n');
        }
        return String(value || '');
    }
    function listFromLines(value = ''): string[] {
        return String(value || '')
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
    }
    function regexPlacementLabel(value: number): string {
        const labels: Record<number, string> = {
            1: '用户输入',
            2: 'AI 回复',
            3: '斜杠命令',
            5: '世界书',
            6: '推理内容',
        };
        return labels[value] || String(value);
    }
    function regexGroupByType(scriptType: number): TavernRegexGroupRow | undefined {
        return regexGroups.value.find((group) => group.scriptType === scriptType);
    }
    function regexDraftTypeLabel(): string {
        const scriptType = selectedRegexRow.value?.scriptType || Number(selectedRegexKey.value.split(':')[0]);
        return regexGroupByType(scriptType)?.label || '正则';
    }
    function updateAssistantPresetPatch(patch: Partial<TavernAssistantPreset>) {
        assistantPreset.value = {
            ...assistantPreset.value,
            ...patch,
        };
    }
    function selectAssistantPresetItem(itemId: string) {
        selectedAssistantPresetItemId.value = itemId;
    }
    function updateSelectedAssistantPresetItem(value = '') {
        const item = selectedAssistantPresetItem.value;
        if (!item) {return;}
        updateAssistantPresetPatch({ [item.key]: String(value || '') } as Partial<TavernAssistantPreset>);
    }
    async function selectAssistantPreset(presetId: string) {
        const targetId = String(presetId || '').trim();
        if (!targetId || targetId === activeAssistantPresetId.value) {return;}
        if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '切换')) {
            return;
        }
        await setActiveTavernAssistantPresetId(targetId);
        activeAssistantPresetId.value = targetId;
        applyActiveAssistantPreset(await loadActiveTavernAssistantPreset());
        assistantPresetStatus.value = '';
    }
    async function saveCurrentAssistantPreset() {
        if (!assistantPresetDirty.value) {
            return;
        }
        const savingBuiltIn = String(activeAssistantPresetRecord.value?.id || '') === DEFAULT_TAVERN_ASSISTANT_PRESET_ID;
        const presetForSave = savingBuiltIn
            ? {
                ...assistantPreset.value,
                id: `assistant-preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name: `${assistantPreset.value.name || '助手预设'} 自定义`,
            }
            : assistantPreset.value;
        const record = await saveTavernAssistantPreset(presetForSave);
        await setActiveTavernAssistantPresetId(record.id);
        activeAssistantPresetId.value = record.id;
        applyActiveAssistantPreset(record.preset);
        assistantPresets.value = await listTavernAssistantPresets();
        assistantPresetStatus.value = '';
    }
    async function deriveAssistantPreset() {
        const record = await saveTavernAssistantPreset({
            ...assistantPreset.value,
            id: `assistant-preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: `${assistantPreset.value.name || '助手预设'} 副本`,
        });
        await setActiveTavernAssistantPresetId(record.id);
        activeAssistantPresetId.value = record.id;
        applyActiveAssistantPreset(record.preset);
        assistantPresets.value = await listTavernAssistantPresets();
        assistantPresetStatus.value = '';
    }
    async function createAssistantPreset() {
        if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '新建')) {
            return;
        }
        const record = await saveTavernAssistantPreset({
            ...createDefaultTavernAssistantPreset(),
            id: `assistant-preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: '新助手预设',
            description: '',
        });
        await setActiveTavernAssistantPresetId(record.id);
        activeAssistantPresetId.value = record.id;
        applyActiveAssistantPreset(record.preset);
        assistantPresets.value = await listTavernAssistantPresets();
        assistantPresetStatus.value = '';
    }
    async function importAssistantPreset(payload: unknown) {
        if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '导入')) {
            return false;
        }
        const source = payload && typeof payload === 'object'
            ? payload as Record<string, unknown>
            : {};
        const presetSource = source.preset && typeof source.preset === 'object'
            ? source.preset as Record<string, unknown>
            : source;
        const record = await saveTavernAssistantPreset({
            ...presetSource,
            id: `assistant-preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: String(presetSource.name || source.name || '导入助手预设').trim() || '导入助手预设',
            description: String(presetSource.description || source.description || '').trim(),
        });
        await setActiveTavernAssistantPresetId(record.id);
        activeAssistantPresetId.value = record.id;
        applyActiveAssistantPreset(record.preset);
        assistantPresets.value = await listTavernAssistantPresets();
        assistantPresetStatus.value = '';
        return true;
    }
    async function deleteCurrentAssistantPreset() {
        const targetId = String(activeAssistantPresetId.value || assistantPreset.value.id || '').trim();
        const record = assistantPresets.value.find((item) => item.id === targetId) || null;
        if (!record || record.id === DEFAULT_TAVERN_ASSISTANT_PRESET_ID) {return;}
        if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '删除')) {
            return;
        }
        if (!window.confirm(`删除「${record.name || '当前助手预设'}」？`)) {return;}
        await deleteTavernAssistantPreset(record.id);
        assistantPresets.value = await listTavernAssistantPresets();
        activeAssistantPresetId.value = await getActiveTavernAssistantPresetId();
        applyActiveAssistantPreset(await loadActiveTavernAssistantPreset());
        assistantPresetStatus.value = '';
    }
    async function discardAssistantPresetChanges() {
        if (!assistantPresetDirty.value) {return;}
        assistantPreset.value = { ...activeAssistantPreset.value };
        savedAssistantPresetJson.value = snapshotAssistantPreset(activeAssistantPreset.value);
        assistantPresetStatus.value = '';
    }
    function syncApiSettingsConfigFromAgentConfig() {
        apiSettingsPanelState.config = normalizeAgentConfig(options.agentConfig.value || {});
        apiSettingsPanelState.configDraft = null;
        apiSettingsPanelState.configFormSyncPending = true;
    }
    function beginApiConfigSave(requestId = '') {
        apiConfigSave.value = { status: 'saving', requestId, error: '' };
        apiSettingsPanelState.configSave = apiConfigSave.value;
        apiConfigStatus.value = '正在保存共享 API 配置...';
        void nextTick(renderApiSettingsPanel);
    }
    function completeApiConfigSave(requestId = '', result: { ok?: boolean; error?: string } = {}) {
        if (requestId && apiConfigSave.value.requestId && requestId !== apiConfigSave.value.requestId) {return;}
        apiConfigSave.value = {
            status: result.ok ? 'success' : 'error',
            requestId,
            error: result.error || '',
        };
        apiSettingsPanelState.configSave = apiConfigSave.value;
        apiConfigStatus.value = result.ok ? '' : `保存失败：${result.error || 'unknown_error'}`;
        window.setTimeout(() => {
            if (apiConfigSave.value.requestId !== requestId || apiConfigSave.value.status !== 'success') {return;}
            apiConfigSave.value = { status: 'idle', requestId: '', error: '' };
            apiSettingsPanelState.configSave = apiConfigSave.value;
            apiConfigStatus.value = '';
            void nextTick(renderApiSettingsPanel);
        }, 1400);
        void nextTick(renderApiSettingsPanel);
    }
    function handleApiConfigSave(payload: { requestId?: string; payload?: Record<string, unknown> }) {
        const requestId = String(payload.requestId || `save-config-${Date.now()}`);
        beginApiConfigSave(requestId);
        options.postToHost('xb-tavern:save-config', {
            requestId,
            payload: payload.payload || {},
        });
    }
    function renderApiSettingsPanel() {
        const root = apiSettingsRootRef.value;
        if (!root) {return;}
        if (!apiSettingsPanel) {
            apiSettingsPanel = createAgentSettingsPanel({
                state: apiSettingsPanelState,
                render: renderApiSettingsPanel,
                describeError: options.describeError,
                showToast: (message: string) => {
                    apiConfigStatus.value = String(message || '');
                },
                saveConfig: handleApiConfigSave,
                getRuntimeSummaryText: () => apiRuntimeLine.value,
            });
        }
        apiSettingsPanelState.configSave = apiConfigSave.value;
        // The settings panel markup is generated by our first-party shared config renderer.
        // eslint-disable-next-line no-unsanitized/property
        root.innerHTML = buildAgentSettingsPanelMarkup({
            configSave: apiConfigSave.value,
            runtimeText: apiRuntimeLine.value,
            inlineToastText: apiConfigStatus.value,
            showAssistantPermissions: false,
            showDelegateSettings: true,
            activePage: String(apiSettingsPanelState.configPage || 'main'),
            delegatePresetHint: '记忆整理会复用这里的分身 API；当前聊天仍使用主 API。',
            isBusy: options.isRunning.value,
            canDeletePreset: Object.keys((apiSettingsPanelState.config as Record<string, unknown>)?.presets || {}).length > 1,
        });
        apiSettingsPanel.syncConfigToForm(root);
        apiSettingsPanel.bindSettingsPanelEvents(root);
    }
    function handleApiConfigSaved(payload: Record<string, unknown>) {
        const ok = payload.ok === true;
        if (ok) {
            options.agentConfig.value = payload.config as Record<string, unknown> || options.agentConfig.value;
            syncApiSettingsConfigFromAgentConfig();
            completeApiConfigSave(String(payload.requestId || ''), { ok: true });
            return;
        }
        syncApiSettingsConfigFromAgentConfig();
        completeApiConfigSave(String(payload.requestId || ''), {
            ok: false,
            error: String(payload.error || '保存失败'),
        });
    }
    function applyHostChatPreset(payload: Record<string, unknown>) {
        if ('chatPreset' in payload) {
            applyActiveChatPreset(payload.chatPreset as Partial<TavernChatPromptPresetBundle>, {
                replaceDraft: !presetDirty.value,
            });
        }
        if ('chatPresetList' in payload) {
            chatPresetList.value = payload.chatPresetList as Record<string, unknown> || {};
        }
    }
    function openSettingsWorkspace(workspace: TavernSettingsWorkspaceKey) {
        options.activeSettingsWorkspace.value = workspace;
        options.activeView.value = 'settings';
    }
    function selectSettingsWorkspace(workspace: string) {
        const normalized = workspace as TavernSettingsWorkspaceKey;
        if (normalized === 'api'
            || normalized === 'chatPreset'
            || normalized === 'worldbooks'
            || normalized === 'regex'
            || normalized === 'assistantPreset') {
            openSettingsWorkspace(normalized);
        }
    }

    watch(promptEditorRows, (rows) => {
        if (!rows.length) {
            selectedPromptIdentifier.value = '';
            return;
        }
        if (!rows.some((row) => row.identifier === selectedPromptIdentifier.value)) {
            selectedPromptIdentifier.value = rows[0]?.identifier || '';
        }
    }, { immediate: true });
    watch(chatPresetSourceSearchText, () => {
        chatPresetSourceVisibleLimit.value = CHAT_PRESET_SOURCE_BATCH_SIZE;
    });
    watch(assistantPresetSearchText, () => {
        assistantPresetVisibleLimit.value = ASSISTANT_PRESET_BATCH_SIZE;
    });
    watch(promptSearchText, () => {
        promptVisibleLimit.value = PROMPT_EDITOR_BATCH_SIZE;
    });
    watch(worldbookSearchText, () => {
        worldbookVisibleLimit.value = WORLDBOOK_BATCH_SIZE;
    });
    watch(regexSearchText, () => {
        regexGroupVisibleLimits.value = {};
    });
    watch(assistantPresetItems, (items) => {
        if (!items.length) {
            selectedAssistantPresetItemId.value = '';
            return;
        }
        if (!items.some((item) => item.id === selectedAssistantPresetItemId.value)) {
            selectedAssistantPresetItemId.value = items[0]?.id || '';
        }
    }, { immediate: true });
    watch([
        () => options.activeSettingsWorkspace.value,
        () => options.activeView.value,
        () => apiConfigSave.value.status,
        () => options.agentConfig.value,
    ], () => {
        if (options.activeView.value === 'settings' && options.activeSettingsWorkspace.value === 'api') {
            void nextTick(renderApiSettingsPanel);
        }
        if (options.activeView.value === 'settings' && options.activeSettingsWorkspace.value === 'regex' && !regexGroups.value.length) {
            void refreshRegexFromHost();
        }
    });
    watch([options.activeView, options.activeSettingsWorkspace], ([view, workspace], [previousView, previousWorkspace]) => {
        if (
            view === 'settings'
            && workspace === 'chatPreset'
            && (previousView !== view || previousWorkspace !== workspace)
        ) {
            void syncChatPresetFromHost();
        }
        if (
            view === 'settings'
            && workspace === 'worldbooks'
            && (previousView !== view || previousWorkspace !== workspace)
        ) {
            void syncWorldbooksFromHost({ keepSelection: true });
        }
    });
    watch(selectedWorldbookName, (name) => {
        if (options.activeView.value !== 'settings' || options.activeSettingsWorkspace.value !== 'worldbooks') {return;}
        worldbookPreviewVisibleLimit.value = WORLDBOOK_PREVIEW_BATCH_SIZE;
        void loadSelectedWorldbookPreview(name);
    });

    const settingsContext = {
        activeAssistantPresetId,
        activePromptOrderLabel,
        activeSettingsWorkspace: options.activeSettingsWorkspace,
        activeView: options.activeView,
        apiReady,
        apiReadyDetail,
        apiRuntimeLine,
        apiSettingsRootRef,
        applyActiveRegexScript,
        ASSISTANT_PRESET_BATCH_SIZE,
        assistantPreset,
        assistantPresetDirty,
        assistantPresetItems,
        assistantPresets,
        assistantPresetSearchText,
        assistantPresetStatus,
        assistantPresetVisibleLimit,
        canEditPromptOrder,
        chatPresetOptions,
        chatPresetSourceSearchText,
        chatPresetSourceVisibleLimit,
        CHAT_PRESET_SOURCE_BATCH_SIZE,
        createAssistantPreset,
        createRegexScript,
        deleteCurrentAssistantPreset,
        deleteCurrentRegexScript,
        deleteRegexScript,
        deriveAssistantPreset,
        discardAssistantPresetChanges,
        discardPresetChanges,
        expandRegexGroup,
        filteredPromptEditorRows,
        hiddenAssistantPresetCount,
        hiddenChatPresetOptionCount,
        hiddenPromptCount,
        hiddenWorldbookCount,
        hiddenWorldbookPreviewEntryCount,
        homeThemeDark: options.homeThemeDark,
        importAssistantPreset,
        linesFromList,
        listFromLines,
        movePromptRow,
        openSelectedWorldbookEditor,
        postToHost: options.postToHost,
        preset,
        presetDirty,
        presetRows,
        presetStatus,
        presetTotalChars,
        PROMPT_EDITOR_BATCH_SIZE,
        promptEditorRows,
        promptRoleDisplay,
        promptRowIndex,
        promptSearchText,
        promptVisibleLimit,
        refreshRegexFromHost,
        REGEX_GROUP_BATCH_SIZE,
        regexDirty,
        regexDraft,
        regexDraftTypeLabel,
        regexGroups,
        regexGroupsForDisplay,
        regexPlacementLabel,
        regexScriptRows,
        regexSearchText,
        regexStatus,
        saveCurrentAssistantPreset,
        saveCurrentPreset,
        saveCurrentRegexScript,
        selectAssistantPreset,
        selectAssistantPresetItem,
        selectChatPresetFromHost,
        selectedAssistantPresetItem,
        selectedPresetSourceId,
        selectedPromptIdentifier,
        selectedPromptRow,
        selectedRegexKey,
        selectedRegexRow,
        selectedWorldbook,
        selectedWorldbookName,
        selectRegexScript,
        selectSettingsWorkspace,
        settingsNavItems,
        shortText: options.shortText,
        showMoreWorldbookPreviewEntries,
        syncWorldbooksFromHost,
        togglePromptRow,
        toggleRegexPlacement,
        updateAssistantPresetPatch,
        updatePromptByIdentifier,
        updateRegexPatch,
        updateSelectedAssistantPresetItem,
        visibleAssistantPresetRecords,
        visibleChatPresetOptions,
        visiblePromptEditorRows,
        visibleWorldbookOptions,
        WORLDBOOK_BATCH_SIZE,
        WORLDBOOK_PREVIEW_BATCH_SIZE,
        worldbookGlobalCount,
        worldbookOptions,
        worldbookPreview,
        worldbookPreviewStatus,
        worldbookPreviewVisibleLimit,
        worldbookSearchText,
        worldbookSourceSummary,
        worldbookStatus,
        worldbookVisibleLimit,
    };

    return {
        activeAssistantPreset,
        activeChatPreset,
        apiReady,
        apiReadyDetail,
        apiRuntimeLine,
        apiSettingsRootRef,
        applyHostChatPreset,
        handleApiConfigSaved,
        openSettingsWorkspace,
        refreshPresets,
        refreshRegexFromHost,
        renderApiSettingsPanel,
        selectSettingsWorkspace,
        settingsContext,
        syncApiSettingsConfigFromAgentConfig,
        syncChatPresetFromHost,
        syncWorldbooksFromHost,
    };
}
