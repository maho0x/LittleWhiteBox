<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { enhanceMarkdownContent, renderMarkdownToHtml } from '../../agent-core/ui/message-markdown.js';
import { createAgentSettingsPanel } from '../../agent-core/ui/settings-panel.js';
import { buildAgentSettingsPanelMarkup } from '../../agent-core/ui/settings-markup.js';
import {
    AGENT_MESSAGE_WINDOW_DEFAULT,
    expandMessageWindow,
    getMessageWindow,
    resetMessageWindow,
} from './message-window';
import { normalizeAgentConfig } from '../../agent-core/config.js';
import { setHostChatCompletionsRequestHeadersProvider } from '../../../shared/host-llm/chat-completions/client.js';
import {
    type XbTavernCharacter,
    type XbTavernContext,
    type XbTavernMessage,
    type XbTavernNativeWorldInfoRuntime,
    type TavernChatPromptPresetBundle,
} from '../shared/message-assembler';
import { buildXbTavernBrain } from '../shared/brain';
import {
    getXbTavernMemoryTokenizerStatus,
    preloadXbTavernMemoryTokenizer,
} from '../shared/memory-retrieval';
import {
    getTavernMemoryIndex,
    getTavernMemoryFile,
    rebuildTavernMemoryDerivedIndex,
    writeTavernMemoryFile,
} from '../shared/memory-files';
import {
    createFallbackTavernChatPromptPresetBundle,
    normalizeTavernChatPromptPresetBundle,
} from '../shared/chat-presets';
import {
    createTavernSession,
    appendTavernMessage,
    appendTavernManagerMessage,
    deleteTavernSession,
    deleteTavernManagerMessages,
    deleteTavernMessages,
    listTavernManagerMessages,
    getActiveTavernAssistantPresetId,
    getSelectedTavernSessionId,
    listTavernAssistantPresets,
    listTavernManagerRuns,
    loadActiveTavernAssistantPreset,
    listTavernMessages,
    listTavernSessions,
    markTavernMemoryStaleFromOrder,
    normalizeTavernSessionState,
    replaceTavernSessionState,
    saveTavernAssistantPreset,
    setActiveTavernAssistantPresetId,
    setSelectedTavernSessionId,
    updateTavernSessionState,
    updateTavernManagerMessage,
    updateTavernMessage,
    updateTavernSessionSnapshot,
    type TavernManagerMessageRecord,
    type TavernManagerRunRecord,
    type TavernMemoryFileListEntry,
    type TavernMemoryIndexFileEntry,
    type TavernMemoryFileRecord,
    type TavernMemoryIndexRecord,
    type TavernMessageRecord,
    type TavernAssistantPresetRecord,
    type TavernStructuredStateDocumentRecord,
    type TavernStructuredStatePatchRecord,
    type TavernSessionRecord,
} from '../shared/session-db';
import { getTavernMapStateForSession } from '../shared/structured-state';
import {
    normalizeTavernSessionContract,
    type TavernSessionContract,
} from '../shared/session-contract';
import {
    normalizeActionCheckRenderGroups,
    type TavernActionCheckRenderGroup,
    type TavernActionCheckRuntimeEvent,
} from '../shared/runtime-events';
import {
    createDefaultTavernAssistantPreset,
    normalizeTavernAssistantPreset,
    type TavernAssistantPreset,
} from '../shared/assistant-presets';
import type { TavernApplyRegexItem, TavernApplyRegexResult } from '../shared/regex';
import type { TavernSubstituteParamsItem, TavernSubstituteParamsResult } from '../shared/substitute-params';
import {
    buildContextHistory,
    deriveTavernSessionStateFromMessagesAsync,
    runXbTavernTurn,
    simulateXbTavernRequest,
} from './runtime/run-once';
import {
    buildManagerChatDisplayItems,
    createManagerStreamToolDraftState,
    managerToolTurnPreview,
    managerToolTurnSummary,
    type ManagerMessageDisplayItem,
} from './manager-tool-display';
import {
    cancelAndRollbackXbTavernManagersForMessageRange,
    ensureTavernManagerChatBudget,
    runXbTavernManagerAfterTurn,
    runXbTavernManagerChat,
    type TavernManagerProtocolEvent,
} from './runtime/manager';
import { resolveXbTavernProviderConfig } from './runtime/provider';
import TavernAboutPage from './components/TavernAboutPage.vue';
import TavernCharacterSelectPage from './components/TavernCharacterSelectPage.vue';
import TavernHomePage from './components/TavernHomePage.vue';
import TavernChatPage from './components/chat/TavernChatPage.vue';
import TavernRequestLogModal from './components/TavernRequestLogModal.vue';
import type { TavernSettingsNavItem } from './components/TavernSettingsSidebar.vue';
import TavernSettingsPage from './components/settings/TavernSettingsPage.vue';
import { TAVERN_APP_UI_CONTEXT } from './components/tavern-app-context';

interface TavernDiagnostics {
    ok?: boolean;
    message?: string;
    worldbookErrors?: Array<{ name: string; error: string }>;
}

interface RequestAuditSnapshot {
    rawMessagesJson?: string;
    rawRequestJson?: string;
    requestKind?: string;
    capturedAt?: number;
    messageCount?: number;
    messageChars?: number;
    presetName?: string;
    provider?: string;
    providerLabel?: string;
    model?: string;
    toolMode?: string;
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

type AssistantPresetSectionKey =
    | 'storyArcPrompt'
    | 'statePrompt'
    | 'turnPrompt';

interface AssistantPresetSectionRow {
    key: AssistantPresetSectionKey;
    label: string;
    summary: string;
}

interface AssistantPresetItemRow {
    id: string;
    key: AssistantPresetSectionKey;
    label: string;
    summary: string;
    content: string;
}

interface ChatPresetOptionRow {
    name: string;
    label: string;
}

interface WorldbookOptionRow {
    name: string;
    globalActive?: boolean;
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

interface WorldbookPreviewRow {
    name: string;
    entryCount: number;
    enabledCount: number;
    constantCount: number;
    disabledCount: number;
    keywordCount: number;
    totalChars: number;
    entries: WorldbookPreviewEntryRow[];
}

interface TavernRegexScriptDraft {
    id?: string;
    scriptName?: string;
    findRegex?: string;
    replaceString?: string;
    trimStrings?: string[];
    placement?: number[];
    disabled?: boolean;
    markdownOnly?: boolean;
    promptOnly?: boolean;
    runOnEdit?: boolean;
    substituteRegex?: number;
    minDepth?: number | null;
    maxDepth?: number | null;
    [key: string]: unknown;
}

interface TavernRegexGroupRow {
    key: string;
    label: string;
    scriptType: number;
    scripts: TavernRegexScriptDraft[];
    allowed?: boolean;
}

interface TavernRegexScriptRow {
    key: string;
    groupKey: string;
    groupLabel: string;
    scriptType: number;
    script: TavernRegexScriptDraft;
    isNew?: boolean;
    searchCorpus?: string;
}

interface TavernCharacterOption {
    id: string;
    name: string;
    avatar?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMessage?: string;
    alternateGreetings?: string[];
    mesExample?: string;
    creatorNotes?: string;
    characterDepthPrompt?: string;
    searchCorpus?: string;
}

const SOURCE_APP = 'xb-tavern-app';
const SOURCE_HOST = 'xb-tavern-host';
const HOST_REQUEST_TIMEOUT_MS = 5000;
const CHARACTER_CONTEXT_TIMEOUT_MS = 15000;
const CHARACTER_ARCHIVE_BATCH_SIZE = 48;
const CHAT_PRESET_SOURCE_BATCH_SIZE = 48;
const ASSISTANT_PRESET_BATCH_SIZE = 48;
const PROMPT_EDITOR_BATCH_SIZE = 80;
const WORLDBOOK_BATCH_SIZE = 80;
const WORLDBOOK_PREVIEW_BATCH_SIZE = 24;
const REGEX_GROUP_BATCH_SIZE = 60;
const CHAT_SIDEBAR_INITIAL_LIMIT = 6;
const CHAT_SIDEBAR_BATCH_SIZE = 12;
const MANAGER_RUN_VISIBLE_LIMIT = 12;
const MEMORY_TURN_INITIAL_LIMIT = 36;
const MEMORY_TURN_BATCH_SIZE = 48;
const MEMORY_FILE_BATCH_SIZE = 24;

const context = ref<XbTavernContext>({});
const diagnostics = ref<TavernDiagnostics>({});
const agentConfig = ref<Record<string, unknown>>({});
const hostRequestHeaders = ref<Record<string, unknown>>({});
const apiSettingsRootRef = ref<HTMLElement | null>(null);
const apiConfigSave = ref({ status: 'idle', requestId: '', error: '' });
const apiConfigStatus = ref('');
const availableCharacters = ref<TavernCharacterOption[]>([]);
const selectedCharacterId = ref('');
const selectedCharacterPreviewId = ref('');
const selectedCharacterGreetingIndex = ref(0);
const pendingCharacterSessionId = ref('');
const pendingCharacterGreetingIndex = ref(0);
const pendingCharacterError = ref('');
const statusText = ref('等待读取角色与会话');
const currentUserMessage = ref('');
const historyMode = ref<'raw' | 'squash'>('raw');
const runtimeText = ref('');
const runtimeThoughts = ref<Array<{ label?: string; text?: string }>>([]);
const runtimeError = ref('');
const composeErrorMessage = ref('');
const runtimeProvider = ref('');
const runtimeModel = ref('');
const isRunning = ref(false);
const isCancellingRun = ref(false);
const tavernDrawStatus = ref({ provider: 'disabled', enabled: false, ready: false });
const drawingMessageKey = ref('');
const drawStatusMessageKey = ref('');
const drawStatusKind = ref<'idle' | 'running' | 'success' | 'error'>('idle');
const drawProgressText = ref('');
const sessions = ref<TavernSessionRecord[]>([]);
const selectedSessionId = ref('');
const sessionMessages = ref<TavernMessageRecord[]>([]);
const managerRuns = ref<TavernManagerRunRecord[]>([]);
const memoryFiles = ref<TavernMemoryIndexFileEntry[]>([]);
const memoryIndex = ref<TavernMemoryIndexRecord | null>(null);
const memoryTokenizerStatus = ref(getXbTavernMemoryTokenizerStatus());
const selectedMemoryFilePath = ref('');
const selectedMemoryFileRecord = ref<TavernMemoryFileRecord | null>(null);
const stateMemoryFile = ref<TavernMemoryFileRecord | null>(null);
const memoryEditorDraft = ref('');
const memoryEditorLoadedPath = ref('');
const memoryEditorBaseContent = ref('');
const memoryEditorMode = ref<'preview' | 'edit'>('preview');
const memoryEditorStatus = ref('');
const chatWorkspacePanel = ref<'state' | 'memory'>('state');
const mapStateDocument = ref<TavernStructuredStateDocumentRecord | null>(null);
const mapStatePatches = ref<TavernStructuredStatePatchRecord[]>([]);
const managerActionStatus = ref('');
const managerInputDraft = ref('');
const managerInputStatus = ref('');
const managerChatMessages = ref<TavernManagerMessageRecord[]>([]);
const isManagerAssistantRunning = ref(false);
const isManagerAssistantCancelling = ref(false);
interface TavernManagerLiveProtocolState {
    sessionId: string;
    messages: TavernManagerMessageRecord[];
    draft: TavernManagerMessageRecord | null;
    nextOrder: number;
}

const LIVE_MANAGER_PROTOCOL_ORDER_BASE = 1000000000;
const managerLiveProtocolState = ref<TavernManagerLiveProtocolState | null>(null);
const runtimeActionCheckEvents = ref<TavernActionCheckRuntimeEvent[]>([]);
const managerCompactionOverlay = ref<{
    id: string;
    active: boolean;
    resolved: boolean;
    currentTokens: number;
    yieldTokens: number;
    triggerTokens: number;
    status: string;
    visibleSince: number;
} | null>(null);
const initialChatPreset = createFallbackTavernChatPromptPresetBundle();
const initialAssistantPreset: TavernAssistantPreset = createDefaultTavernAssistantPreset();
const assistantPresetSections: AssistantPresetSectionRow[] = [
    { key: 'storyArcPrompt', label: '剧情脉络', summary: '长期脉络档案' },
    { key: 'statePrompt', label: '状态栏', summary: '当前状态档案' },
    { key: 'turnPrompt', label: '楼层小记', summary: '每回合轻量记录' },
];
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
const worldbookPreview = ref<WorldbookPreviewRow | null>(null);
const worldbookPreviewStatus = ref('');
const characterSearchText = ref('');
const characterVisibleLimit = ref(CHARACTER_ARCHIVE_BATCH_SIZE);
const chatPresetSourceSearchText = ref('');
const chatPresetSourceVisibleLimit = ref(CHAT_PRESET_SOURCE_BATCH_SIZE);
const assistantPresetSearchText = ref('');
const assistantPresetVisibleLimit = ref(ASSISTANT_PRESET_BATCH_SIZE);
const promptSearchText = ref('');
const promptVisibleLimit = ref(PROMPT_EDITOR_BATCH_SIZE);
const worldbookSearchText = ref('');
const worldbookVisibleLimit = ref(WORLDBOOK_BATCH_SIZE);
const worldbookPreviewVisibleLimit = ref(WORLDBOOK_PREVIEW_BATCH_SIZE);
const memoryFileSearchText = ref('');
const memoryFileGroupVisibleLimits = ref<Record<string, number>>({});
const chatSessionSearchText = ref('');
const chatSidebarSessionLimit = ref(CHAT_SIDEBAR_INITIAL_LIMIT);
const brokenAvatarUrls = ref<Record<string, true>>({});
const regexSearchText = ref('');
const regexGroupVisibleLimits = ref<Record<string, number>>({});
const regexList = ref<Record<string, unknown>>({});
const selectedRegexKey = ref('');
const regexDraft = ref<TavernRegexScriptDraft>({});
const activeRegexScriptJson = ref(snapshotNativeDraft(regexDraft.value));
const regexStatus = ref('');
type AppView = 'home' | 'chat' | 'characters' | 'settings' | 'about';
type SettingsWorkspaceKey = 'api' | 'chatPreset' | 'worldbooks' | 'regex' | 'assistantPreset';
type ChatFocus = 'chat' | 'manager';
type ChatLayout = 'chat' | 'balanced' | 'editor';
type ChatSidePanel = 'sessions' | 'memory';
const TAVERN_THEME_STORAGE_KEY = 'LittleWhiteBox_Tavern_theme';
function readInitialView(): AppView {
    const hash = String(window.location.hash || '').replace(/^#\/?/, '');
    const [view] = hash.split('/');
    if (view === 'chat' || view === 'characters' || view === 'settings' || view === 'about') {
        return view;
    }
    return 'home';
}
function readInitialSettingsWorkspace(): SettingsWorkspaceKey {
    const hash = String(window.location.hash || '').replace(/^#\/?/, '');
    const key = hash.split('/')[1];
    if (key === 'api' || key === 'chatPreset' || key === 'worldbooks' || key === 'regex' || key === 'assistantPreset') {return key;}
    return 'api';
}
function readInitialTavernThemeDark(): boolean {
    try {
        const value = globalThis.localStorage?.getItem(TAVERN_THEME_STORAGE_KEY);
        if (value === 'dark') {return true;}
        if (value === 'light') {return false;}
    } catch {
        // Use the light default below when storage is unavailable.
    }
    return false;
}
interface PendingHostRequest {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: number;
    type: string;
    abort?: () => void;
    signal?: AbortSignal;
}
const pendingHostRequests = new Map<string, PendingHostRequest>();
const TAVERN_IMAGE_MARKER_REGEX = /\[tavern-image:([a-z0-9\-_]+)\]/gi;
const TAVERN_DRAW_REQUEST_TIMEOUT_MS = 1000 * 60 * 20;
const DRAW_COMPLETION_NOTICE_TEXT = '配图已生成';
const presetDirty = computed(() => snapshotPreset(preset.value) !== savedPresetJson.value);
const assistantPresetDirty = computed(() => snapshotAssistantPreset(assistantPreset.value) !== savedAssistantPresetJson.value);
const chatPresetOptions = computed<ChatPresetOptionRow[]>(() => {
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
const filteredChatPresetOptions = computed<ChatPresetOptionRow[]>(() => {
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
const worldbookOptions = computed<WorldbookOptionRow[]>(() => {
    const books = Array.isArray(worldbookList.value.books) ? worldbookList.value.books : [];
    return books.map((item) => {
        const record = promptRecord(item);
        return {
            name: String(record.name || '').trim(),
            globalActive: record.globalActive === true,
        };
    }).filter((item) => item.name);
});
function worldbookSourceSummary(item: WorldbookOptionRow): string {
    return item.globalActive ? '全局世界书' : '';
}

function normalizeWorldbookPreview(value: unknown): WorldbookPreviewRow {
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

function normalizeTextList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
}

const filteredWorldbookOptions = computed<WorldbookOptionRow[]>(() => {
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
const selectedWorldbook = computed<WorldbookOptionRow | null>(() => (
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

const regexGroupsForDisplay = computed(() => {
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
        badge: worldbookGlobalCount.value ? `${worldbookGlobalCount.value} 本全局` : '',
    },
    {
        key: 'chatPreset',
        label: '聊天预设',
        badge: presetDirty.value ? '未保存' : '',
    },
    {
        key: 'assistantPreset',
        label: '助手预设',
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
    },
]);
const assistantPresetItems = computed<AssistantPresetItemRow[]>(() => {
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
const selectedSession = computed(() => sessions.value.find((item) => item.id === selectedSessionId.value) || null);
const sessionRuntimeState = computed(() => normalizeTavernSessionState(selectedSession.value?.state || {}));
const sessionContract = computed<TavernSessionContract>(() => normalizeTavernSessionContract(sessionRuntimeState.value.contract));
const activeView = ref<AppView>(readInitialView());
const activeSettingsWorkspace = ref<SettingsWorkspaceKey>(readInitialSettingsWorkspace());
const homeThemeDark = ref(readInitialTavernThemeDark());
const chatFocus = ref<ChatFocus>('chat');
const chatLayout = ref<ChatLayout>('balanced');
const chatSidePanel = ref<ChatSidePanel>('memory');
const chatScrollRef = ref<HTMLElement | null>(null);
const managerScrollRef = ref<HTMLElement | null>(null);
const chatComposeTextareaRef = ref<HTMLTextAreaElement | null>(null);
const managerComposeTextareaRef = ref<HTMLTextAreaElement | null>(null);
const characterArchivePageRef = ref<InstanceType<typeof TavernCharacterSelectPage> | null>(null);
const chatAutoScroll = ref(true);
const managerAutoScroll = ref(true);
const showChatScrollTop = ref(false);
const showChatScrollBottom = ref(false);
const chatScrollControlsActive = ref(false);
const showManagerScrollTop = ref(false);
const showManagerScrollBottom = ref(false);
const managerScrollControlsActive = ref(false);
const chatMessageWindowLimit = ref(AGENT_MESSAGE_WINDOW_DEFAULT);
const managerMessageWindowLimit = ref(AGENT_MESSAGE_WINDOW_DEFAULT);
const managerStatusClock = ref(Date.now());
const editingMessageKey = ref('');
const editingMessageDraft = ref('');
const showPromptInspector = ref(false);
const promptInspectorTab = ref<'history' | 'simulate'>('history');
const simulateRequestInput = ref('');
const simulateRequestJson = ref('');
const simulateRequestStatus = ref('');
const simulateRequestError = ref('');
const messageActionFeedback = ref<Record<string, 'success' | 'error'>>({});
const activeRunController = ref<AbortController | null>(null);
const managerAssistantController = ref<AbortController | null>(null);
const tavernDrawController = ref<AbortController | null>(null);
const markdownHtmlCache = new Map<string, string>();
const characterOptionCache = new Map<string, { signature: string; option: TavernCharacterOption }>();
const sessionSearchCorpusCache = new Map<string, { signature: string; corpus: string }>();
const memoryFileSearchCorpusCache = new WeakMap<TavernMemoryIndexFileEntry, string>();
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
let chatScrollHideTimer: number | null = null;
let pendingCharacterSessionTimer: number | null = null;
let chatScrollTicking = false;
let managerScrollTicking = false;
let chatTouchStartY: number | null = null;
let managerTouchStartY: number | null = null;
let chatLastScrollTop = 0;
let managerLastScrollTop = 0;
let simulateRequestSequence = 0;
let managerCompactionOverlayHideTimer: number | null = null;
let managerScrollHideTimer: number | null = null;
let composeErrorHideTimer: number | null = null;
let managerRecordsPollTimer: number | null = null;
let managerRecordsPollRunning = false;
let sessionContextSyncSequence = 0;
const effectiveContext = computed<XbTavernContext>(() => ({
    ...context.value,
    history: selectedSessionId.value
        ? buildContextHistory(sessionMessages.value)
        : context.value.history,
}));
const effectiveCharacter = computed(() => effectiveContext.value.character || {});
const characterName = computed(() => displayableTavernName(effectiveCharacter.value.name || '', '未选择角色'));
const characterAvatar = computed(() => {
    const primaryAvatar = String(effectiveCharacter.value.avatar || '').trim();
    const characterId = String(effectiveCharacter.value.id || selectedCharacterId.value || '').trim();
    const characterNameValue = String(effectiveCharacter.value.name || '').trim();
    const matchedCharacter = availableCharacters.value.find((character) => String(character.id || '').trim() === characterId)
        || availableCharacters.value.find((character) => String(character.name || '').trim() === characterNameValue);
    const fallbackAvatar = String(matchedCharacter?.avatar || '').trim();
    const candidates = [primaryAvatar, fallbackAvatar].filter((avatar, index, list) => avatar && list.indexOf(avatar) === index);
    return candidates.find((avatar) => !brokenAvatarUrls.value[avatar]) || candidates[0] || '';
});
const visibleCharacterAvatar = computed(() => {
    const url = characterAvatar.value;
    return url && !brokenAvatarUrls.value[url] ? url : '';
});
const effectiveUser = computed(() => effectiveContext.value.user || {});
const userName = computed(() => displayableTavernName(effectiveUser.value.name || '', 'User'));
const userAvatar = computed(() => String(effectiveUser.value.avatar || '').trim());
const visibleUserAvatar = computed(() => {
    const url = userAvatar.value;
    return url && !brokenAvatarUrls.value[url] ? url : '';
});
const liveCharacter = computed(() => context.value.character || {});
const liveCharacterId = computed(() => String(liveCharacter.value.id || selectedCharacterId.value || '').trim());
function avatarAvailable(url = '') {
    const key = String(url || '').trim();
    return !!key && !brokenAvatarUrls.value[key];
}

function rememberBrokenAvatar(url = '') {
    const key = String(url || '').trim();
    if (!key || brokenAvatarUrls.value[key]) {return;}
    brokenAvatarUrls.value = {
        ...brokenAvatarUrls.value,
        [key]: true,
    };
}

function normalizeCharacterOption(character: Record<string, unknown>, idFallback = ''): TavernCharacterOption | null {
    const id = String(character.id || idFallback || '').trim();
    if (!id) {return null;}
    const name = String(character.name || '').trim() || `角色 ${id}`;
    const avatar = String(character.avatar || '').trim();
    const description = String(character.description || '').trim();
    const personality = String(character.personality || '').trim();
    const scenario = String(character.scenario || '').trim();
    const firstMessage = String(character.firstMessage || character.first_mes || '').trim();
    const alternateGreetings = normalizeTextList(character.alternateGreetings || character.alternate_greetings);
    const mesExample = String(character.mesExample || character.mes_example || '').trim();
    const creatorNotes = String(character.creatorNotes || character.creator_notes || '').trim();
    const characterDepthPrompt = String(character.characterDepthPrompt || character.character_depth_prompt || '').trim();
    const signature = JSON.stringify([id, name, avatar, description, personality, scenario, firstMessage, alternateGreetings, mesExample, creatorNotes, characterDepthPrompt]);
    const cached = characterOptionCache.get(id);
    if (cached?.signature === signature) {return cached.option;}
    const option: TavernCharacterOption = {
        id,
        name,
        avatar,
        description,
        personality,
        scenario,
        firstMessage,
        alternateGreetings,
        mesExample,
        creatorNotes,
        characterDepthPrompt,
    };
    option.searchCorpus = normalizedSearchText(buildSearchCorpus([
        option.id,
        option.name,
        option.description,
        option.personality,
        option.scenario,
        option.firstMessage,
        ...(option.alternateGreetings || []),
        option.mesExample,
        option.creatorNotes,
        option.characterDepthPrompt,
    ], 900));
    characterOptionCache.set(id, { signature, option });
    return option;
}
const characterCards = computed<TavernCharacterOption[]>(() => {
    const byId = new Map<string, TavernCharacterOption>();
    availableCharacters.value.forEach((character) => {
        const option = normalizeCharacterOption(character as unknown as Record<string, unknown>);
        if (option) {byId.set(option.id, option);}
    });
    const currentId = String(liveCharacter.value.id || '').trim();
    if (currentId && liveCharacter.value.name && !byId.has(currentId)) {
        const option = normalizeCharacterOption(liveCharacter.value as Record<string, unknown>, currentId);
        if (option) {byId.set(currentId, option);}
    }
    return [...byId.values()].sort((left, right) => {
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
});
const filteredCharacterCards = computed<TavernCharacterOption[]>(() => {
    const query = normalizedSearchText(characterSearchText.value);
    if (!query) {return characterCards.value;}
    return characterCards.value.filter((character) => String(character.searchCorpus || '').includes(query));
});
const visibleCharacterCards = computed(() => {
    const visible = filteredCharacterCards.value.slice(0, characterVisibleLimit.value);
    const selectedId = String(selectedCharacterPreviewId.value || '').trim();
    if (!selectedId || visible.some((character) => character.id === selectedId)) {return visible;}
    const selected = characterCards.value.find((character) => character.id === selectedId);
    return selected ? [selected, ...visible] : visible;
});
const selectedCharacterPreview = computed(() => {
    const previewId = String(selectedCharacterPreviewId.value || '').trim();
    if (previewId) {
        const selected = characterCards.value.find((character) => character.id === previewId);
        if (selected) {return selected;}
    }
    return null;
});
const selectedCharacterGreetingOptions = computed(() => {
    const character = selectedCharacterPreview.value;
    if (!character) {return [];}
    return [
        String(character.firstMessage || '').trim(),
        ...(character.alternateGreetings || []),
    ].filter(Boolean);
});
const hiddenCharacterCount = computed(() => Math.max(
    0,
    filteredCharacterCards.value.length - Math.min(filteredCharacterCards.value.length, characterVisibleLimit.value),
));
function cleanTavernDisplayName(value = '') {
    return String(value || '')
        .replace(/\s*[·-]\s*小白酒馆\s*$/g, '')
        .replace(/\s*[·-]\s*会话\s*$/g, '')
        .replace(/^小白酒馆会话$/g, '')
        .replace(/\s*·\s*第\s*\d+\s*轮\s*·\s*\d+\s*条可用消息\s*$/g, '')
        .trim();
}

function isSystemDisplayName(value = '') {
    return /^(sillytavern\s+system|system)\b/i.test(String(value || '').trim());
}

function displayableTavernName(value = '', fallback = '') {
    const cleaned = cleanTavernDisplayName(value);
    return cleaned && !isSystemDisplayName(cleaned) ? cleaned : fallback;
}

function sessionDisplayTitle(session?: TavernSessionRecord | null) {
    if (!session) {return '';}
    const character = displayableTavernName(session.characterName || '');
    if (character) {return character;}
    const title = displayableTavernName(session.title || '');
    if (title) {return title;}
    return '';
}

function sessionSearchCorpus(session: TavernSessionRecord) {
    const signature = [
        session.id,
        session.title,
        session.characterName,
        session.updatedAt,
        normalizeTavernSessionState(session.state || {}).turn,
    ].join('|');
    const cached = sessionSearchCorpusCache.get(session.id);
    if (cached?.signature === signature) {return cached.corpus;}
    const corpus = normalizedSearchText(buildSearchCorpus([
        sessionDisplayTitle(session),
        session.title,
        session.characterName,
        session.id,
        normalizeTavernSessionState(session.state || {}).turn,
    ], 600));
    sessionSearchCorpusCache.set(session.id, { signature, corpus });
    return corpus;
}

const selectedSessionTitle = computed(() => (
    sessionDisplayTitle(selectedSession.value)
    || displayableTavernName(effectiveCharacter.value.name || '')
    || '未选择角色'
));
const displayCharacterName = computed(() => (
    selectedSessionId.value
        ? selectedSessionTitle.value
        : (displayableTavernName(characterName.value) || '未选择角色')
));
const lastRequestSnapshot = computed(() => selectedSession.value?.state?.lastRequestSnapshot as RequestAuditSnapshot | undefined);
const lastRequestRawJson = computed(() => String(lastRequestSnapshot.value?.rawRequestJson || lastRequestSnapshot.value?.rawMessagesJson || ''));
const resolvedProviderConfig = computed(() => resolveXbTavernProviderConfig(agentConfig.value));
const apiReady = computed(() => resolvedProviderConfig.value.readiness.ok);
const apiReadyDetail = computed(() => resolvedProviderConfig.value.readiness.message);
const chatMessages = computed(() => sessionMessages.value);
const chatMessageWindow = computed(() => getMessageWindow({
    uiMessageWindowLimit: chatMessageWindowLimit.value,
}, chatMessages.value.length));
const visibleChatMessages = computed(() => chatMessages.value.slice(chatMessageWindow.value.startIndex));
const latestErrorMessage = computed(() => composeErrorMessage.value);
const latestSavedChatError = computed(() => {
    const lastMessage = [...sessionMessages.value].sort((left, right) => left.order - right.order).at(-1);
    return lastMessage?.error ? `${lastMessage.sessionId}:${lastMessage.order}:${lastMessage.content || ''}` : '';
});
const latestManagerRun = computed(() => managerRuns.value[0] || null);
const currentManagerWorkRun = computed(() => (
    managerRuns.value.find((run) => isManagerRunLive(run.status)) || latestManagerRun.value
));
const archivedManagerRuns = computed(() => {
    const currentId = String(currentManagerWorkRun.value?.id || '');
    return managerRuns.value
        .filter((run) => String(run.id || '') !== currentId)
        .slice(0, MANAGER_RUN_VISIBLE_LIMIT);
});
const hiddenManagerRunCount = computed(() => {
    const currentCount = currentManagerWorkRun.value ? 1 : 0;
    return Math.max(0, managerRuns.value.length - currentCount - archivedManagerRuns.value.length);
});
const managerBusy = computed(() => managerRuns.value.some((run) => ['queued', 'running'].includes(run.status)));
const filteredChatSidebarSessions = computed(() => {
    const currentCharacterId = String(selectedSession.value?.characterId || effectiveContext.value.character?.id || '').trim();
    const sameCharacter = currentCharacterId
        ? sessions.value.filter((session) => String(session.characterId || '').trim() === currentCharacterId)
        : sessions.value;
    const query = normalizedSearchText(chatSessionSearchText.value);
    const filtered = query
        ? sameCharacter.filter((session) => sessionSearchCorpus(session).includes(query))
        : sameCharacter;
    return filtered;
});
const chatSidebarSessions = computed(() => {
    const filtered = filteredChatSidebarSessions.value;
    const visible = filtered.slice(0, chatSidebarSessionLimit.value);
    if (selectedSessionId.value && !visible.some((session) => session.id === selectedSessionId.value)) {
        const selected = filtered.find((session) => session.id === selectedSessionId.value);
        if (selected) {visible.unshift(selected);}
    }
    return visible;
});
const filteredChatSidebarSessionCount = computed(() => filteredChatSidebarSessions.value.length);
const hiddenChatSidebarSessionCount = computed(() => Math.max(0, filteredChatSidebarSessionCount.value - chatSidebarSessions.value.length));
const activeMemoryFiles = computed(() => memoryFiles.value.filter((file) => file.status !== 'stale'));
const selectedMemoryFileEntry = computed(() => (
    memoryFiles.value.find((file) => file.path === selectedMemoryFilePath.value)
    || memoryFiles.value[0]
    || null
));
const selectedMemoryFile = computed(() => (
    selectedMemoryFileRecord.value?.sessionId === selectedSessionId.value
    && selectedMemoryFileRecord.value?.path === selectedMemoryFileEntry.value?.path
        ? selectedMemoryFileRecord.value
        : null
));
function memoryFileDisplayName(fileOrPath: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null | undefined) {
    const path = typeof fileOrPath === 'string' ? fileOrPath : String(fileOrPath?.path || '');
    if (path === 'memory/session.md') {return '剧情脉络';}
    if (path === 'memory/state.md') {return '状态栏';}
    const turnMatch = path.match(/^memory\/turns\/(\d{8})-(\d+)\.md$/);
    if (turnMatch) {
        const order = Number(turnMatch[2]) || 0;
        return order > 0 ? `第 ${order} 楼小记` : '楼层小记';
    }
    return path.replace(/^memory\//, '').replace(/\.md$/i, '') || '记忆档案';
}

function memoryFileKindLabel(fileOrPath: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null | undefined) {
    const path = typeof fileOrPath === 'string' ? fileOrPath : String(fileOrPath?.path || '');
    if (path === 'memory/session.md') {return '剧情为什么走到现在';}
    if (path === 'memory/state.md') {return '当前事实与状态';}
    if (path.startsWith('memory/turns/')) {return '每回合小总结';}
    return '记忆档案';
}

function memoryFileSortWeight(path = '') {
    if (path === 'memory/session.md') {return 0;}
    if (path === 'memory/state.md') {return 1;}
    if (path.startsWith('memory/turns/')) {return 20;}
    return 30;
}

function memoryFileSearchCorpus(file: TavernMemoryIndexFileEntry) {
    const cached = memoryFileSearchCorpusCache.get(file);
    if (cached) {return cached;}
    const corpus = normalizedSearchText([
        file.path,
        memoryFileDisplayName(file),
        memoryFileKindLabel(file),
        file.status,
        file.searchText || file.preview || '',
    ].filter(Boolean).join('\n'));
    memoryFileSearchCorpusCache.set(file, corpus);
    return corpus;
}

function memoryFileVisibleLimitForGroup(groupKey = '') {
    const fallback = groupKey === 'turns' ? MEMORY_TURN_INITIAL_LIMIT : MEMORY_FILE_BATCH_SIZE;
    const value = Number(memoryFileGroupVisibleLimits.value[groupKey]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function expandMemoryFileGroup(groupKey = '') {
    const current = memoryFileVisibleLimitForGroup(groupKey);
    memoryFileGroupVisibleLimits.value = {
        ...memoryFileGroupVisibleLimits.value,
        [groupKey]: current + (groupKey === 'turns' ? MEMORY_TURN_BATCH_SIZE : MEMORY_FILE_BATCH_SIZE),
    };
}

const memoryDirectoryGroups = computed(() => {
    const groups = [
        {
            key: 'core',
            title: '核心档案',
            files: [] as TavernMemoryIndexFileEntry[],
        },
        {
            key: 'turns',
            title: '楼层小记',
            files: [] as TavernMemoryIndexFileEntry[],
        },
    ];
    const rest: TavernMemoryIndexFileEntry[] = [];
    [...memoryFiles.value]
        .sort((left, right) => (
            memoryFileSortWeight(left.path) - memoryFileSortWeight(right.path)
            || String(left.path || '').localeCompare(String(right.path || ''))
        ))
        .forEach((file) => {
            if (['memory/session.md', 'memory/state.md'].includes(file.path)) {
                groups[0].files.push(file);
            } else if (file.path.startsWith('memory/turns/')) {
                groups[1].files.push(file);
            } else {
                rest.push(file);
            }
        });
    const visible = groups.filter((group) => group.files.length);
    if (rest.length) {
        visible.push({
            key: 'other',
            title: '其他档案',
            files: rest,
        });
    }
    const query = normalizedSearchText(memoryFileSearchText.value);
    const selectedPath = String(selectedMemoryFilePath.value || '').trim();
    return visible
        .map((group) => {
            const filtered = query
                ? group.files.filter((file) => memoryFileSearchCorpus(file).includes(query))
                : group.files;
            const limit = memoryFileVisibleLimitForGroup(group.key);
            const files = filtered.slice(0, limit);
            if (selectedPath && !files.some((file) => file.path === selectedPath)) {
                const selected = filtered.find((file) => file.path === selectedPath);
                if (selected) {files.unshift(selected);}
            }
            return {
                ...group,
                files,
                totalCount: group.files.length,
                filteredCount: filtered.length,
                hiddenCount: Math.max(0, filtered.length - files.length),
            };
        })
        .filter((group) => group.filteredCount || !query);
});
const memoryEditorDocumentAvailable = computed(() => !!selectedMemoryFileEntry.value || !!memoryEditorLoadedPath.value);
const memoryEditorReadOnly = computed(() => false);
const memoryEditorDirty = computed(() => (
    !!memoryEditorLoadedPath.value
    && memoryEditorDraft.value !== memoryEditorBaseContent.value
));
const memoryIndexStatusLine = computed(() => {
    const tokenizer = memoryTokenizerStatus.value;
    if (tokenizer.status !== 'ready') {
        if (tokenizer.status === 'failed') {return `记忆检索准备失败：${tokenizer.error || 'memory_tokenizer_failed'}`;}
        if (tokenizer.status === 'loading') {return '记忆检索准备中';}
        return '记忆检索尚未准备好';
    }
    const index = memoryIndex.value;
    if (!index) {return '还没有可检索记忆';}
    if (index.status === 'ready') {return '记忆可检索';}
    if (index.status === 'failed') {return `记忆整理失败：${index.error || 'memory_index_failed'}`;}
    return '记忆正在整理';
});
const managerStatusLine = computed(() => {
    if (managerActionStatus.value) {return managerActionStatus.value;}
    const latest = latestManagerRun.value;
    if (!latest) {return '暂无工作记录';}
    if (latest.status === 'failed') {return `失败：${latest.error || 'manager_failed'}`;}
    if (latest.status === 'completed') {return `最近完成：第 ${latest.turn} 轮`; }
    if (latest.status === 'running') {return `正在整理：第 ${latest.turn} 轮`; }
    return `排队中：第 ${latest.turn} 轮`;
});
const visibleChatMarkdownSignature = computed(() => visibleChatMessages.value
    .map((message) => `${message.sessionId}:${message.order}:${message.error ? 1 : 0}:${markdownSignature(message.content)}`)
    .join('|'));
const runtimeThoughtsSignature = computed(() => runtimeThoughts.value
    .map((thought, index) => `${index}:${markdownSignature(String(thought.label || ''))}:${markdownSignature(String(thought.text || ''))}`)
    .join('|'));
const runtimeActionCheckSignature = computed(() => runtimeActionCheckEvents.value
    .map((event, index) => [
        index,
        event.toolCallId || '',
        event.stat,
        event.action,
        event.roll,
        event.difficulty,
        event.insertAfterChars,
        event.success ? 1 : 0,
    ].join(':'))
    .join('|'));
const managerChatDisplayItems = computed(() => buildManagerChatDisplayItems(managerChatMessages.value));
const liveManagerProtocolMessages = computed(() => {
    const liveState = managerLiveProtocolState.value;
    if (!liveState || liveState.sessionId !== selectedSessionId.value) {return [];}
    return liveState.draft ? [...liveState.messages, liveState.draft] : liveState.messages;
});
const liveManagerChatDisplayItems = computed(() => buildManagerChatDisplayItems(liveManagerProtocolMessages.value));
const managerMessageWindow = computed(() => getMessageWindow({
    uiMessageWindowLimit: managerMessageWindowLimit.value,
}, managerChatDisplayItems.value.length));
const visibleManagerChatItems = computed(() => managerChatDisplayItems.value.slice(managerMessageWindow.value.startIndex));
const visibleManagerChatMessages = computed(() => visibleManagerChatItems.value
    .filter((item): item is ManagerMessageDisplayItem => item.kind === 'message')
    .map((item) => item.message));
const visibleManagerMarkdownSignature = computed(() => visibleManagerChatItems.value
    .map((item) => item.kind === 'message'
        ? `${item.message.sessionId}:${item.message.order}:${markdownSignature(item.message.content)}`
        : `${item.key}:${markdownSignature(item.assistantMessage.content)}:${item.calls.map((call) => `${call.id}:${markdownSignature(call.resultText)}`).join(',')}`)
    .join('|'));
const liveManagerMarkdownSignature = computed(() => liveManagerChatDisplayItems.value
    .map((item) => item.kind === 'message'
        ? `${item.message.sessionId}:${item.message.order}:${markdownSignature(item.message.content)}`
        : `${item.key}:${markdownSignature(item.assistantMessage.content)}:${item.calls.map((call) => `${call.id}:${markdownSignature(call.resultText)}`).join(',')}`)
    .join('|'));
const chatSubtitle = computed(() => {
    if (!selectedSessionId.value) {return '写一句话后会自动创建独立会话。';}
    const turn = Number(sessionRuntimeState.value.turn || 0);
    return `第 ${turn} 轮`;
});
const apiRuntimeLine = computed(() => {
    const config = resolvedProviderConfig.value;
    return `预设「${config.currentPresetName || '默认'}」 · ${config.providerLabel} / ${config.model || '未选择模型'}`;
});
const canSendMessage = computed(() => !isCancellingRun.value && (isRunning.value || !!currentUserMessage.value.trim()));
const canSendManagerMessage = computed(() => !isManagerAssistantCancelling.value && (isManagerAssistantRunning.value || (!!selectedSessionId.value && !!managerInputDraft.value.trim())));
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

function clonePostMessagePayload<T>(value: T): T {
    const seen = new WeakSet<object>();
    try {
        return JSON.parse(JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') {return String(item);}
            if (typeof item === 'function' || typeof item === 'symbol') {return undefined;}
            if (!item || typeof item !== 'object') {return item;}
            if (seen.has(item)) {return undefined;}
            seen.add(item);
            return item;
        })) as T;
    } catch {
        return {} as T;
    }
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

function promptRowIndex(identifier: string) {
    return promptEditorRowIndexById.value.get(identifier) ?? -1;
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

watch(characterSearchText, () => {
    characterVisibleLimit.value = CHARACTER_ARCHIVE_BATCH_SIZE;
});

watch(filteredCharacterCards, (cards) => {
    if (!cards.length) {
        selectedCharacterPreviewId.value = '';
        return;
    }
    const current = String(selectedCharacterPreviewId.value || '').trim();
    if (current && cards.some((character) => character.id === current)) {return;}
    selectedCharacterPreviewId.value = '';
}, { immediate: true });

watch(selectedCharacterPreviewId, () => {
    selectedCharacterGreetingIndex.value = 0;
    if (activeView.value === 'characters') {
        scrollSelectedCharacterPreviewIntoView();
    }
});

watch(selectedCharacterGreetingOptions, (options) => {
    if (!options.length) {
        selectedCharacterGreetingIndex.value = 0;
        return;
    }
    const lastIndex = options.length - 1;
    if (selectedCharacterGreetingIndex.value > lastIndex) {
        selectedCharacterGreetingIndex.value = lastIndex;
    }
});

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

watch(memoryFileSearchText, () => {
    memoryFileGroupVisibleLimits.value = {};
});

watch(chatSessionSearchText, () => {
    chatSidebarSessionLimit.value = CHAT_SIDEBAR_INITIAL_LIMIT;
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

function snapshotPreset(value = preset.value) {
    return JSON.stringify(value || {});
}

function snapshotAssistantPreset(value = assistantPreset.value) {
    return JSON.stringify(value || {});
}

function snapshotNativeDraft(value: unknown) {
    return JSON.stringify(value || {});
}

function applyActiveChatPreset(next: Partial<TavernChatPromptPresetBundle> = {}, options: { replaceDraft?: boolean } = {}) {
    const normalized = normalizeTavernChatPromptPresetBundle(next);
    activeChatPreset.value = normalized;
    savedPresetJson.value = snapshotPreset(normalized);
    selectedPresetSourceId.value = String(normalized.promptManager?.name || normalized.name || '').trim();
    if (options.replaceDraft !== false) {
        preset.value = normalized;
    }
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

function applyActiveAssistantPreset(next: Partial<TavernAssistantPreset> = {}, options: { replaceDraft?: boolean } = {}) {
    const normalized = normalizeTavernAssistantPreset(next);
    activeAssistantPreset.value = normalized;
    savedAssistantPresetJson.value = snapshotAssistantPreset(normalized);
    if (options.replaceDraft !== false) {
        assistantPreset.value = normalized;
    }
}

function confirmDiscardDraft(label: string, action = '继续？') {
    return window.confirm(`当前${label}有未保存修改，${action}会放弃这些草稿。继续？`);
}

async function refreshPresets() {
    if (assistantPresetDirty.value && !confirmDiscardDraft('助手预设', '刷新')) {
        assistantPresetStatus.value = '已保留当前草稿';
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
        presetStatus.value = '当前草稿未保存，暂不自动同步';
        return;
    }
    presetStatus.value = '正在同步';
    try {
        const result = await requestHost('xb-tavern:list-chat-presets');
        const payload = (result.result || result) as Record<string, unknown>;
        chatPresetList.value = payload;
        applyActiveChatPreset(payload.active as Partial<TavernChatPromptPresetBundle>);
        presetStatus.value = '已同步';
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
        const result = await requestHost('xb-tavern:select-chat-preset', {
            payload: { promptManagerName: presetName },
        });
        const nextPreset = (result.result || result) as Partial<TavernChatPromptPresetBundle>;
        applyActiveChatPreset(nextPreset);
        presetStatus.value = '已切换';
        postToHost('xb-tavern:refresh-context', {});
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
        presetStatus.value = '没有未保存修改';
        return;
    }
    presetStatus.value = '正在保存';
    const result = await requestHost('xb-tavern:save-chat-preset', {
        payload: preset.value as unknown as Record<string, unknown>,
    });
    if (result.ok === false) {
        presetStatus.value = String(result.error || '保存失败');
        return;
    }
    applyActiveChatPreset(result.result as Partial<TavernChatPromptPresetBundle>);
    presetStatus.value = '已保存';
    postToHost('xb-tavern:refresh-context', {});
}

async function syncWorldbooksFromHost(options: { keepSelection?: boolean } = {}) {
    worldbookStatus.value = '正在同步';
    try {
        const result = await requestHost('xb-tavern:list-worldbook-sources', {
            payload: {
                context: effectiveContext.value,
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
        selectedWorldbookName.value = options.keepSelection && selectedStillExists
            ? selectedWorldbookName.value
            : preferredName;
        worldbookStatus.value = '已同步';
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
        const result = await requestHost('xb-tavern:get-worldbook-preview', {
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
        await requestHost('xb-tavern:open-worldbook-editor', {
            payload: { name: targetName },
        });
        worldbookStatus.value = '已打开酒馆编辑器';
        postToHost('xb-tavern:close');
    } catch (error) {
        worldbookStatus.value = error instanceof Error ? error.message : String(error || '打开失败');
    }
}

async function refreshRegexFromHost() {
    if (regexDirty.value && !confirmDiscardDraft('正则', '刷新')) {
        regexStatus.value = '已保留当前草稿';
        return;
    }
    regexStatus.value = '正在读取';
    try {
        const result = await requestHost('xb-tavern:list-regex-scripts');
        regexList.value = (result.result || result) as Record<string, unknown>;
        const current = regexScriptRows.value.find((row) => row.key === selectedRegexKey.value);
        applyActiveRegexScript(current || regexScriptRows.value[0] || null);
        regexStatus.value = '已刷新';
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
        regexStatus.value = '没有未保存修改';
        return;
    }
    regexStatus.value = '正在保存';
    try {
        const result = await requestHost('xb-tavern:save-regex-script', {
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
        regexStatus.value = '已保存';
    } catch (error) {
        regexStatus.value = error instanceof Error ? error.message : String(error || '保存失败');
    }
}

async function deleteCurrentRegexScript() {
    const row = selectedRegexRow.value;
    const id = String(regexDraft.value.id || row?.script.id || '');
    const scriptType = row?.scriptType || Number(selectedRegexKey.value.split(':')[0]);
    if (!id || !Number.isFinite(scriptType)) {return;}
    if (!window.confirm('删除这个正则脚本？')) {return;}
    regexStatus.value = '正在删除';
    try {
        const result = await requestHost('xb-tavern:delete-regex-script', {
            payload: { scriptType, id },
        });
        regexList.value = (result.result || result) as Record<string, unknown>;
        applyActiveRegexScript(regexScriptRows.value[0] || null);
        regexStatus.value = '已删除';
    } catch (error) {
        regexStatus.value = error instanceof Error ? error.message : String(error || '删除失败');
    }
}

async function discardPresetChanges() {
    if (!presetDirty.value) {return;}
    preset.value = normalizeTavernChatPromptPresetBundle(activeChatPreset.value);
    savedPresetJson.value = snapshotPreset(activeChatPreset.value);
    presetStatus.value = '已放弃';
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
    assistantPresetStatus.value = '已切换';
}

async function saveCurrentAssistantPreset() {
    if (!assistantPresetDirty.value) {
        assistantPresetStatus.value = '没有未保存修改';
        return;
    }
    const savingBuiltIn = activeAssistantPresetRecord.value?.isBuiltIn === true;
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
    assistantPresetStatus.value = savingBuiltIn ? '已另存为自定义预设' : '已保存';
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
    assistantPresetStatus.value = '已复制';
}

async function discardAssistantPresetChanges() {
    if (!assistantPresetDirty.value) {return;}
    assistantPreset.value = { ...activeAssistantPreset.value };
    savedAssistantPresetJson.value = snapshotAssistantPreset(activeAssistantPreset.value);
    assistantPresetStatus.value = '已放弃';
}

function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error || 'unknown_error');
}

function clearComposeError() {
    if (composeErrorHideTimer) {
        window.clearTimeout(composeErrorHideTimer);
        composeErrorHideTimer = null;
    }
    composeErrorMessage.value = '';
}

function showComposeError(message = '', durationMs = 4200) {
    const text = String(message || '').trim();
    if (!text) {
        clearComposeError();
        return;
    }
    if (composeErrorHideTimer) {
        window.clearTimeout(composeErrorHideTimer);
        composeErrorHideTimer = null;
    }
    composeErrorMessage.value = text;
    composeErrorHideTimer = window.setTimeout(() => {
        composeErrorHideTimer = null;
        if (composeErrorMessage.value === text) {
            composeErrorMessage.value = '';
        }
    }, durationMs);
}

function postToHost(type: string, payload: Record<string, unknown> = {}) {
    const safePayload = clonePostMessagePayload(payload);
    window.parent?.postMessage({ source: SOURCE_APP, type, payload: safePayload }, window.location.origin);
}

function createHostRequestId(prefix = 'host') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAbortError() {
    try {
        return new DOMException('request_aborted', 'AbortError') as unknown as Error;
    } catch {
        return new Error('request_aborted');
    }
}

function requestHost(type: string, payload: Record<string, unknown> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const requestId = createHostRequestId();
    if (options.signal?.aborted) {
        return Promise.reject(createAbortError());
    }
    postToHost(type, { ...payload, requestId });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => {
            const pending = pendingHostRequests.get(requestId);
            if (pending?.abort && options.signal) {
                options.signal.removeEventListener('abort', pending.abort);
            }
            pendingHostRequests.delete(requestId);
        };
        const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error('host_request_timeout'));
        }, Number(options.timeoutMs) || HOST_REQUEST_TIMEOUT_MS);
        const abort = () => {
            window.clearTimeout(timer);
            cleanup();
            postToHost('xb-tavern:cancel-request', { requestId });
            reject(createAbortError());
        };
        if (options.signal) {
            options.signal.addEventListener('abort', abort, { once: true });
        }
        pendingHostRequests.set(requestId, { resolve, reject, timer, type, abort: options.signal ? abort : undefined, signal: options.signal });
    });
}

function stripTavernImageMarkers(text = '') {
    return String(text || '').replace(TAVERN_IMAGE_MARKER_REGEX, '').trim();
}

function findAnchorPosition(content = '', anchor = '') {
    const text = String(content || '');
    const normalizedAnchor = String(anchor || '').trim();
    if (!text || !normalizedAnchor) {return -1;}
    const directIndex = text.indexOf(normalizedAnchor);
    if (directIndex >= 0) {return directIndex + normalizedAnchor.length;}
    const compactText = text.replace(/\s+/g, '');
    const compactAnchor = normalizedAnchor.replace(/\s+/g, '');
    if (!compactAnchor) {return -1;}
    const compactIndex = compactText.indexOf(compactAnchor);
    if (compactIndex < 0) {return -1;}
    let compactCursor = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (/\s/.test(text[index])) {continue;}
        compactCursor += 1;
        if (compactCursor >= compactIndex + compactAnchor.length) {
            return index + 1;
        }
    }
    return -1;
}

function findNearestSentenceEnd(content = '', startPos = -1) {
    const text = String(content || '');
    if (startPos < 0 || !text) {return startPos;}
    if (startPos >= text.length) {return text.length;}
    const maxLookAhead = 80;
    const endLimit = Math.min(text.length, startPos + maxLookAhead);
    const basicEnders = new Set(['。', '！', '？', '!', '?', '…']);
    const closingMarks = new Set(['”', '“', '’', '‘', '」', '』', '】', '）', ')', '"', "'", '*', '~', '～', ']']);
    const eatClosingMarks = (position: number) => {
        let next = position;
        while (next < text.length && closingMarks.has(text[next])) {
            next += 1;
        }
        return next;
    };
    if (startPos > 0 && basicEnders.has(text[startPos - 1])) {
        return eatClosingMarks(startPos);
    }
    for (let offset = 0; offset < maxLookAhead && startPos + offset < endLimit; offset += 1) {
        const position = startPos + offset;
        const char = text[position];
        if (char === '\n') {return position + 1;}
        if (basicEnders.has(char)) {return eatClosingMarks(position + 1);}
        if (char === '.' && text.slice(position, position + 3) === '...') {
            return eatClosingMarks(position + 3);
        }
    }
    return startPos;
}

function insertTavernImageMarker(content = '', image: Record<string, unknown> = {}) {
    const slotId = String(image.slotId || '').trim();
    if (!slotId) {return { content, inserted: false, appended: false };}
    const marker = `[tavern-image:${slotId}]`;
    const text = String(content || '');
    if (text.includes(marker)) {return { content: text, inserted: false, appended: false };}
    let position = findAnchorPosition(text, String(image.anchor || ''));
    if (position >= 0) {
        position = findNearestSentenceEnd(text, position);
    }
    if (position >= 0) {
        const before = text.slice(0, position);
        const after = text.slice(position);
        let insertText = marker;
        if (before.length > 0 && !before.endsWith('\n')) {insertText = `\n${insertText}`;}
        if (after.length > 0 && !after.startsWith('\n')) {insertText = `${insertText}\n`;}
        return {
            content: `${before}${insertText}${after}`,
            inserted: true,
            appended: false,
        };
    }
    const needNewline = text.length > 0 && !text.endsWith('\n');
    return {
        content: `${text}${needNewline ? '\n' : ''}${marker}`,
        inserted: true,
        appended: true,
    };
}

function insertTavernImageMarkers(content = '', images: unknown[] = []) {
    let nextContent = String(content || '');
    let inserted = 0;
    let appended = 0;
    (Array.isArray(images) ? images : []).forEach((rawImage) => {
        const image = rawImage && typeof rawImage === 'object' ? rawImage as Record<string, unknown> : {};
        if (!image.slotId || image.success === false) {return;}
        const result = insertTavernImageMarker(nextContent, image);
        nextContent = result.content;
        if (result.inserted) {inserted += 1;}
        if (result.appended) {appended += 1;}
    });
    return { content: nextContent, inserted, appended };
}

function formatDrawProgress(stateName = '', data: Record<string, unknown> = {}) {
    const current = Number(data.current) || 0;
    const total = Number(data.total) || 0;
    const countText = total ? ` ${current}/${total}` : '';
    switch (stateName) {
        case 'llm':
            return '正在分析画面';
        case 'gen':
            return total ? `准备生成 ${total} 张图` : '准备生成图片';
        case 'queued':
            return Number(data.ahead) > 0 ? `画图排队中，前方 ${Number(data.ahead)} 个任务` : `画图排队中${countText}`;
        case 'progress':
            return `正在生成图片${countText}`;
        case 'cooldown': {
            const remainingMs = Number.isFinite(Number(data.remainingMs))
                ? Number(data.remainingMs)
                : Number(data.duration);
            if (!Number.isFinite(remainingMs) || remainingMs <= 0) {return '等待画图冷却';}
            return `等待下一张图片${total ? ` ${data.nextIndex || current}/${total}` : ''}，剩余 ${(remainingMs / 1000).toFixed(1)}s`;
        }
        case 'success': {
            const success = Number(data.success) || 0;
            const finalTotal = total || success;
            if (finalTotal > 0 && success === 0) {
                return `画图结束，${finalTotal} 张都失败`;
            }
            return `画图完成 ${success}/${finalTotal}`;
        }
        default:
            return '正在处理画图';
    }
}

async function refreshTavernDrawStatus() {
    try {
        const result = await requestHost('xb-tavern:draw-status', {});
        tavernDrawStatus.value = {
            provider: String(result.provider || 'disabled'),
            enabled: result.enabled === true,
            ready: result.ready === true,
        };
    } catch {
        tavernDrawStatus.value = { provider: 'disabled', enabled: false, ready: false };
    }
    return tavernDrawStatus.value;
}

async function applyTavernRegex(items: TavernApplyRegexItem[]): Promise<TavernApplyRegexResult> {
    if (!items.length) {
        return { items: [], changedCount: 0 };
    }
    const response = await requestHost('xb-tavern:apply-regex', {
        payload: { items },
    });
    const result = (response.result || response) as Partial<TavernApplyRegexResult>;
    return {
        items: Array.isArray(result.items) ? result.items : [],
        changedCount: Number(result.changedCount) || 0,
    };
}

async function applyTavernSubstituteParams(items: TavernSubstituteParamsItem[]): Promise<TavernSubstituteParamsResult> {
    if (!items.length) {
        return { items: [], changedCount: 0 };
    }
    const response = await requestHost('xb-tavern:substitute-params', {
        payload: { items },
    });
    const result = (response.result || response) as Partial<TavernSubstituteParamsResult>;
    return {
        items: Array.isArray(result.items) ? result.items : [],
        changedCount: Number(result.changedCount) || 0,
    };
}

async function getNativeWorldbookRuntime(input: {
    context: XbTavernContext;
    currentUserMessage: string;
    trigger?: string;
    timedState?: unknown;
}): Promise<XbTavernNativeWorldInfoRuntime> {
    const response = await requestHost('xb-tavern:get-worldbook-runtime', {
        payload: {
            context: input.context,
            currentUserMessage: input.currentUserMessage,
            trigger: input.trigger,
            timedState: input.timedState,
        },
    });
    return (response.result || response) as XbTavernNativeWorldInfoRuntime;
}

async function getHostContext(input: {
    characterId?: string;
    includeHistory?: boolean;
} = {}): Promise<Record<string, unknown>> {
    const response = await requestHost('xb-tavern:get-context', {
        payload: {
            characterId: input.characterId,
            includeHistory: input.includeHistory,
        },
    });
    return (response.result || response) as Record<string, unknown>;
}

function currentContextCharacterId() {
    return String(context.value.character?.id || selectedCharacterId.value || '').trim();
}

function currentContextCharacterReady() {
    return !!displayableTavernName(context.value.character?.name || '') && !!currentContextCharacterId();
}

async function syncSessionCharacterContext(options: { sessionId?: string; force?: boolean } = {}): Promise<XbTavernContext> {
    const targetSessionId = String(options.sessionId || selectedSessionId.value || '').trim();
    const session = sessions.value.find((item) => item.id === targetSessionId) || (targetSessionId === selectedSessionId.value ? selectedSession.value : null);
    if (!session) {return context.value;}
    const targetCharacterId = String(session.characterId || '').trim();
    if (!targetCharacterId) {return context.value;}
    if (!options.force && currentContextCharacterReady() && currentContextCharacterId() === targetCharacterId) {
        return context.value;
    }
    const syncSequence = ++sessionContextSyncSequence;
    const payload = await getHostContext({
        characterId: targetCharacterId,
        includeHistory: false,
    });
    if (syncSequence !== sessionContextSyncSequence) {
        return context.value;
    }
    if (targetSessionId !== String(selectedSessionId.value || '').trim()) {
        return context.value;
    }
    applyHostPayload(payload);
    const nextContext = payload.context as XbTavernContext || context.value;
    const updatedSession = await updateTavernSessionSnapshot(targetSessionId, {
        contextSnapshot: nextContext,
        characterId: String(nextContext.character?.id || session.characterId || ''),
        characterName: String(nextContext.character?.name || session.characterName || ''),
    });
    if (updatedSession) {
        sessions.value = sessions.value.map((item) => item.id === updatedSession.id ? updatedSession : item);
    }
    return nextContext;
}

async function resolveRuntimeContextForSession(sessionId = selectedSessionId.value): Promise<XbTavernContext> {
    const targetSessionId = String(sessionId || '').trim();
    if (!targetSessionId) {return context.value;}
    return await syncSessionCharacterContext({ sessionId: targetSessionId });
}

function resolveHostRequest(payload: Record<string, unknown> = {}) {
    const requestId = String(payload.requestId || '');
    const pending = pendingHostRequests.get(requestId);
    if (!pending) {return;}
    window.clearTimeout(pending.timer);
    if (pending.abort && pending.signal) {
        pending.signal.removeEventListener('abort', pending.abort);
    }
    pendingHostRequests.delete(requestId);
    if (payload.ok === false) {
        const errorText = String(payload.error || 'host_request_failed');
        const error = new Error(`${pending.type}: ${errorText}`);
        const errorStack = String(payload.errorStack || '');
        if (errorStack) {
            error.stack = `${error.message}\n${errorStack}`;
        }
        console.error('[小白酒馆] host request failed', {
            type: pending.type,
            error: errorText,
            errorName: String(payload.errorName || ''),
            errorStack,
        });
        pending.reject(error);
        return;
    }
    pending.resolve(payload);
}

function installHostRequestHeadersProvider(payload: Record<string, unknown> = {}) {
    const fallbackHeaders = payload.hostRequestHeaders && typeof payload.hostRequestHeaders === 'object'
        ? payload.hostRequestHeaders as Record<string, unknown>
        : hostRequestHeaders.value;
    hostRequestHeaders.value = fallbackHeaders || {};
    setHostChatCompletionsRequestHeadersProvider(async () => {
        try {
            const result = await requestHost('xb-tavern:get-host-request-headers');
            return result.hostRequestHeaders && typeof result.hostRequestHeaders === 'object'
                ? result.hostRequestHeaders as Record<string, unknown>
                : hostRequestHeaders.value;
        } catch {
            return hostRequestHeaders.value;
        }
    });
}

function syncApiSettingsConfigFromAgentConfig() {
    apiSettingsPanelState.config = normalizeAgentConfig(agentConfig.value || {});
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
    apiConfigStatus.value = result.ok ? '共享 API 配置已保存。' : `保存失败：${result.error || 'unknown_error'}`;
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
    postToHost('xb-tavern:save-config', {
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
            describeError,
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
        isBusy: isRunning.value,
        canDeletePreset: Object.keys((apiSettingsPanelState.config as Record<string, unknown>)?.presets || {}).length > 1,
    });
    apiSettingsPanel.syncConfigToForm(root);
    apiSettingsPanel.bindSettingsPanelEvents(root);
}

function handleApiConfigSaved(payload: Record<string, unknown>) {
    const ok = payload.ok === true;
    if (ok) {
        agentConfig.value = payload.config as Record<string, unknown> || agentConfig.value;
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

function applyHostPayload(payload: Record<string, unknown>) {
    installHostRequestHeadersProvider(payload);
    context.value = payload.context as XbTavernContext || {};
    diagnostics.value = payload.diagnostics as TavernDiagnostics || {};
    if ('agentConfig' in payload) {
        agentConfig.value = payload.agentConfig as Record<string, unknown> || agentConfig.value;
        syncApiSettingsConfigFromAgentConfig();
    }
    if ('chatPreset' in payload) {
        applyActiveChatPreset(payload.chatPreset as Partial<TavernChatPromptPresetBundle>, {
            replaceDraft: !presetDirty.value,
        });
    }
    if ('chatPresetList' in payload) {
        chatPresetList.value = payload.chatPresetList as Record<string, unknown> || {};
    }
    availableCharacters.value = payload.availableCharacters as TavernCharacterOption[] || availableCharacters.value;
    selectedCharacterId.value = String(payload.selectedCharacterId || context.value.character?.id || selectedCharacterId.value || '');
    statusText.value = diagnostics.value.message || '已同步酒馆内容';
    void finishPendingCharacterSession().catch((error) => {
        pendingCharacterError.value = error instanceof Error ? error.message : String(error || 'create_session_failed');
        clearPendingCharacterSession();
    });
    void nextTick(renderApiSettingsPanel);
}

function onHostMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) {return;}
    const data = event.data || {};
    if (data.source !== SOURCE_HOST) {return;}
    if (data.type === 'xb-tavern:host-result') {
        resolveHostRequest(data.payload || {});
        return;
    }
    if (data.type === 'xb-tavern:draw-progress') {
        const payload = data.payload || {};
        if (drawingMessageKey.value) {
            drawStatusMessageKey.value = drawingMessageKey.value;
            drawStatusKind.value = payload.state === 'success' ? 'success' : 'running';
            drawProgressText.value = formatDrawProgress(String(payload.state || ''), payload.data || {});
        }
        return;
    }
    if (data.type === 'xb-tavern:config') {
        applyHostPayload(data.payload || {});
        return;
    }
    if (data.type === 'xb-tavern:context') {
        applyHostPayload(data.payload || {});
        return;
    }
    if (data.type === 'xb-tavern:config-saved') {
        handleApiConfigSaved(data.payload || {});
    }
}

function openCharacterSelect() {
    activeView.value = 'characters';
    pendingCharacterError.value = '';
    selectedCharacterPreviewId.value = '';
    refreshCharacterList();
}

function openSettingsWorkspace(workspace: SettingsWorkspaceKey) {
    activeSettingsWorkspace.value = workspace;
    activeView.value = 'settings';
}

function selectSettingsWorkspace(workspace: string) {
    const normalized = workspace as SettingsWorkspaceKey;
    if (normalized === 'api'
        || normalized === 'chatPreset'
        || normalized === 'worldbooks'
        || normalized === 'regex'
        || normalized === 'assistantPreset') {
        openSettingsWorkspace(normalized);
    }
}

function refreshCharacterList() {
    statusText.value = '正在读取角色列表';
    pendingCharacterError.value = '';
    postToHost('xb-tavern:refresh-context', {});
}

function selectCharacterForPreview(characterId: string) {
    const targetId = String(characterId || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    selectedCharacterPreviewId.value = targetId;
}

function selectCharacterGreeting(index: number) {
    const options = selectedCharacterGreetingOptions.value;
    if (!options.length) {
        selectedCharacterGreetingIndex.value = 0;
        return;
    }
    selectedCharacterGreetingIndex.value = Math.max(0, Math.min(options.length - 1, Number(index) || 0));
}

function scrollSelectedCharacterPreviewIntoView() {
    void nextTick(() => {
        characterArchivePageRef.value?.scrollSelectedIntoView();
    });
}

function moveCharacterPreview(delta: number) {
    const cards = visibleCharacterCards.value;
    if (!cards.length || pendingCharacterSessionId.value) {return;}
    const currentId = String(selectedCharacterPreview.value?.id || selectedCharacterPreviewId.value || '').trim();
    if (!currentId) {
        selectedCharacterPreviewId.value = cards[delta < 0 ? cards.length - 1 : 0]?.id || '';
        scrollSelectedCharacterPreviewIntoView();
        return;
    }
    const currentIndex = Math.max(0, cards.findIndex((character) => character.id === currentId));
    const nextIndex = Math.min(cards.length - 1, Math.max(0, currentIndex + delta));
    selectedCharacterPreviewId.value = cards[nextIndex]?.id || '';
    scrollSelectedCharacterPreviewIntoView();
}

function handleCharacterArchiveKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveCharacterPreview(1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveCharacterPreview(-1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        selectedCharacterPreviewId.value = visibleCharacterCards.value[0]?.id || '';
        scrollSelectedCharacterPreviewIntoView();
    } else if (event.key === 'End') {
        event.preventDefault();
        selectedCharacterPreviewId.value = visibleCharacterCards.value.at(-1)?.id || '';
        scrollSelectedCharacterPreviewIntoView();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        void enterSelectedCharacter();
    }
}

async function enterSelectedCharacter() {
    const targetId = String(selectedCharacterPreview.value?.id || selectedCharacterPreviewId.value || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    await selectCharacterAndCreateSession(targetId);
}

async function refreshSessions() {
    sessions.value = await listTavernSessions();
    const liveSessionIds = new Set(sessions.value.map((session) => session.id));
    sessionSearchCorpusCache.forEach((_value, sessionId) => {
        if (!liveSessionIds.has(sessionId)) {sessionSearchCorpusCache.delete(sessionId);}
    });
    selectedSessionId.value = await getSelectedTavernSessionId();
    if (!selectedSessionId.value && sessions.value[0]) {
        selectedSessionId.value = sessions.value[0].id;
        await setSelectedTavernSessionId(selectedSessionId.value);
    }
    sessionMessages.value = selectedSessionId.value ? await listTavernMessages(selectedSessionId.value) : [];
    await refreshManagerRecords(selectedSessionId.value);
    if (selectedSessionId.value) {
        void syncSessionCharacterContext({ sessionId: selectedSessionId.value });
    }
}

async function saveSessionContract(nextContract: Partial<TavernSessionContract> = {}) {
    const sessionId = String(selectedSessionId.value || '').trim();
    if (!sessionId) {return null;}
    const updated = await updateTavernSessionState(sessionId, {
        contract: normalizeTavernSessionContract({
            ...sessionContract.value,
            ...nextContract,
        }),
    });
    if (!updated) {return null;}
    sessions.value = sessions.value.map((session) => session.id === updated.id ? updated : session);
    return updated;
}

async function refreshManagerRecords(sessionId = selectedSessionId.value) {
    const id = String(sessionId || '').trim();
    if (!id) {
        managerChatMessages.value = [];
        managerRuns.value = [];
        memoryFiles.value = [];
        memoryIndex.value = null;
        invalidateMemoryFileRecordLoad();
        stateMemoryFile.value = null;
        mapStateDocument.value = null;
        mapStatePatches.value = [];
        selectedMemoryFilePath.value = '';
        return;
    }
    const [managerMessages, runs, rawIndex, mapState, nextStateFile] = await Promise.all([
        listTavernManagerMessages(id),
        listTavernManagerRuns(id, { limit: 18 }),
        getTavernMemoryIndex(id),
        getTavernMapStateForSession(id),
        getTavernMemoryFile(id, 'memory/state.md'),
    ]);
    const index = rawIndex && rawIndex.status === 'ready' && Array.isArray(rawIndex.files)
        ? rawIndex
        : await rebuildTavernMemoryDerivedIndex(id);
    if (id !== selectedSessionId.value) {return;}
    managerChatMessages.value = managerMessages;
    managerRuns.value = runs;
    memoryFiles.value = Array.isArray(index.files) ? index.files.map((file) => ({
        path: String(file.path || ''),
        status: file.status === 'stale' ? 'stale' : 'active',
        createdAt: Number(file.createdAt) || Number(file.updatedAt) || 0,
        updatedAt: Number(file.updatedAt) || 0,
        source: String(file.source || ''),
        staleFromOrder: Number.isFinite(Number(file.staleFromOrder)) ? Number(file.staleFromOrder) : undefined,
        contentLength: Math.max(0, Number(file.contentLength) || 0),
        title: String(file.title || ''),
        preview: String(file.preview || ''),
        searchText: String(file.searchText || ''),
    })) : [];
    memoryIndex.value = index;
    stateMemoryFile.value = nextStateFile;
    mapStateDocument.value = mapState.document;
    mapStatePatches.value = mapState.patches;
    if (!memoryFiles.value.some((file) => file.path === selectedMemoryFilePath.value)) {
        if (memoryEditorDirty.value && selectedMemoryFilePath.value) {
            memoryEditorStatus.value = '当前档案已变化，草稿仍保留';
            return;
        }
        selectedMemoryFilePath.value = memoryFiles.value[0]?.path || '';
    }
}

async function pollLiveManagerRecords() {
    managerStatusClock.value = Date.now();
    if (managerRecordsPollRunning) {return;}
    if (!selectedSessionId.value) {return;}
    const hasLiveManagerRun = managerRuns.value.some((run) => isManagerRunLive(run.status));
    if (!hasLiveManagerRun && !isRunning.value && !isManagerAssistantRunning.value) {return;}
    managerRecordsPollRunning = true;
    try {
        await refreshManagerRecords(selectedSessionId.value);
    } finally {
        managerRecordsPollRunning = false;
    }
}

async function rebuildSelectedSessionRuntimeState(messages: TavernMessageRecord[] = sessionMessages.value) {
    if (!selectedSessionId.value) {return;}
    const currentSessionState = normalizeTavernSessionState(selectedSession.value?.state || {});
    const runtimeContext = await resolveRuntimeContextForSession(selectedSessionId.value);
    const state = await deriveTavernSessionStateFromMessagesAsync({
        messages,
        contextSnapshot: runtimeContext,
        chatPreset: activeChatPreset.value,
        historyMode: historyMode.value,
        diagnostics: diagnostics.value,
        applySubstituteParams: applyTavernSubstituteParams,
        getNativeWorldInfoRuntime: getNativeWorldbookRuntime,
    });
    await replaceTavernSessionState(selectedSessionId.value, {
        ...state,
        contract: currentSessionState.contract,
    });
    await refreshSessions();
}

function resetSessionPreviewState() {
    simulateRequestSequence += 1;
    currentUserMessage.value = '';
    runtimeText.value = '';
    runtimeError.value = '';
    simulateRequestInput.value = '';
    simulateRequestJson.value = '';
    simulateRequestStatus.value = '';
    simulateRequestError.value = '';
    showPromptInspector.value = false;
    promptInspectorTab.value = 'history';
    managerCompactionOverlay.value = null;
    resetChatMessageWindowState();
    resetManagerMessageWindowState();
    markdownHtmlCache.clear();
}

function resetChatMessageWindowState() {
    const state = { uiMessageWindowLimit: chatMessageWindowLimit.value };
    resetMessageWindow(state);
    chatMessageWindowLimit.value = Number(state.uiMessageWindowLimit || AGENT_MESSAGE_WINDOW_DEFAULT);
}

function resetManagerMessageWindowState() {
    const state = { uiMessageWindowLimit: managerMessageWindowLimit.value };
    resetMessageWindow(state);
    managerMessageWindowLimit.value = Number(state.uiMessageWindowLimit || AGENT_MESSAGE_WINDOW_DEFAULT);
}

function revealOlderChatMessages(force = false) {
    const node = chatScrollRef.value;
    if (!force && chatAutoScroll.value !== false) {return false;}
    if (!node || (!force && node.scrollTop > 64)) {return false;}
    const state = { uiMessageWindowLimit: chatMessageWindowLimit.value };
    if (!expandMessageWindow(state, chatMessages.value.length)) {return false;}
    chatMessageWindowLimit.value = Number(state.uiMessageWindowLimit || chatMessageWindowLimit.value);
    chatAutoScroll.value = false;
    return true;
}

function revealOlderManagerMessages(force = false) {
    const node = managerScrollRef.value;
    if (!force && managerAutoScroll.value !== false) {return false;}
    if (!node || (!force && node.scrollTop > 64)) {return false;}
    const state = { uiMessageWindowLimit: managerMessageWindowLimit.value };
    if (!expandMessageWindow(state, managerChatDisplayItems.value.length)) {return false;}
    managerMessageWindowLimit.value = Number(state.uiMessageWindowLimit || managerMessageWindowLimit.value);
    managerAutoScroll.value = false;
    return true;
}

function getCharacterGreetingOptions(character: XbTavernCharacter = {}) {
    return [
        String(character.firstMessage || character.first_mes || '').trim(),
        ...normalizeTextList(character.alternateGreetings || character.alternate_greetings),
    ].filter(Boolean);
}

async function appendFirstMessageIfPresent(sessionId: string, snapshotContext: XbTavernContext, greetingIndex = 0) {
    const greetingOptions = getCharacterGreetingOptions(snapshotContext.character || {});
    const normalizedIndex = Math.max(0, Math.min(greetingOptions.length - 1, Number(greetingIndex) || 0));
    const firstMessage = String(greetingOptions[normalizedIndex] || '').trim();
    if (!firstMessage) {return;}
    await appendTavernMessage(sessionId, {
        role: 'assistant',
        name: String(snapshotContext.character?.name || ''),
        content: firstMessage,
        contextSnapshot: snapshotContext,
        chatPresetId: String(activeChatPreset.value.id || ''),
        chatPresetName: String(activeChatPreset.value.name || ''),
        presetId: String(activeChatPreset.value.id || ''),
        presetName: String(activeChatPreset.value.name || ''),
    });
}

async function createSessionFromContext(options: { includeFirstMessage?: boolean; contextSnapshot?: XbTavernContext; greetingIndex?: number } = {}) {
    const snapshotContext = options.contextSnapshot || context.value;
    const snapshotBrain = buildXbTavernBrain({
        context: snapshotContext,
        chatPreset: activeChatPreset.value,
        currentUserMessage: '',
        historyMode: historyMode.value,
        turn: 0,
        entryStates: {},
        diagnostics: diagnostics.value,
    });
    const session = await createTavernSession({
        title: String(snapshotContext.character?.name || '未选择角色'),
        characterId: String(snapshotContext.character?.id || ''),
        characterName: String(snapshotContext.character?.name || '未选择角色'),
        contextSnapshot: snapshotContext,
        buildSnapshot: snapshotBrain.buildSnapshot,
        chatPresetId: String(activeChatPreset.value.id || ''),
        chatPresetName: String(activeChatPreset.value.name || ''),
        presetId: String(activeChatPreset.value.id || ''),
        presetName: String(activeChatPreset.value.name || ''),
        state: {
            turn: 0,
            worldEntryStates: {},
            nativeWorldInfoTimedState: { sticky: {}, cooldown: {} },
        },
    });
    if (options.includeFirstMessage !== false) {
        await appendFirstMessageIfPresent(session.id, snapshotContext, options.greetingIndex);
    }
    selectedSessionId.value = session.id;
    await refreshSessions();
    return session;
}

async function createSessionAndOpenChat(options: { contextSnapshot?: XbTavernContext; greetingIndex?: number } = {}) {
    await createSessionFromContext(options);
    activeView.value = 'chat';
    chatFocus.value = 'chat';
    scrollChatToBottom(true);
}

async function handleHomePrimaryAction() {
    if (selectedSessionId.value) {
        openChatView();
        return;
    }
    openCharacterSelect();
}

function clearPendingCharacterSession() {
    if (pendingCharacterSessionTimer) {
        window.clearTimeout(pendingCharacterSessionTimer);
        pendingCharacterSessionTimer = null;
    }
    pendingCharacterSessionId.value = '';
    pendingCharacterGreetingIndex.value = 0;
}

async function finishPendingCharacterSession() {
    const targetId = pendingCharacterSessionId.value;
    if (!targetId) {return;}
    const currentId = String(context.value.character?.id || selectedCharacterId.value || '').trim();
    if (currentId !== targetId) {return;}
    if (!displayableTavernName(context.value.character?.name || '')) {
        clearPendingCharacterSession();
        pendingCharacterError.value = '没有读到这张角色卡。';
        return;
    }
    const greetingIndex = pendingCharacterGreetingIndex.value;
    clearPendingCharacterSession();
    pendingCharacterError.value = '';
    resetSessionPreviewState();
    await createSessionAndOpenChat({ greetingIndex });
}

async function selectCharacterAndCreateSession(characterId: string) {
    const targetId = String(characterId || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    const wasPreviewed = targetId === String(selectedCharacterPreviewId.value || '').trim();
    const greetingIndex = wasPreviewed ? selectedCharacterGreetingIndex.value : 0;
    selectedCharacterPreviewId.value = targetId;
    selectedCharacterGreetingIndex.value = greetingIndex;
    selectedSessionId.value = '';
    sessionMessages.value = [];
    await setSelectedTavernSessionId('');
    await refreshManagerRecords('');
    resetSessionPreviewState();
    selectedCharacterId.value = targetId;
    pendingCharacterError.value = '';
    statusText.value = '正在读取角色卡';
    pendingCharacterSessionId.value = targetId;
    pendingCharacterGreetingIndex.value = greetingIndex;
    if (pendingCharacterSessionTimer) {window.clearTimeout(pendingCharacterSessionTimer);}
    pendingCharacterSessionTimer = window.setTimeout(() => {
        if (pendingCharacterSessionId.value !== targetId) {return;}
        clearPendingCharacterSession();
        pendingCharacterError.value = '读取角色卡超时。';
    }, CHARACTER_CONTEXT_TIMEOUT_MS);
    postToHost('xb-tavern:refresh-context', { characterId: targetId, includeHistory: false });
}

async function selectSession(sessionId: string) {
    resetSessionPreviewState();
    invalidateMemoryFileRecordLoad();
    selectedSessionId.value = sessionId;
    await setSelectedTavernSessionId(sessionId);
    sessionMessages.value = await listTavernMessages(sessionId);
    await refreshManagerRecords(sessionId);
    void syncSessionCharacterContext({ sessionId, force: true });
    activeView.value = 'chat';
    chatFocus.value = 'chat';
    scrollChatToBottom(true);
}

async function removeSession(sessionId: string, event?: Event) {
    event?.stopPropagation();
    const id = String(sessionId || '').trim();
    if (!id) {return;}
    const session = sessions.value.find((item) => item.id === id);
    const title = sessionDisplayTitle(session) || '这个会话';
    if (!window.confirm(`删除「${title}」？`)) {return;}
    if (id === selectedSessionId.value && isRunning.value) {
        activeRunController.value?.abort();
    }
    const removed = await deleteTavernSession(id);
    if (!removed) {return;}
    if (id === selectedSessionId.value) {
        resetSessionPreviewState();
    }
    await refreshSessions();
    if (!selectedSessionId.value) {
        sessionMessages.value = [];
        await refreshManagerRecords('');
        activeView.value = 'home';
        return;
    }
    activeView.value = 'chat';
    chatFocus.value = 'chat';
    scrollChatToBottom(true);
}

function openChatView() {
    activeView.value = 'chat';
    chatFocus.value = 'chat';
    scrollChatToBottom(true);
}

function openPromptInspector(tab: 'history' | 'simulate' = 'history') {
    promptInspectorTab.value = tab;
    showPromptInspector.value = true;
}

function closePromptInspector() {
    showPromptInspector.value = false;
}

async function simulateApiRequest() {
    const messageText = simulateRequestInput.value.trim();
    simulateRequestError.value = '';
    simulateRequestStatus.value = '';
    simulateRequestJson.value = '';
    if (!messageText) {
        simulateRequestError.value = '先写一句话。';
        return;
    }
    const requestSequence = simulateRequestSequence + 1;
    simulateRequestSequence = requestSequence;
    const requestSessionId = selectedSessionId.value;
    simulateRequestStatus.value = '模拟中';
    try {
        const runtimeContext = await resolveRuntimeContextForSession(requestSessionId);
        const result = await simulateXbTavernRequest({
            sessionId: requestSessionId,
            agentConfig: agentConfig.value,
            contextSnapshot: runtimeContext,
            chatPreset: activeChatPreset.value,
            currentUserMessage: messageText,
            runtimeState: normalizeTavernSessionState(selectedSession.value?.state || {}),
            diagnostics: diagnostics.value,
            historyMode: historyMode.value,
            applyRegex: applyTavernRegex,
            applySubstituteParams: applyTavernSubstituteParams,
            getNativeWorldInfoRuntime: getNativeWorldbookRuntime,
        });
        if (requestSequence !== simulateRequestSequence || requestSessionId !== selectedSessionId.value) {return;}
        simulateRequestJson.value = result.requestSnapshot.rawRequestJson || result.requestSnapshot.rawMessagesJson || '';
        simulateRequestStatus.value = `模拟完成 · ${result.requestSnapshot.providerLabel || result.provider} / ${result.model || '未选择模型'}`;
    } catch (error) {
        if (requestSequence !== simulateRequestSequence || requestSessionId !== selectedSessionId.value) {return;}
        console.error('[小白酒馆] simulate request failed', error);
        simulateRequestStatus.value = '';
        simulateRequestError.value = error instanceof Error ? error.message : String(error || 'simulate_failed');
    }
}

function shortText(value = '', limit = 180) {
    const text = String(value || '').trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatDurationAgo(timestamp = 0) {
    const elapsed = Math.max(0, managerStatusClock.value - Number(timestamp || 0));
    if (!timestamp || elapsed < 3000) {return '刚刚';}
    return formatElapsedDuration(elapsed);
}

function formatElapsedDuration(elapsed = 0) {
    const seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) {return `${seconds} 秒前`;}
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {return `${minutes} 分钟前`;}
    return `${Math.floor(minutes / 60)} 小时前`;
}

function formatRunningDuration(timestamp = 0) {
    const elapsed = Math.max(0, managerStatusClock.value - Number(timestamp || 0));
    if (!timestamp || elapsed < 3000) {return '刚开始';}
    return formatElapsedDuration(elapsed).replace(/前$/, '');
}

function isManagerRunLive(status = '') {
    return ['queued', 'running'].includes(String(status || ''));
}

function managerStatusLabel(status = '') {
    const labels: Record<string, string> = {
        queued: '排队',
        running: '运行中',
        completed: '完成',
        failed: '失败',
        cancelled: '已取消',
        superseded: '已作废',
        rolled_back: '未采用',
    };
    return labels[status] || status || '未知';
}

function managerRunTone(runOrStatus: TavernManagerRunRecord | string = '') {
    const status = typeof runOrStatus === 'string' ? runOrStatus : String(runOrStatus?.status || '');
    if (typeof runOrStatus !== 'string' && status === 'running') {
        const updatedAt = Number(runOrStatus.updatedAt) || Number(runOrStatus.createdAt) || 0;
        const silentMs = Math.max(0, managerStatusClock.value - updatedAt);
        if (silentMs > 30000) {return 'danger';}
        if (silentMs > 9000) {return 'warn';}
    }
    if (['failed', 'rolled_back'].includes(status)) {return 'danger';}
    if (['cancelled', 'superseded'].includes(status)) {return 'muted';}
    if (['queued', 'running'].includes(status)) {return 'active';}
    if (status === 'completed') {return 'done';}
    return 'neutral';
}

function formatManagerSource(run: TavernManagerRunRecord) {
    return `第 ${run.turn || 0} 轮 · ${run.userOrder}/${run.assistantOrder}`;
}

function formatRunModelLine(run: TavernManagerRunRecord) {
    if (run.status === 'queued') {return '等待后台模型';}
    if (run.status === 'running') {return '后台模型运行中';}
    const provider = String(run.provider || '').trim();
    const model = String(run.model || '').trim();
    return [provider, model].filter(Boolean).join(' / ') || '未记录模型信息';
}

function formatRunActivityLine(run: TavernManagerRunRecord) {
    const status = String(run.status || '');
    const updatedAt = Number(run.updatedAt) || Number(run.createdAt) || 0;
    if (status === 'queued') {
        return `等待开始 · 建立于 ${formatDurationAgo(run.createdAt)}`;
    }
    if (status === 'running') {
        const silentMs = Math.max(0, managerStatusClock.value - updatedAt);
        const runningFor = formatRunningDuration(run.createdAt);
        if (silentMs <= 9000) {return `还活着 · 已运行 ${runningFor} · 正在等 API/工具返回`;}
        if (silentMs <= 30000) {return `等待中 · 已运行 ${runningFor} · 上次心跳 ${formatDurationAgo(updatedAt)}`;}
        return `可能卡住 · 已运行 ${runningFor} · ${formatDurationAgo(updatedAt)}没有心跳`;
    }
    if (['completed', 'failed', 'cancelled', 'superseded', 'rolled_back'].includes(status)) {
        return `已结束 · ${formatDurationAgo(updatedAt)}`;
    }
    return updatedAt ? `最后更新 ${formatDurationAgo(updatedAt)}` : '';
}

function formatRunIssueLine(run: TavernManagerRunRecord) {
    const error = String(run.error || '').trim();
    const labels: Record<string, string> = {
        manager_memory_tool_failed: '记忆工具返回失败，系统没有采用这次结果。',
        manager_memory_tool_required: '本轮没有完成必要的记忆维护，系统没有采用这次结果。',
        manager_aborted: '本次后台工作已停止，系统没有采用这次结果。',
        manager_source_messages_changed: '原文消息已经变化，系统没有采用这次结果。',
    };
    if (/工具轮次达到上限/.test(error)) {return `原因：${error} 系统没有采用这次结果。`;}
    if (error && labels[error]) {return `原因：${labels[error]}`;}
    if (run.status === 'rolled_back') {return '原因：本次结果已撤回，当前记忆和地图保持上一版。';}
    if (error) {return `原因：${error}`;}
    return '';
}

function formatRunInputLine(run: TavernManagerRunRecord) {
    const roleTurn = `第 ${Math.max(0, Number(run.turn) || 0)} 轮`;
    const source = Number.isFinite(Number(run.userOrder)) && Number.isFinite(Number(run.assistantOrder))
        ? `原文 ${run.userOrder}/${run.assistantOrder}`
        : '';
    const trigger = run.trigger === 'after_turn' ? '自动记忆' : run.trigger === 'manager_chat' ? '助手聊天' : String(run.trigger || '');
    return [roleTurn, source, trigger].filter(Boolean).join(' · ');
}

function formatRunMemoryLine(run: TavernManagerRunRecord) {
    const files = Array.isArray(run.changedFiles) ? run.changedFiles : [];
    if (run.status === 'queued') {return '记忆：等待开始';}
    if (run.status === 'running') {return '记忆：正在整理';}
    if (run.status === 'failed') {return files.length ? `记忆：已写入 ${files.length} 份档案，但本轮失败` : '记忆：未完成';}
    if (['cancelled', 'superseded'].includes(run.status)) {return '记忆：已停止，未采用本轮结果';}
    if (run.status === 'rolled_back') {return '记忆：未采用，已撤回本轮写入';}
    if (!files.length) {return '记忆：没有写入文件';}
    return `记忆：已更新 ${files.length} 份档案`;
}

function formatRunMapLine(run: TavernManagerRunRecord) {
    const states = Array.isArray(run.changedStates) ? run.changedStates : [];
    if (run.status === 'queued') {return '地图：等待开始';}
    if (run.status === 'running') {return '地图：正在判断本轮有没有空间变化';}
    if (run.status === 'failed') {return states.length ? `地图：已写入 ${states.length} 份状态，但本轮失败` : '地图：未完成';}
    if (['cancelled', 'superseded'].includes(run.status)) {return '地图：已停止，未采用本轮结果';}
    if (run.status === 'rolled_back') {return '地图：未采用，已撤回本轮更新';}
    if (states.length) {return `地图：已更新 ${states.length} 份状态`;}
    return '地图：本轮没有明确空间变化，未更新';
}

function memoryFileStatusLabel(status = '') {
    return status === 'stale' ? '过期' : '可用';
}

function memoryFileContentLength(file: TavernMemoryFileListEntry | TavernMemoryFileRecord | null | undefined): number {
    if (!file) {return 0;}
    if ('contentLength' in file && Number.isFinite(Number(file.contentLength))) {
        return Math.max(0, Number(file.contentLength) || 0);
    }
    return 'content' in file ? Math.max(0, String(file.content || '').length) : 0;
}

function formatMemoryFileMeta(file: TavernMemoryFileListEntry | TavernMemoryFileRecord) {
    return `${memoryFileStatusLabel(file.status)} · ${memoryFileContentLength(file)} 字`;
}

function loadMemoryFileIntoEditor(file: TavernMemoryFileRecord | null | undefined) {
    const content = String(file?.content || '');
    memoryEditorLoadedPath.value = String(file?.path || '');
    memoryEditorBaseContent.value = content;
    memoryEditorDraft.value = content;
    memoryEditorMode.value = 'preview';
    memoryEditorStatus.value = '';
}

let memoryFileLoadToken = 0;

function invalidateMemoryFileRecordLoad(clearRecord = true) {
    memoryFileLoadToken += 1;
    if (clearRecord) {
        selectedMemoryFileRecord.value = null;
    }
}

async function loadSelectedMemoryFileRecord(path = '') {
    const sessionId = String(selectedSessionId.value || '').trim();
    const nextPath = String(path || '').trim();
    const loadToken = ++memoryFileLoadToken;
    if (!sessionId || !nextPath) {
        invalidateMemoryFileRecordLoad();
        return null;
    }
    const file = await getTavernMemoryFile(sessionId, nextPath);
    if (loadToken !== memoryFileLoadToken) {return null;}
    selectedMemoryFileRecord.value = file;
    return file;
}

function selectMemoryFile(path = '') {
    const nextPath = String(path || '').trim();
    if (!nextPath || nextPath === selectedMemoryFilePath.value) {return;}
    if (memoryEditorDirty.value && !window.confirm('当前记忆档案有未保存修改，切换后会放弃这份草稿。继续切换？')) {
        return;
    }
    selectedMemoryFilePath.value = nextPath;
}

async function saveSelectedMemoryFile() {
    const file = selectedMemoryFileEntry.value;
    if (!selectedSessionId.value || !file) {return;}
    memoryEditorStatus.value = '保存中';
    try {
        await writeTavernMemoryFile(selectedSessionId.value, file.path, memoryEditorDraft.value, { source: 'user' });
        await refreshManagerRecords(selectedSessionId.value);
        memoryEditorLoadedPath.value = file.path;
        memoryEditorBaseContent.value = memoryEditorDraft.value;
        memoryEditorMode.value = 'preview';
        memoryEditorStatus.value = '已保存';
        window.setTimeout(() => {
            if (memoryEditorStatus.value === '已保存') {memoryEditorStatus.value = '';}
        }, 1600);
    } catch (error) {
        memoryEditorStatus.value = error instanceof Error ? error.message : String(error || '保存失败');
    }
}

function enterMemoryEditMode() {
    if (!memoryEditorDocumentAvailable.value) {return;}
    memoryEditorMode.value = 'edit';
    void nextTick(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('[data-memory-editor-textarea="true"]');
        textarea?.focus();
    });
}

function previewMemoryDraft() {
    if (!memoryEditorDocumentAvailable.value) {return;}
    memoryEditorMode.value = 'preview';
}

function discardMemoryDraft() {
    if (!memoryEditorDocumentAvailable.value) {return;}
    memoryEditorDraft.value = memoryEditorBaseContent.value;
    memoryEditorMode.value = 'preview';
    memoryEditorStatus.value = '已放弃修改';
    window.setTimeout(() => {
        if (memoryEditorStatus.value === '已放弃修改') {memoryEditorStatus.value = '';}
    }, 1400);
}

function toolTraceSummary(value: unknown) {
    if (!value) {return '';}
    if (Array.isArray(value)) {
        const failed = value.filter((item) => item && typeof item === 'object' && (item as { ok?: unknown }).ok === false).length;
        const running = value.filter((item) => item && typeof item === 'object' && String((item as { status?: unknown }).status || '') === 'running').length;
        if (running) {return `工具调用 ${value.length} 次 · ${running} 个运行中`;}
        return failed ? `工具调用 ${value.length} 次 · ${failed} 次失败` : `工具调用 ${value.length} 次 · 全部成功`;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const counts = ['calls', 'toolCalls', 'steps', 'trace']
            .map((key) => Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0)
            .filter((count) => count > 0);
        if (counts.length) {return `工具调用 ${Math.max(...counts)} 次`;}
        const keys = Object.keys(record).length;
        return keys ? `工具记录 ${keys} 项` : '';
    }
    return '有工具记录';
}

function managerToolTraceItems(value: unknown) {
    if (!Array.isArray(value)) {return [];}
    const seenPrefaces = new Set<string>();
    const seenThoughts = new Set<string>();
    return value
        .map((item, index) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const name = String(record.name || '工具').trim() || '工具';
            const status = String(record.status || '').trim();
            const ok = record.ok !== false;
            const elapsedMs = Math.max(0, Number(record.elapsedMs) || (
                Number(record.startedAt) && Number(record.finishedAt)
                    ? Number(record.finishedAt) - Number(record.startedAt)
                    : 0
            ));
            const round = Math.max(1, Number(record.round) || 1);
            const rawPreface = String(record.preface || '').trim();
            const prefaceKey = `${round}\n${rawPreface}`;
            const preface = rawPreface && !seenPrefaces.has(prefaceKey) ? rawPreface : '';
            if (rawPreface) {seenPrefaces.add(prefaceKey);}
            const rawThoughts = thoughtBlocks(Array.isArray(record.thoughts) ? record.thoughts as Array<{ label?: string; text?: string }> : []);
            const thoughtsKey = `${round}\n${JSON.stringify(rawThoughts)}`;
            const thoughts = rawThoughts.length && !seenThoughts.has(thoughtsKey) ? rawThoughts : [];
            if (rawThoughts.length) {seenThoughts.add(thoughtsKey);}
            return {
                id: String(record.id || `${name}-${index}`),
                round,
                name,
                status,
                ok,
                args: String(record.args || '').trim(),
                path: String(record.path || '').trim(),
                summary: String(record.summary || record.error || '').trim(),
                error: String(record.error || '').trim(),
                preface,
                thoughts,
                elapsedLabel: elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : '',
            };
        });
}

function managerToolStatusLabel(item: { status?: string; ok?: boolean }) {
    if (item.status === 'running') {return '运行中';}
    if (item.ok === false) {return '失败';}
    return '已返回';
}

function managerToolTone(item: { status?: string; ok?: boolean }) {
    if (item.status === 'running') {return 'is-running';}
    if (item.ok === false) {return 'is-error';}
    return 'is-resolved';
}

async function retryManagerRun(run: TavernManagerRunRecord) {
    if (!selectedSessionId.value || managerBusy.value) {return;}
    const messages = await listTavernMessages(selectedSessionId.value);
    const userMessage = messages.find((message) => message.order === run.userOrder && message.role === 'user');
    const assistantMessage = messages.find((message) => message.order === run.assistantOrder && message.role === 'assistant' && !message.error);
    if (!userMessage || !assistantMessage) {
        managerActionStatus.value = '原文楼层不存在，无法重试。';
        await refreshManagerRecords();
        return;
    }
    managerActionStatus.value = '记忆正在重试。';
    try {
        const result = await runXbTavernManagerAfterTurn({
            sessionId: selectedSessionId.value,
            agentConfig: agentConfig.value,
            userMessage,
            assistantMessage,
            turn: run.turn,
            trigger: 'manual_retry',
            assistantPreset: activeAssistantPreset.value,
            sessionContract: sessionContract.value,
        });
        managerActionStatus.value = result.ok ? '' : `失败：${result.error || 'manager_retry_failed'}`;
    } catch (error) {
        managerActionStatus.value = error instanceof Error ? error.message : String(error || 'manager_retry_failed');
    } finally {
        await refreshManagerRecords();
    }
}

function roleLabel(role = '') {
    if (role === 'assistant') {
        return displayableTavernName(selectedSession.value?.characterName || effectiveCharacter.value.name || '', '角色');
    }
    if (role === 'user') {
        return displayableTavernName(userName.value || '', 'User');
    }
    const labels: Record<string, string> = {
        system: '规则',
        tool: '工具结果',
    };
    return labels[role] || role || '未知';
}

function thoughtBlocks(messageOrThoughts: TavernMessageRecord | Array<{ label?: string; text?: string }> | null | undefined) {
    const source = Array.isArray(messageOrThoughts)
        ? messageOrThoughts
        : Array.isArray(messageOrThoughts?.thoughts) ? messageOrThoughts.thoughts : [];
    return source
        .map((thought, index) => ({
            label: String(thought?.label || `思考 ${index + 1}`).trim() || `思考 ${index + 1}`,
            text: String(thought?.text || '').trim(),
        }))
        .filter((thought) => thought.text);
}

function thoughtSummaryLabel(messageOrThoughts: TavernMessageRecord | Array<{ label?: string; text?: string }> | null | undefined, streaming = false) {
    const thoughts = thoughtBlocks(messageOrThoughts);
    if (!thoughts.length) {return '';}
    const prefix = streaming ? '正在思考' : '展开思考块';
    return thoughts.length > 1 ? `${prefix}（${thoughts.length} 段）` : prefix;
}

function formatMessageTime(value: unknown) {
    const timestamp = Number(value) || 0;
    if (!timestamp) {return '';}
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

function markdownSignature(text = '') {
    const raw = String(text || '');
    let hash = 0;
    for (let index = 0; index < raw.length; index += 1) {
        hash = ((hash * 31) + raw.charCodeAt(index)) >>> 0;
    }
    return `${raw.length}:${hash.toString(36)}`;
}

function renderChatMarkdown(text = '') {
    // renderMarkdownToHtml sanitizes through DOMPurify when SillyTavern exposes it,
    // matching the ebook/assistant Markdown pipeline before Vue inserts the HTML.
    const raw = String(text || '');
    const canCache = !/(^|\n)(`{3,}|~{3,})[ \t]*(html|htm|xhtml|xml|svg|vue|svelte)?\b/i.test(raw)
        && !/^<!doctype\s+html/i.test(raw.trim())
        && !/^<html[\s>]/i.test(raw.trim());
    const cacheKey = markdownSignature(raw);
    if (canCache && markdownHtmlCache.has(cacheKey)) {
        return markdownHtmlCache.get(cacheKey) || '';
    }
    const html = renderMarkdownToHtml(raw);
    if (canCache) {
        markdownHtmlCache.set(cacheKey, html);
        if (markdownHtmlCache.size > 160) {
            const firstKey = markdownHtmlCache.keys().next().value;
            if (firstKey) {markdownHtmlCache.delete(firstKey);}
        }
    }
    return html;
}

const dialogueQuotePairs: Record<string, string> = {
    '"': '"',
    '“': '”',
    '「': '」',
    '『': '』',
};

const dialogueQuoteOpeners = new Set(Object.keys(dialogueQuotePairs));
const dialogueSkipTags = new Set(['A', 'BUTTON', 'CODE', 'KBD', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);
const maxInlineDialogueLength = 600;

function shouldSkipDialogueTextNode(node: Text) {
    let parent = node.parentElement;
    while (parent) {
        if (dialogueSkipTags.has(parent.tagName) || parent.classList.contains('xb-rp-dialogue')) {
            return true;
        }
        parent = parent.parentElement;
    }
    return false;
}

function collectDialogueRanges(text: string) {
    const ranges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    while (cursor < text.length) {
        const opener = text[cursor];
        if (!dialogueQuoteOpeners.has(opener)) {
            cursor += 1;
            continue;
        }
        const closer = dialogueQuotePairs[opener];
        let end = text.indexOf(closer, cursor + 1);
        if (end < 0 || end === cursor + 1 || end - cursor > maxInlineDialogueLength) {
            cursor += 1;
            continue;
        }
        const segment = text.slice(cursor + 1, end);
        if (segment.includes('\n') || !segment.trim()) {
            cursor += 1;
            continue;
        }
        ranges.push({ start: cursor, end: end + 1 });
        cursor = end + 1;
    }
    return ranges;
}

function enhanceRoleplayDialogue(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const textNode = node as Text;
            if (!textNode.data || shouldSkipDialogueTextNode(textNode)) {
                return NodeFilter.FILTER_REJECT;
            }
            return collectDialogueRanges(textNode.data).length
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_SKIP;
        },
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode as Text);
    }
    nodes.forEach((textNode) => {
        const ranges = collectDialogueRanges(textNode.data);
        if (!ranges.length) {return;}
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        ranges.forEach((range) => {
            if (range.start > cursor) {
                fragment.append(document.createTextNode(textNode.data.slice(cursor, range.start)));
            }
            const span = document.createElement('span');
            span.className = 'xb-rp-dialogue';
            span.textContent = textNode.data.slice(range.start, range.end);
            fragment.append(span);
            cursor = range.end;
        });
        if (cursor < textNode.data.length) {
            fragment.append(document.createTextNode(textNode.data.slice(cursor)));
        }
        textNode.replaceWith(fragment);
    });
}

function canHydrateTavernFigure(figure: HTMLElement, slotId = '') {
    return !!(
        figure
        && figure.isConnected !== false
        && String(figure.dataset.tavernImageSlot || '').trim() === slotId
    );
}

function hydrateTavernImageFigure(figure: HTMLElement) {
    const slotId = String(figure.dataset.tavernImageSlot || '').trim();
    if (!slotId || figure.dataset.tavernImageHydrating === 'true' || figure.dataset.tavernImageLoaded === 'true') {
        return;
    }
    figure.dataset.tavernImageHydrating = 'true';
    void requestHost('xb-tavern:draw-image', {
        payload: { slotId },
    }, { timeoutMs: HOST_REQUEST_TIMEOUT_MS * 2 })
        .then((response) => {
            if (!canHydrateTavernFigure(figure, slotId)) {return;}
            const result = (response.result || response) as Record<string, unknown>;
            figure.dataset.tavernImageHydrating = 'false';
            if (!result.hasData || !result.url) {
                figure.classList.add('is-failed');
                const placeholder = document.createElement('span');
                placeholder.className = 'xb-tavern-image-placeholder';
                placeholder.textContent = result.isFailed
                    ? String(result.errorMessage || '配图生成失败')
                    : '配图未找到';
                figure.replaceChildren(placeholder);
                return;
            }
            figure.classList.add('is-loaded');
            figure.dataset.tavernImageLoaded = 'true';
            const image = document.createElement('img');
            image.src = String(result.url || '');
            image.alt = result.tags ? `配图：${String(result.tags)}` : '配图';
            image.loading = 'lazy';
            figure.replaceChildren(image);
        })
        .catch(() => {
            if (!canHydrateTavernFigure(figure, slotId)) {return;}
            figure.dataset.tavernImageHydrating = 'false';
            figure.classList.add('is-failed');
            const placeholder = document.createElement('span');
            placeholder.className = 'xb-tavern-image-placeholder';
            placeholder.textContent = '配图加载失败';
            figure.replaceChildren(placeholder);
        });
}

function createTavernImageFigure(slotId = '') {
    const figure = document.createElement('span');
    figure.className = 'xb-tavern-image';
    figure.dataset.tavernImageSlot = slotId;
    const placeholder = document.createElement('span');
    placeholder.className = 'xb-tavern-image-placeholder';
    placeholder.textContent = '配图加载中';
    figure.append(placeholder);
    return figure;
}

function enhanceTavernImageMarkers(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const textNode = node as Text;
            if (!textNode.data || !TAVERN_IMAGE_MARKER_REGEX.test(textNode.data)) {
                TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
                return NodeFilter.FILTER_SKIP;
            }
            TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
            const parent = textNode.parentElement;
            if (parent?.closest?.('a, button, code, kbd, pre, script, style, textarea, .xb-tavern-image')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode as Text);
    }
    nodes.forEach((textNode) => {
        const text = textNode.data;
        TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        let replaced = false;
        const fragment = document.createDocumentFragment();
        while ((match = TAVERN_IMAGE_MARKER_REGEX.exec(text)) !== null) {
            replaced = true;
            if (match.index > lastIndex) {
                fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            fragment.append(createTavernImageFigure(match[1] || ''));
            lastIndex = TAVERN_IMAGE_MARKER_REGEX.lastIndex;
        }
        if (!replaced) {return;}
        if (lastIndex < text.length) {
            fragment.append(document.createTextNode(text.slice(lastIndex)));
        }
        textNode.replaceWith(fragment);
    });
    root.querySelectorAll<HTMLElement>('[data-tavern-image-slot]').forEach((figure) => hydrateTavernImageFigure(figure));
}

function buildActionCheckAriaLabel(event: TavernActionCheckRuntimeEvent) {
    const outcome = event.success ? 'Success' : 'Failure';
    const action = String(event.action || '').trim();
    return [
        `Action check: ${event.stat}.`,
        `Roll ${event.roll} versus DC ${event.difficulty}.`,
        `${outcome}.`,
        action ? `Action: ${action}.` : '',
    ].filter(Boolean).join(' ');
}

function createActionCheckCard(event: TavernActionCheckRuntimeEvent) {
    const card = document.createElement('span');
    card.className = `action-check-card ${event.success ? 'is-success' : 'is-failure'}`;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', buildActionCheckAriaLabel(event));

    const head = document.createElement('span');
    head.className = 'action-check-card-head';

    const title = document.createElement('strong');
    title.textContent = event.stat;
    head.append(title);

    const outcome = document.createElement('span');
    outcome.textContent = event.success ? 'Success' : 'Failure';
    head.append(outcome);

    const grid = document.createElement('span');
    grid.className = 'action-check-card-grid';
    [{
        label: 'DC',
        value: String(event.difficulty),
    }, {
        label: 'Roll',
        value: String(event.roll),
    }].forEach((item) => {
        const cell = document.createElement('span');
        const label = document.createElement('small');
        label.textContent = item.label;
        const value = document.createElement('strong');
        value.textContent = item.value;
        cell.append(label, value);
        grid.append(cell);
    });

    const copy = document.createElement('span');
    copy.className = 'action-check-card-copy';
    copy.textContent = event.action;

    card.append(head, grid, copy);
    return card;
}

function createActionCheckStack(events: TavernActionCheckRuntimeEvent[] = []) {
    const stack = document.createElement('span');
    stack.className = 'assistant-runtime-event-stack';
    stack.setAttribute('role', 'group');
    stack.setAttribute('aria-label', events.length > 1 ? `${events.length} action check results.` : 'Action check result.');
    events.forEach((event) => {
        stack.append(createActionCheckCard(event));
    });
    return stack;
}

function readActionCheckRenderGroups(value: unknown): TavernActionCheckRenderGroup[] {
    try {
        return normalizeActionCheckRenderGroups(JSON.parse(String(value || '[]')));
    } catch {
        return [];
    }
}

function enhanceActionCheckMarkers(root: HTMLElement) {
    const groups = readActionCheckRenderGroups(root.dataset.actionCheckGroups);
    if (!groups.length) {return;}
    const byMarker = new Map(groups.map((group) => [group.marker, group.events]));
    const markers = new Set(groups.map((group) => group.marker));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const textNode = node as Text;
            if (!textNode.data) {
                return NodeFilter.FILTER_SKIP;
            }
            const parent = textNode.parentElement;
            if (parent?.closest?.('a, button, code, kbd, pre, script, style, textarea, .assistant-runtime-event-stack')) {
                return NodeFilter.FILTER_REJECT;
            }
            return [...textNode.data].some((char) => markers.has(char))
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_SKIP;
        },
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode as Text);
    }
    nodes.forEach((textNode) => {
        const fragment = document.createDocumentFragment();
        let replaced = false;
        [...textNode.data].forEach((char) => {
            const events = byMarker.get(char);
            if (events?.length) {
                fragment.append(createActionCheckStack(events));
                replaced = true;
                return;
            }
            fragment.append(document.createTextNode(char));
        });
        if (replaced) {
            textNode.replaceWith(fragment);
        }
    });
}

function enhanceChatMarkdown() {
    const root = chatScrollRef.value;
    if (!root?.querySelectorAll) {return;}
    root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
        const signature = node.dataset.markdownSignature || '';
        if (node.dataset.markdownEnhanced === signature) {return;}
        enhanceMarkdownContent(node, {
            codeBlockClassName: 'xb-tavern-codeblock',
            codeCopyClassName: 'xb-tavern-code-copy',
        });
        enhanceTavernImageMarkers(node);
        enhanceRoleplayDialogue(node);
        enhanceActionCheckMarkers(node);
        node.dataset.markdownEnhanced = signature;
    });
}

function enhanceManagerMarkdown() {
    const root = managerScrollRef.value;
    if (!root?.querySelectorAll) {return;}
    root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
        const signature = node.dataset.markdownSignature || '';
        if (node.dataset.markdownEnhanced === signature) {return;}
        enhanceMarkdownContent(node, {
            codeBlockClassName: 'xb-tavern-codeblock',
            codeCopyClassName: 'xb-tavern-code-copy',
        });
        node.dataset.markdownEnhanced = signature;
    });
}

function messageKey(message: TavernMessageRecord) {
    return `${message.sessionId}:${message.order}`;
}

function managerMessageKey(message: TavernManagerMessageRecord) {
    return `manager:${message.sessionId}:${message.order}`;
}

function canEditMessage(message: TavernMessageRecord) {
    return !isRunning.value && !message.error && ['user', 'assistant'].includes(message.role);
}

function canEditManagerMessage(message: TavernManagerMessageRecord) {
    return !isManagerAssistantRunning.value && !message.error && ['user', 'assistant'].includes(message.role);
}

function canRerunMessage(message: TavernMessageRecord) {
    if (isRunning.value) {return false;}
    if (message.role === 'user') {return true;}
    const sorted = [...sessionMessages.value].sort((left, right) => left.order - right.order);
    const index = sorted.findIndex((item) => item.order === message.order);
    if (index < 0) {return false;}
    return sorted.slice(0, index + 1).some((item) => item.role === 'user');
}

function canRerunManagerMessage(message: TavernManagerMessageRecord) {
    if (isManagerAssistantRunning.value) {return false;}
    if (message.role === 'user') {return true;}
    const sorted = [...managerChatMessages.value].sort((left, right) => left.order - right.order);
    const index = sorted.findIndex((item) => item.order === message.order);
    if (index < 0) {return false;}
    return sorted.slice(0, index + 1).some((item) => item.role === 'user');
}

function isEditingMessage(message: TavernMessageRecord) {
    return editingMessageKey.value === messageKey(message);
}

function isEditingManagerMessage(message: TavernManagerMessageRecord) {
    return editingMessageKey.value === managerMessageKey(message);
}

function isEditingMessageDirty(message: TavernMessageRecord) {
    return isEditingMessage(message) && editingMessageDraft.value.trim() !== String(message.content || '').trim();
}

function isEditingManagerMessageDirty(message: TavernManagerMessageRecord) {
    return isEditingManagerMessage(message) && editingMessageDraft.value.trim() !== String(message.content || '').trim();
}

function flashMessageAction(message: TavernMessageRecord, action: string, ok: boolean) {
    const key = `${messageKey(message)}:${action}`;
    messageActionFeedback.value = {
        ...messageActionFeedback.value,
        [key]: ok ? 'success' : 'error',
    };
    window.setTimeout(() => {
        const next = { ...messageActionFeedback.value };
        delete next[key];
        messageActionFeedback.value = next;
    }, 1100);
}

function flashManagerMessageAction(message: TavernManagerMessageRecord, action: string, ok: boolean) {
    const key = `${managerMessageKey(message)}:${action}`;
    messageActionFeedback.value = {
        ...messageActionFeedback.value,
        [key]: ok ? 'success' : 'error',
    };
    window.setTimeout(() => {
        const next = { ...messageActionFeedback.value };
        delete next[key];
        messageActionFeedback.value = next;
    }, 1100);
}

function actionFeedback(message: TavernMessageRecord, action: string) {
    return messageActionFeedback.value[`${messageKey(message)}:${action}`] || '';
}

function managerActionFeedback(message: TavernManagerMessageRecord, action: string) {
    return messageActionFeedback.value[`${managerMessageKey(message)}:${action}`] || '';
}

function isDrawingMessage(message: TavernMessageRecord) {
    return drawingMessageKey.value === messageKey(message);
}

function showDrawMessageStatus(
    message: TavernMessageRecord,
    text = '',
    kind: 'running' | 'success' | 'error' = 'running',
    durationMs = 0,
) {
    drawStatusMessageKey.value = messageKey(message);
    drawStatusKind.value = kind;
    drawProgressText.value = text;
    if (durationMs > 0) {
        const key = messageKey(message);
        window.setTimeout(() => {
            if (drawStatusMessageKey.value !== key || drawingMessageKey.value === key) {return;}
            drawStatusMessageKey.value = '';
            drawStatusKind.value = 'idle';
            drawProgressText.value = '';
        }, durationMs);
    }
}

function drawMessageStatusText(message: TavernMessageRecord) {
    return drawStatusMessageKey.value === messageKey(message) ? drawProgressText.value : '';
}

function drawMessageStatusClass(message: TavernMessageRecord) {
    return drawStatusMessageKey.value === messageKey(message) ? `is-${drawStatusKind.value}` : '';
}

function canDrawMessage(message: TavernMessageRecord) {
    if (isRunning.value || isEditingMessage(message) || message.error) {return false;}
    if (!['user', 'assistant'].includes(message.role)) {return false;}
    if (drawingMessageKey.value && !isDrawingMessage(message)) {return false;}
    return !!stripTavernImageMarkers(message.content || '');
}

function drawMessageTitle(message: TavernMessageRecord) {
    if (isDrawingMessage(message)) {
        return drawMessageStatusText(message) || '停止画图';
    }
    if (!canDrawMessage(message)) {
        return drawingMessageKey.value ? '已有画图任务正在运行' : '这条消息暂不能画图';
    }
    if (tavernDrawStatus.value.enabled && tavernDrawStatus.value.ready) {
        return '为这条消息画图';
    }
    return '为这条消息画图';
}

async function copyTextWithFallback(text = '') {
    const normalized = String(text || '');
    if (!normalized) {return false;}
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(normalized);
            return true;
        }
    } catch {
        // Fall through to the DOM-based clipboard path.
    }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = normalized;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
    } catch {
        return false;
    }
}

async function copyMessage(message: TavernMessageRecord) {
    const ok = await copyTextWithFallback(message.content || '');
    flashMessageAction(message, 'copy', ok);
}

async function copyManagerMessage(message: TavernManagerMessageRecord) {
    const ok = await copyTextWithFallback(message.content || '');
    flashManagerMessageAction(message, 'copy', ok);
}

async function drawMessage(message: TavernMessageRecord) {
    if (isDrawingMessage(message)) {
        tavernDrawController.value?.abort();
        showDrawMessageStatus(message, '正在停止画图', 'running');
        return;
    }
    if (!canDrawMessage(message)) {
        flashMessageAction(message, 'draw', false);
        return;
    }
    const status = await refreshTavernDrawStatus();
    if (!status.enabled || !status.ready) {
        const text = '请开启小白X画图模块';
        showDrawMessageStatus(message, text, 'error', 3200);
        flashMessageAction(message, 'draw', false);
        return;
    }
    const controller = new AbortController();
    tavernDrawController.value = controller;
    drawingMessageKey.value = messageKey(message);
    showDrawMessageStatus(message, '正在准备画图', 'running');
    try {
        const cleanText = stripTavernImageMarkers(message.content || '');
        const resultPayload = await requestHost('xb-tavern:draw-generate', {
            payload: {
                source: 'tavern',
                text: cleanText,
                title: roleLabel(message.role),
                sessionId: message.sessionId,
                messageOrder: message.order,
                role: message.role,
                characterName: selectedSession.value?.characterName || effectiveCharacter.value.name || '',
            },
        }, {
            timeoutMs: TAVERN_DRAW_REQUEST_TIMEOUT_MS,
            signal: controller.signal,
        });
        if (controller.signal.aborted) {
            flashMessageAction(message, 'draw', false);
            return;
        }
        const result = (resultPayload.result || resultPayload) as Record<string, unknown>;
        const insertion = insertTavernImageMarkers(message.content || '', Array.isArray(result.images) ? result.images : []);
        if (!insertion.inserted) {
            const success = Number(result.success) || 0;
            const total = Number(result.total) || (Array.isArray(result.images) ? result.images.length : 0);
            const text = total > 0 && success === 0
                ? `画图任务结束：${total} 张都失败了，未插入图片。`
                : success > 0
                    ? `画图完成 ${success}/${total || success}，但没有返回可用图片占位。`
                    : '画图任务结束，但没有返回可用图片。';
            showDrawMessageStatus(message, text, 'error', 4200);
            flashMessageAction(message, 'draw', false);
            return;
        }
        const updated = await updateTavernMessage(message.sessionId, message.order, { content: insertion.content });
        if (updated && selectedSessionId.value === message.sessionId) {
            sessionMessages.value = await listTavernMessages(message.sessionId);
        }
        const fallbackText = insertion.appended ? `，${insertion.appended} 张追加到末尾` : '';
        showDrawMessageStatus(message, `${DRAW_COMPLETION_NOTICE_TEXT}${fallbackText}`, 'success', 2600);
        flashMessageAction(updated || message, 'draw', !!updated);
        void nextTick(enhanceChatMarkdown);
    } catch (error) {
        const text = describeError(error);
        if (/abort|已取消|request_aborted/i.test(text)) {
            showDrawMessageStatus(message, '配图已取消', 'error', 1800);
        } else {
            const errorText = `配图失败：${text}`;
            showDrawMessageStatus(message, errorText, 'error', 4200);
        }
        flashMessageAction(message, 'draw', false);
    } finally {
        if (tavernDrawController.value === controller) {
            tavernDrawController.value = null;
        }
        if (drawingMessageKey.value === messageKey(message)) {
            window.setTimeout(() => {
                if (!tavernDrawController.value && drawingMessageKey.value === messageKey(message)) {
                    drawingMessageKey.value = '';
                }
            }, 1200);
        }
    }
}

function startEditMessage(message: TavernMessageRecord) {
    if (!canEditMessage(message)) {return;}
    editingMessageKey.value = messageKey(message);
    editingMessageDraft.value = message.content || '';
    void nextTick(() => {
        const textarea = chatScrollRef.value?.querySelector<HTMLTextAreaElement>(`[data-message-editor="${messageKey(message)}"]`);
        if (!textarea) {return;}
        autoSizeTextarea(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
}

function startEditManagerMessage(message: TavernManagerMessageRecord) {
    if (!canEditManagerMessage(message)) {return;}
    editingMessageKey.value = managerMessageKey(message);
    editingMessageDraft.value = message.content || '';
    void nextTick(() => {
        const textarea = managerScrollRef.value?.querySelector<HTMLTextAreaElement>(`[data-manager-message-editor="${managerMessageKey(message)}"]`);
        if (!textarea) {return;}
        autoSizeTextarea(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
}

function cancelEditMessage() {
    editingMessageKey.value = '';
    editingMessageDraft.value = '';
    void nextTick(() => {
        enhanceChatMarkdown();
        enhanceManagerMarkdown();
    });
}

function autoSizeTextarea(
    textarea: HTMLTextAreaElement | null,
    options: { minHeight?: number; maxHeight?: number } = {},
) {
    if (!textarea) {return;}
    const minHeight = Number(options.minHeight ?? 144);
    const maxHeight = Number(options.maxHeight ?? 420);
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
}

function resetTextareaHeight(textarea: HTMLTextAreaElement | null) {
    if (!textarea) {return;}
    textarea.style.height = '';
}

function handleEditKeydown(event: KeyboardEvent, message: TavernMessageRecord) {
    if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditMessage();
        return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveEditMessage(message);
    }
}

function handleManagerEditKeydown(event: KeyboardEvent, message: TavernManagerMessageRecord) {
    if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditMessage();
        return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveEditManagerMessage(message);
    }
}

function handleEditInput(event: Event) {
    autoSizeTextarea(event.target as HTMLTextAreaElement);
}

function handleComposeInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const isManagerCompose = !!textarea.closest('.manager-compose');
    autoSizeTextarea(textarea, isManagerCompose
        ? { minHeight: 48, maxHeight: 180 }
        : { minHeight: 36, maxHeight: 99 });
}

async function saveEditMessage(message: TavernMessageRecord, options: { rerun?: boolean } = {}) {
    if (!canEditMessage(message)) {return;}
    const content = editingMessageDraft.value.trim();
    if (!content) {
        flashMessageAction(message, 'edit', false);
        return;
    }
    if (!options.rerun && !isEditingMessageDirty(message)) {
        cancelEditMessage();
        return;
    }
    if (options.rerun && message.role !== 'user') {
        cancelEditMessage();
        await rerunFromMessage(message);
        return;
    }
    const updated = await updateTavernMessage(message.sessionId, message.order, {
        content,
        ...(message.role === 'user' ? { runtimeEvents: [] } : {}),
    });
    if (updated) {
        const rollback = await cancelAndRollbackXbTavernManagersForMessageRange(message.sessionId, message.order);
        await markTavernMemoryStaleFromOrder(message.sessionId, message.order);
        if (!rollback.conflicts.length) {
            await rebuildTavernMemoryDerivedIndex(message.sessionId);
        }
    }
    if (updated && selectedSessionId.value) {
        sessionMessages.value = await listTavernMessages(selectedSessionId.value);
        await refreshManagerRecords(selectedSessionId.value);
    }
    cancelEditMessage();
    flashMessageAction(updated || message, 'edit', !!updated);
    if (updated && options.rerun) {
        if (updated.role === 'user') {
            await runOnce({
                messageText: updated.content,
                reuseUserMessageOrder: updated.order,
                rerollRuntimeEvents: true,
            });
        } else {
            await rerunFromMessage(updated);
        }
    } else if (updated) {
        await rebuildSelectedSessionRuntimeState();
    }
}

async function saveEditManagerMessage(message: TavernManagerMessageRecord, options: { rerun?: boolean } = {}) {
    if (!canEditManagerMessage(message)) {return;}
    const content = editingMessageDraft.value.trim();
    if (!content) {
        flashManagerMessageAction(message, 'edit', false);
        return;
    }
    if (!options.rerun && !isEditingManagerMessageDirty(message)) {
        cancelEditMessage();
        return;
    }
    if (options.rerun && message.role !== 'user') {
        cancelEditMessage();
        await rerunFromManagerMessage(message);
        return;
    }
    const updated = await updateTavernManagerMessage(message.sessionId, message.order, {
        content,
        clearProtocolPayload: message.role === 'assistant',
    });
    if (updated && selectedSessionId.value === message.sessionId) {
        managerChatMessages.value = await listTavernManagerMessages(message.sessionId);
    }
    cancelEditMessage();
    flashManagerMessageAction(updated || message, 'edit', !!updated);
    if (updated && options.rerun) {
        await rerunFromManagerMessage(updated);
    }
}

function findDeleteOrders(message: TavernMessageRecord) {
    if (message.role !== 'user') {return [message.order];}
    const sorted = [...sessionMessages.value].sort((left, right) => left.order - right.order);
    const startIndex = sorted.findIndex((item) => item.order === message.order);
    if (startIndex < 0) {return [message.order];}
    const orders: number[] = [];
    for (let index = startIndex; index < sorted.length; index += 1) {
        const item = sorted[index];
        if (index > startIndex && item.role === 'user') {break;}
        orders.push(item.order);
    }
    return orders;
}

async function deleteMessageTurn(message: TavernMessageRecord) {
    if (isRunning.value) {return;}
    const ordersToDelete = findDeleteOrders(message);
    const confirmText = message.role === 'user'
        ? `删除这一轮对话？将移除 ${ordersToDelete.length} 条记录。`
        : '删除这条回复？';
    if (!window.confirm(confirmText)) {return;}
    const fromOrder = Math.min(...ordersToDelete);
    const rollback = await cancelAndRollbackXbTavernManagersForMessageRange(message.sessionId, fromOrder);
    const deleted = await deleteTavernMessages(message.sessionId, ordersToDelete);
    if (deleted > 0) {
        await markTavernMemoryStaleFromOrder(message.sessionId, message.order);
        if (!rollback.conflicts.length) {
            await rebuildTavernMemoryDerivedIndex(message.sessionId);
        }
    }
    if (selectedSessionId.value) {
        sessionMessages.value = await listTavernMessages(selectedSessionId.value);
        await refreshManagerRecords(selectedSessionId.value);
    }
    if (deleted > 0) {
        await rebuildSelectedSessionRuntimeState();
    }
    if (editingMessageKey.value.startsWith(`${message.sessionId}:`)) {
        cancelEditMessage();
    }
    flashMessageAction(message, 'delete', deleted > 0);
}

async function rerunFromMessage(message: TavernMessageRecord) {
    if (!canRerunMessage(message)) {
        flashMessageAction(message, 'rerun', false);
        return;
    }
    const sorted = [...sessionMessages.value].sort((left, right) => left.order - right.order);
    const index = sorted.findIndex((item) => item.order === message.order);
    const userMessage = message.role === 'user'
        ? message
        : [...sorted.slice(0, Math.max(0, index + 1))].reverse().find((item) => item.role === 'user');
    if (!userMessage) {
        flashMessageAction(message, 'rerun', false);
        return;
    }
    const ordersToDelete = sorted
        .filter((item) => item.order > userMessage.order)
        .map((item) => item.order);
    const latestOrder = sorted.at(-1)?.order ?? userMessage.order;
    if (ordersToDelete.length > 1 || latestOrder > Math.max(...ordersToDelete, userMessage.order)) {
        const ok = window.confirm(`从这里重新生成会移除后面的 ${ordersToDelete.length} 条记录。继续？`);
        if (!ok) {return;}
    }
    flashMessageAction(message, 'rerun', true);
    await runOnce({
        messageText: userMessage.content,
        reuseUserMessageOrder: userMessage.order,
    });
}

function findManagerDeleteOrders(message: TavernManagerMessageRecord) {
    const sorted = [...managerChatMessages.value].sort((left, right) => left.order - right.order);
    const startIndex = sorted.findIndex((item) => item.order === message.order);
    if (startIndex < 0) {return [message.order];}
    if (message.role !== 'user') {
        let turnStartIndex = startIndex;
        for (let index = startIndex; index >= 0; index -= 1) {
            if (sorted[index]?.role === 'user') {
                turnStartIndex = index;
                break;
            }
        }
        const orders: number[] = [];
        for (let index = turnStartIndex + 1; index < sorted.length; index += 1) {
            const item = sorted[index];
            if (item.role === 'user') {break;}
            orders.push(item.order);
        }
        return orders.length ? orders : [message.order];
    }
    const orders: number[] = [];
    for (let index = startIndex; index < sorted.length; index += 1) {
        const item = sorted[index];
        if (index > startIndex && item.role === 'user') {break;}
        orders.push(item.order);
    }
    return orders;
}

async function deleteManagerMessageTurn(message: TavernManagerMessageRecord) {
    if (isManagerAssistantRunning.value) {return;}
    const ordersToDelete = findManagerDeleteOrders(message);
    const confirmText = message.role === 'user'
        ? `删除这轮助手对话？将移除 ${ordersToDelete.length} 条记录。`
        : '删除这条助手回复？';
    if (!window.confirm(confirmText)) {return;}
    const deleted = await deleteTavernManagerMessages(message.sessionId, ordersToDelete);
    if (selectedSessionId.value === message.sessionId) {
        managerChatMessages.value = await listTavernManagerMessages(message.sessionId);
    }
    if (editingMessageKey.value.startsWith(`manager:${message.sessionId}:`)) {
        cancelEditMessage();
    }
    flashManagerMessageAction(message, 'delete', deleted > 0);
}

async function rerunFromManagerMessage(message: TavernManagerMessageRecord) {
    if (!canRerunManagerMessage(message)) {
        flashManagerMessageAction(message, 'rerun', false);
        return;
    }
    const sorted = [...managerChatMessages.value].sort((left, right) => left.order - right.order);
    const index = sorted.findIndex((item) => item.order === message.order);
    const userMessage = message.role === 'user'
        ? message
        : [...sorted.slice(0, Math.max(0, index + 1))].reverse().find((item) => item.role === 'user');
    if (!userMessage || !selectedSessionId.value) {
        flashManagerMessageAction(message, 'rerun', false);
        return;
    }
    const ordersToDelete = sorted
        .filter((item) => item.order >= userMessage.order)
        .map((item) => item.order);
    if (ordersToDelete.length > 2) {
        const ok = window.confirm(`从这里重新询问助手会移除后面的 ${ordersToDelete.length} 条记录。继续？`);
        if (!ok) {return;}
    }
    const historyBeforeTurn = sorted.filter((item) => item.order < userMessage.order);
    flashManagerMessageAction(message, 'rerun', true);
    await sendManagerQuestion(userMessage.sessionId, userMessage.content, {
        historyBeforeTurn,
        replaceOrdersAfterAppend: ordersToDelete,
    });
}

function updateChatScrollButtons() {
    const node = chatScrollRef.value;
    if (!node) {
        showChatScrollTop.value = false;
        showChatScrollBottom.value = false;
        return;
    }
    const threshold = 80;
    showChatScrollTop.value = node.scrollTop > threshold;
    showChatScrollBottom.value = node.scrollHeight - node.scrollTop - node.clientHeight > threshold;
}

function updateManagerScrollButtons() {
    const node = managerScrollRef.value;
    if (!node) {
        showManagerScrollTop.value = false;
        showManagerScrollBottom.value = false;
        return;
    }
    const threshold = 80;
    showManagerScrollTop.value = node.scrollTop > threshold;
    showManagerScrollBottom.value = node.scrollHeight - node.scrollTop - node.clientHeight > threshold;
}

function scheduleHideChatScrollHelpers() {
    chatScrollControlsActive.value = true;
    chatScrollRef.value?.classList.add('is-scrolling');
    if (chatScrollHideTimer) {
        window.clearTimeout(chatScrollHideTimer);
    }
    chatScrollHideTimer = window.setTimeout(() => {
        chatScrollControlsActive.value = false;
        chatScrollRef.value?.classList.remove('is-scrolling');
        chatScrollHideTimer = null;
    }, 1500);
}

function scheduleHideManagerScrollHelpers() {
    managerScrollControlsActive.value = true;
    managerScrollRef.value?.classList.add('is-scrolling');
    if (managerScrollHideTimer) {
        window.clearTimeout(managerScrollHideTimer);
    }
    managerScrollHideTimer = window.setTimeout(() => {
        managerScrollControlsActive.value = false;
        managerScrollRef.value?.classList.remove('is-scrolling');
        managerScrollHideTimer = null;
    }, 1500);
}

function isChatNearBottom(threshold = 56) {
    const node = chatScrollRef.value;
    if (!node) {return true;}
    return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function isManagerNearBottom(threshold = 56) {
    const node = managerScrollRef.value;
    if (!node) {return true;}
    return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function collapseChatMessageWindowIfBottom(force = false) {
    if (chatMessageWindowLimit.value <= AGENT_MESSAGE_WINDOW_DEFAULT) {return false;}
    if (!force && !isChatNearBottom(8)) {return false;}
    resetChatMessageWindowState();
    return true;
}

function collapseManagerMessageWindowIfBottom(force = false) {
    if (managerMessageWindowLimit.value <= AGENT_MESSAGE_WINDOW_DEFAULT) {return false;}
    if (!force && !isManagerNearBottom(8)) {return false;}
    resetManagerMessageWindowState();
    return true;
}

function scrollChatToBottom(force = false, options: { collapseWindow?: boolean; revealHelpers?: boolean } = {}) {
    if (!force && !chatAutoScroll.value) {return;}
    if (force) {chatAutoScroll.value = true;}
    if (options.collapseWindow || chatAutoScroll.value) {
        collapseChatMessageWindowIfBottom(true);
    }
    void nextTick(() => {
        const node = chatScrollRef.value;
        if (!node) {return;}
        const apply = () => {
            node.scrollTop = node.scrollHeight;
        };
        apply();
        requestAnimationFrame(() => {
            apply();
            requestAnimationFrame(() => {
                apply();
                updateChatScrollButtons();
                if (options.revealHelpers) {
                    scheduleHideChatScrollHelpers();
                }
            });
        });
    });
}

function scrollChatToTop() {
    const node = chatScrollRef.value;
    if (!node) {return;}
    chatAutoScroll.value = false;
    chatLastScrollTop = 0;
    node.scrollTo?.({ top: 0, behavior: 'smooth' });
    node.scrollTop = 0;
    updateChatScrollButtons();
    scheduleHideChatScrollHelpers();
}

function scrollManagerToBottom(force = false, options: { collapseWindow?: boolean; revealHelpers?: boolean } = {}) {
    if (!force && !managerAutoScroll.value) {return;}
    if (force) {managerAutoScroll.value = true;}
    if (options.collapseWindow || managerAutoScroll.value) {
        collapseManagerMessageWindowIfBottom(true);
    }
    void nextTick(() => {
        const node = managerScrollRef.value;
        if (!node) {return;}
        const apply = () => {
            node.scrollTop = node.scrollHeight;
        };
        apply();
        requestAnimationFrame(() => {
            apply();
            requestAnimationFrame(() => {
                apply();
                updateManagerScrollButtons();
                if (options.revealHelpers) {
                    scheduleHideManagerScrollHelpers();
                }
            });
        });
    });
}

function scrollManagerToTop() {
    const node = managerScrollRef.value;
    if (!node) {return;}
    managerAutoScroll.value = false;
    managerLastScrollTop = 0;
    node.scrollTo?.({ top: 0, behavior: 'smooth' });
    node.scrollTop = 0;
    updateManagerScrollButtons();
    scheduleHideManagerScrollHelpers();
}

function handleChatScroll() {
    const node = chatScrollRef.value;
    if (!node) {return;}
    if (revealOlderChatMessages()) {return;}
    const currentScrollTop = Number(node.scrollTop || 0);
    const scrollingTowardBottom = currentScrollTop > chatLastScrollTop;
    chatLastScrollTop = currentScrollTop;
    const nearBottom = isChatNearBottom();
    if (nearBottom) {
        if (chatAutoScroll.value !== false || scrollingTowardBottom) {
            chatAutoScroll.value = true;
            collapseChatMessageWindowIfBottom();
        }
    } else {
        chatAutoScroll.value = false;
    }
    if (chatScrollTicking) {return;}
    chatScrollTicking = true;
    requestAnimationFrame(() => {
        updateChatScrollButtons();
        scheduleHideChatScrollHelpers();
        chatScrollTicking = false;
    });
}

function handleManagerScroll() {
    const node = managerScrollRef.value;
    if (!node) {return;}
    if (revealOlderManagerMessages()) {return;}
    const currentScrollTop = Number(node.scrollTop || 0);
    const scrollingTowardBottom = currentScrollTop > managerLastScrollTop;
    managerLastScrollTop = currentScrollTop;
    const nearBottom = isManagerNearBottom();
    if (nearBottom) {
        if (managerAutoScroll.value !== false || scrollingTowardBottom) {
            managerAutoScroll.value = true;
            collapseManagerMessageWindowIfBottom();
        }
    } else {
        managerAutoScroll.value = false;
    }
    if (managerScrollTicking) {return;}
    managerScrollTicking = true;
    requestAnimationFrame(() => {
        updateManagerScrollButtons();
        scheduleHideManagerScrollHelpers();
        managerScrollTicking = false;
    });
}

function handleChatWheel(event: WheelEvent) {
    if (Number(event.deltaY || 0) < 0) {
        chatAutoScroll.value = false;
    }
}

function handleManagerWheel(event: WheelEvent) {
    if (Number(event.deltaY || 0) < 0) {
        managerAutoScroll.value = false;
    }
}

function handleChatTouchStart(event: TouchEvent) {
    chatTouchStartY = Number(event.touches?.[0]?.clientY);
}

function handleManagerTouchStart(event: TouchEvent) {
    managerTouchStartY = Number(event.touches?.[0]?.clientY);
}

function handleChatTouchMove(event: TouchEvent) {
    const currentY = Number(event.touches?.[0]?.clientY);
    if (!Number.isFinite(Number(chatTouchStartY)) || !Number.isFinite(currentY)) {
        chatAutoScroll.value = false;
        return;
    }
    if (chatTouchStartY !== null && (currentY > chatTouchStartY + 4 || !isChatNearBottom())) {
        chatAutoScroll.value = false;
    }
}

function handleManagerTouchMove(event: TouchEvent) {
    const currentY = Number(event.touches?.[0]?.clientY);
    if (!Number.isFinite(Number(managerTouchStartY)) || !Number.isFinite(currentY)) {
        managerAutoScroll.value = false;
        return;
    }
    if (managerTouchStartY !== null && (currentY > managerTouchStartY + 4 || !isManagerNearBottom())) {
        managerAutoScroll.value = false;
    }
}

function handleComposeKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') {return;}
    if (event.isComposing || event.shiftKey || event.altKey) {return;}
    const shouldSend = event.ctrlKey || event.metaKey || window.innerWidth >= 760;
    if (!shouldSend) {return;}
    event.preventDefault();
    void runOnce();
}

function handleManagerComposeKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') {return;}
    if (event.isComposing || event.shiftKey || event.altKey) {return;}
    const shouldSend = event.ctrlKey || event.metaKey || window.innerWidth >= 760;
    if (!shouldSend) {return;}
    event.preventDefault();
    void handleManagerSubmit();
}

function clearManagerCompactionOverlayHideTimer() {
    if (managerCompactionOverlayHideTimer) {
        window.clearTimeout(managerCompactionOverlayHideTimer);
        managerCompactionOverlayHideTimer = null;
    }
}

function updateManagerCompactionOverlay(patch: Partial<NonNullable<typeof managerCompactionOverlay.value>>) {
    const previous = managerCompactionOverlay.value || null;
    const nextId = String(patch.id || previous?.id || `manager-compaction-${Date.now()}`);
    const visibleSince = Number(patch.visibleSince)
        || (previous?.id === nextId ? Number(previous.visibleSince) : 0)
        || Date.now();
    managerCompactionOverlay.value = {
        id: nextId,
        active: true,
        resolved: false,
        currentTokens: 0,
        yieldTokens: 0,
        triggerTokens: 0,
        status: '正在释放较早管理员对话...',
        ...previous,
        ...patch,
        visibleSince,
    };
}

function scheduleManagerCompactionOverlayHide(delayMs = 3000) {
    const overlayId = managerCompactionOverlay.value?.id || '';
    const visibleSince = Number(managerCompactionOverlay.value?.visibleSince) || Date.now();
    const elapsedMs = Math.max(0, Date.now() - visibleSince);
    const waitMs = Math.max(0, delayMs - elapsedMs);
    clearManagerCompactionOverlayHideTimer();
    managerCompactionOverlayHideTimer = window.setTimeout(() => {
        managerCompactionOverlayHideTimer = null;
        if (!overlayId || managerCompactionOverlay.value?.id !== overlayId) {return;}
        managerCompactionOverlay.value = null;
    }, waitMs);
}

function createLiveManagerMessage(
    sessionId: string,
    patch: Partial<TavernManagerMessageRecord> & Pick<TavernManagerMessageRecord, 'role' | 'content'>,
): TavernManagerMessageRecord {
    const liveState = managerLiveProtocolState.value?.sessionId === sessionId
        ? managerLiveProtocolState.value
        : {
            sessionId,
            messages: [],
            draft: null,
            nextOrder: LIVE_MANAGER_PROTOCOL_ORDER_BASE,
        };
    const order = liveState.nextOrder;
    liveState.nextOrder += 1;
    managerLiveProtocolState.value = liveState;
    return {
        sessionId,
        order,
        role: patch.role,
        content: patch.content,
        name: patch.name,
        error: patch.error === true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: patch.provider,
        model: patch.model,
        finishReason: patch.finishReason,
        thoughts: patch.thoughts,
        providerPayload: patch.providerPayload,
        toolCalls: patch.toolCalls,
        toolCallId: patch.toolCallId,
        toolName: patch.toolName,
        toolDisplay: patch.toolDisplay,
    };
}

function ensureManagerLiveProtocolState(sessionId: string) {
    const id = String(sessionId || '').trim();
    if (!id) {return null;}
    if (!managerLiveProtocolState.value || managerLiveProtocolState.value.sessionId !== id) {
        managerLiveProtocolState.value = {
            sessionId: id,
            messages: [],
            draft: createLiveManagerMessage(id, {
                role: 'assistant',
                content: '正在思考...',
            }),
            nextOrder: LIVE_MANAGER_PROTOCOL_ORDER_BASE + 1,
        };
    }
    return managerLiveProtocolState.value;
}

function clearManagerLiveProtocolState(sessionId = '') {
    const id = String(sessionId || '').trim();
    if (!id || managerLiveProtocolState.value?.sessionId === id) {
        managerLiveProtocolState.value = null;
    }
}

function setManagerLiveProtocolDraft(
    sessionId: string,
    patch: Partial<TavernManagerMessageRecord> & Pick<TavernManagerMessageRecord, 'content'>,
) {
    const liveState = ensureManagerLiveProtocolState(sessionId);
    if (!liveState) {return;}
    const draft = liveState.draft || createLiveManagerMessage(sessionId, {
        role: 'assistant',
        content: patch.content,
    });
    liveState.draft = {
        ...draft,
        ...patch,
        role: 'assistant',
        content: patch.content,
        updatedAt: Date.now(),
    };
}

function normalizeLiveProtocolToolCalls(message: XbTavernMessage): Array<{ id?: string; name?: string; arguments?: string }> {
    if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
        return message.toolCalls.map((toolCall) => ({
            id: typeof toolCall?.id === 'string' ? toolCall.id : '',
            name: typeof toolCall?.name === 'string' ? toolCall.name : '',
            arguments: typeof toolCall?.arguments === 'string' ? toolCall.arguments : '{}',
        }));
    }
    if (!Array.isArray(message.tool_calls)) {return [];}
    return message.tool_calls.map((toolCall) => ({
        id: typeof toolCall?.id === 'string' ? toolCall.id : '',
        name: typeof toolCall?.function?.name === 'string' ? toolCall.function.name : '',
        arguments: typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : '{}',
    }));
}

function appendManagerLiveProtocolMessage(sessionId: string, message: XbTavernMessage) {
    const liveState = ensureManagerLiveProtocolState(sessionId);
    if (!liveState) {return;}
    liveState.messages = [...liveState.messages, createLiveManagerMessage(sessionId, {
        role: message.role,
        content: String(message.content || ''),
        name: message.name,
        thoughts: Array.isArray(message.thoughts) ? thoughtBlocks(message.thoughts) : undefined,
        providerPayload: message.providerPayload,
        toolCalls: message.role === 'assistant' ? normalizeLiveProtocolToolCalls(message) : undefined,
        toolCallId: message.role === 'tool' ? String(message.toolCallId || message.tool_call_id || '') : undefined,
        toolName: message.role === 'tool' ? String(message.toolName || '') : undefined,
        toolDisplay: message.role === 'tool' ? message.toolDisplay : undefined,
    })];
}

function applyManagerProtocolEvent(sessionId: string, event: TavernManagerProtocolEvent) {
    const id = String(sessionId || '').trim();
    if (!id) {return;}
    if (event.type === 'clear_stream_draft') {
        const liveState = ensureManagerLiveProtocolState(id);
        if (liveState) {
            liveState.draft = null;
        }
        return;
    }
    appendManagerLiveProtocolMessage(id, event.message);
}

function clearRuntimeAssistantLiveState() {
    runtimeText.value = '';
    runtimeThoughts.value = [];
    runtimeActionCheckEvents.value = [];
}

async function appendManagerProtocolMessages(
    sessionId: string,
    messages: XbTavernMessage[],
    fallbackText: string,
    patch: Pick<TavernManagerMessageRecord, 'provider' | 'model' | 'finishReason' | 'error'>,
) {
    const protocolMessages = (Array.isArray(messages) ? messages : []).filter((message) => (
        message && ['assistant', 'tool'].includes(message.role)
    ));
    const finalMessages: XbTavernMessage[] = protocolMessages.length
        ? protocolMessages
        : [{ role: 'assistant' as const, content: fallbackText }];
    const finalAssistantIndex = [...finalMessages]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find(({ message }) => {
            const hasToolCalls = (Array.isArray(message.toolCalls) && message.toolCalls.length)
                || (Array.isArray(message.tool_calls) && message.tool_calls.length);
            return message.role === 'assistant' && !hasToolCalls;
        })?.index ?? -1;
    if (finalAssistantIndex < 0) {
        finalMessages.push({ role: 'assistant', content: fallbackText });
    } else if (!String(finalMessages[finalAssistantIndex]?.content || '').trim()) {
        finalMessages[finalAssistantIndex] = {
            ...finalMessages[finalAssistantIndex],
            content: fallbackText,
        };
    }
    const appended: TavernManagerMessageRecord[] = [];
    for (let index = 0; index < finalMessages.length; index += 1) {
        const message = finalMessages[index];
        const hasToolCalls = (Array.isArray(message.toolCalls) && message.toolCalls.length)
            || (Array.isArray(message.tool_calls) && message.tool_calls.length);
        const isFinalAssistant = message.role === 'assistant' && !hasToolCalls && index === finalMessages.length - 1;
        const appendedMessage = await appendTavernManagerMessage(sessionId, {
            role: message.role,
            content: isFinalAssistant
                ? (String(message.content || '').trim() || fallbackText)
                : String(message.content || ''),
            name: message.name,
            thoughts: message.thoughts,
            providerPayload: message.providerPayload,
            toolCalls: message.toolCalls,
            tool_calls: message.tool_calls,
            toolCallId: message.toolCallId || message.tool_call_id,
            toolName: message.toolName,
            toolDisplay: message.toolDisplay,
            provider: message.role === 'assistant' ? patch.provider : undefined,
            model: message.role === 'assistant' ? patch.model : undefined,
            finishReason: message.role === 'assistant' && !hasToolCalls ? patch.finishReason : undefined,
            error: message.role === 'assistant' && !hasToolCalls ? patch.error : false,
        });
        appended.push(appendedMessage);
    }
    return appended;
}

async function sendManagerQuestion(
    managerSessionId: string,
    text: string,
    options: {
        historyBeforeTurn?: TavernManagerMessageRecord[];
        replaceOrdersAfterAppend?: number[];
    } = {},
) {
    const question = String(text || '').trim();
    if (!managerSessionId || !question) {return;}
    const managerTurn = Number(sessionRuntimeState.value.turn || 0);
    const controller = new AbortController();
    managerAssistantController.value = controller;
    isManagerAssistantRunning.value = true;
    isManagerAssistantCancelling.value = false;
    managerInputStatus.value = '运行中';
    managerAutoScroll.value = true;
    resetManagerMessageWindowState();
    const managerStreamToolDraftState = createManagerStreamToolDraftState();
    try {
        const budget = await ensureTavernManagerChatBudget({
            sessionId: managerSessionId,
            agentConfig: agentConfig.value,
            assistantPreset: activeAssistantPreset.value,
            question,
            history: options.historyBeforeTurn,
            signal: controller.signal,
            onCompactionStart: (snapshot) => {
                updateManagerCompactionOverlay({
                    id: `manager-compaction-${Date.now()}`,
                    active: true,
                    resolved: false,
                    currentTokens: snapshot.currentTokens,
                    yieldTokens: snapshot.yieldTokens || 0,
                    triggerTokens: snapshot.triggerTokens,
                    status: snapshot.status,
                });
            },
            onCompactionProgress: (snapshot) => {
                updateManagerCompactionOverlay({
                    currentTokens: snapshot.currentTokens,
                    yieldTokens: snapshot.yieldTokens || snapshot.currentTokens,
                    triggerTokens: snapshot.triggerTokens,
                    status: snapshot.status,
                });
            },
            onCompactionComplete: (snapshot) => {
                updateManagerCompactionOverlay({
                    resolved: true,
                    currentTokens: snapshot.currentTokens,
                    yieldTokens: snapshot.yieldTokens || snapshot.currentTokens,
                    triggerTokens: snapshot.triggerTokens,
                    status: snapshot.status,
                });
                scheduleManagerCompactionOverlayHide();
                void refreshManagerRecords(managerSessionId);
            },
            onCompactionUnable: (snapshot) => {
                updateManagerCompactionOverlay({
                    resolved: true,
                    currentTokens: snapshot.currentTokens,
                    yieldTokens: snapshot.yieldTokens || snapshot.currentTokens,
                    triggerTokens: snapshot.triggerTokens,
                    status: snapshot.status,
                });
                scheduleManagerCompactionOverlayHide();
            },
        });
        const historyBeforeTurn = Array.isArray(options.historyBeforeTurn)
            ? budget.history
            : await listTavernManagerMessages(managerSessionId);
        const userMessage = await appendTavernManagerMessage(managerSessionId, {
            role: 'user',
            content: question,
        });
        if (selectedSessionId.value === managerSessionId) {
            managerChatMessages.value = [...managerChatMessages.value, userMessage]
                .sort((left, right) => left.order - right.order);
        }
        ensureManagerLiveProtocolState(managerSessionId);
        const replaceOrders = [...new Set((options.replaceOrdersAfterAppend || [])
            .map((order) => Number(order))
            .filter((order) => Number.isInteger(order) && order >= 0))];
        if (replaceOrders.length) {
            await deleteTavernManagerMessages(managerSessionId, replaceOrders);
            if (selectedSessionId.value === managerSessionId) {
                managerChatMessages.value = await listTavernManagerMessages(managerSessionId);
            }
        }
        const result = await runXbTavernManagerChat({
            sessionId: managerSessionId,
            agentConfig: agentConfig.value,
            assistantPreset: activeAssistantPreset.value,
            question,
            history: historyBeforeTurn,
            turn: managerTurn,
            signal: controller.signal,
            onProtocolEvent: (event) => {
                managerStreamToolDraftState.reset();
                applyManagerProtocolEvent(managerSessionId, event);
            },
            onStreamProgress: (snapshot) => {
                const streamPatch = managerStreamToolDraftState.update(snapshot);
                setManagerLiveProtocolDraft(managerSessionId, {
                    content: streamPatch.content,
                    thoughts: Array.isArray(snapshot.thoughts) ? thoughtBlocks(snapshot.thoughts) : undefined,
                    toolCalls: streamPatch.toolCalls,
                });
            },
        });
        const finalText = String(result.text || '').trim() || '没有返回内容。';
        await appendManagerProtocolMessages(managerSessionId, result.protocolMessages, finalText, {
            provider: result.provider,
            model: result.model,
            finishReason: result.ok ? 'stop' : 'error',
            error: result.ok ? false : true,
        });
        clearManagerLiveProtocolState(managerSessionId);
        if (selectedSessionId.value === managerSessionId) {
            managerChatMessages.value = await listTavernManagerMessages(managerSessionId);
        }
        await refreshManagerRecords(managerSessionId);
        managerInputStatus.value = '';
    } catch (error) {
        clearManagerLiveProtocolState(managerSessionId);
        if (controller.signal.aborted) {
            await appendTavernManagerMessage(managerSessionId, {
                role: 'assistant',
                content: '已停止。',
                finishReason: 'aborted',
            });
            if (selectedSessionId.value === managerSessionId) {
                managerChatMessages.value = await listTavernManagerMessages(managerSessionId);
            }
            managerInputStatus.value = '';
        } else {
            const errorText = error instanceof Error ? error.message : String(error || 'assistant_failed');
            await appendTavernManagerMessage(managerSessionId, {
                role: 'assistant',
                content: errorText,
                error: true,
                finishReason: 'error',
            });
            if (selectedSessionId.value === managerSessionId) {
                managerChatMessages.value = await listTavernManagerMessages(managerSessionId);
            }
            managerInputStatus.value = '失败';
        }
    } finally {
        managerStreamToolDraftState.reset();
        if (managerAssistantController.value === controller) {
            managerAssistantController.value = null;
        }
        isManagerAssistantCancelling.value = false;
        isManagerAssistantRunning.value = false;
    }
}

async function handleManagerSubmit() {
    if (isManagerAssistantRunning.value) {
        if (!isManagerAssistantCancelling.value) {
            isManagerAssistantCancelling.value = true;
            managerInputStatus.value = '正在停止...';
        }
        managerAssistantController.value?.abort();
        return;
    }
    const text = managerInputDraft.value.trim();
    if (!text || !selectedSessionId.value) {return;}
    const managerSessionId = selectedSessionId.value;
    managerInputDraft.value = '';
    void nextTick(() => resetTextareaHeight(managerComposeTextareaRef.value));
    await sendManagerQuestion(managerSessionId, text);
}

function cancelActiveRun() {
    if (!isRunning.value || !activeRunController.value) {return;}
    if (!isCancellingRun.value) {
        isCancellingRun.value = true;
        runtimeText.value = runtimeText.value || '正在停止...';
    }
    activeRunController.value.abort();
}

function handleChatSubmit() {
    void runOnce();
}

async function warmupMemoryTokenizer() {
    memoryTokenizerStatus.value = getXbTavernMemoryTokenizerStatus();
    const ok = await preloadXbTavernMemoryTokenizer();
    memoryTokenizerStatus.value = getXbTavernMemoryTokenizerStatus();
    if (!ok) {
        managerActionStatus.value = `记忆检索准备失败：${memoryTokenizerStatus.value.error || 'memory_tokenizer_failed'}`;
    }
}

async function runOnce(options: { messageText?: string; reuseUserMessageOrder?: number; rerollRuntimeEvents?: boolean } = {}) {
    if (isRunning.value) {
        cancelActiveRun();
        return;
    }
    clearComposeError();
    const messageText = String(options.messageText ?? currentUserMessage.value ?? '').trim();
    if (!messageText) {
        runtimeError.value = '先写一句话。';
        showComposeError('先写一句话。');
        return;
    }
    const controller = new AbortController();
    activeRunController.value = controller;
    isRunning.value = true;
    isCancellingRun.value = false;
    runtimeError.value = '';
    clearComposeError();
    runtimeText.value = '';
    runtimeThoughts.value = [];
    runtimeActionCheckEvents.value = [];
    runtimeProvider.value = '';
    runtimeModel.value = '';
    chatAutoScroll.value = true;
    resetChatMessageWindowState();
    try {
        if (!selectedSessionId.value) {
            await createSessionFromContext();
        }
        const runtimeContext = await resolveRuntimeContextForSession(selectedSessionId.value);
        if (controller.signal.aborted) {
            clearRuntimeAssistantLiveState();
            return;
        }
        const result = await runXbTavernTurn({
            sessionId: selectedSessionId.value,
            agentConfig: agentConfig.value,
            contextSnapshot: runtimeContext,
            chatPreset: activeChatPreset.value,
            assistantPreset: activeAssistantPreset.value,
            currentUserMessage: messageText,
            runtimeState: normalizeTavernSessionState(selectedSession.value?.state || {}),
            diagnostics: diagnostics.value,
            historyMode: historyMode.value,
            signal: controller.signal,
            reuseUserMessageOrder: options.reuseUserMessageOrder,
            rerollRuntimeEvents: options.rerollRuntimeEvents,
            runManager: true,
            applyRegex: applyTavernRegex,
            applySubstituteParams: applyTavernSubstituteParams,
            getNativeWorldInfoRuntime: getNativeWorldbookRuntime,
            onStreamProgress: (snapshot) => {
                if (typeof snapshot.text === 'string') {runtimeText.value = snapshot.text;}
                if (Array.isArray(snapshot.thoughts)) {runtimeThoughts.value = thoughtBlocks(snapshot.thoughts);}
                if (Array.isArray(snapshot.liveActionCheckEvents)) {
                    runtimeActionCheckEvents.value = snapshot.liveActionCheckEvents.map((event) => ({ ...event }));
                }
            },
            onUserMessageSaved: async (sessionId, message) => {
                selectedSessionId.value = sessionId;
                await setSelectedTavernSessionId(sessionId);
                const existingIndex = sessionMessages.value.findIndex((item) => item.sessionId === message.sessionId && item.order === message.order);
                sessionMessages.value = existingIndex >= 0
                    ? sessionMessages.value.map((item, index) => index === existingIndex ? message : item)
                    : [...sessionMessages.value, message].sort((left, right) => left.order - right.order);
                currentUserMessage.value = '';
                void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
                await refreshSessions();
                scrollChatToBottom(true);
            },
            onAssistantMessageSaved: async (sessionId, message) => {
                selectedSessionId.value = sessionId;
                const existingIndex = sessionMessages.value.findIndex((item) => item.sessionId === message.sessionId && item.order === message.order);
                sessionMessages.value = existingIndex >= 0
                    ? sessionMessages.value.map((item, index) => index === existingIndex ? message : item)
                    : [...sessionMessages.value, message].sort((left, right) => left.order - right.order);
                clearRuntimeAssistantLiveState();
                await refreshSessions();
                scrollChatToBottom();
            },
            onManagerRunSaved: async (sessionId) => {
                await refreshManagerRecords(sessionId);
            },
        });
        selectedSessionId.value = result.sessionId;
        clearRuntimeAssistantLiveState();
        runtimeError.value = result.error || '';
        runtimeProvider.value = result.provider || '';
        runtimeModel.value = result.model || '';
        await refreshSessions();
        await refreshManagerRecords(result.sessionId);
        scrollChatToBottom();
    } catch (error) {
        console.error('[小白酒馆] turn failed', error);
        clearRuntimeAssistantLiveState();
        runtimeError.value = error instanceof Error ? error.message : String(error || 'run_failed');
    } finally {
        if (activeRunController.value === controller) {
            activeRunController.value = null;
        }
        isCancellingRun.value = false;
        isRunning.value = false;
        scrollChatToBottom();
    }
}

watch([
    () => visibleChatMessages.value.length,
    () => chatMessageWindow.value.startIndex,
    () => visibleChatMarkdownSignature.value,
    () => runtimeText.value,
    () => runtimeThoughtsSignature.value,
    () => runtimeActionCheckSignature.value,
    () => activeView.value,
    () => chatFocus.value,
], () => {
    if (activeView.value === 'chat' && chatFocus.value === 'chat') {
        scrollChatToBottom();
        void nextTick(() => {
            enhanceChatMarkdown();
            updateChatScrollButtons();
        });
    }
});

watch([
    () => visibleManagerChatMessages.value.length,
    () => managerMessageWindow.value.startIndex,
    () => visibleManagerMarkdownSignature.value,
    () => liveManagerMarkdownSignature.value,
    () => isManagerAssistantRunning.value,
    () => activeView.value,
    () => chatFocus.value,
], () => {
    if (activeView.value === 'chat' && chatFocus.value === 'manager') {
        scrollManagerToBottom();
        void nextTick(() => {
            enhanceManagerMarkdown();
            updateManagerScrollButtons();
        });
    }
});

watch([() => activeView.value, () => chatFocus.value], () => {
    if (activeView.value === 'chat' && chatFocus.value === 'chat') {
        scrollChatToBottom(true);
    }
});

watch(() => selectedSessionId.value, () => {
    resetChatMessageWindowState();
    resetManagerMessageWindowState();
    chatAutoScroll.value = true;
    managerAutoScroll.value = true;
    chatLastScrollTop = 0;
    managerLastScrollTop = 0;
    memoryFileSearchText.value = '';
    memoryFileGroupVisibleLimits.value = {};
    chatSessionSearchText.value = '';
    chatSidebarSessionLimit.value = CHAT_SIDEBAR_INITIAL_LIMIT;
    void nextTick(() => {
        scrollChatToBottom(true);
        scrollManagerToBottom(true);
    });
});

watch([() => activeMemoryFiles.value.length, () => filteredChatSidebarSessionCount.value], ([memoryCount, sessionCount]) => {
    if (chatSidePanel.value === 'sessions' && memoryCount && !sessionCount) {
        chatSidePanel.value = 'memory';
    }
});

watch(runtimeError, (message) => {
    if (message) {
        showComposeError(message);
    }
});

watch(latestSavedChatError, (signature) => {
    if (!signature) {return;}
    const errorText = signature.split(':').slice(2).join(':').trim();
    if (errorText) {
        showComposeError(errorText);
    }
});

watch([
    () => activeSettingsWorkspace.value,
    () => activeView.value,
    () => apiConfigSave.value.status,
    () => agentConfig.value,
], () => {
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'api') {
        void nextTick(renderApiSettingsPanel);
    }
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'regex' && !regexGroups.value.length) {
        void refreshRegexFromHost();
    }
});

watch([activeView, activeSettingsWorkspace], ([view, workspace], [previousView, previousWorkspace]) => {
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
    if (activeView.value !== 'settings' || activeSettingsWorkspace.value !== 'worldbooks') {return;}
    worldbookPreviewVisibleLimit.value = WORLDBOOK_PREVIEW_BATCH_SIZE;
    void loadSelectedWorldbookPreview(name);
});

watch(selectedMemoryFileEntry, async (file) => {
    const nextPath = String(file?.path || '');
    if (!nextPath) {
        if (memoryEditorDirty.value) {
            memoryEditorStatus.value = '当前档案已变化，草稿仍保留';
            return;
        }
        invalidateMemoryFileRecordLoad();
        loadMemoryFileIntoEditor(null);
        return;
    }
    if (memoryEditorLoadedPath.value === nextPath && memoryEditorDirty.value) {
        if (selectedMemoryFileRecord.value?.sessionId !== selectedSessionId.value) {
            selectedMemoryFileRecord.value = null;
        }
        memoryEditorStatus.value = '档案已刷新，当前草稿仍保留';
        return;
    }
    const loaded = await loadSelectedMemoryFileRecord(nextPath);
    if (String(selectedMemoryFilePath.value || '') !== nextPath) {return;}
    loadMemoryFileIntoEditor(loaded);
}, { immediate: true });

watch(homeThemeDark, (isDark) => {
    try {
        globalThis.localStorage?.setItem(TAVERN_THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
        // Theme persistence is best-effort only.
    }
});

provide(TAVERN_APP_UI_CONTEXT, {
    actionFeedback,
    activeAssistantPresetId,
    activeMemoryFiles,
    activePromptOrderLabel,
    activeSettingsWorkspace,
    activeView,
    apiSettingsRootRef,
    apiReady,
    apiReadyDetail,
    apiRuntimeLine,
    applyActiveRegexScript,
    ASSISTANT_PRESET_BATCH_SIZE,
    assistantPreset,
    assistantPresetDirty,
    assistantPresetItems,
    assistantPresetSearchText,
    assistantPresetStatus,
    assistantPresetVisibleLimit,
    cancelEditMessage,
    canDrawMessage,
    canEditMessage,
    canEditManagerMessage,
    canEditPromptOrder,
    canRerunMessage,
    canRerunManagerMessage,
    canSendManagerMessage,
    canSendMessage,
    CHAT_PRESET_SOURCE_BATCH_SIZE,
    CHAT_SIDEBAR_BATCH_SIZE,
    chatAutoScroll,
    chatFocus,
    chatLayout,
    chatMessages,
    chatMessageWindow,
    chatComposeTextareaRef,
    chatPresetSourceSearchText,
    chatPresetSourceVisibleLimit,
    chatScrollControlsActive,
    chatScrollRef,
    chatSessionSearchText,
    chatSidebarSessionLimit,
    chatSidebarSessions,
    chatSidePanel,
    chatSubtitle,
    chatWorkspacePanel,
    copyMessage,
    copyManagerMessage,
    currentManagerWorkRun,
    createRegexScript,
    currentUserMessage,
    deleteCurrentRegexScript,
    deleteManagerMessageTurn,
    deleteMessageTurn,
    deriveAssistantPreset,
    discardAssistantPresetChanges,
    discardMemoryDraft,
    discardPresetChanges,
    displayCharacterName,
    drawMessage,
    drawMessageStatusClass,
    drawMessageStatusText,
    drawMessageTitle,
    drawProgressText,
    editingMessageDraft,
    enterMemoryEditMode,
    expandMemoryFileGroup,
    expandRegexGroup,
    filteredChatSidebarSessionCount,
    filteredPromptEditorRows,
    formatRunActivityLine,
    formatRunIssueLine,
    formatRunInputLine,
    formatRunMapLine,
    formatRunMemoryLine,
    formatManagerSource,
    formatMemoryFileMeta,
    formatMessageTime,
    formatRunModelLine,
    handleChatScroll,
    handleChatSubmit,
    handleChatTouchMove,
    handleChatTouchStart,
    handleChatWheel,
    handleComposeInput,
    handleComposeKeydown,
    handleEditInput,
    handleEditKeydown,
    handleManagerComposeKeydown,
    handleManagerEditKeydown,
    handleManagerScroll,
    handleManagerSubmit,
    handleManagerTouchMove,
    handleManagerTouchStart,
    handleManagerWheel,
    hiddenAssistantPresetCount,
    hiddenChatPresetOptionCount,
    hiddenChatSidebarSessionCount,
    hiddenManagerRunCount,
    hiddenPromptCount,
    hiddenWorldbookCount,
    hiddenWorldbookPreviewEntryCount,
    homeThemeDark,
    isDrawingMessage,
    isEditingMessage,
    isEditingManagerMessage,
    isEditingMessageDirty,
    isEditingManagerMessageDirty,
    isCancellingRun,
    isManagerAssistantCancelling,
    isManagerAssistantRunning,
    isRunning,
    latestErrorMessage,
    linesFromList,
    listFromLines,
    archivedManagerRuns,
    managerAutoScroll,
    managerActionFeedback,
    managerBusy,
    managerChatMessages,
    managerCompactionOverlay,
    managerInputDraft,
    managerInputStatus,
    managerMessageWindow,
    managerRuns,
    managerComposeTextareaRef,
    managerScrollControlsActive,
    managerScrollRef,
    managerRunTone,
    managerStatusLabel,
    managerStatusLine,
    managerToolStatusLabel,
    managerToolTone,
    managerToolTraceItems,
    managerToolTurnPreview,
    managerToolTurnSummary,
    markdownSignature,
    MEMORY_FILE_BATCH_SIZE,
    MEMORY_TURN_BATCH_SIZE,
    memoryDirectoryGroups,
    memoryEditorDirty,
    memoryEditorDocumentAvailable,
    memoryEditorDraft,
    memoryEditorLoadedPath,
    memoryEditorMode,
    memoryEditorReadOnly,
    memoryEditorStatus,
    memoryFileDisplayName,
    memoryFileKindLabel,
    memoryFiles,
    memoryFileSearchText,
    memoryFileStatusLabel,
    memoryIndexStatusLine,
    mapStateDocument,
    mapStatePatches,
    messageKey,
    movePromptRow,
    normalizeTavernSessionState,
    openPromptInspector,
    openSelectedWorldbookEditor,
    postToHost,
    preset,
    presetDirty,
    presetRows,
    presetStatus,
    presetTotalChars,
    previewMemoryDraft,
    PROMPT_EDITOR_BATCH_SIZE,
    promptEditorRows,
    promptRoleDisplay,
    promptRowIndex,
    promptSearchText,
    promptVisibleLimit,
    refreshRegexFromHost,
    syncWorldbooksFromHost,
    REGEX_GROUP_BATCH_SIZE,
    regexDirty,
    regexDraft,
    regexDraftTypeLabel,
    regexGroupsForDisplay,
    regexPlacementLabel,
    regexScriptRows,
    regexSearchText,
    regexStatus,
    rememberBrokenAvatar,
    removeSession,
    renderChatMarkdown,
    rerunFromMessage,
    rerunFromManagerMessage,
    retryManagerRun,
    revealOlderChatMessages,
    revealOlderManagerMessages,
    roleLabel,
    runtimeText,
    runtimeThoughts,
    runtimeActionCheckEvents,
    saveCurrentAssistantPreset,
    saveCurrentPreset,
    saveCurrentRegexScript,
    saveEditMessage,
    saveEditManagerMessage,
    saveSessionContract,
    saveSelectedMemoryFile,
    scrollChatToBottom,
    scrollChatToTop,
    scrollManagerToBottom,
    scrollManagerToTop,
    selectAssistantPreset,
    selectAssistantPresetItem,
    selectChatPresetFromHost,
    selectedAssistantPresetItem,
    selectedMemoryFileEntry,
    selectedMemoryFile,
    selectedMemoryFilePath,
    selectedPresetSourceId,
    selectedPromptIdentifier,
    selectedPromptRow,
    selectedRegexKey,
    selectedRegexRow,
    sessionContract,
    selectedSessionId,
    selectedWorldbook,
    selectedWorldbookName,
    selectMemoryFile,
    selectRegexScript,
    selectSession,
    selectSettingsWorkspace,
    sessionDisplayTitle,
    sessions,
    settingsNavItems,
    shortText,
    showChatScrollBottom,
    showChatScrollTop,
    showMoreWorldbookPreviewEntries,
    showManagerScrollBottom,
    showManagerScrollTop,
    startEditMessage,
    startEditManagerMessage,
    stateMemoryFile,
    thoughtBlocks,
    thoughtSummaryLabel,
    togglePromptRow,
    toggleRegexPlacement,
    toolTraceSummary,
    updateAssistantPresetPatch,
    updateChatScrollButtons,
    updateManagerScrollButtons,
    updatePromptByIdentifier,
    updateRegexPatch,
    updateSelectedAssistantPresetItem,
    visibleAssistantPresetRecords,
    visibleCharacterAvatar,
    visibleChatMessages,
    visibleChatPresetOptions,
    visibleManagerChatItems,
    visibleManagerChatMessages,
    liveManagerChatDisplayItems,
    visiblePromptEditorRows,
    visibleUserAvatar,
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
});

onMounted(async () => {
    // onHostMessage validates origin and message source before accepting payloads.
    // eslint-disable-next-line no-restricted-syntax
    window.addEventListener('message', onHostMessage);
    managerRecordsPollTimer = window.setInterval(() => {
        void pollLiveManagerRecords();
    }, 2000);
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'api') {
        void nextTick(renderApiSettingsPanel);
    }
    void warmupMemoryTokenizer();
    await refreshPresets();
    await refreshSessions();
    syncApiSettingsConfigFromAgentConfig();
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'api') {
        await nextTick(renderApiSettingsPanel);
    }
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'chatPreset') {
        void syncChatPresetFromHost();
    }
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'worldbooks') {
        void syncWorldbooksFromHost();
    }
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'regex') {
        void refreshRegexFromHost();
    }
    postToHost('xb-tavern:frame-ready');
    if (selectedSessionId.value) {
        void syncSessionCharacterContext({ sessionId: selectedSessionId.value, force: true });
    }
    if (activeView.value === 'chat' && chatFocus.value === 'chat') {
        scrollChatToBottom(true);
    }
});

onUnmounted(() => {
    window.removeEventListener('message', onHostMessage);
    setHostChatCompletionsRequestHeadersProvider(null);
    pendingHostRequests.forEach((request) => {
        window.clearTimeout(request.timer);
        if (request.abort && request.signal) {
            request.signal.removeEventListener('abort', request.abort);
        }
        request.reject(new Error('tavern_unmounted'));
    });
    pendingHostRequests.clear();
    activeRunController.value?.abort();
    managerAssistantController.value?.abort();
    tavernDrawController.value?.abort();
    if (chatScrollHideTimer) {
        window.clearTimeout(chatScrollHideTimer);
        chatScrollHideTimer = null;
    }
    chatScrollRef.value?.classList.remove('is-scrolling');
    if (managerScrollHideTimer) {
        window.clearTimeout(managerScrollHideTimer);
        managerScrollHideTimer = null;
    }
    managerScrollRef.value?.classList.remove('is-scrolling');
    if (composeErrorHideTimer) {
        window.clearTimeout(composeErrorHideTimer);
        composeErrorHideTimer = null;
    }
    if (managerRecordsPollTimer) {
        window.clearInterval(managerRecordsPollTimer);
        managerRecordsPollTimer = null;
    }
    clearManagerCompactionOverlayHideTimer();
    clearPendingCharacterSession();
});
</script>

<template>
  <main
    class="xb-tavern xb-os-shell"
    :class="{ 'is-home-view': activeView === 'home' || activeView === 'about', 'theme-dark': homeThemeDark, 'theme-light': !homeThemeDark }"
  >
    <section class="xb-os-stage">
      <TavernHomePage
        v-if="activeView === 'home'"
        :dark="homeThemeDark"
        :has-session="!!selectedSessionId"
        :subtitle="chatSubtitle"
        :character-count="characterCards.length"
        @toggle-theme="homeThemeDark = !homeThemeDark"
        @exit="postToHost('xb-tavern:close')"
        @enter="handleHomePrimaryAction"
        @open-characters="openCharacterSelect"
        @open-settings="openSettingsWorkspace"
        @open-about="activeView = 'about'"
      />

      <TavernAboutPage
        v-if="activeView === 'about'"
        :dark="homeThemeDark"
        @toggle-theme="homeThemeDark = !homeThemeDark"
        @exit="postToHost('xb-tavern:close')"
        @back="activeView = 'home'"
      />

      <TavernCharacterSelectPage
        v-if="activeView === 'characters'"
        ref="characterArchivePageRef"
        v-model:search-text="characterSearchText"
        :dark="homeThemeDark"
        :pending-error="pendingCharacterError"
        :characters="characterCards"
        :visible-characters="visibleCharacterCards"
        :filtered-count="filteredCharacterCards.length"
        :live-character-id="liveCharacterId"
        :selected-character="selectedCharacterPreview"
        :selected-greeting-index="selectedCharacterGreetingIndex"
        :pending-character-session-id="pendingCharacterSessionId"
        :hidden-count="hiddenCharacterCount"
        :batch-size="CHARACTER_ARCHIVE_BATCH_SIZE"
        :avatar-available="avatarAvailable"
        :short-text="shortText"
        @toggle-theme="homeThemeDark = !homeThemeDark"
        @exit="postToHost('xb-tavern:close')"
        @back="activeView = 'home'"
        @refresh="refreshCharacterList"
        @select="selectCharacterForPreview"
        @select-greeting="selectCharacterGreeting"
        @enter-selected="enterSelectedCharacter"
        @enter-character="selectCharacterAndCreateSession"
        @load-more="characterVisibleLimit += CHARACTER_ARCHIVE_BATCH_SIZE"
        @keydown="handleCharacterArchiveKeydown"
        @avatar-error="rememberBrokenAvatar"
      />

      <TavernChatPage
        v-if="activeView === 'chat'"
      />

      <TavernSettingsPage
        v-if="activeView === 'settings'"
      />
    </section>

    <TavernRequestLogModal
      v-if="showPromptInspector"
      v-model:tab="promptInspectorTab"
      v-model:simulate-input="simulateRequestInput"
      :last-request-raw-json="lastRequestRawJson"
      :last-request-snapshot="lastRequestSnapshot"
      :simulate-status="simulateRequestStatus"
      :simulate-error="simulateRequestError"
      :simulate-json="simulateRequestJson"
      @close="closePromptInspector"
      @simulate="simulateApiRequest"
    />
  </main>
</template>
