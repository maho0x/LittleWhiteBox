import { createEbookAgentRunner } from './agent-runner.js';
import { createBookController } from './book-controller.js';
import { createEbookConversationStore } from './conversation-store.js';
import { createAgentSettingsPanel } from '../../agent-core/ui/settings-panel.js';
import {
    createAdapter as createProviderAdapter,
    getActiveProviderConfig as resolveActiveProviderConfig,
    normalizeEbookConfig,
} from './provider-config.js';
import { renderEbookShell } from './renderer.js';
import { createEbookState } from './state.js';
import { injectEbookStyles } from './styles.js';
import { bindEbookEvents } from './ui-bindings.js';
import { enhanceMarkdownContent } from '../../agent-core/ui/message-markdown.js';

const CONFIG_SAVE_TIMEOUT_MS = 3000;
const CONFIG_SAVE_RESULT_MS = 1800;

function createRequestId(prefix = 'req') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEbookApp(options = {}) {
    const {
        rootId,
        hostBridge,
    } = options;
    const state = createEbookState();
    let configSaveTimeout = null;
    let configSaveResetTimer = null;

    function getActiveProviderConfig(options = {}) {
        return resolveActiveProviderConfig(state.config, options);
    }

    function createAdapter(providerConfig = getActiveProviderConfig()) {
        return createProviderAdapter(providerConfig);
    }

    function showToast(message = '') {
        state.toast = String(message || '');
        render();
        if (state.toast) {
            setTimeout(() => {
                if (state.toast === message) {
                    state.toast = '';
                    render();
                }
            }, 2200);
        }
    }

    function describeError(error) {
        return error instanceof Error ? error.message : String(error || 'unknown_error');
    }

    function clearConfigSaveTimers() {
        if (configSaveTimeout) {
            clearTimeout(configSaveTimeout);
            configSaveTimeout = null;
        }
        if (configSaveResetTimer) {
            clearTimeout(configSaveResetTimer);
            configSaveResetTimer = null;
        }
    }

    function scheduleConfigSaveReset(delay = CONFIG_SAVE_RESULT_MS) {
        if (configSaveResetTimer) {
            clearTimeout(configSaveResetTimer);
        }
        configSaveResetTimer = setTimeout(() => {
            configSaveResetTimer = null;
            state.configSave = {
                status: 'idle',
                requestId: '',
                error: '',
            };
            render();
        }, delay);
    }

    function beginConfigSave(requestId) {
        clearConfigSaveTimers();
        state.configSave = {
            status: 'saving',
            requestId,
            error: '',
        };
        configSaveTimeout = setTimeout(() => {
            configSaveTimeout = null;
            if (state.configSave.requestId !== requestId || state.configSave.status !== 'saving') {
                return;
            }
            state.configSave = {
                status: 'error',
                requestId,
                error: '保存超时，请重试',
            };
            render();
            scheduleConfigSaveReset();
        }, CONFIG_SAVE_TIMEOUT_MS);
        render();
    }

    function completeConfigSave(requestId, { ok, error = '' } = {}) {
        if (requestId && state.configSave.requestId && state.configSave.requestId !== requestId) {
            return;
        }
        if (configSaveTimeout) {
            clearTimeout(configSaveTimeout);
            configSaveTimeout = null;
        }
        state.configSave = {
            status: ok ? 'success' : 'error',
            requestId: requestId || state.configSave.requestId || '',
            error: ok ? '' : String(error || '保存失败'),
        };
        render();
        scheduleConfigSaveReset();
    }

    let bookController;
    let agentRunner;
    const conversationStore = createEbookConversationStore({ state });
    const settingsPanel = createAgentSettingsPanel({
        state,
        render,
        showToast,
        createRequestId,
        describeError,
        saveConfig: async ({ requestId, config, payload }) => {
            beginConfigSave(requestId);
            try {
                const result = await hostBridge.requestHost('xb-ebook:save-config', payload);
                state.config = normalizeEbookConfig(result?.config || config || {});
                state.configDraft = null;
                state.configFormSyncPending = true;
                completeConfigSave(requestId, { ok: true });
                showToast('配置已保存');
                render();
            } catch (error) {
                completeConfigSave(requestId, { ok: false, error: describeError(error) });
                showToast(describeError(error));
            }
        },
        getRuntimeSummaryText: ({ providerLabel }) => providerLabel,
    });

    function captureScrollState(root, selector) {
        const node = root?.querySelector?.(selector);
        if (!node) return null;
        const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
        return {
            selector,
            scrollTop: node.scrollTop,
            nearBottom: distanceToBottom < 80,
        };
    }

    function restoreScrollState(root, snapshot, defaultSelector = null, options = {}) {
        const selector = snapshot?.selector || defaultSelector;
        if (!selector) return;
        const node = root?.querySelector?.(selector);
        if (!node) return;
        if (options.forceBottom) {
            node.scrollTop = node.scrollHeight;
            return;
        }
        if (!snapshot) {
            if (options.defaultToBottom !== false) {
                node.scrollTop = node.scrollHeight;
            }
            return;
        }
        node.scrollTop = snapshot.nearBottom
            ? node.scrollHeight
            : Math.min(snapshot.scrollTop, node.scrollHeight);
    }

    function captureFocusState(root) {
        const active = document.activeElement;
        if (!active || !root?.contains?.(active)) return null;
        const id = String(active.id || '').trim();
        if (!id) return null;
        return {
            id,
            selectionStart: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
            selectionEnd: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null,
        };
    }

    function restoreFocusState(root, snapshot) {
        if (!snapshot?.id) return;
        const node = document.getElementById(snapshot.id);
        if (!node || !root?.contains?.(node)) return;
        try {
            node.focus({ preventScroll: true });
        } catch {
            node.focus?.();
        }
        if (
            Number.isFinite(snapshot.selectionStart)
            && Number.isFinite(snapshot.selectionEnd)
            && typeof node.setSelectionRange === 'function'
        ) {
            try {
                node.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
            } catch {
                // Not all focused elements expose a text selection.
            }
        }
    }

    function render() {
        const root = document.getElementById(rootId);
        if (!root) return;
        const agentScroll = captureScrollState(root, '.xb-agent-main');
        const settingsScroll = captureScrollState(root, '.xb-ebook-settings-body');
        const focusState = captureFocusState(root);
        const wasSettingsOpen = !!root.querySelector('.xb-ebook-settings-body');
        const providerConfig = getActiveProviderConfig();
        // Dynamic values are escaped by renderer helpers before interpolation.
        // eslint-disable-next-line no-unsanitized/property
        root.innerHTML = renderEbookShell({
            state,
            providerConfig,
            dirty: bookController.isEditorDirty(),
        });
        root.querySelectorAll('.xb-msg-markdown, .xb-tool-preface-markdown').forEach((node) => {
            enhanceMarkdownContent(node, {
                codeBlockClassName: 'xb-assistant-codeblock',
                codeCopyClassName: 'xb-assistant-code-copy',
            });
        });
        if (state.isSettingsOpen) {
            settingsPanel.syncConfigToForm(root);
            state.configFormSyncPending = false;
            settingsPanel.bindSettingsPanelEvents(root);
        }
        bindEbookEvents({
            root,
            state,
            render,
            postToHost: hostBridge.postToHost,
            bookController,
            agentRunner,
            persistConversation: conversationStore.persistConversation,
            clearConversation: conversationStore.clearConversation,
            showToast,
        });
        restoreScrollState(root, agentScroll, '.xb-agent-main', {
            forceBottom: state.agentAutoScroll !== false,
            defaultToBottom: state.agentAutoScroll !== false,
        });
        if (state.isSettingsOpen) {
            const settingsBody = root.querySelector('.xb-ebook-settings-body');
            if (settingsBody) {
                if (wasSettingsOpen && settingsScroll) {
                    restoreScrollState(root, settingsScroll, '.xb-ebook-settings-body', {
                        defaultToBottom: false,
                    });
                } else {
                    settingsBody.scrollTop = 0;
                }
            }
        }
        if (wasSettingsOpen === state.isSettingsOpen) {
            restoreFocusState(root, focusState);
        }
    }

    bookController = createBookController({
        state,
        render,
        requestHost: hostBridge.requestHost,
        showToast,
        conversationStore,
    });

    agentRunner = createEbookAgentRunner({
        state,
        refreshBooksAndFiles: bookController.refreshBooksAndFiles,
        render,
        showToast,
        persistConversation: conversationStore.persistConversation,
        isEditorDirty: bookController.isEditorDirty,
        getActiveProviderConfig,
        createAdapter,
    });

    function handleHostConfig(payload = {}) {
        state.config = normalizeEbookConfig(payload?.config || {});
        state.configDraft = null;
        state.configFormSyncPending = true;
        render();
    }

    function handleOpenSettings() {
        state.isSettingsOpen = true;
        state.configFormSyncPending = true;
        render();
    }

    function handleDrawProgress(payload = {}) {
        bookController.handleDrawProgress(payload);
    }

    function handleTtsState(payload = {}) {
        bookController.handleTtsState(payload);
    }

    async function start() {
        injectEbookStyles(rootId);
        await bookController.initializeBook();
        state.status = '就绪';
        render();
        hostBridge.postToHost('xb-ebook:frame-ready');
        void bookController.refreshDrawStatus({ renderAfter: true });
        void bookController.refreshTtsStatus({ renderAfter: true });
    }

    return {
        handleDrawProgress,
        handleHostConfig,
        handleOpenSettings,
        handleTtsState,
        start,
        state,
    };
}
