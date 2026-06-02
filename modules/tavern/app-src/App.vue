<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { enhanceMarkdownContent, renderMarkdownToHtml } from '../../agent-core/ui/message-markdown.js';
import { createAgentSettingsPanel } from '../../agent-core/ui/settings-panel.js';
import { buildAgentSettingsPanelMarkup } from '../../agent-core/ui/settings-markup.js';
import { normalizeAgentConfig } from '../../agent-core/config.js';
import { setHostChatCompletionsRequestHeadersProvider } from '../../../shared/host-llm/chat-completions/client.js';
import {
    type XbTavernContext,
    type XbTavernPresetSection,
} from '../shared/message-assembler';
import { buildXbTavernBrain } from '../shared/brain';
import {
    buildXbTavernMemoryIgnoredTerms,
    buildXbTavernMemoryQuery,
    getXbTavernMemoryTokenizerStatus,
    preloadXbTavernMemoryTokenizer,
    selectXbTavernMemoryContext,
} from '../shared/memory-retrieval';
import {
    getTavernMemoryIndex,
    listTavernMemoryFiles,
} from '../shared/memory-files';
import { createDefaultXbTavernPreset, DEFAULT_XB_TAVERN_PRESET_ID } from '../shared/presets';
import {
    createTavernSession,
    appendTavernMessage,
    deleteTavernMessages,
    deriveAndActivateDefaultTavernPreset,
    getActiveTavernPresetId,
    getSelectedTavernSessionId,
    listTavernEpisodeSummaries,
    listTavernManagerRuns,
    loadActiveTavernPreset,
    listTavernMessages,
    listTavernSessions,
    listTavernTurnSummaries,
    listUserTavernPresets,
    markTavernMemoryStaleFromOrder,
    normalizeTavernSessionState,
    replaceTavernSessionState,
    saveTavernPreset,
    setActiveTavernPresetId,
    setSelectedTavernSessionId,
    updateTavernMessage,
    updateTavernSessionSnapshot,
    type TavernEpisodeSummaryRecord,
    type TavernManagerRunRecord,
    type TavernMemoryFileRecord,
    type TavernMemoryIndexRecord,
    type TavernMessageRecord,
    type TavernPresetRecord,
    type TavernSessionRecord,
    type TavernTurnSummaryRecord,
} from '../shared/session-db';
import { buildContextHistory, deriveTavernSessionStateFromMessages, runXbTavernTurn, simulateXbTavernRequest } from './runtime/run-once';
import { runXbTavernManagerAfterTurn } from './runtime/manager';
import { resolveXbTavernProviderConfig } from './runtime/provider';

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

interface TavernCharacterOption {
    id: string;
    name: string;
    avatar?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMessage?: string;
}

const SOURCE_APP = 'xb-tavern-app';
const SOURCE_HOST = 'xb-tavern-host';
const HOST_REQUEST_TIMEOUT_MS = 5000;
const CHARACTER_CONTEXT_TIMEOUT_MS = 15000;

const context = ref<XbTavernContext>({});
const diagnostics = ref<TavernDiagnostics>({});
const agentConfig = ref<Record<string, unknown>>({});
const hostRequestHeaders = ref<Record<string, unknown>>({});
const apiSettingsRootRef = ref<HTMLElement | null>(null);
const apiConfigSave = ref({ status: 'idle', requestId: '', error: '' });
const apiConfigStatus = ref('');
const availableCharacters = ref<TavernCharacterOption[]>([]);
const selectedCharacterId = ref('');
const pendingCharacterSessionId = ref('');
const pendingCharacterError = ref('');
const statusText = ref('等待读取资料');
const currentUserMessage = ref('');
const historyMode = ref<'raw' | 'squash'>('squash');
const runtimeText = ref('');
const runtimeError = ref('');
const runtimeProvider = ref('');
const runtimeModel = ref('');
const runtimeSnapshotJson = ref('');
const isRunning = ref(false);
const sessions = ref<TavernSessionRecord[]>([]);
const selectedSessionId = ref('');
const sessionMessages = ref<TavernMessageRecord[]>([]);
const turnSummaries = ref<TavernTurnSummaryRecord[]>([]);
const episodeSummaries = ref<TavernEpisodeSummaryRecord[]>([]);
const managerRuns = ref<TavernManagerRunRecord[]>([]);
const memoryFiles = ref<TavernMemoryFileRecord[]>([]);
const memoryIndex = ref<TavernMemoryIndexRecord | null>(null);
const memoryTokenizerStatus = ref(getXbTavernMemoryTokenizerStatus());
const selectedMemoryFilePath = ref('');
const managerActionStatus = ref('');
const preset = ref(createDefaultXbTavernPreset());
const userPresets = ref<TavernPresetRecord[]>([]);
const activePresetId = ref(DEFAULT_XB_TAVERN_PRESET_ID);
const presetStatus = ref('');
const savedPresetJson = ref('');
const selectedPresetSourceId = ref('');
type AppView = 'home' | 'chat' | 'characters' | 'settings';
type SettingsWorkspaceKey = 'api' | 'preset';
type ChatFocus = 'chat' | 'balanced' | 'manager';
function readInitialView(): AppView {
    const hash = String(window.location.hash || '').replace(/^#\/?/, '');
    const [view] = hash.split('/');
    if (view === 'chat' || view === 'characters' || view === 'settings') {
        return view;
    }
    return 'home';
}
function readInitialSettingsWorkspace(): SettingsWorkspaceKey {
    const hash = String(window.location.hash || '').replace(/^#\/?/, '');
    return hash.split('/')[1] === 'preset' ? 'preset' : 'api';
}
interface PendingHostRequest {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: number;
}
const presetIsBuiltIn = computed(() => activePresetId.value === DEFAULT_XB_TAVERN_PRESET_ID);
const pendingHostRequests = new Map<string, PendingHostRequest>();
const presetDirty = computed(() => !presetIsBuiltIn.value && snapshotPreset(preset.value) !== savedPresetJson.value);
const selectedSession = computed(() => sessions.value.find((item) => item.id === selectedSessionId.value) || null);
const sessionRuntimeState = computed(() => normalizeTavernSessionState(selectedSession.value?.state || {}));
const activeView = ref<AppView>(readInitialView());
const activeSettingsWorkspace = ref<SettingsWorkspaceKey>(readInitialSettingsWorkspace());
const chatFocus = ref<ChatFocus>('balanced');
const chatScrollRef = ref<HTMLElement | null>(null);
const chatAutoScroll = ref(true);
const showChatScrollTop = ref(false);
const showChatScrollBottom = ref(false);
const chatScrollControlsActive = ref(false);
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
const markdownHtmlCache = new Map<string, string>();
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
let chatTouchStartY: number | null = null;
let chatLastScrollTop = 0;
const usingLockedSessionContext = computed(() => !!selectedSession.value?.contextSnapshot);
const liveWorldBookCount = computed(() => context.value.worldBooks?.length || 0);
const liveWorldEntryCount = computed(() => (context.value.worldBooks || []).reduce((sum, book) => sum + (book.entries?.length || 0), 0));
const contextSourceTitle = computed(() => usingLockedSessionContext.value
    ? '会话快照'
    : '酒馆当前资料');
const contextSourceDetail = computed(() => usingLockedSessionContext.value
    ? `保存于会话：${selectedSession.value?.characterName || '未选择角色'}。`
    : `${context.value.character?.name || '未选择角色'} · 世界书 ${liveWorldBookCount.value} 本 / ${liveWorldEntryCount.value} 条。`);
const effectiveContext = computed<XbTavernContext>(() => ({
    ...(selectedSession.value?.contextSnapshot || context.value),
    history: selectedSessionId.value
        ? buildContextHistory(sessionMessages.value)
        : context.value.history,
}));
const memoryContext = computed(() => {
    if (memoryTokenizerStatus.value.status !== 'ready') {return {};}
    return selectXbTavernMemoryContext({
        episodeSummaries: episodeSummaries.value,
        turnSummaries: turnSummaries.value,
        memoryFiles: memoryFiles.value,
        queryText: buildXbTavernMemoryQuery(effectiveContext.value, currentUserMessage.value),
        ignoredTerms: buildXbTavernMemoryIgnoredTerms(effectiveContext.value),
    });
});

const brainBuild = computed(() => buildXbTavernBrain({
    context: effectiveContext.value,
    preset: preset.value,
    currentUserMessage: currentUserMessage.value,
    historyMode: historyMode.value,
    turn: sessionRuntimeState.value.turn,
    entryStates: sessionRuntimeState.value.worldEntryStates,
    memoryContext: memoryContext.value,
    diagnostics: diagnostics.value,
}));
const buildResult = computed(() => brainBuild.value.buildResult);

const effectiveCharacter = computed(() => effectiveContext.value.character || {});
const effectiveUser = computed(() => effectiveContext.value.user || {});
const characterName = computed(() => effectiveCharacter.value.name || '未选择角色');
const hasCharacter = computed(() => !!String(effectiveCharacter.value.name || '').trim());
const characterAvatar = computed(() => String(effectiveCharacter.value.avatar || '').trim());
const liveCharacter = computed(() => context.value.character || {});
const liveCharacterId = computed(() => String(liveCharacter.value.id || selectedCharacterId.value || '').trim());
const characterCards = computed<TavernCharacterOption[]>(() => {
    const byId = new Map<string, TavernCharacterOption>();
    availableCharacters.value.forEach((character) => {
        const id = String(character.id || '').trim();
        if (!id) {return;}
        byId.set(id, {
            id,
            name: String(character.name || '').trim() || `角色 ${id}`,
            avatar: String(character.avatar || '').trim(),
            description: String(character.description || '').trim(),
            personality: String(character.personality || '').trim(),
            scenario: String(character.scenario || '').trim(),
            firstMessage: String(character.firstMessage || '').trim(),
        });
    });
    const currentId = String(liveCharacter.value.id || '').trim();
    if (currentId && liveCharacter.value.name && !byId.has(currentId)) {
        byId.set(currentId, {
            id: currentId,
            name: String(liveCharacter.value.name || '').trim(),
            avatar: String(liveCharacter.value.avatar || '').trim(),
            description: String(liveCharacter.value.description || '').trim(),
            personality: String(liveCharacter.value.personality || '').trim(),
            scenario: String(liveCharacter.value.scenario || '').trim(),
            firstMessage: String(liveCharacter.value.firstMessage || '').trim(),
        });
    }
    return [...byId.values()].sort((left, right) => {
        const leftCurrent = left.id === liveCharacterId.value ? -1 : 0;
        const rightCurrent = right.id === liveCharacterId.value ? -1 : 0;
        if (leftCurrent !== rightCurrent) {return leftCurrent - rightCurrent;}
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
});
const userName = computed(() => effectiveUser.value.name || 'User');
const worldBooks = computed(() => effectiveContext.value.worldBooks || []);
const worldBookCount = computed(() => worldBooks.value.length);
const worldEntryCount = computed(() => buildResult.value.worldEntryCandidates.length);
const activatedCount = computed(() => buildResult.value.activatedWorldEntries.length);
const messagePreview = computed(() => buildResult.value.messages);
const selectedSessionTitle = computed(() => selectedSession.value?.title || '未创建会话');
const rawMessagesJson = computed(() => buildResult.value.meta.rawMessagesJson);
const buildSnapshot = computed(() => brainBuild.value.buildSnapshot);
const effectiveHistoryCount = computed(() => effectiveContext.value.history?.length || 0);
const lastRequestSnapshot = computed(() => selectedSession.value?.state?.lastRequestSnapshot as RequestAuditSnapshot | undefined);
const lastRequestRawJson = computed(() => String(lastRequestSnapshot.value?.rawRequestJson || lastRequestSnapshot.value?.rawMessagesJson || ''));
const lastRequestMatchesPreview = computed(() => !!lastRequestSnapshot.value?.rawMessagesJson
    && lastRequestSnapshot.value.rawMessagesJson === rawMessagesJson.value);
const resolvedProviderConfig = computed(() => resolveXbTavernProviderConfig(agentConfig.value));
const apiReady = computed(() => resolvedProviderConfig.value.readiness.ok);
const apiReadyDetail = computed(() => resolvedProviderConfig.value.readiness.message);
const chatMessages = computed(() => sessionMessages.value);
const sessionMessagesForChat = computed(() => sessionMessages.value.filter((message) => !message.error));
const latestErrorMessage = computed(() => {
    if (runtimeError.value) {return runtimeError.value;}
    const lastMessage = [...sessionMessages.value].sort((left, right) => left.order - right.order).at(-1);
    return lastMessage?.error ? lastMessage.content : '';
});
const latestManagerRun = computed(() => managerRuns.value[0] || null);
const managerBusy = computed(() => managerRuns.value.some((run) => ['queued', 'running'].includes(run.status)));
const recentTurnSummaries = computed(() => [...turnSummaries.value].reverse().slice(0, 8));
const sidebarSessions = computed(() => sessions.value.slice(0, 6));
const chatSidebarSessions = computed(() => {
    const currentCharacterId = String(selectedSession.value?.characterId || effectiveContext.value.character?.id || '').trim();
    const sameCharacter = currentCharacterId
        ? sessions.value.filter((session) => String(session.characterId || '').trim() === currentCharacterId)
        : sessions.value;
    return sameCharacter.slice(0, 6);
});
const activeMemoryFiles = computed(() => memoryFiles.value.filter((file) => file.status !== 'stale'));
const selectedMemoryFile = computed(() => (
    memoryFiles.value.find((file) => file.path === selectedMemoryFilePath.value)
    || memoryFiles.value[0]
    || null
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
const chatMarkdownSignature = computed(() => sessionMessages.value
    .map((message) => `${message.sessionId}:${message.order}:${message.error ? 1 : 0}:${markdownSignature(message.content)}`)
    .join('|'));
const chatReadyLabel = computed(() => selectedSessionId.value ? selectedSessionTitle.value : '未创建会话');
const chatSubtitle = computed(() => {
    if (!selectedSessionId.value) {return '写一句话后会自动创建独立会话。';}
    const turn = Number(sessionRuntimeState.value.turn || 0);
    return `${characterName.value} · 第 ${turn} 轮 · ${sessionMessagesForChat.value.length} 条可用消息`;
});
const lastModelLine = computed(() => {
    const provider = String(lastRequestSnapshot.value?.providerLabel || lastRequestSnapshot.value?.provider || runtimeProvider.value || resolvedProviderConfig.value.providerLabel || '').trim();
    const model = String(lastRequestSnapshot.value?.model || runtimeModel.value || resolvedProviderConfig.value.model || '').trim();
    if (!provider && !model) {return '还没有调用记录';}
    return `${provider || '未知通道'} / ${model || '未知模型'}`;
});
const apiRuntimeLine = computed(() => {
    const config = resolvedProviderConfig.value;
    return `预设「${config.currentPresetName || '默认'}」 · ${config.providerLabel} / ${config.model || '未选择模型'}`;
});
const canSendMessage = computed(() => isRunning.value || !!currentUserMessage.value.trim());
const characterFields = computed(() => {
    const character = effectiveContext.value.character || {};
    const user = effectiveContext.value.user || {};
    return [
        ['角色', character.name],
        ['头像', character.avatar],
        ['用户', user.name],
        ['用户设定', user.persona || user.description],
        ['描述', character.description],
        ['性格', character.personality],
        ['场景', character.scenario],
        ['首条消息', character.firstMessage || character.first_mes],
        ['示例消息', character.mesExample || character.mes_example],
        ['作者备注', character.creatorNotes || character.creator_notes],
    ].filter((item) => String(item[1] || '').trim());
});

const diagnosticRows = computed(() => {
    const rows = [
        contextSourceDetail.value,
        apiReady.value ? `API：${apiRuntimeLine.value}` : `API：${apiReadyDetail.value}`,
        diagnostics.value.message || statusText.value,
        characterName.value ? '' : '当前没有可用角色卡。',
        effectiveHistoryCount.value ? '' : '这次准备资料里没有聊天历史。',
        worldBookCount.value ? '' : '这次准备资料里没有可用世界书。',
        ...(diagnostics.value.worldbookErrors || []).map((item) => `${item.name}: ${item.error}`),
    ];
    return rows.map((item) => String(item || '').trim()).filter(Boolean);
});

const messageRows = computed(() => messagePreview.value.map((message, index) => {
    const layer = buildResult.value.messageLayers[index];
    return {
        index,
        message,
        layer: layer?.layer || 'unknown',
        label: layer?.label || 'unknown',
        sourceId: layer?.sourceId || '',
        chars: layer?.chars || message.content.length,
        tokenEstimate: layer?.tokenEstimate || Math.max(1, Math.ceil(message.content.length / 4)),
    };
}));

type MessagePreviewRow = (typeof messageRows.value)[number];

const messageGroups = computed(() => {
    const labels: Record<string, string> = {
        top: '开场规则',
        preset: '预设条目',
        'world-before': '先放入的世界书',
        'character-card': '角色卡',
        'world-after': '角色卡后的世界书',
        'world-author-note': '世界书 · 作者备注',
        'world-examples': '世界书 · 示例消息',
        history: '会话历史',
        'current-user/history': '历史和本次输入',
        'current-user': '本次输入',
        'world-depth': '插入到历史里的世界书',
        'assistant-prefill': '回复开头',
    };
    const groups: Array<{ key: string; label: string; rows: MessagePreviewRow[]; chars: number; tokenEstimate: number }> = [];
    messageRows.value.forEach((row) => {
        const previous = groups[groups.length - 1];
        let group = previous?.key === row.layer ? previous : null;
        if (!group) {
            group = {
                key: row.layer,
                label: labels[row.layer] || row.label || row.layer,
                rows: [],
                chars: 0,
                tokenEstimate: 0,
            };
            groups.push(group);
        }
        group.rows.push(row);
        group.chars += row.chars;
        group.tokenEstimate += row.tokenEstimate;
    });
    return groups;
});

const activatedOrder = computed(() => new Map(buildResult.value.activatedWorldEntries.map((entry, index) => [entry.activationKey, index])));
const candidateRows = computed(() => buildResult.value.worldEntryCandidates);
function displayList(value: unknown): string {
    if (Array.isArray(value)) {return value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');}
    return String(value || '').trim();
}
const worldBookEntryRows = computed(() => worldBooks.value.flatMap((book) => (book.entries || []).map((entry, index) => ({
    key: `${book.name || 'worldbook'}-${entry.uid ?? entry.id ?? index}`,
    bookName: book.name || '未命名世界书',
    title: String(entry.comment || entry.title || entry.name || entry.uid || entry.id || `条目 ${index + 1}`),
    keywords: displayList(entry.key),
    secondaryKeywords: displayList(entry.keysecondary || entry.secondary_keys),
    content: String(entry.content || ''),
}))));
const scanTextPreview = computed(() => buildResult.value.meta.scanText || '');
const worldBudget = computed(() => buildResult.value.meta.worldBudget);
const worldPositionRows = computed(() => Object.entries(buildResult.value.meta.worldPositionCounts || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN')));
const activatedCandidateRows = computed(() => candidateRows.value
    .filter((entry) => entry.status === 'activated')
    .sort((left, right) => (activatedOrder.value.get(left.activationKey) ?? 999999) - (activatedOrder.value.get(right.activationKey) ?? 999999)));
const skippedCandidateRows = computed(() => candidateRows.value
    .filter((entry) => entry.status !== 'activated')
    .sort((left, right) => right.order - left.order || left.activationKey.localeCompare(right.activationKey, 'zh-Hans-CN')));
const placementLabels: Record<string, string> = {
    top: '最前面',
    beforeCharacter: '角色卡前',
    afterCharacter: '角色卡后',
    beforeHistory: '历史前',
    afterHistory: '历史后',
    assistantPrefill: '回复开头',
};
type PresetQueueRow = XbTavernPresetSection & {
    previewId: string;
    previewLabel: string;
    previewPlacement: string;
    sectionIndex: number;
    chars: number;
};
const presetRows = computed(() => {
    const sections = Array.isArray(preset.value.sections) ? preset.value.sections : [];
    const rows: PresetQueueRow[] = sections.map((section, index) => ({
        ...section,
        previewId: section.id || `preset-section-${index}`,
        previewLabel: section.label || `条目 ${index + 1}`,
        previewPlacement: placementLabels[section.placement || 'beforeHistory'] || section.placement || '历史前',
        sectionIndex: index,
        enabled: section.enabled !== false,
        chars: 0,
    }));
    return rows
        .map((row) => ({
            ...row,
            content: String(row.content || ''),
            chars: String(row.content || '').length,
        }))
        .filter((row) => row.content || row.enabled === false);
});
const selectedPresetPreviewRow = computed(() => (
    presetRows.value.find((row) => row.previewId === selectedPresetSourceId.value)
    || presetRows.value[0]
    || null
));
const presetTotalChars = computed(() => presetRows.value
    .filter((row) => row.enabled !== false)
    .reduce((sum, row) => sum + row.chars, 0));

function snapshotPreset(value = preset.value) {
    return JSON.stringify(value || {});
}

async function refreshPresets() {
    userPresets.value = await listUserTavernPresets();
    const activeId = await getActiveTavernPresetId();
    const loaded = await loadActiveTavernPreset();
    preset.value = loaded;
    activePresetId.value = loaded.id || activeId || DEFAULT_XB_TAVERN_PRESET_ID;
    savedPresetJson.value = snapshotPreset(loaded);
    if (activeId !== activePresetId.value) {
        await setActiveTavernPresetId(activePresetId.value);
    }
}

async function deriveDefaultPreset() {
    const record = await deriveAndActivateDefaultTavernPreset();
    activePresetId.value = record.id;
    preset.value = record.preset;
    await refreshPresets();
    presetStatus.value = '已复制默认预设，可以开始编辑。';
}

async function selectPreset(presetId: string) {
    await setActiveTavernPresetId(presetId);
    activePresetId.value = presetId || DEFAULT_XB_TAVERN_PRESET_ID;
    preset.value = await loadActiveTavernPreset();
    savedPresetJson.value = snapshotPreset(preset.value);
    selectedPresetSourceId.value = '';
    presetStatus.value = presetIsBuiltIn.value ? '当前使用默认预设，需复制后编辑。' : '已切换到你的预设。';
}

async function saveCurrentPreset() {
    if (presetIsBuiltIn.value) {
        presetStatus.value = '默认预设需复制后编辑。';
        return;
    }
    const record = await saveTavernPreset(preset.value);
    await setActiveTavernPresetId(record.id);
    activePresetId.value = record.id;
    preset.value = record.preset;
    savedPresetJson.value = snapshotPreset(record.preset);
    await refreshPresets();
    presetStatus.value = '规则已保存。';
}

async function resetToBuiltInPreset() {
    await setActiveTavernPresetId(DEFAULT_XB_TAVERN_PRESET_ID);
    activePresetId.value = DEFAULT_XB_TAVERN_PRESET_ID;
    preset.value = createDefaultXbTavernPreset();
    savedPresetJson.value = snapshotPreset(preset.value);
    selectedPresetSourceId.value = '';
    presetStatus.value = '已恢复默认预设。';
}

function updatePresetSection(index: number, patch: Partial<XbTavernPresetSection>) {
    if (presetIsBuiltIn.value) {return;}
    const sections = [...(preset.value.sections || [])];
    sections[index] = {
        ...sections[index],
        ...patch,
    };
    preset.value = {
        ...preset.value,
        sections,
    };
}

function updatePresetMeta(patch: Partial<typeof preset.value>) {
    if (presetIsBuiltIn.value) {return;}
    preset.value = {
        ...preset.value,
        ...patch,
    };
}

function addPresetSection() {
    if (presetIsBuiltIn.value) {return;}
    const sections = [...(preset.value.sections || [])];
    const id = `custom-section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    sections.push({
        id,
        label: `条目 ${sections.length + 1}`,
        locked: false,
        enabled: true,
        placement: 'beforeHistory',
        role: 'system',
        content: '',
    });
    preset.value = {
        ...preset.value,
        sections,
    };
    selectedPresetSourceId.value = id;
}

function movePresetSection(index: number, direction: -1 | 1) {
    if (presetIsBuiltIn.value) {return;}
    const sections = [...(preset.value.sections || [])];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= sections.length) {return;}
    const [section] = sections.splice(index, 1);
    sections.splice(nextIndex, 0, section);
    preset.value = {
        ...preset.value,
        sections,
    };
}

function removePresetSection(index: number) {
    if (presetIsBuiltIn.value) {return;}
    const sections = [...(preset.value.sections || [])];
    const removedId = sections[index]?.id || '';
    sections.splice(index, 1);
    preset.value = {
        ...preset.value,
        sections,
    };
    if (selectedPresetSourceId.value === removedId) {
        selectedPresetSourceId.value = '';
    }
}

async function discardPresetChanges() {
    if (presetIsBuiltIn.value || !presetDirty.value) {return;}
    preset.value = await loadActiveTavernPreset();
    savedPresetJson.value = snapshotPreset(preset.value);
    selectedPresetSourceId.value = '';
    presetStatus.value = '已放弃未保存的改动。';
}

function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error || 'unknown_error');
}

function postToHost(type: string, payload: Record<string, unknown> = {}) {
    window.parent?.postMessage({ source: SOURCE_APP, type, payload }, window.location.origin);
}

function createHostRequestId(prefix = 'host') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestHost(type: string, payload: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}) {
    const requestId = createHostRequestId();
    postToHost(type, { ...payload, requestId });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pendingHostRequests.delete(requestId);
            reject(new Error('host_request_timeout'));
        }, Number(options.timeoutMs) || HOST_REQUEST_TIMEOUT_MS);
        pendingHostRequests.set(requestId, { resolve, reject, timer });
    });
}

function resolveHostRequest(payload: Record<string, unknown> = {}) {
    const requestId = String(payload.requestId || '');
    const pending = pendingHostRequests.get(requestId);
    if (!pending) {return;}
    window.clearTimeout(pending.timer);
    pendingHostRequests.delete(requestId);
    if (payload.ok === false) {
        pending.reject(new Error(String(payload.error || 'host_request_failed')));
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
    availableCharacters.value = payload.availableCharacters as TavernCharacterOption[] || availableCharacters.value;
    selectedCharacterId.value = String(payload.selectedCharacterId || context.value.character?.id || selectedCharacterId.value || '');
    statusText.value = usingLockedSessionContext.value
        ? `${diagnostics.value.message || '宿主资料已加载'}；当前会话仍使用锁定资料。`
        : diagnostics.value.message || '宿主资料已加载';
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
}

function refreshCharacterList() {
    statusText.value = '正在读取角色列表';
    pendingCharacterError.value = '';
    postToHost('xb-tavern:refresh-context', {});
}

async function refreshSessions() {
    sessions.value = await listTavernSessions();
    selectedSessionId.value = await getSelectedTavernSessionId();
    if (!selectedSessionId.value && sessions.value[0]) {
        selectedSessionId.value = sessions.value[0].id;
        await setSelectedTavernSessionId(selectedSessionId.value);
    }
    sessionMessages.value = selectedSessionId.value ? await listTavernMessages(selectedSessionId.value) : [];
    await refreshManagerRecords(selectedSessionId.value);
}

async function refreshManagerRecords(sessionId = selectedSessionId.value) {
    const id = String(sessionId || '').trim();
    if (!id) {
        turnSummaries.value = [];
        episodeSummaries.value = [];
        managerRuns.value = [];
        memoryFiles.value = [];
        memoryIndex.value = null;
        selectedMemoryFilePath.value = '';
        return;
    }
    const [turns, episodes, runs, files, index] = await Promise.all([
        listTavernTurnSummaries(id),
        listTavernEpisodeSummaries(id),
        listTavernManagerRuns(id, { limit: 18 }),
        listTavernMemoryFiles(id, { includeStale: true }),
        getTavernMemoryIndex(id),
    ]);
    if (id !== selectedSessionId.value) {return;}
    turnSummaries.value = turns;
    episodeSummaries.value = episodes.reverse();
    managerRuns.value = runs;
    memoryFiles.value = files;
    memoryIndex.value = index;
    if (!files.some((file) => file.path === selectedMemoryFilePath.value)) {
        selectedMemoryFilePath.value = files[0]?.path || '';
    }
}

async function rebuildSelectedSessionRuntimeState(messages: TavernMessageRecord[] = sessionMessages.value) {
    if (!selectedSessionId.value) {return;}
    const state = deriveTavernSessionStateFromMessages({
        messages,
        contextSnapshot: selectedSession.value?.contextSnapshot || context.value,
        preset: preset.value,
        historyMode: historyMode.value,
        diagnostics: diagnostics.value,
    });
    await replaceTavernSessionState(selectedSessionId.value, state);
    await refreshSessions();
}

function resetSessionPreviewState() {
    currentUserMessage.value = '';
    runtimeText.value = '';
    runtimeError.value = '';
    runtimeSnapshotJson.value = '';
}

async function appendFirstMessageIfPresent(sessionId: string, snapshotContext: XbTavernContext) {
    const firstMessage = String(snapshotContext.character?.firstMessage || snapshotContext.character?.first_mes || '').trim();
    if (!firstMessage) {return;}
    await appendTavernMessage(sessionId, {
        role: 'assistant',
        name: String(snapshotContext.character?.name || ''),
        content: firstMessage,
        contextSnapshot: snapshotContext,
        presetId: String(preset.value.id || activePresetId.value || ''),
        presetName: String(preset.value.name || ''),
    });
}

async function createSessionFromContext(options: { includeFirstMessage?: boolean } = {}) {
    const snapshotContext = context.value;
    const snapshotBrain = buildXbTavernBrain({
        context: snapshotContext,
        preset: preset.value,
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
        presetId: String(preset.value.id || activePresetId.value || ''),
        presetName: String(preset.value.name || ''),
        state: {
            turn: 0,
            worldEntryStates: {},
        },
    });
    if (options.includeFirstMessage !== false) {
        await appendFirstMessageIfPresent(session.id, snapshotContext);
    }
    selectedSessionId.value = session.id;
    await refreshSessions();
    return session;
}

async function createSessionAndOpenChat() {
    await createSessionFromContext();
    activeView.value = 'chat';
    chatFocus.value = 'balanced';
}

async function handleHomePrimaryAction() {
    if (selectedSessionId.value) {
        openChatView();
        return;
    }
    openCharacterSelect();
}

async function handleHomeNewSession() {
    openCharacterSelect();
}

function clearPendingCharacterSession() {
    if (pendingCharacterSessionTimer) {
        window.clearTimeout(pendingCharacterSessionTimer);
        pendingCharacterSessionTimer = null;
    }
    pendingCharacterSessionId.value = '';
}

async function finishPendingCharacterSession() {
    const targetId = pendingCharacterSessionId.value;
    if (!targetId) {return;}
    const currentId = String(context.value.character?.id || selectedCharacterId.value || '').trim();
    if (currentId !== targetId) {return;}
    if (!context.value.character?.name) {
        clearPendingCharacterSession();
        pendingCharacterError.value = '没有读到这张角色卡。';
        return;
    }
    clearPendingCharacterSession();
    pendingCharacterError.value = '';
    resetSessionPreviewState();
    await createSessionAndOpenChat();
}

async function selectCharacterAndCreateSession(characterId: string) {
    const targetId = String(characterId || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    selectedSessionId.value = '';
    sessionMessages.value = [];
    await setSelectedTavernSessionId('');
    await refreshManagerRecords('');
    resetSessionPreviewState();
    selectedCharacterId.value = targetId;
    pendingCharacterError.value = '';
    statusText.value = '正在读取角色卡';
    pendingCharacterSessionId.value = targetId;
    if (pendingCharacterSessionTimer) {window.clearTimeout(pendingCharacterSessionTimer);}
    pendingCharacterSessionTimer = window.setTimeout(() => {
        if (pendingCharacterSessionId.value !== targetId) {return;}
        clearPendingCharacterSession();
        pendingCharacterError.value = '读取角色卡超时。';
    }, CHARACTER_CONTEXT_TIMEOUT_MS);
    postToHost('xb-tavern:refresh-context', { characterId: targetId, includeHistory: false });
}

async function refreshSelectedSessionSnapshot() {
    if (!selectedSessionId.value) {return;}
    const snapshotContext = context.value;
    const snapshotBrain = buildXbTavernBrain({
        context: snapshotContext,
        preset: preset.value,
        currentUserMessage: currentUserMessage.value,
        historyMode: historyMode.value,
        turn: sessionRuntimeState.value.turn,
        entryStates: sessionRuntimeState.value.worldEntryStates,
        diagnostics: diagnostics.value,
    });
    await updateTavernSessionSnapshot(selectedSessionId.value, {
        contextSnapshot: snapshotContext,
        buildSnapshot: snapshotBrain.buildSnapshot,
        presetId: String(preset.value.id || activePresetId.value || ''),
        presetName: String(preset.value.name || ''),
    });
    await refreshSessions();
}

async function selectSession(sessionId: string) {
    resetSessionPreviewState();
    selectedSessionId.value = sessionId;
    await setSelectedTavernSessionId(sessionId);
    sessionMessages.value = await listTavernMessages(sessionId);
    await refreshManagerRecords(sessionId);
    activeView.value = 'chat';
    chatFocus.value = 'balanced';
}

function openChatView() {
    activeView.value = 'chat';
    chatFocus.value = 'balanced';
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
    simulateRequestStatus.value = '模拟中';
    try {
        const result = await simulateXbTavernRequest({
            sessionId: selectedSessionId.value,
            agentConfig: agentConfig.value,
            contextSnapshot: context.value,
            preset: preset.value,
            currentUserMessage: messageText,
            runtimeState: normalizeTavernSessionState(selectedSession.value?.state || {}),
            diagnostics: diagnostics.value,
            historyMode: historyMode.value,
        });
        simulateRequestJson.value = result.requestSnapshot.rawRequestJson || result.requestSnapshot.rawMessagesJson || '';
        simulateRequestStatus.value = `模拟完成 · ${result.requestSnapshot.providerLabel || result.provider} / ${result.model || '未选择模型'}`;
    } catch (error) {
        simulateRequestStatus.value = '';
        simulateRequestError.value = error instanceof Error ? error.message : String(error || 'simulate_failed');
    }
}

function shortText(value = '', limit = 180) {
    const text = String(value || '').trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function statusLabel(status = '') {
    const labels: Record<string, string> = {
        activated: '本次会带上',
        budget_skipped: '超出预算，未带上',
        not_matched: '本次未带上',
        secondary_not_matched: '二级关键词不满足',
        disabled: '已禁用',
        suppressed_by_decorator: '装饰器抑制',
        cooldown: '冷却中',
        delay: '延迟中',
        probability_failed: '概率判定未带上',
    };
    return labels[status] || status || '未知';
}

function managerStatusLabel(status = '') {
    const labels: Record<string, string> = {
        queued: '排队',
        running: '运行中',
        completed: '完成',
        failed: '失败',
    };
    return labels[status] || status || '未知';
}

function formatManagerSource(run: TavernManagerRunRecord) {
    return `第 ${run.turn || 0} 轮 · ${run.userOrder}/${run.assistantOrder}`;
}

function formatSummarySource(summary: TavernTurnSummaryRecord) {
    return `第 ${summary.turn || 0} 轮 · ${summary.userOrder}/${summary.assistantOrder}`;
}

function formatRunModelLine(run: TavernManagerRunRecord) {
    const provider = String(run.provider || '').trim();
    const model = String(run.model || '').trim();
    return [provider, model].filter(Boolean).join(' / ') || '未记录模型';
}

function memoryFileStatusLabel(status = '') {
    return status === 'stale' ? '过期' : '可用';
}

function formatMemoryFileMeta(file: TavernMemoryFileRecord) {
    return `${memoryFileStatusLabel(file.status)} · ${Math.max(0, String(file.content || '').length)} 字`;
}

function formatDebugJson(value: unknown) {
    try {
        return JSON.stringify(value ?? null, null, 2);
    } catch {
        return String(value || '');
    }
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
        });
        managerActionStatus.value = result.ok ? '' : `失败：${result.error || 'manager_retry_failed'}`;
    } catch (error) {
        managerActionStatus.value = error instanceof Error ? error.message : String(error || 'manager_retry_failed');
    } finally {
        await refreshManagerRecords();
    }
}

function candidateReason(entry: { status?: string; activationReason?: string; budgetShortfall?: number; budgetRemainingBefore?: number; matchedKeys?: string[]; matchedSecondaryKeys?: string[] }) {
    if (entry.status === 'activated') {
        const matched = [
            ...(entry.matchedKeys || []),
            ...(entry.matchedSecondaryKeys || []),
        ].filter(Boolean);
        if (matched.length) {return `触发关键词：${matched.join(', ')}`;}
        if (entry.activationReason === 'constant') {return '常驻条目，本次固定带上';}
        if (entry.activationReason === 'decorator') {return '装饰器要求本次带上';}
        if (entry.activationReason === 'sticky') {return '粘滞状态，本次继续带上';}
        return '本次会带上';
    }
    if (entry.status === 'budget_skipped') {
        const shortfall = Number(entry.budgetShortfall) || 0;
        return shortfall > 0 ? `预算不足，差 ${shortfall} 字` : '预算跳过';
    }
    return statusLabel(entry.status || '');
}

function roleLabel(role = '') {
    const labels: Record<string, string> = {
        system: '规则',
        user: '你',
        assistant: '角色',
        tool: '工具结果',
    };
    return labels[role] || role || '未知';
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

function enhanceChatMarkdown() {
    const root = chatScrollRef.value;
    if (!root?.querySelectorAll) {return;}
    root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
        const signature = node.dataset.markdownSignature || '';
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

function canEditMessage(message: TavernMessageRecord) {
    return !isRunning.value && !message.error && ['user', 'assistant'].includes(message.role);
}

function isEditingMessage(message: TavernMessageRecord) {
    return editingMessageKey.value === messageKey(message);
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

function actionFeedback(message: TavernMessageRecord, action: string) {
    return messageActionFeedback.value[`${messageKey(message)}:${action}`] || '';
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
        // Fall through to the legacy path.
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

function cancelEditMessage() {
    editingMessageKey.value = '';
    editingMessageDraft.value = '';
}

function autoSizeTextarea(textarea: HTMLTextAreaElement | null) {
    if (!textarea) {return;}
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 144), 420)}px`;
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

function handleEditInput(event: Event) {
    autoSizeTextarea(event.target as HTMLTextAreaElement);
}

function handleComposeInput(event: Event) {
    autoSizeTextarea(event.target as HTMLTextAreaElement);
}

async function saveEditMessage(message: TavernMessageRecord, options: { rerun?: boolean } = {}) {
    if (!canEditMessage(message)) {return;}
    const content = editingMessageDraft.value.trim();
    if (!content) {
        flashMessageAction(message, 'edit', false);
        return;
    }
    const updated = await updateTavernMessage(message.sessionId, message.order, { content });
    if (updated) {
        await markTavernMemoryStaleFromOrder(message.sessionId, message.order);
    }
    if (updated && selectedSessionId.value) {
        sessionMessages.value = await listTavernMessages(selectedSessionId.value);
        await refreshManagerRecords(selectedSessionId.value);
    }
    cancelEditMessage();
    flashMessageAction(updated || message, 'edit', !!updated);
    if (updated && options.rerun) {
        await rerunFromMessage(updated);
    } else if (updated) {
        await rebuildSelectedSessionRuntimeState();
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
    const deleted = await deleteTavernMessages(message.sessionId, findDeleteOrders(message));
    if (deleted > 0) {
        await markTavernMemoryStaleFromOrder(message.sessionId, message.order);
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
    if (isRunning.value) {return;}
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
    await deleteTavernMessages(userMessage.sessionId, ordersToDelete);
    await markTavernMemoryStaleFromOrder(userMessage.sessionId, userMessage.order);
    if (selectedSessionId.value) {
        sessionMessages.value = await listTavernMessages(selectedSessionId.value);
        await refreshManagerRecords(selectedSessionId.value);
    }
    flashMessageAction(message, 'rerun', true);
    await runOnce({
        messageText: userMessage.content,
        reuseUserMessageOrder: userMessage.order,
    });
}

function insertionTargetLabel(target = '') {
    const text = String(target || '');
    const exact: Record<string, string> = {
        'before character card': '角色卡前',
        'after character card': '角色卡后',
        'author note top': '作者备注前段',
        'author note bottom': '作者备注后段',
        'example messages top': '示例对话前段',
        'example messages bottom': '示例对话后段',
    };
    if (exact[text]) {return exact[text];}
    if (text.startsWith('history depth ')) {
        return `插入历史第 ${text.replace('history depth ', '')} 层`;
    }
    if (text.startsWith('outlet:')) {
        return `自定义出口：${text.replace('outlet:', '')}`;
    }
    return text || '未指定位置';
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

function scheduleHideChatScrollHelpers() {
    chatScrollControlsActive.value = true;
    if (chatScrollHideTimer) {
        window.clearTimeout(chatScrollHideTimer);
    }
    chatScrollHideTimer = window.setTimeout(() => {
        chatScrollControlsActive.value = false;
        chatScrollHideTimer = null;
    }, 1500);
}

function isChatNearBottom() {
    const node = chatScrollRef.value;
    if (!node) {return true;}
    return node.scrollHeight - node.scrollTop - node.clientHeight <= 56;
}

function scrollChatToBottom(force = false) {
    if (!force && !chatAutoScroll.value) {return;}
    if (force) {chatAutoScroll.value = true;}
    void nextTick(() => {
        const node = chatScrollRef.value;
        if (!node) {return;}
        node.scrollTop = node.scrollHeight;
        requestAnimationFrame(() => {
            node.scrollTop = node.scrollHeight;
            updateChatScrollButtons();
            scheduleHideChatScrollHelpers();
        });
    });
}

function scrollChatToTop() {
    const node = chatScrollRef.value;
    if (!node) {return;}
    chatAutoScroll.value = false;
    chatLastScrollTop = 0;
    node.scrollTop = 0;
    updateChatScrollButtons();
    scheduleHideChatScrollHelpers();
}

function handleChatScroll() {
    const node = chatScrollRef.value;
    if (!node) {return;}
    const currentScrollTop = Number(node.scrollTop || 0);
    const scrollingTowardBottom = currentScrollTop > chatLastScrollTop;
    chatLastScrollTop = currentScrollTop;
    const nearBottom = isChatNearBottom();
    if (nearBottom) {
        if (chatAutoScroll.value !== false || scrollingTowardBottom) {
            chatAutoScroll.value = true;
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

function handleChatWheel(event: WheelEvent) {
    if (Number(event.deltaY || 0) < 0) {
        chatAutoScroll.value = false;
    }
}

function handleChatTouchStart(event: TouchEvent) {
    chatTouchStartY = Number(event.touches?.[0]?.clientY);
}

function handleChatTouchMove(event: TouchEvent) {
    const currentY = Number(event.touches?.[0]?.clientY);
    if (!Number.isFinite(Number(chatTouchStartY)) || !Number.isFinite(currentY)) {
        chatAutoScroll.value = false;
        return;
    }
    if (chatTouchStartY !== null && currentY > chatTouchStartY + 4) {
        chatAutoScroll.value = false;
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

function cancelActiveRun() {
    activeRunController.value?.abort();
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

async function runOnce(options: { messageText?: string; reuseUserMessageOrder?: number } = {}) {
    if (isRunning.value) {
        cancelActiveRun();
        return;
    }
    const messageText = String(options.messageText ?? currentUserMessage.value ?? '').trim();
    if (!messageText) {
        runtimeError.value = '先写一句话。';
        return;
    }
    if (!selectedSessionId.value) {
        await createSessionFromContext();
    }
    const controller = new AbortController();
    activeRunController.value = controller;
    runtimeError.value = '';
    runtimeText.value = '';
    runtimeProvider.value = '';
    runtimeModel.value = '';
    runtimeSnapshotJson.value = JSON.stringify({
        status: 'running',
    }, null, 2);
    isRunning.value = true;
    chatAutoScroll.value = true;
    try {
        const result = await runXbTavernTurn({
            sessionId: selectedSessionId.value,
            agentConfig: agentConfig.value,
            contextSnapshot: context.value,
            preset: preset.value,
            currentUserMessage: messageText,
            runtimeState: normalizeTavernSessionState(selectedSession.value?.state || {}),
            diagnostics: diagnostics.value,
            historyMode: historyMode.value,
            signal: controller.signal,
            reuseUserMessageOrder: options.reuseUserMessageOrder,
            runManager: true,
            onStreamProgress: (snapshot) => {
                if (typeof snapshot.text === 'string') {runtimeText.value = snapshot.text;}
            },
            onUserMessageSaved: async (sessionId, message) => {
                selectedSessionId.value = sessionId;
                await setSelectedTavernSessionId(sessionId);
                const exists = sessionMessages.value.some((item) => item.sessionId === message.sessionId && item.order === message.order);
                sessionMessages.value = exists ? sessionMessages.value : [...sessionMessages.value, message].sort((left, right) => left.order - right.order);
                currentUserMessage.value = '';
                await refreshSessions();
                scrollChatToBottom(true);
            },
            onAssistantMessageSaved: async (sessionId, message) => {
                selectedSessionId.value = sessionId;
                const exists = sessionMessages.value.some((item) => item.sessionId === message.sessionId && item.order === message.order);
                sessionMessages.value = exists ? sessionMessages.value : [...sessionMessages.value, message].sort((left, right) => left.order - right.order);
                await refreshSessions();
                scrollChatToBottom(true);
            },
            onManagerRunSaved: async (sessionId) => {
                await refreshManagerRecords(sessionId);
            },
        });
        selectedSessionId.value = result.sessionId;
        runtimeText.value = '';
        runtimeError.value = result.error || '';
        runtimeProvider.value = result.provider || '';
        runtimeModel.value = result.model || '';
        runtimeSnapshotJson.value = JSON.stringify({
            provider: result.provider || '',
            model: result.model || '',
            previewMatchesRequest: result.previewMatchesRequest,
            nextTurn: result.nextTurn,
            buildSnapshot: result.buildSnapshot,
            requestSnapshot: result.requestSnapshot,
            error: result.error || '',
        }, null, 2);
        await refreshSessions();
        await refreshManagerRecords(result.sessionId);
        scrollChatToBottom(true);
    } catch (error) {
        runtimeError.value = error instanceof Error ? error.message : String(error || 'run_failed');
    } finally {
        if (activeRunController.value === controller) {
            activeRunController.value = null;
        }
        isRunning.value = false;
        scrollChatToBottom(true);
    }
}

watch([
    () => chatMessages.value.length,
    () => chatMarkdownSignature.value,
    () => runtimeText.value,
    () => activeView.value,
], () => {
    if (activeView.value === 'chat') {
        scrollChatToBottom();
        void nextTick(() => {
            enhanceChatMarkdown();
            updateChatScrollButtons();
        });
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
});

onMounted(async () => {
    // onHostMessage validates origin and message source before accepting payloads.
    // eslint-disable-next-line no-restricted-syntax
    window.addEventListener('message', onHostMessage);
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
    postToHost('xb-tavern:frame-ready');
});

onUnmounted(() => {
    window.removeEventListener('message', onHostMessage);
    setHostChatCompletionsRequestHeadersProvider(null);
    pendingHostRequests.forEach((request) => {
        window.clearTimeout(request.timer);
        request.reject(new Error('tavern_unmounted'));
    });
    pendingHostRequests.clear();
    activeRunController.value?.abort();
    if (chatScrollHideTimer) {
        window.clearTimeout(chatScrollHideTimer);
        chatScrollHideTimer = null;
    }
    clearPendingCharacterSession();
});
</script>

<template>
  <main class="xb-tavern xb-os-shell">
    <aside class="xb-os-rail">
      <button
        class="rail-brand"
        type="button"
        title="首页"
        @click="activeView = 'home'"
      >
        <span>XB</span>
        <strong>小白酒馆</strong>
      </button>
      <nav
        class="rail-nav"
        aria-label="页面"
      >
        <button
          type="button"
          :class="{ active: activeView === 'home' || activeView === 'characters' }"
          @click="activeView = 'home'"
        >
          <span>01</span>
          首页
        </button>
        <button
          type="button"
          :class="{ active: activeView === 'chat' }"
          @click="openChatView"
        >
          <span>02</span>
          聊天
        </button>
        <button
          type="button"
          :class="{ active: activeView === 'settings' }"
          @click="activeView = 'settings'"
        >
          <span>03</span>
          设置
        </button>
      </nav>
      <span
        class="mobile-settings-label"
        aria-hidden="true"
      >设置</span>
      <div class="rail-status">
        <span>{{ apiReady ? 'READY' : 'SETUP' }}</span>
        <strong>{{ characterName }}</strong>
        <small>{{ chatReadyLabel }}</small>
      </div>
      <button
        class="rail-close"
        type="button"
        title="关闭"
        aria-label="关闭"
        @click="postToHost('xb-tavern:close')"
      >
        ×
      </button>
    </aside>

    <section class="xb-os-stage">
      <section
        v-if="activeView === 'home'"
        class="tavern-home xb-page home-command-center"
      >
        <div class="home-hero home-command-hero">
          <div class="home-brand-panel">
            <div class="home-brand-mark">
              XB
            </div>
            <p class="eyebrow">
              角色共演
            </p>
            <h2>{{ hasCharacter ? characterName : '选择角色' }}</h2>
            <p>
              {{ selectedSessionId ? selectedSessionTitle : '选择角色，开一段新的对话。' }}
            </p>
            <div class="home-metric-strip">
              <span>
                <strong>{{ sessions.length }}</strong>
                会话
              </span>
              <span>
                <strong>{{ worldBookCount }}</strong>
                世界书
              </span>
              <span>
                <strong>{{ apiReady ? 'OK' : 'SET' }}</strong>
                API
              </span>
            </div>
          </div>
          <div class="home-command-panel">
            <button
              type="button"
              class="home-action-main"
              @click="handleHomePrimaryAction"
            >
              <strong>{{ selectedSessionId ? '继续聊天' : '选择角色' }}</strong>
              <span>{{ selectedSessionId ? selectedSessionTitle : `${characterCards.length} 张角色卡可选` }}</span>
            </button>
            <button
              type="button"
              class="home-action-main"
              @click="handleHomeNewSession"
            >
              <strong>新开会话</strong>
              <span>先选角色卡</span>
            </button>
          </div>
        </div>

        <section class="session-board home-session-board">
          <div class="panel-head">
            <div>
              <h2>最近会话</h2>
            </div>
            <button
              type="button"
              @click="handleHomeNewSession"
            >
              新开会话
            </button>
          </div>
          <div class="home-session-list">
            <button
              v-for="session in sessions"
              :key="session.id"
              type="button"
              :class="{ active: session.id === selectedSessionId }"
              @click="selectSession(session.id)"
            >
              <strong>{{ session.title }}</strong>
              <small>{{ session.characterName || '未选择角色' }}</small>
            </button>
            <p
              v-if="!sessions.length"
              class="muted"
            >
              还没有会话。
            </p>
          </div>
        </section>
      </section>

      <section
        v-if="activeView === 'characters'"
        class="xb-page character-select-page"
      >
        <header class="character-select-head">
          <button
            type="button"
            class="ghost-link"
            @click="activeView = 'home'"
          >
            返回首页
          </button>
          <div>
            <p class="eyebrow">
              角色
            </p>
            <h2>选择角色卡</h2>
            <p>选中一张角色卡后，会用它的角色资料和世界书创建新的独立会话。</p>
          </div>
          <button
            type="button"
            @click="refreshCharacterList"
          >
            刷新列表
          </button>
        </header>

        <div
          v-if="pendingCharacterError"
          class="character-select-error"
        >
          {{ pendingCharacterError }}
        </div>

        <section
          v-if="characterCards.length"
          class="character-card-grid"
        >
          <button
            v-for="character in characterCards"
            :key="character.id"
            type="button"
            class="character-card-option"
            :class="{
              current: character.id === liveCharacterId,
              pending: character.id === pendingCharacterSessionId,
            }"
            :disabled="!!pendingCharacterSessionId"
            @click="selectCharacterAndCreateSession(character.id)"
          >
            <span class="character-card-avatar">
              <img
                v-if="character.avatar"
                :src="character.avatar"
                alt=""
              >
              <span v-else>{{ character.name.slice(0, 1) }}</span>
            </span>
            <span class="character-card-body">
              <span class="character-card-title">
                <strong>{{ character.name }}</strong>
                <small v-if="character.id === liveCharacterId">当前</small>
                <small v-if="character.id === pendingCharacterSessionId">读取中</small>
              </span>
              <span class="character-card-desc">
                {{ shortText(character.description || character.personality || character.scenario || character.firstMessage || '没有卡面摘要。', 150) }}
              </span>
            </span>
          </button>
        </section>

        <section
          v-else
          class="character-empty"
        >
          <h2>没有读到角色卡</h2>
          <p>请先在酒馆里加载角色，再刷新列表。</p>
          <button
            type="button"
            @click="refreshCharacterList"
          >
            刷新列表
          </button>
        </section>
      </section>

      <section
        v-if="activeView === 'chat'"
        class="tavern-chat xb-page"
        :class="`chat-focus-${chatFocus}`"
      >
        <aside class="chat-side">
          <section class="chat-profile">
            <div class="avatar-orb">
              <img
                v-if="characterAvatar"
                :src="characterAvatar"
                alt=""
              >
              <span v-else>{{ characterName.slice(0, 1) }}</span>
            </div>
            <div>
              <p class="eyebrow">
                角色
              </p>
              <h2>{{ characterName }}</h2>
              <p>{{ contextSourceTitle }}</p>
            </div>
          </section>

          <section class="chat-side-block">
            <div class="side-stat">
              <span>状态</span>
              <strong>{{ chatReadyLabel }}</strong>
            </div>
            <div class="side-stat">
              <span>轮次</span>
              <strong>第 {{ sessionRuntimeState.turn || 0 }} 轮</strong>
            </div>
            <div class="side-stat">
              <span>位置</span>
              <strong>未记录</strong>
            </div>
          </section>

          <section class="chat-map-panel">
            <strong>场景</strong>
            <div class="map-placeholder">
              <span>未记录</span>
            </div>
          </section>

          <section
            v-if="usingLockedSessionContext"
            class="chat-lock-note"
          >
            <strong>会话资料已锁定</strong>
            <span>角色卡或世界书改动后，需要手动刷新当前会话。</span>
            <button
              type="button"
              @click="refreshSelectedSessionSnapshot"
            >
              刷新会话资料
            </button>
          </section>

          <section class="chat-side-block">
            <div class="side-block-head">
              <strong>会话</strong>
              <button
                type="button"
                @click="handleHomeNewSession"
              >
                新建
              </button>
            </div>
            <div class="session-list">
              <button
                v-for="session in chatSidebarSessions"
                :key="session.id"
                type="button"
                :class="{ active: session.id === selectedSessionId }"
                @click="selectSession(session.id)"
              >
                <strong>{{ session.title }}</strong>
                <small>{{ session.characterName || '未选择角色' }}</small>
              </button>
              <button
                v-if="sessions.length > chatSidebarSessions.length"
                type="button"
                class="session-more"
                @click="activeView = 'home'"
              >
                查看全部会话
              </button>
              <p
                v-if="!chatSidebarSessions.length"
                class="muted compact"
              >
                当前角色还没有其他会话。
              </p>
            </div>
          </section>
        </aside>

        <section class="chat-main">
          <header class="chat-head">
            <div>
              <p class="eyebrow">
                {{ chatReadyLabel }}
              </p>
              <h2>{{ selectedSessionTitle }}</h2>
              <p>{{ chatSubtitle }}</p>
            </div>
            <div class="chat-head-actions">
              <button
                type="button"
                class="prompt-inspector-trigger"
                @click="openPromptInspector('history')"
              >
                API 请求
              </button>
              <div
                class="mobile-chat-focus-switch"
                aria-label="聊天视图"
              >
                <button
                  type="button"
                  :class="{ active: chatFocus !== 'manager' }"
                  @click="chatFocus = 'balanced'"
                >
                  聊天
                </button>
                <button
                  type="button"
                  :class="{ active: chatFocus === 'manager' }"
                  @click="chatFocus = 'manager'"
                >
                  记忆
                </button>
              </div>
            </div>
          </header>
          <div
            ref="chatScrollRef"
            class="chat-scroll"
            @scroll="handleChatScroll"
            @wheel.passive="handleChatWheel"
            @touchstart.passive="handleChatTouchStart"
            @touchmove.passive="handleChatTouchMove"
          >
            <div
              v-for="message in chatMessages"
              :key="`${message.sessionId}-${message.order}`"
              class="chat-bubble"
              :class="[
                message.role === 'user' ? 'from-user' : 'from-assistant',
                { 'is-error': message.error },
              ]"
            >
              <div class="bubble-meta">
                <span>{{ message.error ? '错误' : roleLabel(message.role) }}</span>
                <small>{{ formatMessageTime(message.createdAt) }}</small>
              </div>
              <div
                v-if="isEditingMessage(message)"
                class="message-edit-panel"
              >
                <textarea
                  v-model="editingMessageDraft"
                  class="message-edit-box"
                  rows="6"
                  :data-message-editor="messageKey(message)"
                  @input="handleEditInput"
                  @keydown="handleEditKeydown($event, message)"
                />
                <div class="message-edit-actions">
                  <button
                    type="button"
                    @click="saveEditMessage(message)"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    @click="saveEditMessage(message, { rerun: true })"
                  >
                    保存并重跑
                  </button>
                  <button
                    type="button"
                    @click="cancelEditMessage"
                  >
                    取消
                  </button>
                </div>
              </div>
              <div
                v-else
                class="xb-tavern-markdown"
                :data-markdown-signature="markdownSignature(message.content)"
                v-html="renderChatMarkdown(message.content)"
              />
              <div
                v-if="!isEditingMessage(message)"
                class="message-actions"
              >
                <button
                  type="button"
                  :class="actionFeedback(message, 'copy')"
                  title="复制"
                  aria-label="复制"
                  @click="copyMessage(message)"
                >
                  ⧉
                </button>
                <button
                  type="button"
                  :disabled="!canEditMessage(message)"
                  :class="actionFeedback(message, 'edit')"
                  title="编辑"
                  aria-label="编辑"
                  @click="startEditMessage(message)"
                >
                  ✎
                </button>
                <button
                  type="button"
                  :disabled="isRunning"
                  :class="actionFeedback(message, 'rerun')"
                  title="重新生成"
                  aria-label="重新生成"
                  @click="rerunFromMessage(message)"
                >
                  ↻
                </button>
                <button
                  type="button"
                  :disabled="isRunning"
                  :class="actionFeedback(message, 'delete')"
                  title="删除"
                  aria-label="删除"
                  @click="deleteMessageTurn(message)"
                >
                  ⌫
                </button>
              </div>
            </div>
            <div
              v-if="isRunning && runtimeText"
              class="chat-bubble from-assistant streaming"
            >
              <div class="bubble-meta">
                <span>角色</span>
                <small>生成中</small>
              </div>
              <div
                class="xb-tavern-markdown"
                :data-markdown-signature="markdownSignature(runtimeText)"
                v-html="renderChatMarkdown(runtimeText)"
              />
            </div>
            <div
              v-if="isRunning && !runtimeText"
              class="chat-bubble from-assistant streaming thinking"
            >
              <div class="bubble-meta">
                <span>角色</span>
                <small>生成中</small>
              </div>
              <p>正在组织回复...</p>
            </div>
            <p
              v-if="!chatMessages.length && !isRunning"
              class="chat-empty"
            >
              写一句话，开始。
            </p>
            <div
              class="chat-scroll-helpers"
              :class="{ active: chatScrollControlsActive }"
            >
              <button
                type="button"
                :class="{ visible: showChatScrollTop }"
                title="回到顶部"
                aria-label="回到顶部"
                @click="scrollChatToTop"
              >
                ▲
              </button>
              <button
                type="button"
                :class="{ visible: showChatScrollBottom }"
                title="回到底部"
                aria-label="回到底部"
                @click="scrollChatToBottom(true)"
              >
                ▼
              </button>
            </div>
          </div>
          <form
            class="chat-compose"
            @submit.prevent="handleChatSubmit"
          >
            <div
              v-if="latestErrorMessage"
              class="compose-error"
            >
              {{ latestErrorMessage }}
            </div>
            <textarea
              v-model="currentUserMessage"
              rows="3"
              placeholder="对角色说一句话..."
              :disabled="isRunning"
              @input="handleComposeInput"
              @keydown="handleComposeKeydown"
            />
            <button
              type="submit"
              class="primary-action"
              :disabled="!canSendMessage"
            >
              {{ isRunning ? '停止' : '发送' }}
            </button>
          </form>
        </section>

        <aside class="chat-manager">
          <header class="manager-head">
            <div>
              <p class="eyebrow">
                记忆
              </p>
              <h2>记忆管理</h2>
              <p>{{ managerStatusLine }}</p>
            </div>
            <div class="manager-head-actions">
              <div
                class="mobile-chat-focus-switch"
                aria-label="聊天视图"
              >
                <button
                  type="button"
                  :class="{ active: chatFocus !== 'manager' }"
                  @click="chatFocus = 'balanced'"
                >
                  聊天
                </button>
                <button
                  type="button"
                  :class="{ active: chatFocus === 'manager' }"
                  @click="chatFocus = 'manager'"
                >
                  记忆
                </button>
              </div>
              <button
                type="button"
                @click="refreshManagerRecords()"
              >
                刷新
              </button>
            </div>
          </header>

          <section class="manager-section">
            <div class="side-block-head">
              <strong>记忆档案</strong>
              <span>{{ activeMemoryFiles.length }}/{{ memoryFiles.length }}</span>
            </div>
            <p class="manager-index-line">
              {{ memoryIndexStatusLine }}
            </p>
            <div
              v-if="memoryFiles.length"
              class="memory-file-grid"
            >
              <div class="memory-file-list">
                <button
                  v-for="file in memoryFiles"
                  :key="file.path"
                  type="button"
                  :class="{ active: selectedMemoryFile?.path === file.path, stale: file.status === 'stale' }"
                  @click="selectedMemoryFilePath = file.path"
                >
                  <strong>{{ file.path }}</strong>
                  <span>{{ formatMemoryFileMeta(file) }}</span>
                </button>
              </div>
              <article
                v-if="selectedMemoryFile"
                class="manager-card memory-file-preview"
                :class="{ 'is-stale': selectedMemoryFile.status === 'stale' }"
              >
                <div class="manager-run-title">
                  <strong>{{ selectedMemoryFile.path }}</strong>
                  <small>{{ memoryFileStatusLabel(selectedMemoryFile.status) }}</small>
                </div>
                <div
                  class="xb-tavern-markdown memory-file-markdown"
                  :data-markdown-signature="markdownSignature(selectedMemoryFile.content)"
                  v-html="renderChatMarkdown(selectedMemoryFile.content)"
                />
                <details>
                  <summary>查看 Markdown 原文</summary>
                  <pre>{{ selectedMemoryFile.content }}</pre>
                </details>
              </article>
            </div>
            <p
              v-else
              class="muted compact"
            >
              还没有记忆档案。
            </p>
          </section>

          <section class="manager-section">
            <div class="side-block-head">
              <strong>阶段大总结</strong>
              <span>{{ episodeSummaries.length }}</span>
            </div>
            <article
              v-for="episode in episodeSummaries"
              :key="episode.id"
              class="manager-card"
            >
              <strong>{{ episode.title }}</strong>
              <small>第 {{ episode.startTurn }}-{{ episode.endTurn }} 轮</small>
              <p>{{ episode.summary || '暂无摘要。' }}</p>
              <p v-if="episode.unresolved?.length">
                未解决：{{ episode.unresolved.join('、') }}
              </p>
            </article>
            <p
              v-if="!episodeSummaries.length"
              class="muted compact"
            >
              还没有阶段大总结。
            </p>
          </section>

          <section class="manager-section">
            <div class="side-block-head">
              <strong>每轮小总结</strong>
              <span>{{ turnSummaries.length }}</span>
            </div>
            <article
              v-for="summary in recentTurnSummaries"
              :key="summary.id"
              class="manager-card"
            >
              <strong>{{ formatSummarySource(summary) }}</strong>
              <small>{{ summary.tags?.join('、') || '无标签' }}</small>
              <p>{{ summary.summary }}</p>
            </article>
            <p
              v-if="!turnSummaries.length"
              class="muted compact"
            >
              还没有小总结。
            </p>
          </section>

          <section class="manager-section">
            <div class="side-block-head">
              <strong>工作记录</strong>
              <span>{{ managerRuns.length }}</span>
            </div>
            <article
              v-for="run in managerRuns"
              :key="run.id"
              class="manager-card"
              :class="`is-${run.status}`"
            >
              <div class="manager-run-title">
                <strong>{{ managerStatusLabel(run.status) }}</strong>
                <small>{{ formatManagerSource(run) }}</small>
              </div>
              <p>{{ run.inputSummary }}</p>
              <small>{{ formatRunModelLine(run) }}</small>
              <p v-if="run.parsedAction">
                动作：{{ run.parsedAction }}
              </p>
              <p v-if="run.changedFiles?.length">
                文件：{{ run.changedFiles.join('、') }}
              </p>
              <details v-if="run.outputText">
                <summary>工作结论</summary>
                <pre>{{ run.outputText }}</pre>
              </details>
              <details v-if="run.toolTrace">
                <summary>改动记录</summary>
                <pre>{{ formatDebugJson(run.toolTrace) }}</pre>
              </details>
              <p v-if="run.error">
                {{ run.error }}
              </p>
              <button
                v-if="run.status === 'failed'"
                type="button"
                :disabled="managerBusy"
                @click="retryManagerRun(run)"
              >
                重试
              </button>
            </article>
            <p
              v-if="!managerRuns.length"
              class="muted compact"
            >
              还没有工作记录。
            </p>
          </section>
        </aside>
      </section>


      <section
        v-if="activeView === 'settings'"
        class="xb-layout xb-page settings-layout"
      >
        <aside class="xb-sidebar settings-sidebar">
          <div class="panel guide-card">
            <h2>设置</h2>
            <div class="guide-steps">
              <button
                type="button"
                class="guide-step"
                :class="{ active: activeSettingsWorkspace === 'api' }"
                @click="activeSettingsWorkspace = 'api'"
              >
                <strong>API 配置</strong>
                <span>模型预设</span>
              </button>
              <button
                type="button"
                class="guide-step"
                :class="{ active: activeSettingsWorkspace === 'preset' }"
                @click="activeSettingsWorkspace = 'preset'"
              >
                <strong>小白预设</strong>
                <span>规则</span>
              </button>
            </div>
          </div>
        </aside>

        <section class="xb-main">
          <div
            v-show="activeSettingsWorkspace === 'api'"
            class="panel step-panel api-workspace"
          >
            <div class="panel-head">
              <div>
                <h2>API 配置</h2>
                <p class="muted compact">
                  这里使用小白助手和电纸书同一套模型预设；保存后会立刻用于后续聊天。
                </p>
              </div>
              <span
                class="pill"
                :class="{ warning: !apiReady }"
              >
                {{ apiReady ? '可发模' : '需配置' }}
              </span>
            </div>
            <div
              class="what-to-check"
              :class="{ warning: !apiReady }"
            >
              <strong>当前模型：</strong>
              <span>{{ apiReady ? apiRuntimeLine : apiReadyDetail }}</span>
            </div>
            <div
              ref="apiSettingsRootRef"
              class="tavern-api-settings"
            />
          </div>

          <div
            v-show="activeSettingsWorkspace === 'preset'"
            class="panel step-panel preset-workspace"
          >
            <div class="panel-head preset-page-head">
              <div>
                <h2>小白预设</h2>
                <p class="muted compact">
                  聊天前写给模型的预设条目。
                </p>
              </div>
              <div class="panel-pills">
                <span
                  v-if="presetDirty"
                  class="pill warning"
                >未保存</span>
                <span
                  class="pill"
                  :class="{ warning: presetIsBuiltIn }"
                >{{ presetIsBuiltIn ? '只读' : '可编辑' }}</span>
              </div>
            </div>
            <div class="preset-command-bar">
              <label>
                <span>当前预设</span>
                <select
                  v-model="activePresetId"
                  @change="selectPreset(activePresetId)"
                >
                  <option :value="DEFAULT_XB_TAVERN_PRESET_ID">
                    默认预设
                  </option>
                  <option
                    v-for="item in userPresets"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.name }}
                  </option>
                </select>
              </label>
              <div class="preset-actions">
                <button
                  type="button"
                  @click="deriveDefaultPreset"
                >
                  复制
                </button>
                <button
                  type="button"
                  :disabled="presetIsBuiltIn"
                  @click="saveCurrentPreset"
                >
                  保存
                </button>
                <button
                  type="button"
                  :disabled="!presetDirty"
                  @click="discardPresetChanges"
                >
                  放弃
                </button>
                <button
                  type="button"
                  @click="resetToBuiltInPreset"
                >
                  恢复默认
                </button>
              </div>
            </div>

            <div
              v-if="presetStatus || presetIsBuiltIn"
              class="preset-status-line"
            >
              <span>{{ presetIsBuiltIn ? '默认预设只读，复制后可以编辑。' : presetStatus }}</span>
            </div>

            <div class="preset-meta-strip">
              <label>
                <span>预设名称</span>
                <input
                  :value="preset.name"
                  :disabled="presetIsBuiltIn"
                  @input="updatePresetMeta({ name: ($event.target as HTMLInputElement).value })"
                >
              </label>
              <label>
                <span>说明</span>
                <textarea
                  :value="preset.description"
                  :disabled="presetIsBuiltIn"
                  rows="2"
                  @input="updatePresetMeta({ description: ($event.target as HTMLTextAreaElement).value })"
                />
              </label>
            </div>

            <div class="preset-studio">
              <section class="preset-list-panel">
                <div class="preset-list-head">
                  <div>
                    <strong>预设队列</strong>
                    <span>{{ presetRows.length }} 条 · {{ presetTotalChars }} 字</span>
                  </div>
                  <button
                    type="button"
                    :disabled="presetIsBuiltIn"
                    @click="addPresetSection"
                  >
                    新增
                  </button>
                </div>
                <div class="preset-queue">
                  <div class="preset-queue-head">
                    <span>名称</span>
                    <span>位置 / 身份</span>
                    <span>字数</span>
                    <span>操作</span>
                  </div>
                  <button
                    v-for="(row, index) in presetRows"
                    :key="row.previewId"
                    type="button"
                    class="preset-queue-row"
                    :class="{
                      disabled: row.enabled === false,
                      selected: selectedPresetPreviewRow?.previewId === row.previewId,
                    }"
                    @click="selectedPresetSourceId = row.previewId"
                  >
                    <span class="preset-row-name">
                      <small>{{ String(index + 1).padStart(2, '0') }}</small>
                      <strong>{{ row.previewLabel }}</strong>
                      <em>条目</em>
                    </span>
                    <span class="preset-row-meta">
                      {{ row.previewPlacement }} / {{ roleLabel(String(row.role || 'system')) }}
                    </span>
                    <span class="preset-row-count">{{ row.chars }}</span>
                    <span class="preset-row-actions">
                      <label
                        class="inline-check"
                        @click.stop
                      >
                        <input
                          type="checkbox"
                          :checked="row.enabled !== false"
                          :disabled="presetIsBuiltIn"
                          @change="updatePresetSection(row.sectionIndex, { enabled: ($event.target as HTMLInputElement).checked })"
                        >
                        启用
                      </label>
                      <button
                        type="button"
                        :disabled="presetIsBuiltIn || row.sectionIndex === 0"
                        @click.stop="movePresetSection(row.sectionIndex, -1)"
                      >
                        上
                      </button>
                      <button
                        type="button"
                        :disabled="presetIsBuiltIn || row.sectionIndex === (preset.sections || []).length - 1"
                        @click.stop="movePresetSection(row.sectionIndex, 1)"
                      >
                        下
                      </button>
                      <button
                        type="button"
                        :disabled="presetIsBuiltIn"
                        @click.stop="removePresetSection(row.sectionIndex)"
                      >
                        删
                      </button>
                    </span>
                  </button>
                </div>
              </section>

              <aside class="preset-detail-panel">
                <div class="preset-preview-head">
                  <strong>{{ selectedPresetPreviewRow?.previewLabel || '条目' }}</strong>
                  <span>{{ selectedPresetPreviewRow?.previewPlacement || '' }}</span>
                </div>
                <div
                  v-if="selectedPresetPreviewRow"
                  class="preset-detail-fields"
                >
                  <label>
                    <span>名称</span>
                    <input
                      :value="selectedPresetPreviewRow.previewLabel"
                      :disabled="presetIsBuiltIn"
                      @input="updatePresetSection(selectedPresetPreviewRow.sectionIndex, { label: ($event.target as HTMLInputElement).value })"
                    >
                  </label>
                  <label>
                    <span>位置</span>
                    <select
                      :value="selectedPresetPreviewRow.placement || 'beforeHistory'"
                      :disabled="presetIsBuiltIn"
                      @change="updatePresetSection(selectedPresetPreviewRow.sectionIndex, { placement: ($event.target as HTMLSelectElement).value as XbTavernPresetSection['placement'] })"
                    >
                      <option value="top">
                        最前面
                      </option>
                      <option value="beforeCharacter">
                        角色卡前
                      </option>
                      <option value="afterCharacter">
                        角色卡后
                      </option>
                      <option value="beforeHistory">
                        历史前
                      </option>
                      <option value="afterHistory">
                        历史后
                      </option>
                      <option value="assistantPrefill">
                        回复开头
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>消息身份</span>
                    <select
                      :value="selectedPresetPreviewRow.role || 'system'"
                      :disabled="presetIsBuiltIn"
                      @change="updatePresetSection(selectedPresetPreviewRow.sectionIndex, { role: ($event.target as HTMLSelectElement).value })"
                    >
                      <option value="system">
                        规则
                      </option>
                      <option value="user">
                        用户
                      </option>
                      <option value="assistant">
                        助手
                      </option>
                    </select>
                  </label>
                </div>
                <label
                  v-if="selectedPresetPreviewRow"
                  class="preset-text-field"
                >
                  <span>内容</span>
                  <textarea
                    :value="selectedPresetPreviewRow.content"
                    :disabled="presetIsBuiltIn"
                    rows="18"
                    @input="updatePresetSection(selectedPresetPreviewRow.sectionIndex, { content: ($event.target as HTMLTextAreaElement).value })"
                  />
                </label>
                <p
                  v-if="selectedPresetPreviewRow"
                  class="muted compact"
                >
                  {{ selectedPresetPreviewRow.enabled === false ? '这条已停用，不会进入发送内容。' : '这条会按左侧顺序进入发送内容。' }}
                </p>
                <p
                  v-else
                  class="muted compact"
                >
                  选择左侧条目后编辑。
                </p>
                <div
                  v-if="selectedPresetPreviewRow"
                  class="preset-preview-content"
                >
                  <strong>预览</strong>
                  <pre>{{ selectedPresetPreviewRow.content }}</pre>
                </div>
              </aside>
            </div>
          </div>
        </section>
      </section>
    </section>

    <div
      v-if="showPromptInspector"
      class="prompt-inspector-overlay"
      @click.self="closePromptInspector"
      @keydown.esc="closePromptInspector"
    >
      <section
        class="prompt-inspector-modal"
        tabindex="-1"
      >
        <header class="prompt-inspector-head">
          <div>
            <p class="eyebrow">
              请求记录
            </p>
            <h2>API 请求</h2>
            <p>{{ lastRequestRawJson ? '上一次真实调用' : '暂无真实调用' }}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            @click="closePromptInspector"
          >
            ×
          </button>
        </header>

        <div
          class="prompt-inspector-tabs"
          aria-label="API 请求视图"
        >
          <button
            type="button"
            :class="{ active: promptInspectorTab === 'history' }"
            @click="promptInspectorTab = 'history'"
          >
            历史
          </button>
          <button
            type="button"
            :class="{ active: promptInspectorTab === 'simulate' }"
            @click="promptInspectorTab = 'simulate'"
          >
            模拟
          </button>
        </div>

        <div class="prompt-inspector-body">
          <section
            v-show="promptInspectorTab === 'history'"
            class="prompt-inspector-view"
          >
            <div class="prompt-inspector-summary">
              <span>{{ lastRequestRawJson ? '有记录' : '暂无记录' }}</span>
              <span>{{ lastRequestSnapshot?.requestKind || 'history' }}</span>
              <span>{{ lastRequestSnapshot?.providerLabel || lastRequestSnapshot?.provider || '未调用' }}</span>
              <span>{{ lastRequestSnapshot?.model || '未选择模型' }}</span>
            </div>
            <pre
              v-if="lastRequestRawJson"
              class="prompt-request-json"
            >{{ lastRequestRawJson }}</pre>
            <p
              v-else
              class="prompt-empty-state"
            >
              暂无请求历史。
            </p>
          </section>

          <section
            v-show="promptInspectorTab === 'simulate'"
            class="prompt-inspector-view"
          >
            <div class="prompt-simulate-panel">
              <div>
                <label for="request-simulate-input">输入</label>
                <textarea
                  id="request-simulate-input"
                  v-model="simulateRequestInput"
                  rows="5"
                  placeholder="写一句要模拟发送的话"
                />
              </div>
              <button
                type="button"
                @click="simulateApiRequest"
              >
                模拟
              </button>
            </div>
            <p
              v-if="simulateRequestStatus"
              class="muted compact"
            >
              {{ simulateRequestStatus }}
            </p>
            <p
              v-if="simulateRequestError"
              class="error"
            >
              {{ simulateRequestError }}
            </p>
            <pre
              v-if="simulateRequestJson"
              class="prompt-request-json"
            >{{ simulateRequestJson }}</pre>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
