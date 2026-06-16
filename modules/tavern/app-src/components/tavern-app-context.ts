import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { TavernSettingsNavItem } from './TavernSettingsSidebar.vue';
import type {
    TavernAssistantPreset,
} from '../../shared/assistant-presets';
import type {
    TavernChatPromptPresetBundle,
} from '../../shared/message-assembler';
import type { ManagerChatDisplayItem } from '../manager-tool-display';
import type {
    TavernSessionContract,
} from '../../shared/session-contract';
import type {
    TavernActionCheckRuntimeEvent,
} from '../../shared/runtime-events';
import type {
    TavernAssistantPresetRecord,
    TavernManagerMessageRecord,
    TavernManagerRunRecord,
    TavernMemoryFileListEntry,
    TavernMemoryFileRecord,
    TavernMemoryIndexFileEntry,
    TavernMessageRecord,
    TavernSessionRecord,
    TavernStructuredStateDocumentRecord,
    TavernStructuredStatePatchRecord,
} from '../../shared/session-db';

export type TavernReadable<T> = Ref<T> | ComputedRef<T>;
export type TavernCommand<TArgs extends unknown[] = [], TResult = void> = (...args: TArgs) => TResult;

export interface TavernPromptEditorRow {
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
    orderEntry: { [key: string]: unknown };
    prompt: { [key: string]: unknown };
    listed: boolean;
    searchCorpus?: string;
}

export interface TavernAssistantPresetItemRow {
    id: string;
    key: string;
    label: string;
    summary: string;
    content: string;
}

export interface TavernChatPresetOptionRow {
    name: string;
    label: string;
}

export interface TavernWorldbookOptionRow {
    name: string;
    globalActive?: boolean;
}

export interface TavernWorldbookPreviewEntryRow {
    uid: string;
    name: string;
    keys: string[];
    secondaryKeys: string[];
    contentPreview: string;
    enabled: boolean;
    constant: boolean;
    order: number;
}

export interface TavernWorldbookPreviewRow {
    name: string;
    entryCount: number;
    enabledCount: number;
    constantCount: number;
    disabledCount: number;
    keywordCount: number;
    totalChars: number;
    entries: TavernWorldbookPreviewEntryRow[];
}

export interface TavernWorldbookEntryDraft {
    worldbookName: string;
    uid: string;
    comment: string;
    name: string;
    title: string;
    key: string[];
    keysecondary: string[];
    secondary_keys: string[];
    content: string;
    disable: boolean;
    enabled: boolean;
    constant: boolean;
    order: number;
    entryHash: string;
    revision: string;
}

export interface TavernRegexScriptDraft {
    scriptName?: string;
    findRegex?: string;
    replaceString?: string;
    scriptType?: number;
    disabled?: boolean;
    placement?: number[];
    [key: string]: unknown;
}

export interface TavernRegexGroupRow {
    key: string;
    label: string;
    scriptType: number;
    scripts: TavernRegexScriptDraft[];
    allowed?: boolean;
}

export interface TavernRegexScriptRow {
    key: string;
    scriptType: number;
    groupKey: string;
    groupLabel: string;
    script: TavernRegexScriptDraft;
    isNew?: boolean;
    searchCorpus?: string;
}

export interface TavernRegexGroupDisplayRow extends TavernRegexGroupRow {
    visibleRows: TavernRegexScriptRow[];
    totalCount: number;
    filteredCount: number;
    hiddenCount: number;
}

export interface TavernMemoryDirectoryGroup {
    key: string;
    title: string;
    totalCount: number;
    hiddenCount: number;
    files: TavernMemoryIndexFileEntry[];
}

export interface TavernMessageWindowState {
    startIndex: number;
    hiddenBefore: number;
    visibleCount: number;
}

export interface TavernManagerCompactionOverlay {
    active?: boolean;
    resolved?: boolean;
    status?: string;
    currentTokens?: number;
    triggerTokens?: number;
    yieldTokens?: number;
}

export interface TavernManagerToolTraceItem {
    id: string;
    round: number;
    name: string;
    status: string;
    ok: boolean;
    args: string;
    path: string;
    summary: string;
    error: string;
    preface: string;
    thoughts: Array<{ label?: string; text?: string }>;
    elapsedLabel: string;
}

export interface TavernShellContext {
    activeView: Ref<string>;
    chatFocus: Ref<string>;
    homeThemeDark: Ref<boolean>;
    openPromptInspector: TavernCommand<[tab?: 'history' | 'simulate']>;
    postToHost: TavernCommand<[type: string, payload?: object]>;
    rememberBrokenAvatar: TavernCommand<[url?: string]>;
    shortText: TavernCommand<[value?: string, limit?: number], string>;
}

export interface TavernChatContext {
    actionFeedback: TavernCommand<[message: TavernMessageRecord, action: string], string>;
    cancelEditMessage: TavernCommand;
    canDrawMessage: TavernCommand<[message: TavernMessageRecord], boolean>;
    canEditMessage: TavernCommand<[message: TavernMessageRecord], boolean>;
    canRerunMessage: TavernCommand<[message: TavernMessageRecord], boolean>;
    canSendMessage: TavernReadable<boolean>;
    CHAT_SIDEBAR_BATCH_SIZE: number;
    chatAutoScroll: Ref<boolean>;
    chatFocus: Ref<string>;
    chatLayout: Ref<string>;
    chatMessages: TavernReadable<TavernMessageRecord[]>;
    chatMessageWindow: TavernReadable<TavernMessageWindowState>;
    chatComposeTextareaRef: Ref<HTMLTextAreaElement | null>;
    chatScrollControlsActive: Ref<boolean>;
    chatScrollRef: Ref<HTMLElement | null>;
    chatSidebarSessionLimit: Ref<number>;
    chatSidebarSessions: TavernReadable<TavernSessionRecord[]>;
    chatSidePanel: Ref<string>;
    chatSubtitle: TavernReadable<string>;
    copyMessage: TavernCommand<[message: TavernMessageRecord], Promise<void>>;
    currentUserMessage: Ref<string>;
    deleteMessageTurn: TavernCommand<[message: TavernMessageRecord], Promise<void>>;
    displayMessageContent: TavernCommand<[message: TavernMessageRecord], string>;
    displayMessageRenderProjection: TavernCommand<[message: TavernMessageRecord], { text: string; actionCheckEvents: TavernActionCheckRuntimeEvent[] }>;
    displayMessageThoughtBlocks: TavernCommand<[message: TavernMessageRecord], Array<{ label?: string; text?: string }>>;
    displayRuntimeContent: TavernCommand<[text?: string], string>;
    displayRuntimeRenderProjection: TavernCommand<[text?: string, events?: TavernActionCheckRuntimeEvent[]], { text: string; actionCheckEvents: TavernActionCheckRuntimeEvent[] }>;
    displayRuntimeThoughtBlocks: TavernCommand<[thoughts?: Array<{ label?: string; text?: string }>], Array<{ label?: string; text?: string }>>;
    displayCharacterName: TavernReadable<string>;
    drawMessage: TavernCommand<[message: TavernMessageRecord], Promise<void>>;
    drawMessageStatusClass: TavernCommand<[message: TavernMessageRecord], string>;
    drawMessageStatusText: TavernCommand<[message: TavernMessageRecord], string>;
    drawMessageTitle: TavernCommand<[message: TavernMessageRecord], string>;
    drawProgressText: Ref<string>;
    filteredChatSidebarSessionCount: TavernReadable<number>;
    formatMessageTime: TavernCommand<[value: unknown], string>;
    handleChatScroll: TavernCommand;
    handleChatSubmit: TavernCommand;
    handleChatTouchMove: TavernCommand<[event: TouchEvent]>;
    handleChatTouchStart: TavernCommand<[event: TouchEvent]>;
    handleChatWheel: TavernCommand<[event: WheelEvent]>;
    handleComposeInput: TavernCommand<[event: Event]>;
    handleComposeKeydown: TavernCommand<[event: KeyboardEvent]>;
    hiddenChatSidebarSessionCount: TavernReadable<number>;
    isDrawingMessage: TavernCommand<[message: TavernMessageRecord], boolean>;
    isEditingMessage: TavernCommand<[message: TavernMessageRecord], boolean>;
    isCancellingRun: Ref<boolean>;
    isRunning: Ref<boolean>;
    latestErrorMessage: TavernReadable<string>;
    markdownSignature: TavernCommand<[text?: string], string>;
    messageKey: TavernCommand<[message: TavernMessageRecord], string>;
    normalizeTavernSessionState: TavernCommand<[value?: unknown], { turn?: number }>;
    removeSession: TavernCommand<[sessionId: string, event?: Event], Promise<void>>;
    renderChatMarkdown: TavernCommand<[text?: string, options?: { roleplay?: boolean; userName?: string; characterName?: string }], string>;
    rerunFromMessage: TavernCommand<[message: TavernMessageRecord], Promise<void>>;
    revealOlderChatMessages: TavernCommand<[force?: boolean], boolean>;
    roleLabel: TavernCommand<[role?: string], string>;
    runtimeActionCheckEvents: Ref<TavernActionCheckRuntimeEvent[]>;
    runtimeText: Ref<string>;
    runtimeThoughts: Ref<Array<{ label?: string; text?: string }>>;
    saveEditMessage: TavernCommand<[message: TavernMessageRecord, options?: { rerun?: boolean; content?: string }], Promise<void>>;
    scrollChatToBottom: TavernCommand<[force?: boolean, options?: { collapseWindow?: boolean; revealHelpers?: boolean }]>;
    scrollChatToTop: TavernCommand;
    selectedSessionId: Ref<string>;
    selectSession: TavernCommand<[sessionId: string], Promise<void>>;
    sessionDisplayTitle: TavernCommand<[session?: TavernSessionRecord | null], string>;
    sessionFloorLabel: TavernCommand<[session?: TavernSessionRecord | null], string>;
    sessions: Ref<TavernSessionRecord[]>;
    showChatScrollBottom: Ref<boolean>;
    showChatScrollTop: Ref<boolean>;
    startEditMessage: TavernCommand<[message: TavernMessageRecord]>;
    thoughtBlocks: TavernCommand<[messageOrThoughts: unknown], Array<{ label?: string; text?: string }>>;
    thoughtSummaryLabel: TavernCommand<[messageOrThoughts: unknown, streaming?: boolean], string>;
    updateChatScrollButtons: TavernCommand;
    visibleCharacterAvatar: TavernReadable<string>;
    visibleChatMessages: TavernReadable<TavernMessageRecord[]>;
    visibleUserAvatar: TavernReadable<string>;
}

export interface TavernManagerContext {
    activeMemoryFiles: TavernReadable<TavernMemoryIndexFileEntry[]>;
    archivedManagerRuns: TavernReadable<TavernManagerRunRecord[]>;
    canEditManagerMessage: TavernCommand<[message: TavernManagerMessageRecord], boolean>;
    canRerunManagerMessage: TavernCommand<[message: TavernManagerMessageRecord], boolean>;
    canSendManagerMessage: TavernReadable<boolean>;
    copyManagerMessage: TavernCommand<[message: TavernManagerMessageRecord], Promise<void>>;
    currentManagerWorkRun: TavernReadable<TavernManagerRunRecord | null>;
    deleteManagerMessageTurn: TavernCommand<[message: TavernManagerMessageRecord], Promise<void>>;
    editingMessageDraft: Ref<string>;
    formatRunActivityLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    formatRunIssueLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    formatRunInputLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    formatRunMapLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    formatRunMemoryLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    formatRunModelLine: TavernCommand<[run: TavernManagerRunRecord], string>;
    handleManagerComposeKeydown: TavernCommand<[event: KeyboardEvent]>;
    handleEditInput: TavernCommand<[event: Event]>;
    handleManagerEditKeydown: TavernCommand<[event: KeyboardEvent, message: TavernManagerMessageRecord]>;
    handleManagerScroll: TavernCommand;
    handleManagerSubmit: TavernCommand<[], Promise<void>>;
    handleManagerTouchMove: TavernCommand<[event: TouchEvent]>;
    handleManagerTouchStart: TavernCommand<[event: TouchEvent]>;
    handleManagerWheel: TavernCommand<[event: WheelEvent]>;
    hiddenManagerRunCount: TavernReadable<number>;
    isEditingManagerMessage: TavernCommand<[message: TavernManagerMessageRecord], boolean>;
    isEditingManagerMessageDirty: TavernCommand<[message: TavernManagerMessageRecord], boolean>;
    isManagerAssistantCancelling: Ref<boolean>;
    isManagerAssistantRunning: Ref<boolean>;
    isManagerRunRetrying: TavernCommand<[run: TavernManagerRunRecord | null | undefined], boolean>;
    liveManagerChatDisplayItems: TavernReadable<ManagerChatDisplayItem[]>;
    managerActionFeedback: TavernCommand<[message: TavernManagerMessageRecord, action: string], string>;
    managerAutoScroll: Ref<boolean>;
    managerBusy: TavernReadable<boolean>;
    managerCompactionOverlay: Ref<TavernManagerCompactionOverlay | null>;
    managerComposeTextareaRef: Ref<HTMLTextAreaElement | null>;
    managerInputDraft: Ref<string>;
    managerInputStatus: Ref<string>;
    managerMessageWindow: TavernReadable<TavernMessageWindowState>;
    managerRuns: Ref<TavernManagerRunRecord[]>;
    managerRunTone: TavernCommand<[runOrStatus: TavernManagerRunRecord | string], string>;
    managerScrollControlsActive: Ref<boolean>;
    managerScrollRef: Ref<HTMLElement | null>;
    managerStatusLabel: TavernCommand<[status?: string], string>;
    managerToolStatusLabel: TavernCommand<[item: { status?: string; ok?: boolean }], string>;
    managerToolTone: TavernCommand<[item: { status?: string; ok?: boolean }], string>;
    managerToolTraceItems: TavernCommand<[value: unknown], TavernManagerToolTraceItem[]>;
    managerToolTurnPreview: TavernCommand<[item: ManagerChatDisplayItem], string>;
    managerToolTurnSummary: TavernCommand<[item: ManagerChatDisplayItem], string>;
    memoryFileDisplayName: TavernCommand<[fileOrPath?: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null], string>;
    memoryFiles: Ref<TavernMemoryIndexFileEntry[]>;
    memoryIndexStatusLine: TavernReadable<string>;
    retryManagerRun: TavernCommand<[run: TavernManagerRunRecord], Promise<void>>;
    revealOlderManagerMessages: TavernCommand<[force?: boolean], boolean>;
    rerunFromManagerMessage: TavernCommand<[message: TavernManagerMessageRecord], Promise<void>>;
    saveEditManagerMessage: TavernCommand<[message: TavernManagerMessageRecord, options?: { rerun?: boolean }], Promise<void>>;
    scrollManagerToBottom: TavernCommand<[force?: boolean, options?: { collapseWindow?: boolean; revealHelpers?: boolean }]>;
    scrollManagerToTop: TavernCommand;
    selectedMemoryFile: TavernReadable<TavernMemoryFileRecord | null>;
    showManagerScrollBottom: Ref<boolean>;
    showManagerScrollTop: Ref<boolean>;
    startEditManagerMessage: TavernCommand<[message: TavernManagerMessageRecord]>;
    toolTraceSummary: TavernCommand<[value: unknown], string>;
    updateManagerScrollButtons: TavernCommand;
    visibleManagerChatItems: TavernReadable<ManagerChatDisplayItem[]>;
}

export interface TavernMemoryContext {
    activeMemoryFiles: TavernReadable<TavernMemoryIndexFileEntry[]>;
    discardMemoryDraft: TavernCommand;
    enterMemoryEditMode: TavernCommand;
    expandMemoryFileGroup: TavernCommand<[groupKey?: string]>;
    formatMemoryFileMeta: TavernCommand<[file: TavernMemoryFileListEntry | TavernMemoryFileRecord], string>;
    markdownSignature: TavernCommand<[text?: string], string>;
    MEMORY_FILE_BATCH_SIZE: number;
    MEMORY_TURN_BATCH_SIZE: number;
    memoryDirectoryGroups: TavernReadable<TavernMemoryDirectoryGroup[]>;
    memoryEditorDirty: TavernReadable<boolean>;
    memoryEditorDocumentAvailable: TavernReadable<boolean>;
    memoryEditorDraft: Ref<string>;
    memoryEditorLoadedPath: Ref<string>;
    memoryEditorMode: Ref<'preview' | 'edit'>;
    memoryEditorReadOnly: TavernReadable<boolean>;
    memoryEditorStatus: Ref<string>;
    memoryFileDisplayName: TavernCommand<[fileOrPath?: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null], string>;
    memoryFileKindLabel: TavernCommand<[fileOrPath?: TavernMemoryFileListEntry | TavernMemoryFileRecord | string | null], string>;
    memoryFiles: Ref<TavernMemoryIndexFileEntry[]>;
    memoryFileSearchText: Ref<string>;
    memoryFileStatusLabel: TavernCommand<[status?: string], string>;
    previewMemoryDraft: TavernCommand;
    renderChatMarkdown: TavernCommand<[text?: string, options?: { roleplay?: boolean; userName?: string; characterName?: string }], string>;
    saveSelectedMemoryFile: TavernCommand<[], Promise<void>>;
    selectedMemoryFileEntry: TavernReadable<TavernMemoryIndexFileEntry | null>;
    selectedMemoryFile: TavernReadable<TavernMemoryFileRecord | null>;
    selectedMemoryFilePath: Ref<string>;
    selectMemoryFile: TavernCommand<[path?: string]>;
    stateMemoryFile: Ref<TavernMemoryFileRecord | null>;
}

export interface TavernWorkspaceContext {
    activeMemoryFiles: TavernReadable<TavernMemoryIndexFileEntry[]>;
    chatWorkspacePanel: Ref<string>;
    mapStateDocument: Ref<TavernStructuredStateDocumentRecord | null>;
    mapStatePatches: Ref<TavernStructuredStatePatchRecord[]>;
    saveSessionContract: TavernCommand<[nextContract?: Partial<TavernSessionContract>], Promise<TavernSessionRecord | null>>;
    selectedSessionId: Ref<string>;
    sessionContract: TavernReadable<TavernSessionContract>;
    stateMemoryFile: Ref<TavernMemoryFileRecord | null>;
}

export interface TavernSettingsContext {
    activeAssistantPresetId: Ref<string>;
    activePromptOrderLabel: TavernReadable<string>;
    activeSettingsWorkspace: Ref<string>;
    activeView: Ref<string>;
    apiReady: TavernReadable<boolean>;
    apiReadyDetail: TavernReadable<string>;
    apiRuntimeLine: TavernReadable<string>;
    apiSettingsRootRef: Ref<HTMLElement | null>;
    applyActiveRegexScript: TavernCommand<[row: TavernRegexScriptRow | null]>;
    ASSISTANT_PRESET_BATCH_SIZE: number;
    assistantPreset: Ref<TavernAssistantPreset>;
    assistantPresetDirty: TavernReadable<boolean>;
    assistantPresetItems: TavernReadable<TavernAssistantPresetItemRow[]>;
    assistantPresets: Ref<TavernAssistantPresetRecord[]>;
    assistantPresetSearchText: Ref<string>;
    assistantPresetStatus: Ref<string>;
    assistantPresetVisibleLimit: Ref<number>;
    canEditPromptOrder: TavernReadable<boolean>;
    cancelWorldbookEntryEdit: TavernCommand;
    chatPresetOptions: TavernReadable<TavernChatPresetOptionRow[]>;
    chatPresetSourceSearchText: Ref<string>;
    chatPresetSourceVisibleLimit: Ref<number>;
    CHAT_PRESET_SOURCE_BATCH_SIZE: number;
    createAssistantPreset: TavernCommand<[], Promise<void>>;
    createRegexScript: TavernCommand<[group: TavernRegexGroupRow]>;
    deleteCurrentAssistantPreset: TavernCommand<[], Promise<void>>;
    deleteCurrentRegexScript: TavernCommand<[], Promise<void>>;
    deriveAssistantPreset: TavernCommand<[], Promise<void>>;
    discardAssistantPresetChanges: TavernCommand<[], Promise<void>>;
    discardPresetChanges: TavernCommand<[], Promise<void>>;
    expandRegexGroup: TavernCommand<[groupKey?: string]>;
    filteredPromptEditorRows: TavernReadable<TavernPromptEditorRow[]>;
    globalWorldbookOptions: Ref<string[]>;
    globalWorldbookSelected: Ref<string[]>;
    globalWorldbookSaving: Ref<boolean>;
    globalWorldbookStatus: Ref<string>;
    hiddenAssistantPresetCount: TavernReadable<number>;
    hiddenChatPresetOptionCount: TavernReadable<number>;
    hiddenPromptCount: TavernReadable<number>;
    hiddenWorldbookCount: TavernReadable<number>;
    hiddenWorldbookPreviewEntryCount: TavernReadable<number>;
    homeThemeDark: Ref<boolean>;
    importAssistantPreset: TavernCommand<[payload: unknown], Promise<boolean>>;
    isEditingWorldbookEntry: TavernCommand<[entry: TavernWorldbookPreviewEntryRow], boolean>;
    linesFromList: TavernCommand<[value: unknown], string>;
    listFromLines: TavernCommand<[value?: string], string[]>;
    movePromptRow: TavernCommand<[identifier: string, direction: -1 | 1]>;
    postToHost: TavernCommand<[type: string, payload?: object]>;
    preset: Ref<TavernChatPromptPresetBundle>;
    presetDirty: TavernReadable<boolean>;
    presetRows: TavernReadable<Array<{ previewId: string; previewLabel: string; previewPlacement: string; sectionIndex: number; chars: number }>>;
    presetStatus: Ref<string>;
    presetTotalChars: TavernReadable<number>;
    PROMPT_EDITOR_BATCH_SIZE: number;
    promptEditorRows: TavernReadable<TavernPromptEditorRow[]>;
    promptRoleDisplay: TavernCommand<[role?: string], string>;
    promptRowIndex: TavernCommand<[identifier: string], number>;
    promptSearchText: Ref<string>;
    promptVisibleLimit: Ref<number>;
    refreshRegexFromHost: TavernCommand<[], Promise<void>>;
    REGEX_GROUP_BATCH_SIZE: number;
    regexDirty: TavernReadable<boolean>;
    regexDraft: Ref<TavernRegexScriptDraft>;
    regexDraftTypeLabel: TavernCommand<[], string>;
    regexGroups: TavernReadable<TavernRegexGroupRow[]>;
    regexGroupsForDisplay: TavernReadable<TavernRegexGroupDisplayRow[]>;
    regexPlacementLabel: TavernCommand<[value: number], string>;
    regexScriptRows: TavernReadable<TavernRegexScriptRow[]>;
    regexSearchText: Ref<string>;
    regexStatus: Ref<string>;
    saveCurrentAssistantPreset: TavernCommand<[], Promise<void>>;
    saveCurrentPreset: TavernCommand<[], Promise<void>>;
    saveCurrentRegexScript: TavernCommand<[], Promise<void>>;
    saveGlobalWorldbooksToHost: TavernCommand<[selected?: string[]], Promise<void>>;
    saveWorldbookEntryDraft: TavernCommand<[], Promise<void>>;
    selectAssistantPreset: TavernCommand<[presetId: string], Promise<void>>;
    selectAssistantPresetItem: TavernCommand<[itemId: string]>;
    selectChatPresetFromHost: TavernCommand<[name?: string], Promise<void>>;
    selectedAssistantPresetItem: TavernReadable<TavernAssistantPresetItemRow | null>;
    selectedPresetSourceId: Ref<string>;
    selectedPromptIdentifier: Ref<string>;
    selectedPromptRow: TavernReadable<TavernPromptEditorRow | null>;
    selectedRegexKey: Ref<string>;
    selectedRegexRow: TavernReadable<TavernRegexScriptRow | null>;
    selectedWorldbook: TavernReadable<TavernWorldbookOptionRow | null>;
    selectedWorldbookName: Ref<string>;
    deleteRegexScript: TavernCommand<[row: TavernRegexScriptRow], Promise<void>>;
    selectRegexScript: TavernCommand<[row: TavernRegexScriptRow]>;
    selectSettingsWorkspace: TavernCommand<[workspace: string]>;
    settingsNavItems: TavernReadable<TavernSettingsNavItem[]>;
    shortText: TavernCommand<[value?: string, limit?: number], string>;
    showMoreWorldbookPreviewEntries: TavernCommand;
    startWorldbookEntryEdit: TavernCommand<[entry: TavernWorldbookPreviewEntryRow], Promise<void>>;
    syncGlobalWorldbooksFromHost: TavernCommand<[], Promise<void>>;
    syncWorldbooksFromHost: TavernCommand<[options?: { keepSelection?: boolean }], Promise<void>>;
    toggleGlobalWorldbook: TavernCommand<[name: string, selected: boolean]>;
    togglePromptRow: TavernCommand<[identifier: string, enabled: boolean]>;
    toggleRegexPlacement: TavernCommand<[value: number, checked: boolean]>;
    updateAssistantPresetPatch: TavernCommand<[patch: Partial<TavernAssistantPreset>]>;
    updatePromptByIdentifier: TavernCommand<[identifier: string, patch: object]>;
    updateRegexPatch: TavernCommand<[patch: Partial<TavernRegexScriptDraft>]>;
    updateSelectedAssistantPresetItem: TavernCommand<[value?: string]>;
    updateWorldbookEntryDraftPatch: TavernCommand<[patch: Partial<TavernWorldbookEntryDraft>]>;
    visibleAssistantPresetRecords: TavernReadable<TavernAssistantPresetRecord[]>;
    visibleChatPresetOptions: TavernReadable<TavernChatPresetOptionRow[]>;
    visiblePromptEditorRows: TavernReadable<TavernPromptEditorRow[]>;
    visibleWorldbookOptions: TavernReadable<TavernWorldbookOptionRow[]>;
    WORLDBOOK_BATCH_SIZE: number;
    WORLDBOOK_PREVIEW_BATCH_SIZE: number;
    worldbookEntryDirty: TavernReadable<boolean>;
    worldbookEntryDraft: Ref<TavernWorldbookEntryDraft | null>;
    worldbookEntryEditingKey: Ref<string>;
    worldbookEntrySaving: TavernReadable<boolean>;
    worldbookEntryStatus: Ref<string>;
    worldbookOptions: TavernReadable<TavernWorldbookOptionRow[]>;
    worldbookPreview: Ref<TavernWorldbookPreviewRow | null>;
    worldbookPreviewStatus: Ref<string>;
    worldbookPreviewVisibleLimit: Ref<number>;
    worldbookSearchText: Ref<string>;
    worldbookStatus: Ref<string>;
    worldbookVisibleLimit: Ref<number>;
}

export interface TavernAppUiContext {
    shell: TavernShellContext;
    chat: TavernChatContext;
    manager: TavernManagerContext;
    memory: TavernMemoryContext;
    workspace: TavernWorkspaceContext;
    settings: TavernSettingsContext;
}

export const TAVERN_APP_UI_CONTEXT: InjectionKey<TavernAppUiContext> = Symbol('TavernAppUiContext');

export function useTavernAppUiContext(): TavernAppUiContext {
    const context = inject(TAVERN_APP_UI_CONTEXT);
    if (!context) {
        throw new Error('tavern_app_ui_context_missing');
    }
    return context;
}

export function useTavernShellContext(): TavernShellContext {
    return useTavernAppUiContext().shell;
}

export function useTavernChatContext(): TavernChatContext {
    return useTavernAppUiContext().chat;
}

export function useTavernManagerContext(): TavernManagerContext {
    return useTavernAppUiContext().manager;
}

export function useTavernMemoryContext(): TavernMemoryContext {
    return useTavernAppUiContext().memory;
}

export function useTavernWorkspaceContext(): TavernWorkspaceContext {
    return useTavernAppUiContext().workspace;
}

export function useTavernSettingsContext(): TavernSettingsContext {
    return useTavernAppUiContext().settings;
}
