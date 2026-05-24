import { normalizeEbookConfig } from './provider-config.js';

export const EBOOK_THEME_STORAGE_KEY = 'LittleWhiteBox_Ebook_ColorTheme';

function getInitialColorTheme() {
    try {
        const value = globalThis.localStorage?.getItem(EBOOK_THEME_STORAGE_KEY);
        return value === 'light' ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

export function createEbookState() {
    return {
        config: normalizeEbookConfig({}),
        configDraft: null,
        books: [],
        book: null,
        files: [],
        selectedPath: '',
        readerPath: '',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        liveToolTurn: null,
        openToolTurnKeys: [],
        activeTurnStartIndex: -1,
        openThoughtKeys: [],
        editingMessageIndex: -1,
        messageActionFeedback: {},
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        agentAutoScroll: true,
        drawStatus: {
            provider: 'disabled',
            enabled: false,
            ready: false,
        },
        isDrawingChapter: false,
        drawProgressText: '',
        readerTtsStatus: {
            enabled: false,
            ready: false,
        },
        readerTtsPlayback: {
            status: 'idle',
            playbackId: '',
            chapterPath: '',
            error: '',
        },
        studioLayout: 'balanced',
        colorTheme: getInitialColorTheme(),
        isSettingsOpen: false,
        isDeleteBookOpen: false,
        configPage: 'main',
        configFormSyncPending: true,
        modelOptionsByProvider: {},
        pullStateByProvider: {},
        configSave: {
            status: 'idle',
            requestId: '',
            error: '',
        },
        status: '正在打开书架...',
        toast: '',
    };
}
