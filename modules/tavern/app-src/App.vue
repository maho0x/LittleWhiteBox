<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import {
    getMessageWindow,
    normalizeHiddenOutsideCount,
    normalizeMessageLoadBatchSize,
} from './message-window';
import { normalizeTavernDisplaySettings, type TavernDisplaySettings } from '../shared/settings';
import { useTavernMarkdownTools } from './components/chat/useTavernMarkdownTools';
import { useTavernScrollPane } from './components/chat/useTavernScrollPane';
import { setHostChatCompletionsRequestHeadersProvider } from '../../../shared/host-llm/chat-completions/client.js';
import {
    normalizeXbTavernAuthorNote,
    type XbTavernAuthorNote,
    type XbTavernCharacter,
    type XbTavernContext,
    type XbTavernMessage,
    type XbTavernNativeWorldInfoRuntime,
    type TavernChatPromptPresetBundle,
} from '../shared/message-assembler';
import { buildXbTavernBrain } from '../shared/brain';
import {
    getTavernMemoryIndex,
    getTavernMemoryFile,
    rebuildTavernMemoryDerivedIndex,
    restoreTavernMemoryToFloor,
    trimTavernMemorySnapshotsFromFloor,
} from '../shared/memory-files';
import {
    createTavernSession,
    appendTavernMessage,
    appendTavernManagerMessage,
    countTavernMessages,
    deleteTavernSession,
    deleteTavernManagerMessages,
    deleteTavernMessages,
    listTavernManagerMessages,
    getSelectedTavernSessionId,
    listTavernManagerRuns,
    listTavernMessages,
    listTavernSessions,
    normalizeTavernSessionState,
    replaceTavernSessionState,
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
    extractActionCheckRegexMarkers,
    getActionCheckEvents,
    injectActionCheckRegexMarkers,
    type TavernActionCheckRuntimeEvent,
} from '../shared/runtime-events';
import type { TavernApplyRegexItem, TavernApplyRegexResult } from '../shared/regex';
import type { TavernSubstituteParamsItem, TavernSubstituteParamsOptions, TavernSubstituteParamsResult } from '../shared/substitute-params';
import {
    buildContextHistory,
    deriveTavernSessionStateFromMessagesAsync,
    resolveTavernContextWindow,
    runXbTavernTurn,
    simulateXbTavernRequest,
    type TavernBuildNativeChatPromptRuntime,
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
import TavernAboutPage from './components/TavernAboutPage.vue';
import TavernCharacterSelectPage from './components/TavernCharacterSelectPage.vue';
import TavernHomePage from './components/TavernHomePage.vue';
import TavernChatPage from './components/chat/TavernChatPage.vue';
import { useTavernManagerDisplay } from './components/chat/useTavernManagerDisplay';
import { useTavernMemoryWorkspace } from './components/chat/useTavernMemoryWorkspace';
import TavernRequestLogModal from './components/TavernRequestLogModal.vue';
import TavernSettingsPage from './components/settings/TavernSettingsPage.vue';
import {
    readInitialSettingsWorkspace,
    useTavernSettingsController,
    type TavernSettingsWorkspaceKey,
} from './components/settings/useTavernSettingsController';
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

interface TavernCharacterOption {
    id: string;
    name: string;
    avatar?: string;
    shallow?: boolean;
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

interface TavernCharacterWorldbookState {
    characterId: string;
    currentCharacterId: string;
    isCurrentCharacter: boolean;
    characterName: string;
    boundWorldbookName: string;
    boundExists: boolean;
    hasEmbeddedBook: boolean;
    embeddedBookName: string;
    worldbookOptions: string[];
}

interface TavernCharacterWorldbookActionResult {
    action?: string;
    name?: string;
    worldbookOptions?: unknown;
    state?: TavernCharacterWorldbookState;
}

const SOURCE_APP = 'xb-tavern-app';
const SOURCE_HOST = 'xb-tavern-host';
const CHARACTER_ARCHIVE_BATCH_SIZE = 48;
const CHAT_SIDEBAR_INITIAL_LIMIT = 6;
const CHAT_SIDEBAR_BATCH_SIZE = 12;
const MANAGER_RUN_VISIBLE_LIMIT = 12;
const MEMORY_TURN_INITIAL_LIMIT = 36;
const MEMORY_TURN_BATCH_SIZE = 48;
const MEMORY_FILE_BATCH_SIZE = 24;
const DISPLAY_REGEX_CACHE_LIMIT = 480;
const RUNTIME_DISPLAY_REGEX_THROTTLE_MS = 200;

const context = ref<XbTavernContext>({});
const diagnostics = ref<TavernDiagnostics>({});
const agentConfig = ref<Record<string, unknown>>({});
const tavernDisplaySettings = ref<TavernDisplaySettings>(normalizeTavernDisplaySettings({}));
const htmlRenderEnabled = ref(true);
const hiddenOutsideCount = computed(() => normalizeHiddenOutsideCount(tavernDisplaySettings.value.hiddenOutsideCount));
const loadBatchSize = computed(() => normalizeMessageLoadBatchSize(tavernDisplaySettings.value.loadBatchSize));
const hostRequestHeaders = ref<Record<string, unknown>>({});
const hostMainFontSizePx = ref('15px');
const hostProseLineHeightPx = ref('23px');
const availableCharacters = ref<TavernCharacterOption[]>([]);
const selectedCharacterId = ref('');
const selectedCharacterPreviewId = ref('');
const selectedCharacterGreetingIndex = ref(0);
const pendingCharacterPreviewId = ref('');
const pendingCharacterSessionId = ref('');
const characterWorldbookState = ref<TavernCharacterWorldbookState | null>(null);
const characterWorldbookBusy = ref(false);
const characterWorldbookStatus = ref('');
const characterWorldbookSelectionOpen = ref(false);
const characterWorldbookSelectionOptions = ref<string[]>([]);
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
const runtimeUserMessageVisible = ref(false);
const runtimePendingUserMessage = ref('');
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
const sessionMessageCounts = ref<Record<string, number>>({});
const managerRuns = ref<TavernManagerRunRecord[]>([]);
const memoryFiles = ref<TavernMemoryIndexFileEntry[]>([]);
const memoryIndex = ref<TavernMemoryIndexRecord | null>(null);
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
const retryingManagerRunId = ref('');
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
const characterSearchText = ref('');
const characterVisibleLimit = ref(CHARACTER_ARCHIVE_BATCH_SIZE);
const memoryFileSearchText = ref('');
const memoryFileGroupVisibleLimits = ref<Record<string, number>>({});
const chatSidebarSessionLimit = ref(CHAT_SIDEBAR_INITIAL_LIMIT);
const brokenAvatarUrls = ref<Record<string, true>>({});
type AppView = 'home' | 'chat' | 'characters' | 'settings' | 'about';
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
    type: string;
    abort?: () => void;
    signal?: AbortSignal;
}
interface DisplayRegexTextRequest {
    key: string;
    text: string;
    placement: TavernApplyRegexItem['placement'];
    options: TavernApplyRegexItem['options'];
    actionCheckEvents?: TavernActionCheckRuntimeEvent[];
    actionCheckBoundaries?: Array<{ originalOffset: number; marker: string }>;
}
interface DisplayRegexProjection {
    text: string;
    actionCheckEvents: TavernActionCheckRuntimeEvent[];
}
interface PendingRuntimeDisplayRegexRequest {
    timer: number;
    key: string;
    input: DisplayRegexTextRequest;
}
const pendingHostRequests = new Map<string, PendingHostRequest>();
const DRAW_COMPLETION_NOTICE_TEXT = '配图已生成';
function normalizedSearchText(value = '') {
    return String(value || '').trim().toLocaleLowerCase();
}

function normalizeHostPx(value: unknown, fallback: string): string {
    const parsed = Number.parseFloat(String(value || ''));
    return Number.isFinite(parsed) && parsed > 0
        ? `${Math.round(parsed * 100) / 100}px`
        : fallback;
}

function deriveHostProseLineHeightPx(fontSizePx = hostMainFontSizePx.value): string {
    const parsed = Number.parseFloat(String(fontSizePx || ''));
    return Number.isFinite(parsed) && parsed > 0
        ? `${Math.round((parsed + 8) * 100) / 100}px`
        : '23px';
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

const selectedSession = computed(() => sessions.value.find((item) => item.id === selectedSessionId.value) || null);
const currentAuthorNote = computed<XbTavernAuthorNote>(() => normalizeXbTavernAuthorNote(selectedSession.value?.contextSnapshot?.authorNote));
const sessionRuntimeState = computed(() => normalizeTavernSessionState(selectedSession.value?.state || {}));
const sessionContract = computed<TavernSessionContract>(() => normalizeTavernSessionContract(sessionRuntimeState.value.contract));
const canResumeSelectedSession = computed(() => !!(
    selectedSession.value
    && String(selectedSession.value.characterId || '').trim()
));
const activeView = ref<AppView>(readInitialView());
const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>(readInitialSettingsWorkspace());
const homeThemeDark = ref(readInitialTavernThemeDark());
const chatFocus = ref<ChatFocus>('chat');
const chatLayout = ref<ChatLayout>('balanced');
const chatSidePanel = ref<ChatSidePanel>('memory');
const chatComposeTextareaRef = ref<HTMLTextAreaElement | null>(null);
const managerComposeTextareaRef = ref<HTMLTextAreaElement | null>(null);
const characterArchivePageRef = ref<InstanceType<typeof TavernCharacterSelectPage> | null>(null);
const chatScrollPane = useTavernScrollPane({
    totalItems: () => chatMessages.value.length,
    defaultLimit: hiddenOutsideCount,
    loadBatchSize,
});
const managerScrollPane = useTavernScrollPane({
    totalItems: () => managerChatDisplayItems.value.length,
    defaultLimit: hiddenOutsideCount,
    loadBatchSize,
});
const chatScrollRef = chatScrollPane.scrollRef;
const managerScrollRef = managerScrollPane.scrollRef;
const chatAutoScroll = chatScrollPane.autoScroll;
const managerAutoScroll = managerScrollPane.autoScroll;
const showChatScrollTop = chatScrollPane.showScrollTop;
const showChatScrollBottom = chatScrollPane.showScrollBottom;
const chatScrollControlsActive = chatScrollPane.scrollControlsActive;
const showManagerScrollTop = managerScrollPane.showScrollTop;
const showManagerScrollBottom = managerScrollPane.showScrollBottom;
const managerScrollControlsActive = managerScrollPane.scrollControlsActive;
const chatMessageWindowLimit = chatScrollPane.messageWindowLimit;
const managerMessageWindowLimit = managerScrollPane.messageWindowLimit;
const editingMessageKey = ref('');
const editingMessageDraft = ref('');
const showPromptInspector = ref(false);
const promptInspectorTab = ref<'history' | 'simulate'>('history');
const simulateRequestInput = ref('');
const simulateRequestJson = ref('');
const simulateRequestStatus = ref('');
const simulateRequestError = ref('');
const messageActionFeedback = ref<Record<string, 'success' | 'error'>>({});
const displayRegexCache = ref<Record<string, string>>({});
const activeRunController = ref<AbortController | null>(null);
const managerAssistantController = ref<AbortController | null>(null);
const tavernDrawController = ref<AbortController | null>(null);
const rootTypographyStyle = computed<Record<string, string>>(() => ({
    '--xb-host-main-font-size': hostMainFontSizePx.value,
    '--xb-host-prose-line-height': hostProseLineHeightPx.value,
}));
const {
    clearMarkdownCache,
    enhanceChatMarkdown,
    enhanceManagerMarkdown,
    markdownSignature,
    renderChatMarkdown,
    stripTavernImageMarkers,
} = useTavernMarkdownTools({
    chatScrollRef,
    managerScrollRef,
    htmlRenderEnabled,
    requestHost,
});
const characterOptionCache = new Map<string, { signature: string; option: TavernCharacterOption }>();
const memoryFileSearchCorpusCache = new WeakMap<TavernMemoryIndexFileEntry, string>();
let characterPreviewRequestSequence = 0;
let characterWorldbookRequestSequence = 0;
let simulateRequestSequence = 0;
let managerCompactionOverlayHideTimer: number | null = null;
let composeErrorHideTimer: number | null = null;
let managerRecordsPollTimer: number | null = null;
let managerRecordsPollRunning = false;
let sessionContextSyncSequence = 0;
let initialConfigApplied = false;
let postReadyStartupStarted = false;
const pendingDisplayRegexKeys = new Set<string>();
const pendingRuntimeDisplayRegexRequests = new Map<string, PendingRuntimeDisplayRegexRequest>();
const latestRuntimeDisplayRegexKeys = new Map<string, string>();
const runtimeDisplayRegexStableProjection = new Map<string, DisplayRegexProjection>();
let displayRegexCacheGeneration = 0;
const effectiveContext = computed<XbTavernContext>(() => ({
    ...context.value,
    history: selectedSessionId.value
        ? buildContextHistory(sessionMessages.value)
        : context.value.history,
}));
const {
    activeAssistantPreset,
    applyHostChatPreset,
    handleApiConfigSaved,
    loadTavernUsers,
    openSettingsWorkspace,
    openWorldbookWorkspace,
    refreshPresets,
    refreshRegexFromHost,
    renderApiSettingsPanel,
    runtimeChatPreset,
    selectSettingsWorkspace,
    settingsContext,
    syncApiSettingsConfigFromAgentConfig,
    syncChatPresetFromHost,
    syncWorldbooksFromHost,
} = useTavernSettingsController({
    activeView,
    activeSettingsWorkspace,
    agentConfig,
    tavernDisplaySettings,
    effectiveContext,
    homeThemeDark,
    isRunning,
    describeError,
    postToHost,
    requestHost,
    shortText,
});
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
    const shallow = character.shallow === true;
    const description = String(character.description || '').trim();
    const personality = String(character.personality || '').trim();
    const scenario = String(character.scenario || '').trim();
    const firstMessage = String(character.firstMessage || character.first_mes || '').trim();
    const alternateGreetings = normalizeTextList(character.alternateGreetings || character.alternate_greetings);
    const mesExample = String(character.mesExample || character.mes_example || '').trim();
    const creatorNotes = String(character.creatorNotes || character.creator_notes || '').trim();
    const characterDepthPrompt = String(character.characterDepthPrompt || character.character_depth_prompt || '').trim();
    const signature = JSON.stringify([id, name, avatar, shallow, description, personality, scenario, firstMessage, alternateGreetings, mesExample, creatorNotes, characterDepthPrompt]);
    const cached = characterOptionCache.get(id);
    if (cached?.signature === signature) {return cached.option;}
    const option: TavernCharacterOption = {
        id,
        name,
        avatar,
        shallow,
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
const selectedCharacterSessions = computed<TavernSessionRecord[]>(() => {
    const characterId = String(selectedCharacterPreview.value?.id || '').trim();
    if (!characterId) {return [];}
    return sessions.value
        .filter((session) => String(session.characterId || '').trim() === characterId)
        .slice()
        .sort((left, right) => (
            (Number(right.updatedAt) || Number(right.createdAt) || 0)
            - (Number(left.updatedAt) || Number(left.createdAt) || 0)
        ));
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
const chatMessages = computed(() => sessionMessages.value);
const chatMessageWindow = computed(() => getMessageWindow({
    uiMessageWindowLimit: chatMessageWindowLimit.value,
}, chatMessages.value.length, { defaultLimit: hiddenOutsideCount.value }));
const visibleChatMessages = computed(() => chatMessages.value.slice(chatMessageWindow.value.startIndex));
const latestErrorMessage = computed(() => composeErrorMessage.value);
const latestSavedChatError = computed(() => {
    const lastMessage = [...sessionMessages.value].sort((left, right) => left.order - right.order).at(-1);
    return lastMessage?.error ? `${lastMessage.sessionId}:${lastMessage.order}:${lastMessage.content || ''}` : '';
});
const {
    archivedManagerRuns,
    currentManagerWorkRun,
    formatRunActivityLine,
    formatRunIssueLine,
    formatRunInputLine,
    formatRunMapLine,
    formatRunMemoryLine,
    formatRunModelLine,
    hiddenManagerRunCount,
    isManagerRunLive,
    managerBusy,
    managerRunTone,
    managerStatusClock,
    managerStatusLabel,
    managerToolStatusLabel,
    managerToolTone,
    managerToolTraceItems,
    toolTraceSummary,
} = useTavernManagerDisplay({
    managerRuns,
    visibleRunLimit: MANAGER_RUN_VISIBLE_LIMIT,
});
const filteredChatSidebarSessions = computed(() => {
    const currentCharacterId = String(selectedSession.value?.characterId || effectiveContext.value.character?.id || '').trim();
    return currentCharacterId
        ? sessions.value.filter((session) => String(session.characterId || '').trim() === currentCharacterId)
        : sessions.value;
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

function rememberSessionMessageCount(sessionId = '', count = 0) {
    const id = String(sessionId || '').trim();
    if (!id) {return;}
    const nextCount = Math.max(0, Math.floor(Number(count) || 0));
    if (sessionMessageCounts.value[id] === nextCount) {return;}
    sessionMessageCounts.value = {
        ...sessionMessageCounts.value,
        [id]: nextCount,
    };
}

function forgetSessionMessageCount(sessionId = '') {
    const id = String(sessionId || '').trim();
    if (!id || !(id in sessionMessageCounts.value)) {return;}
    const next = { ...sessionMessageCounts.value };
    delete next[id];
    sessionMessageCounts.value = next;
}

function sessionFloorCount(session?: TavernSessionRecord | null) {
    const id = String(session?.id || '').trim();
    if (!id) {return 0;}
    if (id === selectedSessionId.value) {return chatMessages.value.length;}
    return Math.max(0, Number(sessionMessageCounts.value[id]) || 0);
}

function sessionFloorLabel(session?: TavernSessionRecord | null) {
    const id = String(session?.id || '').trim();
    if (id && id !== selectedSessionId.value && !(id in sessionMessageCounts.value)) {
        return '统计中';
    }
    return `第 ${sessionFloorCount(session)} 楼`;
}

async function refreshSessionMessageCountsForSessions(targetSessions: TavernSessionRecord[] = []) {
    const visibleIds = targetSessions
        .map((session) => String(session.id || '').trim())
        .filter(Boolean);
    const missingIds = [...new Set(visibleIds)]
        .filter((id) => id !== selectedSessionId.value && !(id in sessionMessageCounts.value));
    if (!missingIds.length) {return;}
    const entries = await Promise.all(missingIds.map(async (id) => [id, await countTavernMessages(id)] as const));
    const next = { ...sessionMessageCounts.value };
    entries.forEach(([id, count]) => {
        if (id === selectedSessionId.value || id in sessionMessageCounts.value) {return;}
        next[id] = Math.max(0, Math.floor(Number(count) || 0));
    });
    sessionMessageCounts.value = next;
}

async function refreshVisibleSessionMessageCounts() {
    await refreshSessionMessageCountsForSessions(chatSidebarSessions.value);
}

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
    if (path === 'memory/state.md') {return '会话记忆';}
    if (path.startsWith('memory/characters/') && path.endsWith('.md')) {
        return path.replace(/^memory\/characters\//, '').replace(/\.md$/i, '') || '人物记忆';
    }
    return path.replace(/^memory\//, '').replace(/\.md$/i, '') || '记忆档案';
}

function memoryFileKindLabel(fileOrPath: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null | undefined) {
    const path = typeof fileOrPath === 'string' ? fileOrPath : String(fileOrPath?.path || '');
    if (path === 'memory/state.md') {return '当前有效记忆状态';}
    if (path.startsWith('memory/characters/') && path.endsWith('.md')) {return '人物长期记忆';}
    return '记忆档案';
}

function memoryFileSortWeight(path = '') {
    if (path === 'memory/state.md') {return 0;}
    if (path.startsWith('memory/characters/')) {return 10;}
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
            title: '会话记忆',
            files: [] as TavernMemoryIndexFileEntry[],
        },
        {
            key: 'characters',
            title: '人物记忆',
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
            if (file.path === 'memory/state.md') {
                groups[0].files.push(file);
            } else if (file.path.startsWith('memory/characters/')) {
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
    const index = memoryIndex.value;
    if (!index) {return '还没有可检索记忆';}
    if (index.status === 'ready') {return '记忆可检索';}
    if (index.status === 'failed') {return `记忆整理失败：${index.error || 'memory_index_failed'}`;}
    return '记忆正在整理';
});
const visibleChatMarkdownSignature = computed(() => visibleChatMessages.value
    .map((message) => `${message.sessionId}:${message.order}:${message.error ? 1 : 0}:${markdownSignature(message.content)}`)
    .join('|'));
const messageDisplayDepthByKey = computed(() => {
    const sorted = [...sessionMessages.value]
        .filter((message) => isNormalRoleplayDisplayMessage(message))
        .sort((left, right) => left.order - right.order);
    return sorted.reduce<Record<string, number>>((depthByKey, message, index) => {
        depthByKey[messageKey(message)] = Math.max(0, sorted.length - index - 1);
        return depthByKey;
    }, {});
});
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
}, managerChatDisplayItems.value.length, { defaultLimit: hiddenOutsideCount.value }));
const visibleManagerChatItems = computed(() => managerChatDisplayItems.value.slice(managerMessageWindow.value.startIndex));
const visibleManagerChatMessages = computed(() => visibleManagerChatItems.value
    .filter((item): item is ManagerMessageDisplayItem => item.kind === 'message')
    .map((item) => item.message));
const visibleManagerMarkdownSignature = computed(() => visibleManagerChatItems.value
    .map((item) => item.kind === 'message'
        ? `${item.message.sessionId}:${item.message.order}:${markdownSignature(item.message.content)}`
        : `${item.key}:${markdownSignature(item.assistantMessage.content)}:${item.calls.map((call) => `${call.id}:${markdownSignature(call.resultText)}`).join(',')}`)
    .concat(htmlRenderEnabled.value ? 'html-render:on' : 'html-render:off')
    .join('|'));
const liveManagerMarkdownSignature = computed(() => liveManagerChatDisplayItems.value
    .map((item) => item.kind === 'message'
        ? `${item.message.sessionId}:${item.message.order}:${markdownSignature(item.message.content)}`
        : `${item.key}:${markdownSignature(item.assistantMessage.content)}:${item.calls.map((call) => `${call.id}:${markdownSignature(call.resultText)}`).join(',')}`)
    .concat(htmlRenderEnabled.value ? 'html-render:on' : 'html-render:off')
    .join('|'));
const chatSubtitle = computed(() => {
    if (!selectedSessionId.value) {return '写一句话后会自动创建独立会话。';}
    return sessionFloorLabel(selectedSession.value);
});
const canSendMessage = computed(() => !isCancellingRun.value && (isRunning.value || !!currentUserMessage.value.trim()));
const canSendManagerMessage = computed(() => !isManagerAssistantCancelling.value && (isManagerAssistantRunning.value || (!!selectedSessionId.value && !!managerInputDraft.value.trim())));
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
    characterWorldbookState.value = null;
    characterWorldbookStatus.value = '';
    characterWorldbookSelectionOpen.value = false;
    characterWorldbookSelectionOptions.value = [];
    if (activeView.value === 'characters') {
        scrollSelectedCharacterPreviewIntoView();
    }
});

watch([activeView, selectedCharacterPreviewId, liveCharacterId], ([view, previewId]) => {
    if (view !== 'characters') {return;}
    const targetId = String(previewId || '').trim();
    if (!targetId) {return;}
    void syncCharacterWorldbookState(targetId);
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

watch(memoryFileSearchText, () => {
    memoryFileGroupVisibleLimits.value = {};
});

watch([
    () => selectedSessionId.value,
    () => sessionMessages.value.length,
], ([sessionId, count]) => {
    rememberSessionMessageCount(String(sessionId || ''), Number(count) || 0);
});

watch(() => chatSidebarSessions.value.map((session) => session.id).join('|'), () => {
    void refreshVisibleSessionMessageCounts();
}, { immediate: true });

watch(() => selectedCharacterSessions.value.map((session) => session.id).join('|'), () => {
    void refreshSessionMessageCountsForSessions(selectedCharacterSessions.value);
}, { immediate: true });

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

function requestHost(type: string, payload: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) {
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
        const abort = () => {
            cleanup();
            postToHost('xb-tavern:cancel-request', { requestId });
            reject(createAbortError());
        };
        if (options.signal) {
            options.signal.addEventListener('abort', abort, { once: true });
        }
        pendingHostRequests.set(requestId, { resolve, reject, type, abort: options.signal ? abort : undefined, signal: options.signal });
    });
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

function clearRuntimeDisplayRegexRequests() {
    pendingRuntimeDisplayRegexRequests.forEach((request) => window.clearTimeout(request.timer));
    pendingRuntimeDisplayRegexRequests.clear();
    latestRuntimeDisplayRegexKeys.clear();
    runtimeDisplayRegexStableProjection.clear();
}

function clearDisplayRegexCache() {
    displayRegexCacheGeneration += 1;
    pendingDisplayRegexKeys.clear();
    clearRuntimeDisplayRegexRequests();
    displayRegexCache.value = {};
}

function rememberDisplayRegexText(key: string, text: string) {
    const next = { ...displayRegexCache.value, [key]: text };
    const keys = Object.keys(next);
    if (keys.length > DISPLAY_REGEX_CACHE_LIMIT) {
        keys.slice(0, keys.length - DISPLAY_REGEX_CACHE_LIMIT).forEach((staleKey) => {
            delete next[staleKey];
        });
    }
    displayRegexCache.value = next;
    if (activeView.value === 'chat' && chatFocus.value === 'chat') {
        void nextTick(() => {
            enhanceChatMarkdown();
            updateChatScrollButtons();
        });
    }
}

function toDisplayRegexProjection(text: string, input: Pick<DisplayRegexTextRequest, 'actionCheckEvents' | 'actionCheckBoundaries'>): DisplayRegexProjection {
    const normalized = extractActionCheckRegexMarkers(
        text,
        input.actionCheckEvents || [],
        input.actionCheckBoundaries || [],
    );
    return {
        text: normalized.text,
        actionCheckEvents: normalized.events,
    };
}

function rememberRuntimeDisplayRegexProjection(slot: string, key: string, text: string, input: DisplayRegexTextRequest) {
    rememberDisplayRegexText(key, text);
    runtimeDisplayRegexStableProjection.set(slot, toDisplayRegexProjection(text, input));
}

function messageRegexPlacement(message: TavernMessageRecord): TavernApplyRegexItem['placement'] | null {
    if (message.role === 'user') {return 'userInput';}
    if (message.role === 'assistant') {return 'aiOutput';}
    return null;
}

function isNormalRoleplayDisplayMessage(message: TavernMessageRecord): boolean {
    return ['user', 'assistant'].includes(message.role)
        && !message.error
        && !!String(message.content || '').trim();
}

function messageDisplayDepth(message: TavernMessageRecord): number {
    const depth = Number(messageDisplayDepthByKey.value[messageKey(message)]);
    return Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

function messageCharacterOverride(message: TavernMessageRecord): string {
    return String(message.name || roleLabel(message.role) || '').trim();
}

function displayRegexCacheKey(
    kind: 'message' | 'reasoning',
    message: TavernMessageRecord,
    input: {
        placement: TavernApplyRegexItem['placement'];
        text: string;
        depth: number;
        index?: number;
        label?: string;
        characterOverride?: string;
        actionCheckSignature?: string;
    },
) {
    return [
        kind,
        message.sessionId,
        String(message.order),
        message.role,
        String(message.name || ''),
        String(input.index ?? ''),
        input.placement,
        String(input.depth),
        input.characterOverride || '',
        input.actionCheckSignature || '',
        markdownSignature(String(input.label || '')),
        markdownSignature(input.text),
    ].join('\u0001');
}

function runtimeDisplayRegexCacheKey(
    kind: 'message' | 'reasoning',
    input: {
        placement: TavernApplyRegexItem['placement'];
        text: string;
        depth: number;
        index?: number;
        label?: string;
        characterOverride?: string;
        actionCheckSignature?: string;
    },
) {
    const latestOrder = [...sessionMessages.value].sort((left, right) => left.order - right.order).at(-1)?.order ?? -1;
    return [
        'runtime',
        kind,
        selectedSessionId.value,
        String(latestOrder),
        'assistant',
        String(input.index ?? ''),
        input.placement,
        String(input.depth),
        input.characterOverride || '',
        input.actionCheckSignature || '',
        markdownSignature(String(input.label || '')),
        markdownSignature(input.text),
    ].join('\u0001');
}

function actionCheckEventsCacheSignature(events: TavernActionCheckRuntimeEvent[] = []): string {
    return getActionCheckEvents(events)
        .map((event, index) => [
            index,
            event.toolCallId || '',
            event.createdAt || '',
            event.stat,
            event.action,
            event.roll,
            event.difficulty,
            event.insertAfterChars,
            event.success ? 1 : 0,
            event.summary || '',
            event.stakes || '',
        ].join(':'))
        .join('|');
}

async function resolveDisplayRegexText(input: DisplayRegexTextRequest) {
    if (pendingDisplayRegexKeys.has(input.key)) {return;}
    const generation = displayRegexCacheGeneration;
    pendingDisplayRegexKeys.add(input.key);
    try {
        const result = await applyTavernRegex([{
            id: input.key,
            text: input.text,
            placement: input.placement,
            options: input.options,
        }]);
        if (generation !== displayRegexCacheGeneration) {return;}
        const item = result.items.find((candidate) => candidate.id === input.key) || result.items[0];
        rememberDisplayRegexText(input.key, item?.text ?? input.text);
    } catch (error) {
        console.warn('[小白酒馆] 显示正则应用失败', error);
    } finally {
        pendingDisplayRegexKeys.delete(input.key);
    }
}

async function resolveRuntimeDisplayRegexText(slot: string, input: DisplayRegexTextRequest) {
    if (pendingDisplayRegexKeys.has(input.key)) {return;}
    const generation = displayRegexCacheGeneration;
    pendingDisplayRegexKeys.add(input.key);
    try {
        const result = await applyTavernRegex([{
            id: input.key,
            text: input.text,
            placement: input.placement,
            options: input.options,
        }]);
        if (generation !== displayRegexCacheGeneration || latestRuntimeDisplayRegexKeys.get(slot) !== input.key) {return;}
        const item = result.items.find((candidate) => candidate.id === input.key) || result.items[0];
        rememberRuntimeDisplayRegexProjection(slot, input.key, item?.text ?? input.text, input);
    } catch (error) {
        console.warn('[小白酒馆] 生成中显示正则应用失败', error);
        if (generation === displayRegexCacheGeneration && latestRuntimeDisplayRegexKeys.get(slot) === input.key) {
            rememberRuntimeDisplayRegexProjection(slot, input.key, input.text, input);
        }
    } finally {
        pendingDisplayRegexKeys.delete(input.key);
    }
}

function scheduleRuntimeDisplayRegexText(slot: string, input: DisplayRegexTextRequest) {
    latestRuntimeDisplayRegexKeys.set(slot, input.key);
    const current = pendingRuntimeDisplayRegexRequests.get(slot);
    if (current) {
        current.key = input.key;
        current.input = input;
        return;
    }
    const timer = window.setTimeout(() => {
        const pending = pendingRuntimeDisplayRegexRequests.get(slot);
        if (!pending) {return;}
        pendingRuntimeDisplayRegexRequests.delete(slot);
        void resolveRuntimeDisplayRegexText(slot, pending.input);
    }, RUNTIME_DISPLAY_REGEX_THROTTLE_MS);
    pendingRuntimeDisplayRegexRequests.set(slot, {
        timer,
        key: input.key,
        input,
    });
}

function displayMessageContent(message: TavernMessageRecord): string {
    const text = String(message.content || '');
    if (!text) {return '';}
    if (!isNormalRoleplayDisplayMessage(message)) {return text;}
    const placement = messageRegexPlacement(message);
    if (!placement) {return text;}
    const depth = messageDisplayDepth(message);
    const characterOverride = messageCharacterOverride(message);
    const key = displayRegexCacheKey('message', message, {
        placement,
        text,
        depth,
        characterOverride,
    });
    const cached = displayRegexCache.value[key];
    if (cached !== undefined) {return cached;}
    void resolveDisplayRegexText({
        key,
        text,
        placement,
        options: {
            isMarkdown: true,
            depth,
            characterOverride,
        },
    });
    return text;
}

function displayMessageRenderProjection(message: TavernMessageRecord): DisplayRegexProjection {
    const text = String(message.content || '');
    if (!text) {return { text: '', actionCheckEvents: [] };}
    const actionCheckEvents = message.role === 'assistant' ? getActionCheckEvents(message.runtimeEvents) : [];
    if (!actionCheckEvents.length) {
        return { text: displayMessageContent(message), actionCheckEvents: [] };
    }
    if (!isNormalRoleplayDisplayMessage(message)) {
        return { text, actionCheckEvents };
    }
    const placement = messageRegexPlacement(message);
    if (!placement) {
        return { text, actionCheckEvents };
    }
    const markerPayload = injectActionCheckRegexMarkers(text, actionCheckEvents);
    const depth = messageDisplayDepth(message);
    const characterOverride = messageCharacterOverride(message);
    const key = displayRegexCacheKey('message', message, {
        placement,
        text: markerPayload.text,
        depth,
        characterOverride,
        actionCheckSignature: actionCheckEventsCacheSignature(actionCheckEvents),
    });
    const request: DisplayRegexTextRequest = {
        key,
        text: markerPayload.text,
        placement,
        options: {
            isMarkdown: true,
            depth,
            characterOverride,
        },
        actionCheckEvents,
        actionCheckBoundaries: markerPayload.boundaries,
    };
    const cached = displayRegexCache.value[key];
    if (cached !== undefined) {
        return toDisplayRegexProjection(cached, request);
    }
    void resolveDisplayRegexText(request);
    return toDisplayRegexProjection(markerPayload.text, request);
}

function displayMessageThoughtBlocks(message: TavernMessageRecord): Array<{ label?: string; text?: string }> {
    const depth = messageDisplayDepth(message);
    return thoughtBlocks(message).map((thought, index) => {
        const text = String(thought.text || '');
        if (!text) {return thought;}
        const key = displayRegexCacheKey('reasoning', message, {
            placement: 'reasoning',
            text,
            depth,
            index,
            label: thought.label,
        });
        const cached = displayRegexCache.value[key];
        if (cached !== undefined) {
            return { ...thought, text: cached };
        }
        void resolveDisplayRegexText({
            key,
            text,
            placement: 'reasoning',
            options: {
                isMarkdown: true,
                depth,
            },
        });
        return thought;
    }).filter((thought) => String(thought.text || '').trim());
}

function displayRuntimeRenderProjection(
    textInput = '',
    events: TavernActionCheckRuntimeEvent[] = [],
): DisplayRegexProjection {
    const text = String(textInput || '');
    const actionCheckEvents = getActionCheckEvents(events);
    if (!text && !actionCheckEvents.length) {return { text: '', actionCheckEvents: [] };}
    if (!text) {return { text: '', actionCheckEvents };}
    const markerPayload = injectActionCheckRegexMarkers(text, actionCheckEvents);
    const depth = 0;
    const characterOverride = String(roleLabel('assistant') || '').trim();
    const key = runtimeDisplayRegexCacheKey('message', {
        placement: 'aiOutput',
        text: markerPayload.text,
        depth,
        characterOverride,
        actionCheckSignature: actionCheckEventsCacheSignature(actionCheckEvents),
    });
    const request: DisplayRegexTextRequest = {
        key,
        text: markerPayload.text,
        placement: 'aiOutput',
        options: {
            isMarkdown: true,
            depth,
            characterOverride,
        },
        actionCheckEvents,
        actionCheckBoundaries: markerPayload.boundaries,
    };
    const cached = displayRegexCache.value[key];
    if (cached !== undefined) {
        const projection = toDisplayRegexProjection(cached, request);
        runtimeDisplayRegexStableProjection.set('runtime:message', projection);
        return projection;
    }
    scheduleRuntimeDisplayRegexText('runtime:message', request);
    return runtimeDisplayRegexStableProjection.get('runtime:message') ?? { text: '', actionCheckEvents: [] };
}

function displayRuntimeContent(textInput = ''): string {
    return displayRuntimeRenderProjection(textInput).text;
}

function displayRuntimeThoughtBlocks(thoughts: Array<{ label?: string; text?: string }> = []): Array<{ label?: string; text?: string }> {
    const depth = 0;
    return thoughtBlocks(thoughts).map((thought, index) => {
        const text = String(thought.text || '');
        if (!text) {return thought;}
        const key = runtimeDisplayRegexCacheKey('reasoning', {
            placement: 'reasoning',
            text,
            depth,
            index,
            label: thought.label,
        });
        const cached = displayRegexCache.value[key];
        if (cached !== undefined) {
            runtimeDisplayRegexStableProjection.set(`runtime:reasoning:${index}`, { text: cached, actionCheckEvents: [] });
            return { ...thought, text: cached };
        }
        const request: DisplayRegexTextRequest = {
            key,
            text,
            placement: 'reasoning',
            options: {
                isMarkdown: true,
                depth,
            },
        };
        const slot = `runtime:reasoning:${index}`;
        scheduleRuntimeDisplayRegexText(slot, request);
        return {
            ...thought,
            text: runtimeDisplayRegexStableProjection.get(slot)?.text ?? '',
        };
    }).filter((thought) => String(thought.text || '').trim());
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

const buildNativeChatPrompt: TavernBuildNativeChatPromptRuntime = async (input) => {
    const response = await requestHost('xb-tavern:build-native-chat-prompt', {
        payload: input,
    }, { signal: input.signal });
    return (response.result || response) as Awaited<ReturnType<TavernBuildNativeChatPromptRuntime>>;
};

async function getHostContext(input: {
    characterId?: string;
    includeHistory?: boolean;
    includeWorldbooks?: boolean;
} = {}, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const response = await requestHost('xb-tavern:get-context', {
        payload: {
            characterId: input.characterId,
            includeHistory: input.includeHistory,
            includeWorldbooks: input.includeWorldbooks,
        },
    }, options);
    return (response.result || response) as Record<string, unknown>;
}

function currentContextCharacterId() {
    return String(context.value.character?.id || selectedCharacterId.value || '').trim();
}

function currentContextCharacterReady() {
    return !!displayableTavernName(context.value.character?.name || '') && !!currentContextCharacterId();
}

function hasAuthorNoteSnapshot(value: unknown): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

function preserveSessionAuthorNote(nextContext: XbTavernContext = {}, session?: TavernSessionRecord | null): XbTavernContext {
    const authorNote = session?.contextSnapshot?.authorNote;
    if (!hasAuthorNoteSnapshot(authorNote)) {return nextContext;}
    return {
        ...nextContext,
        authorNote: { ...(authorNote as Record<string, unknown>) },
    };
}

async function saveCurrentAuthorNote(note: XbTavernAuthorNote): Promise<void> {
    const sessionId = String(selectedSessionId.value || '').trim();
    const session = selectedSession.value;
    if (!sessionId || !session) {
        throw new Error('当前没有可保存的会话。');
    }
    const normalized = normalizeXbTavernAuthorNote(note);
    const contextBase = selectedSessionId.value === sessionId
        ? (context.value || session.contextSnapshot || {})
        : (session.contextSnapshot || context.value || {});
    const nextContext: XbTavernContext = {
        ...contextBase,
        authorNote: normalized,
    };
    const updatedSession = await updateTavernSessionSnapshot(sessionId, {
        contextSnapshot: nextContext,
        characterId: String(nextContext.character?.id || session.characterId || ''),
        characterName: String(nextContext.character?.name || session.characterName || ''),
    });
    if (updatedSession) {
        sessions.value = sessions.value.map((item) => item.id === updatedSession.id ? updatedSession : item);
    }
    if (selectedSessionId.value !== sessionId) {return;}
    context.value = nextContext;
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
    const nextContext = preserveSessionAuthorNote(payload.context as XbTavernContext || context.value, session);
    applyHostPayload({
        ...payload,
        context: nextContext,
    });
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
    return await syncSessionCharacterContext({ sessionId: targetSessionId, force: true });
}

function resolveHostRequest(payload: Record<string, unknown> = {}) {
    const requestId = String(payload.requestId || '');
    const pending = pendingHostRequests.get(requestId);
    if (!pending) {return;}
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
    if (['xb-tavern:list-regex-scripts', 'xb-tavern:save-regex-script', 'xb-tavern:delete-regex-script'].includes(pending.type)) {
        clearDisplayRegexCache();
    }
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

function applyHostPayload(payload: Record<string, unknown>) {
    installHostRequestHeadersProvider(payload);
    if ('context' in payload) {
        context.value = payload.context as XbTavernContext || {};
    }
    if ('diagnostics' in payload) {
        diagnostics.value = payload.diagnostics as TavernDiagnostics || {};
    }
    const nextHostMainFontSizePx = 'hostMainFontSizePx' in payload
        ? normalizeHostPx(payload.hostMainFontSizePx, hostMainFontSizePx.value)
        : hostMainFontSizePx.value;
    hostMainFontSizePx.value = nextHostMainFontSizePx;
    hostProseLineHeightPx.value = 'hostProseLineHeightPx' in payload
        ? normalizeHostPx(payload.hostProseLineHeightPx, deriveHostProseLineHeightPx(nextHostMainFontSizePx))
        : deriveHostProseLineHeightPx(nextHostMainFontSizePx);
    if ('agentConfig' in payload) {
        agentConfig.value = payload.agentConfig as Record<string, unknown> || agentConfig.value;
        syncApiSettingsConfigFromAgentConfig();
    }
    if ('tavernDisplaySettings' in payload) {
        tavernDisplaySettings.value = normalizeTavernDisplaySettings(payload.tavernDisplaySettings);
    }
    if ('htmlRenderEnabled' in payload) {
        htmlRenderEnabled.value = payload.htmlRenderEnabled !== false;
    }
    applyHostChatPreset(payload);
    availableCharacters.value = payload.availableCharacters as TavernCharacterOption[] || availableCharacters.value;
    selectedCharacterId.value = String(payload.selectedCharacterId || context.value.character?.id || selectedCharacterId.value || '');
    statusText.value = diagnostics.value.message || '';
    void finishPendingCharacterSession().catch((error) => {
        pendingCharacterError.value = error instanceof Error ? error.message : String(error || 'create_session_failed');
        clearPendingCharacterSession();
    });
    void nextTick(renderApiSettingsPanel);
}

function startPostReadyStartupTasksAfterInitialConfig() {
    if (!initialConfigApplied || postReadyStartupStarted) {return;}
    postReadyStartupStarted = true;
    void runPostReadyStartupTasks();
}

function applyCharacterListPayload(payload: Record<string, unknown>) {
    const characters = payload.availableCharacters;
    if (Array.isArray(characters)) {
        availableCharacters.value = characters as TavernCharacterOption[];
    }
}

function hasCharacterPreviewDetails(character: TavernCharacterOption | null | undefined) {
    return !!character && !!(
        character.description
        || character.personality
        || character.scenario
        || character.firstMessage
        || character.mesExample
        || character.creatorNotes
        || character.characterDepthPrompt
        || character.alternateGreetings?.length
    );
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
        initialConfigApplied = true;
        startPostReadyStartupTasksAfterInitialConfig();
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

function refreshCharacterList() {
    statusText.value = '正在读取角色列表';
    pendingCharacterError.value = '';
    postToHost('xb-tavern:refresh-context', {});
}

async function selectCharacterForPreview(characterId: string) {
    const targetId = String(characterId || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    selectedCharacterPreviewId.value = targetId;
    void syncCharacterWorldbookState(targetId);
    const current = characterCards.value.find((character) => character.id === targetId);
    if (current && current.shallow !== true && hasCharacterPreviewDetails(current)) {return;}
    const sequence = ++characterPreviewRequestSequence;
    pendingCharacterPreviewId.value = targetId;
    pendingCharacterError.value = '';
    try {
        const payload = await getHostContext({ characterId: targetId, includeHistory: false, includeWorldbooks: false });
        if (sequence !== characterPreviewRequestSequence || selectedCharacterPreviewId.value !== targetId) {return;}
        applyCharacterListPayload(payload);
    } catch (error) {
        if (sequence !== characterPreviewRequestSequence || selectedCharacterPreviewId.value !== targetId) {return;}
        pendingCharacterError.value = error instanceof Error ? error.message : String(error || 'character_preview_failed');
    } finally {
        if (sequence === characterPreviewRequestSequence && pendingCharacterPreviewId.value === targetId) {
            pendingCharacterPreviewId.value = '';
        }
    }
}

async function syncCharacterWorldbookState(characterId = selectedCharacterPreviewId.value) {
    const targetId = String(characterId || '').trim();
    if (!targetId) {
        characterWorldbookState.value = null;
        characterWorldbookSelectionOpen.value = false;
        characterWorldbookSelectionOptions.value = [];
        return;
    }
    const sequence = ++characterWorldbookRequestSequence;
    try {
        const result = await requestHost('xb-tavern:get-character-worldbook-state', {
            payload: { characterId: targetId },
        });
        if (sequence !== characterWorldbookRequestSequence || String(selectedCharacterPreviewId.value || '').trim() !== targetId) {return;}
        characterWorldbookState.value = (result.result || result) as unknown as TavernCharacterWorldbookState;
        characterWorldbookStatus.value = '';
    } catch (error) {
        if (sequence !== characterWorldbookRequestSequence || String(selectedCharacterPreviewId.value || '').trim() !== targetId) {return;}
        characterWorldbookStatus.value = describeError(error);
    }
}

async function openSelectedCharacterWorldbook() {
    const targetId = String(selectedCharacterPreviewId.value || '').trim();
    if (!targetId || characterWorldbookBusy.value) {return;}
    characterWorldbookBusy.value = true;
    characterWorldbookStatus.value = '';
    try {
        let result = await requestHost('xb-tavern:activate-character-worldbook', {
            payload: { characterId: targetId },
        });
        let payload = (result.result || result) as TavernCharacterWorldbookActionResult;
        if (payload.action === 'needs_import_confirmation') {
            const name = String(payload.name || '').trim();
            const state = payload.state as TavernCharacterWorldbookState | undefined;
            if (state) {characterWorldbookState.value = state;}
            if (!name || !window.confirm(`世界书「${name}」已存在，导入角色内嵌世界书会覆盖它。继续？`)) {
                return;
            }
            result = await requestHost('xb-tavern:activate-character-worldbook', {
                payload: { characterId: targetId, confirmed: true },
            });
            payload = (result.result || result) as TavernCharacterWorldbookActionResult;
        }
        const action = String(payload.action || '');
        if (action === 'selected' || action === 'imported') {
            const state = payload.state as TavernCharacterWorldbookState | undefined;
            if (state) {characterWorldbookState.value = state;}
            if (action === 'imported') {
                postToHost('xb-tavern:refresh-context', {});
            }
            openWorldbookWorkspace(String(payload.name || ''));
            return;
        }
        if (action === 'needs_selection') {
            characterWorldbookSelectionOptions.value = normalizeTextList(payload.worldbookOptions);
            characterWorldbookSelectionOpen.value = true;
            const state = payload.state as TavernCharacterWorldbookState | undefined;
            if (state) {characterWorldbookState.value = state;}
            return;
        }
        await syncCharacterWorldbookState(targetId);
    } catch (error) {
        characterWorldbookStatus.value = describeError(error);
    } finally {
        characterWorldbookBusy.value = false;
    }
}

function closeCharacterWorldbookSelection() {
    characterWorldbookSelectionOpen.value = false;
}

async function bindSelectedCharacterWorldbook(name: string) {
    const targetId = String(selectedCharacterPreviewId.value || '').trim();
    const targetName = String(name || '').trim();
    if (!targetId || !targetName || characterWorldbookBusy.value) {return;}
    characterWorldbookBusy.value = true;
    characterWorldbookStatus.value = '';
    try {
        const result = await requestHost('xb-tavern:bind-character-worldbook', {
            payload: { characterId: targetId, name: targetName },
        });
        characterWorldbookState.value = (result.result || result) as unknown as TavernCharacterWorldbookState;
        characterWorldbookSelectionOpen.value = false;
        postToHost('xb-tavern:refresh-context', {});
        openWorldbookWorkspace(targetName);
    } catch (error) {
        characterWorldbookStatus.value = describeError(error);
    } finally {
        characterWorldbookBusy.value = false;
    }
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
        characterArchivePageRef.value?.openSessionArchive();
    }
}

async function enterSelectedCharacter() {
    const targetId = String(selectedCharacterPreview.value?.id || selectedCharacterPreviewId.value || '').trim();
    if (!targetId || pendingCharacterSessionId.value) {return;}
    await selectCharacterAndCreateSession(targetId);
}

async function refreshSessions() {
    sessions.value = await listTavernSessions();
    const storedSessionId = String(await getSelectedTavernSessionId() || '').trim();
    selectedSessionId.value = sessions.value.some((session) => session.id === storedSessionId)
        ? storedSessionId
        : '';
    if (storedSessionId && !selectedSessionId.value) {
        await setSelectedTavernSessionId('');
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
        chatPreset: runtimeChatPreset.value,
        historyMode: historyMode.value,
        diagnostics: diagnostics.value,
        applySubstituteParams: applyTavernSubstituteParams,
        getNativeWorldInfoRuntime: getNativeWorldbookRuntime,
    });
    await replaceTavernSessionState(selectedSessionId.value, {
        ...state,
        contract: currentSessionState.contract,
        contextWindowStartOrder: resolveTavernContextWindow({
            messages,
            contextWindowStartOrder: currentSessionState.contextWindowStartOrder,
        }).contextWindowStartOrder,
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
    clearMarkdownCache();
}

const resetChatMessageWindowState = chatScrollPane.resetWindowState;
const resetManagerMessageWindowState = managerScrollPane.resetWindowState;
const revealOlderChatMessages = chatScrollPane.revealOlderMessages;
const revealOlderManagerMessages = managerScrollPane.revealOlderMessages;

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
        chatPresetId: String(runtimeChatPreset.value.id || ''),
        chatPresetName: String(runtimeChatPreset.value.name || ''),
        presetId: String(runtimeChatPreset.value.id || ''),
        presetName: String(runtimeChatPreset.value.name || ''),
    });
}

async function createSessionFromContext(options: { includeFirstMessage?: boolean; contextSnapshot?: XbTavernContext; greetingIndex?: number } = {}) {
    const snapshotContext = options.contextSnapshot || context.value;
    const snapshotBrain = buildXbTavernBrain({
        context: snapshotContext,
        chatPreset: runtimeChatPreset.value,
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
        chatPresetId: String(runtimeChatPreset.value.id || ''),
        chatPresetName: String(runtimeChatPreset.value.name || ''),
        presetId: String(runtimeChatPreset.value.id || ''),
        presetName: String(runtimeChatPreset.value.name || ''),
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

async function createNewChatSession() {
    if (isRunning.value || isCancellingRun.value) {return;}
    const snapshotContext = selectedSessionId.value
        ? await resolveRuntimeContextForSession(selectedSessionId.value)
        : context.value;
    resetSessionPreviewState();
    await createSessionAndOpenChat({ contextSnapshot: snapshotContext });
}

async function handleHomePrimaryAction() {
    if (canResumeSelectedSession.value) {
        openChatView();
        return;
    }
    openCharacterSelect();
}

function clearPendingCharacterSession() {
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
    const deletedCharacterId = String(session?.characterId || '').trim();
    const isDeletingSelectedSession = id === selectedSessionId.value;
    const nextSameCharacterSession = deletedCharacterId
        ? sessions.value
            .filter((item) => item.id !== id && String(item.characterId || '').trim() === deletedCharacterId)
            .slice()
            .sort((left, right) => (
                (Number(right.updatedAt) || Number(right.createdAt) || 0)
                - (Number(left.updatedAt) || Number(left.createdAt) || 0)
            ))[0]
        : null;
    const title = sessionDisplayTitle(session) || '这个会话';
    if (!window.confirm(`删除「${title}」？`)) {return;}
    if (isDeletingSelectedSession && isRunning.value) {
        activeRunController.value?.abort();
    }
    const removed = await deleteTavernSession(id);
    if (!removed) {return;}
    forgetSessionMessageCount(id);
    if (!isDeletingSelectedSession) {
        await refreshSessions();
        activeView.value = selectedSessionId.value ? 'chat' : 'home';
        if (selectedSessionId.value) {
            chatFocus.value = 'chat';
            scrollChatToBottom(true);
        }
        return;
    }
    resetSessionPreviewState();
    if (nextSameCharacterSession?.id) {
        selectedSessionId.value = nextSameCharacterSession.id;
        await setSelectedTavernSessionId(nextSameCharacterSession.id);
        await refreshSessions();
        activeView.value = 'chat';
        chatFocus.value = 'chat';
        scrollChatToBottom(true);
        return;
    }
    selectedSessionId.value = '';
    sessionMessages.value = [];
    await setSelectedTavernSessionId('');
    await refreshSessions();
    if (deletedCharacterId) {
        selectedCharacterPreviewId.value = deletedCharacterId;
        void syncCharacterWorldbookState(deletedCharacterId);
    }
    activeView.value = deletedCharacterId ? 'characters' : 'home';
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
            chatPreset: runtimeChatPreset.value,
            currentUserMessage: messageText,
            runtimeState: normalizeTavernSessionState(selectedSession.value?.state || {}),
            diagnostics: diagnostics.value,
            historyMode: historyMode.value,
            applyRegex: applyTavernRegex,
            applySubstituteParams: applyTavernSubstituteParams,
            getNativeWorldInfoRuntime: getNativeWorldbookRuntime,
            buildNativeChatPrompt,
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

const {
    discardMemoryDraft,
    enterMemoryEditMode,
    formatMemoryFileMeta,
    invalidateMemoryFileRecordLoad,
    loadMemoryFileIntoEditor,
    loadSelectedMemoryFileRecord,
    memoryFileStatusLabel,
    previewMemoryDraft,
    saveSelectedMemoryFile,
    selectMemoryFile,
} = useTavernMemoryWorkspace({
    memoryEditorBaseContent,
    memoryEditorDocumentAvailable,
    memoryEditorDraft,
    memoryEditorDirty,
    memoryEditorLoadedPath,
    memoryEditorMode,
    memoryEditorStatus,
    selectedMemoryFileEntry,
    selectedMemoryFilePath,
    selectedMemoryFileRecord,
    selectedSessionId,
    refreshRecords: refreshManagerRecords,
});

async function retryManagerRun(run: TavernManagerRunRecord) {
    const runId = String(run.id || '');
    if (!runId || !selectedSessionId.value || managerBusy.value || retryingManagerRunId.value) {return;}
    retryingManagerRunId.value = runId;
    managerActionStatus.value = '记忆正在重试。';
    try {
        const messages = await listTavernMessages(selectedSessionId.value);
        const userMessage = messages.find((message) => message.order === run.userOrder && message.role === 'user');
        const assistantMessage = messages.find((message) => message.order === run.assistantOrder && message.role === 'assistant' && !message.error);
        if (!userMessage || !assistantMessage) {
            managerActionStatus.value = '原文楼层不存在，无法重试。';
            await refreshManagerRecords();
            return;
        }
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
        try {
            await refreshManagerRecords();
        } finally {
            retryingManagerRunId.value = '';
        }
    }
}

function isManagerRunRetrying(run: TavernManagerRunRecord | null | undefined) {
    return !!run && !!retryingManagerRunId.value && String(run.id || '') === retryingManagerRunId.value;
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
    const sorted = [...sessionMessages.value].sort((left, right) => left.order - right.order);
    const latest = sorted.at(-1);
    if (!latest || latest.sessionId !== message.sessionId || latest.order !== message.order) {return false;}
    if (message.role === 'user') {return true;}
    if (message.role !== 'assistant') {return false;}
    return sorted.slice(0, -1).some((item) => item.role === 'user');
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
        }, { signal: controller.signal });
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
        : { minHeight: 36, maxHeight: 76 });
}

async function restoreMemoryStateBeforeMessage(sessionId = '', changedOrder = 0) {
    const id = String(sessionId || '').trim();
    const order = Number(changedOrder);
    if (!id || !Number.isFinite(order)) {return;}
    await restoreTavernMemoryToFloor(id, order - 1);
    await trimTavernMemorySnapshotsFromFloor(id, order);
    await rebuildTavernMemoryDerivedIndex(id);
}

function memoryRollbackNoticeForFloor(floor: number): string {
    const previousFloor = Math.max(0, floor - 1);
    const target = previousFloor > 0 ? `第 ${previousFloor} 楼后的状态` : '开局前状态';
    return `会话记忆 state.md 和人物记忆会回滚到${target}。`;
}

async function saveEditMessage(message: TavernMessageRecord, options: { rerun?: boolean; content?: string } = {}) {
    if (!canEditMessage(message)) {return;}
    const draft = 'content' in options
        ? String(options.content || '')
        : String(message.content || '');
    const content = draft.trim();
    if (!content) {
        flashMessageAction(message, 'edit', false);
        return;
    }
    if (!options.rerun && content === String(message.content || '').trim()) {
        cancelEditMessage();
        return;
    }
    if (options.rerun && message.role !== 'user') {
        cancelEditMessage();
        await rerunFromMessage(message);
        return;
    }
    const floor = Math.max(1, Number(message.order) + 1);
    if (!window.confirm(`保存第 ${floor} 楼的编辑？\n\n${memoryRollbackNoticeForFloor(floor)}`)) {return;}
    const substitutedContent = await substituteEditedMessageContent(message, content);
    const regexedContent = await applyEditRegexToMessageContent(message, substitutedContent);
    const updated = await updateTavernMessage(message.sessionId, message.order, {
        content: regexedContent,
        ...(message.role === 'user' ? { runtimeEvents: [] } : {}),
    });
    if (updated) {
        await cancelAndRollbackXbTavernManagersForMessageRange(message.sessionId, message.order);
        await restoreMemoryStateBeforeMessage(message.sessionId, message.order);
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
    const sorted = [...sessionMessages.value].sort((left, right) => left.order - right.order);
    const startIndex = sorted.findIndex((item) => item.order === message.order);
    if (startIndex < 0) {return [message.order];}
    return sorted.slice(startIndex).map((item) => item.order);
}

async function deleteMessageTurn(message: TavernMessageRecord) {
    if (isRunning.value) {return;}
    const ordersToDelete = findDeleteOrders(message);
    const floor = Math.max(1, Number(message.order) + 1);
    const confirmText = ordersToDelete.length > 1
        ? `从第 ${floor} 楼开始删除后续剧情？将移除 ${ordersToDelete.length} 楼。\n\n${memoryRollbackNoticeForFloor(floor)}`
        : `删除第 ${floor} 楼？\n\n${memoryRollbackNoticeForFloor(floor)}`;
    if (!window.confirm(confirmText)) {return;}
    const fromOrder = Math.min(...ordersToDelete);
    await cancelAndRollbackXbTavernManagersForMessageRange(message.sessionId, fromOrder);
    const deleted = await deleteTavernMessages(message.sessionId, ordersToDelete);
    if (deleted > 0) {
        await restoreMemoryStateBeforeMessage(message.sessionId, fromOrder);
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

const updateChatScrollButtons = chatScrollPane.updateScrollButtons;
const updateManagerScrollButtons = managerScrollPane.updateScrollButtons;
const scrollChatToBottom = chatScrollPane.scrollToBottom;
const scrollChatToTop = chatScrollPane.scrollToTop;
const scrollManagerToBottom = managerScrollPane.scrollToBottom;
const scrollManagerToTop = managerScrollPane.scrollToTop;
const handleChatScroll = chatScrollPane.handleScroll;
const handleManagerScroll = managerScrollPane.handleScroll;
const handleChatWheel = chatScrollPane.handleWheel;
const handleManagerWheel = managerScrollPane.handleWheel;
const handleChatTouchStart = chatScrollPane.handleTouchStart;
const handleManagerTouchStart = managerScrollPane.handleTouchStart;
const handleChatTouchMove = chatScrollPane.handleTouchMove;
const handleManagerTouchMove = managerScrollPane.handleTouchMove;

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

function shouldRunTavernSlashCommand(text: string, options: { reuseUserMessageOrder?: number } = {}) {
    return !Number.isFinite(Number(options.reuseUserMessageOrder)) && text.trim().startsWith('/');
}

function normalizeSlashPipeForMessage(value: unknown): string {
    if (value === undefined || value === null) {return '';}
    if (typeof value === 'string') {return value.trim();}
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

async function resolveSlashCommandMessageText(messageText: string, options: { reuseUserMessageOrder?: number } = {}): Promise<string> {
    if (!shouldRunTavernSlashCommand(messageText, options)) {
        return messageText;
    }
    const response = await requestHost('xb-tavern:run-slash-command', {
        payload: { command: messageText },
    });
    const result = (response.result || response) as Record<string, unknown>;
    const execution = result.execution && typeof result.execution === 'object'
        ? result.execution as Record<string, unknown>
        : {};
    if (result.ok === false || execution.isError === true || execution.isAborted === true) {
        throw new Error(String(result.error || execution.errorMessage || execution.abortReason || 'slash_command_failed'));
    }
    const pipe = normalizeSlashPipeForMessage(result.pipe);
    if (!pipe) {
        currentUserMessage.value = '';
        void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
        showComposeError('斜杠命令已执行，没有输出。', 2600);
        return '';
    }
    return pipe;
}

function buildUiSubstituteParamsOptions(contextSnapshot: XbTavernContext = {}): TavernSubstituteParamsOptions {
    const options: TavernSubstituteParamsOptions = {};
    const userName = String(contextSnapshot.user?.name || '').trim();
    const characterName = String(contextSnapshot.character?.name || '').trim();
    if (userName) {options.name1Override = userName;}
    if (characterName) {options.name2Override = characterName;}
    return options;
}

async function substituteEditedMessageContent(message: TavernMessageRecord, content: string): Promise<string> {
    const session = sessions.value.find((item) => item.id === message.sessionId)
        || (selectedSessionId.value === message.sessionId ? selectedSession.value : null);
    const contextSnapshot = (session?.contextSnapshot || context.value || {}) as XbTavernContext;
    const result = await applyTavernSubstituteParams([{
        id: `edit:${message.sessionId}:${message.order}`,
        text: content,
        options: buildUiSubstituteParamsOptions(contextSnapshot),
    }]);
    return result.items[0]?.text ?? content;
}

async function applyEditRegexToMessageContent(message: TavernMessageRecord, content: string): Promise<string> {
    const placement = messageRegexPlacement(message);
    if (!placement) {return content;}
    const result = await applyTavernRegex([{
        id: `edit:${message.sessionId}:${message.order}`,
        text: content,
        placement,
        options: {
            isEdit: true,
            characterOverride: messageCharacterOverride(message),
        },
    }]);
    return result.items[0]?.text ?? content;
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
    clearRuntimeDisplayRegexRequests();
    runtimeText.value = '';
    runtimeThoughts.value = [];
    runtimeActionCheckEvents.value = [];
    runtimeUserMessageVisible.value = false;
    runtimePendingUserMessage.value = '';
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
    isManagerAssistantRunning.value = true;
    isManagerAssistantCancelling.value = false;
    managerInputStatus.value = '准备中';
    if (isManagerAssistantCancelling.value) {
        isManagerAssistantRunning.value = false;
        isManagerAssistantCancelling.value = false;
        managerInputDraft.value = text;
        managerInputStatus.value = '';
        return;
    }
    isManagerAssistantRunning.value = false;
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

async function runOnce(options: { messageText?: string; reuseUserMessageOrder?: number; rerollRuntimeEvents?: boolean } = {}) {
    if (isRunning.value) {
        cancelActiveRun();
        return;
    }
    clearComposeError();
    let messageText = String(options.messageText ?? currentUserMessage.value ?? '').trim();
    if (!messageText) {
        runtimeError.value = '先写一句话。';
        showComposeError('先写一句话。');
        return;
    }
    try {
        messageText = await resolveSlashCommandMessageText(messageText, options);
    } catch (error) {
        const errorText = describeError(error);
        runtimeError.value = errorText;
        showComposeError(errorText);
        return;
    }
    if (!messageText) {
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
    runtimeUserMessageVisible.value = false;
    runtimePendingUserMessage.value = '';
    runtimeProvider.value = '';
    runtimeModel.value = '';
    chatAutoScroll.value = true;
    resetChatMessageWindowState();
    const shouldShowPendingUserMessage = !Number.isFinite(Number(options.reuseUserMessageOrder));
    if (shouldShowPendingUserMessage) {
        runtimePendingUserMessage.value = messageText;
        currentUserMessage.value = '';
        void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
        scrollChatToBottom(true);
    }
    try {
        if (controller.signal.aborted) {
            const pendingUserMessage = runtimePendingUserMessage.value;
            clearRuntimeAssistantLiveState();
            if (pendingUserMessage && !currentUserMessage.value.trim()) {
                currentUserMessage.value = pendingUserMessage;
                void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
            }
            return;
        }
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
            chatPreset: runtimeChatPreset.value,
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
            buildNativeChatPrompt,
            onStreamProgress: (snapshot) => {
                if (typeof snapshot.text === 'string') {runtimeText.value = snapshot.text;}
                if (Array.isArray(snapshot.thoughts)) {runtimeThoughts.value = thoughtBlocks(snapshot.thoughts);}
                if (Array.isArray(snapshot.liveActionCheckEvents)) {
                    runtimeActionCheckEvents.value = snapshot.liveActionCheckEvents.map((event) => ({ ...event }));
                }
            },
            onUserMessageSaved: async (sessionId, message) => {
                selectedSessionId.value = sessionId;
                const existingIndex = sessionMessages.value.findIndex((item) => item.sessionId === message.sessionId && item.order === message.order);
                sessionMessages.value = existingIndex >= 0
                    ? sessionMessages.value.map((item, index) => index === existingIndex ? message : item)
                    : [...sessionMessages.value, message].sort((left, right) => left.order - right.order);
                runtimeUserMessageVisible.value = true;
                runtimePendingUserMessage.value = '';
                currentUserMessage.value = '';
                void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
                scrollChatToBottom(true);
                await setSelectedTavernSessionId(sessionId);
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
        const pendingUserMessage = runtimePendingUserMessage.value;
        clearRuntimeAssistantLiveState();
        if (pendingUserMessage && !currentUserMessage.value.trim()) {
            currentUserMessage.value = pendingUserMessage;
            void nextTick(() => resetTextareaHeight(chatComposeTextareaRef.value));
        }
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
    () => runtimePendingUserMessage.value,
    () => runtimeThoughtsSignature.value,
    () => runtimeActionCheckSignature.value,
    () => htmlRenderEnabled.value,
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
    chatScrollPane.resetPositionState();
    managerScrollPane.resetPositionState();
    memoryFileSearchText.value = '';
    memoryFileGroupVisibleLimits.value = {};
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
    shell: {
        activeView,
        chatFocus,
        homeThemeDark,
        openPromptInspector,
        postToHost,
        rememberBrokenAvatar,
        shortText,
    },
    chat: {
        actionFeedback,
        cancelEditMessage,
        canDrawMessage,
        canEditMessage,
        canRerunMessage,
        canSendMessage,
        createNewChatSession,
        currentAuthorNote,
        CHAT_SIDEBAR_BATCH_SIZE,
        chatAutoScroll,
        chatFocus,
        chatLayout,
        chatMessages,
        chatMessageWindow,
        chatComposeTextareaRef,
        chatScrollControlsActive,
        chatScrollRef,
        chatSidebarSessionLimit,
        chatSidebarSessions,
        chatSidePanel,
        chatSubtitle,
        copyMessage,
        currentUserMessage,
        deleteMessageTurn,
        displayMessageContent,
        displayMessageRenderProjection,
        displayMessageThoughtBlocks,
        displayRuntimeContent,
        displayRuntimeRenderProjection,
        displayRuntimeThoughtBlocks,
        displayCharacterName,
        drawMessage,
        drawMessageStatusClass,
        drawMessageStatusText,
        drawMessageTitle,
        drawProgressText,
        filteredChatSidebarSessionCount,
        formatMessageTime,
        handleChatScroll,
        handleChatSubmit,
        handleChatTouchMove,
        handleChatTouchStart,
        handleChatWheel,
        handleComposeInput,
        handleComposeKeydown,
        hiddenChatSidebarSessionCount,
        isDrawingMessage,
        isEditingMessage,
        isCancellingRun,
        isRunning,
        latestErrorMessage,
        markdownSignature,
        htmlRenderEnabled,
        messageKey,
        normalizeTavernSessionState,
        removeSession,
        renderChatMarkdown,
        rerunFromMessage,
        revealOlderChatMessages,
        roleLabel,
        runtimeText,
        runtimeThoughts,
        runtimeActionCheckEvents,
        runtimeUserMessageVisible,
        runtimePendingUserMessage,
        saveEditMessage,
        scrollChatToBottom,
        scrollChatToTop,
        selectedSessionId,
        selectSession,
        saveCurrentAuthorNote,
        sessionDisplayTitle,
        sessionFloorLabel,
        sessions,
        showChatScrollBottom,
        showChatScrollTop,
        startEditMessage,
        thoughtBlocks,
        thoughtSummaryLabel,
        updateChatScrollButtons,
        visibleCharacterAvatar,
        visibleChatMessages,
        visibleUserAvatar,
    },
    manager: {
        activeMemoryFiles,
        archivedManagerRuns,
        canEditManagerMessage,
        canRerunManagerMessage,
        canSendManagerMessage,
        copyManagerMessage,
        currentManagerWorkRun,
        deleteManagerMessageTurn,
        editingMessageDraft,
        formatRunActivityLine,
        formatRunIssueLine,
        formatRunInputLine,
        formatRunMapLine,
        formatRunMemoryLine,
        formatRunModelLine,
        handleEditInput,
        handleManagerComposeKeydown,
        handleManagerEditKeydown,
        handleManagerScroll,
        handleManagerSubmit,
        handleManagerTouchMove,
        handleManagerTouchStart,
        handleManagerWheel,
        hiddenManagerRunCount,
        isEditingManagerMessage,
        isEditingManagerMessageDirty,
        isManagerRunRetrying,
        isManagerAssistantCancelling,
        isManagerAssistantRunning,
        liveManagerChatDisplayItems,
        managerActionFeedback,
        managerAutoScroll,
        managerBusy,
        managerCompactionOverlay,
        managerComposeTextareaRef,
        managerInputDraft,
        managerInputStatus,
        managerMessageWindow,
        managerRuns,
        managerRunTone,
        managerScrollControlsActive,
        managerScrollRef,
        managerStatusLabel,
        managerToolStatusLabel,
        managerToolTone,
        managerToolTraceItems,
        managerToolTurnPreview,
        managerToolTurnSummary,
        memoryFileDisplayName,
        memoryFiles,
        memoryIndexStatusLine,
        retryManagerRun,
        revealOlderManagerMessages,
        rerunFromManagerMessage,
        saveEditManagerMessage,
        scrollManagerToBottom,
        scrollManagerToTop,
        selectedMemoryFile,
        showManagerScrollBottom,
        showManagerScrollTop,
        startEditManagerMessage,
        toolTraceSummary,
        updateManagerScrollButtons,
        visibleManagerChatItems,
    },
    memory: {
        activeMemoryFiles,
        discardMemoryDraft,
        enterMemoryEditMode,
        expandMemoryFileGroup,
        formatMemoryFileMeta,
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
        previewMemoryDraft,
        renderChatMarkdown,
        saveSelectedMemoryFile,
        selectedMemoryFileEntry,
        selectedMemoryFile,
        selectedMemoryFilePath,
        selectMemoryFile,
        stateMemoryFile,
    },
    workspace: {
        activeMemoryFiles,
        chatWorkspacePanel,
        mapStateDocument,
        mapStatePatches,
        saveSessionContract,
        selectedSessionId,
        sessionContract,
        stateMemoryFile,
    },
    settings: settingsContext,
});

async function runPostReadyStartupTasks() {
    const startupResults = await Promise.allSettled([
        refreshPresets(),
        refreshSessions(),
    ]);
    const firstError = startupResults.find((result) => result.status === 'rejected');
    if (firstError?.status === 'rejected') {
        statusText.value = describeError(firstError.reason);
    }
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
    if (activeView.value === 'settings' && activeSettingsWorkspace.value === 'base') {
        void loadTavernUsers();
    }
    if (selectedSessionId.value) {
        void syncSessionCharacterContext({ sessionId: selectedSessionId.value, force: true });
    }
    if (activeView.value === 'chat' && chatFocus.value === 'chat') {
        scrollChatToBottom(true);
    }
}

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
    syncApiSettingsConfigFromAgentConfig();
    await nextTick();
    postToHost('xb-tavern:frame-ready');
});

onUnmounted(() => {
    window.removeEventListener('message', onHostMessage);
    setHostChatCompletionsRequestHeadersProvider(null);
    pendingHostRequests.forEach((request) => {
        if (request.abort && request.signal) {
            request.signal.removeEventListener('abort', request.abort);
        }
        request.reject(new Error('tavern_unmounted'));
    });
    pendingHostRequests.clear();
    activeRunController.value?.abort();
    managerAssistantController.value?.abort();
    tavernDrawController.value?.abort();
    chatScrollPane.cleanup();
    managerScrollPane.cleanup();
    if (composeErrorHideTimer) {
        window.clearTimeout(composeErrorHideTimer);
        composeErrorHideTimer = null;
    }
    if (managerRecordsPollTimer) {
        window.clearInterval(managerRecordsPollTimer);
        managerRecordsPollTimer = null;
    }
    clearDisplayRegexCache();
    clearManagerCompactionOverlayHideTimer();
    clearPendingCharacterSession();
});
</script>

<template>
  <main
    class="xb-tavern xb-os-shell"
    :class="{ 'is-home-view': activeView === 'home' || activeView === 'about', 'theme-dark': homeThemeDark, 'theme-light': !homeThemeDark }"
    :data-chat-font-size="tavernDisplaySettings.chatFontSize"
    :style="rootTypographyStyle"
  >
    <section class="xb-os-stage">
      <TavernHomePage
        v-if="activeView === 'home'"
        :dark="homeThemeDark"
        :has-session="canResumeSelectedSession"
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
        :selected-character-sessions="selectedCharacterSessions"
        :selected-greeting-index="selectedCharacterGreetingIndex"
        :pending-preview-character-id="pendingCharacterPreviewId"
        :pending-character-session-id="pendingCharacterSessionId"
        :character-worldbook-state="characterWorldbookState"
        :character-worldbook-busy="characterWorldbookBusy"
        :hidden-count="hiddenCharacterCount"
        :batch-size="CHARACTER_ARCHIVE_BATCH_SIZE"
        :avatar-available="avatarAvailable"
        :session-floor-label="sessionFloorLabel"
        :short-text="shortText"
        @toggle-theme="homeThemeDark = !homeThemeDark"
        @back="activeView = 'home'"
        @refresh="refreshCharacterList"
        @select="selectCharacterForPreview"
        @select-greeting="selectCharacterGreeting"
        @enter-selected="enterSelectedCharacter"
        @open-character-worldbook="openSelectedCharacterWorldbook"
        @open-session="selectSession"
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

    <div
      v-if="characterWorldbookSelectionOpen"
      class="character-worldbook-picker-overlay"
      @click.self="closeCharacterWorldbookSelection"
    >
      <section class="character-worldbook-picker">
        <header>
          <strong>选择角色世界书</strong>
          <button
            type="button"
            class="worldbook-picker-close"
            aria-label="关闭"
            @click="closeCharacterWorldbookSelection"
          />
        </header>
        <div
          v-if="characterWorldbookStatus"
          class="worldbook-picker-status"
        >
          {{ characterWorldbookStatus }}
        </div>
        <div class="worldbook-picker-list">
          <button
            v-for="name in characterWorldbookSelectionOptions"
            :key="name"
            type="button"
            :disabled="characterWorldbookBusy"
            @click="bindSelectedCharacterWorldbook(name)"
          >
            {{ name }}
          </button>
        </div>
      </section>
    </div>
  </main>
</template>
