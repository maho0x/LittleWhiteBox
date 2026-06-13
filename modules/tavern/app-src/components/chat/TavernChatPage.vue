<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated, ref, watch } from 'vue';
import { captureElementScrollState, restoreElementScrollState, type ElementScrollSnapshot } from '../../scroll-state';
import TavernCornerActions from '../TavernCornerActions.vue';
import TavernMapPanel from '../TavernMapPanel.vue';
import TavernMemoryEditor from '../TavernMemoryEditor.vue';
import TavernScrollControls from '../TavernScrollControls.vue';
import TavernContractModal from './TavernContractModal.vue';
import { useTavernAppUiContext } from '../tavern-app-context';
import TavernChatSidebar from './TavernChatSidebar.vue';
import {
    hasRenderableLiveAssistantContent,
    hasRenderableLiveAssistantMarkdown,
} from './live-assistant-state';
import {
    normalizeTavernSessionContract,
    type TavernContractPermissionKey,
    type TavernSessionContract,
} from '../../../shared/session-contract';
import {
    getActionCheckEvents,
    injectActionCheckRenderMarkers,
} from '../../../shared/runtime-events';
import type { TavernMessageRecord } from '../../../shared/session-db';

const ui = useTavernAppUiContext();
const {
    actionFeedback,
    activeMemoryFiles,
    activeView,
    cancelEditMessage,
    canDrawMessage,
    canEditMessage,
    canEditManagerMessage,
    canRerunMessage,
    canRerunManagerMessage,
    canSendManagerMessage,
    canSendMessage,
    chatAutoScroll,
    chatFocus,
    chatLayout,
    chatMessages,
    chatMessageWindow,
    chatComposeTextareaRef,
    chatScrollControlsActive,
    chatScrollRef,
    chatSidePanel,
    chatWorkspacePanel,
    copyMessage,
    copyManagerMessage,
    currentManagerWorkRun,
    currentUserMessage,
    deleteMessageTurn,
    deleteManagerMessageTurn,
    drawMessage,
    drawMessageStatusClass,
    drawMessageStatusText,
    drawMessageTitle,
    discardMemoryDraft,
    editingMessageDraft,
    enterMemoryEditMode,
    expandMemoryFileGroup,
    formatRunActivityLine,
    formatRunIssueLine,
    formatRunInputLine,
    formatRunMapLine,
    formatRunMemoryLine,
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
    hiddenManagerRunCount,
    homeThemeDark,
    isEditingMessage,
    isEditingManagerMessage,
    isDrawingMessage,
    isEditingMessageDirty,
    isEditingManagerMessageDirty,
    isCancellingRun,
    isManagerAssistantCancelling,
    isManagerAssistantRunning,
    isRunning,
    latestErrorMessage,
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
    memoryFileSearchText,
    memoryFiles,
    memoryIndexStatusLine,
    mapStateDocument,
    mapStatePatches,
    messageKey,
    openPromptInspector,
    postToHost,
    previewMemoryDraft,
    rememberBrokenAvatar,
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
    saveEditMessage,
    saveEditManagerMessage,
    saveSessionContract,
    saveSelectedMemoryFile,
    sessionContract,
    scrollChatToBottom,
    scrollChatToTop,
    scrollManagerToBottom,
    scrollManagerToTop,
    selectedMemoryFileEntry,
    selectedMemoryFile,
    selectedMemoryFilePath,
    selectedSessionId,
    selectMemoryFile,
    shortText,
    showChatScrollBottom,
    showChatScrollTop,
    showManagerScrollBottom,
    showManagerScrollTop,
    startEditMessage,
    startEditManagerMessage,
    stateMemoryFile,
    thoughtBlocks,
    thoughtSummaryLabel,
    toolTraceSummary,
    updateChatScrollButtons,
    updateManagerScrollButtons,
    visibleChatMessages,
    visibleCharacterAvatar,
    visibleManagerChatItems,
    visibleManagerChatMessages,
    liveManagerChatDisplayItems,
    visibleUserAvatar,
} = ui;

let pendingChatScrollSnapshot: ElementScrollSnapshot | null = null;
let pendingManagerScrollSnapshot: ElementScrollSnapshot | null = null;
const contractModalOpen = ref(false);
const contractSaving = ref(false);
const contractError = ref('');
const contractDraft = ref<TavernSessionContract>(normalizeTavernSessionContract(sessionContract.value));
const mobileChatPanel = ref<'none' | 'directory' | 'workspace'>('none');
const mobileMemoryDirectoryOpen = ref(false);

const currentStateFile = computed(() => stateMemoryFile.value || null);
const currentStateContent = computed(() => String(currentStateFile.value?.content || '').trim());
const currentStatePreviewHtml = computed(() => renderChatMarkdown(currentStateContent.value));
const contractDraftDirty = computed(() => JSON.stringify(contractDraft.value) !== JSON.stringify(sessionContract.value));
const currentStatePreviewSignature = computed(() => markdownSignature(currentStateContent.value));

function buildAssistantRenderState(text: string, events: ReturnType<typeof getActionCheckEvents> = []) {
    const payload = injectActionCheckRenderMarkers(text, events);
    const actionCheckGroups = payload.groups.length ? JSON.stringify(payload.groups) : '';
    return {
        text: payload.text,
        signature: actionCheckGroups
            ? markdownSignature(`${payload.text}\u0000${actionCheckGroups}`)
            : markdownSignature(payload.text),
        actionCheckGroups,
    };
}

function assistantMessageRenderState(message: TavernMessageRecord) {
    const text = String(message.content || '');
    if (message.role !== 'assistant') {
        return {
            text,
            signature: markdownSignature(text),
            actionCheckGroups: '',
        };
    }
    return buildAssistantRenderState(text, getActionCheckEvents(message.runtimeEvents));
}

const liveAssistantRenderState = computed(() => buildAssistantRenderState(
    String(runtimeText.value || ''),
    Array.isArray(runtimeActionCheckEvents.value) ? runtimeActionCheckEvents.value : [],
));
const liveAssistantVisible = computed(() => hasRenderableLiveAssistantContent({
    text: runtimeText.value,
    thoughts: runtimeThoughts.value,
    actionCheckEvents: runtimeActionCheckEvents.value,
}));
const liveAssistantMarkdownVisible = computed(() => hasRenderableLiveAssistantMarkdown({
    text: runtimeText.value,
    actionCheckEvents: runtimeActionCheckEvents.value,
}));

function setChatScrollRef(element: Element | null) {
    chatScrollRef.value = element instanceof HTMLElement ? element : null;
}

function setChatComposeTextareaRef(element: Element | null) {
    chatComposeTextareaRef.value = element instanceof HTMLTextAreaElement ? element : null;
}

function setManagerScrollRef(element: Element | null) {
    managerScrollRef.value = element instanceof HTMLElement ? element : null;
}

function setManagerComposeTextareaRef(element: Element | null) {
    managerComposeTextareaRef.value = element instanceof HTMLTextAreaElement ? element : null;
}

function closeMobileChatPanel() {
    mobileChatPanel.value = 'none';
    mobileMemoryDirectoryOpen.value = false;
}

function toggleMobileChatPanel(panel: 'directory' | 'workspace') {
    mobileChatPanel.value = mobileChatPanel.value === panel ? 'none' : panel;
}

function toggleMobileSessionsPanel() {
    chatSidePanel.value = 'sessions';
    toggleMobileChatPanel('directory');
}

function toggleMobileWorkspacePanel(panel: 'state' | 'memory') {
    const sameOpenPanel = mobileChatPanel.value === 'workspace' && chatWorkspacePanel.value === panel;
    chatWorkspacePanel.value = panel;
    mobileChatPanel.value = sameOpenPanel ? 'none' : 'workspace';
    mobileMemoryDirectoryOpen.value = false;
}

function handleMobileDirectoryClick(event: Event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest?.('.chat-mobile-sheet-handle')) {
        closeMobileChatPanel();
        return;
    }
    if (!target?.closest?.('.session-open, .memory-file:not(.memory-file-more)')) {return;}
    closeMobileChatPanel();
}

function toggleMobileMemoryDirectory() {
    mobileMemoryDirectoryOpen.value = !mobileMemoryDirectoryOpen.value;
}

function selectMobileMemoryFile(path: string) {
    selectMemoryFile(path);
    mobileMemoryDirectoryOpen.value = false;
}

function openContractModal() {
    contractError.value = '';
    contractDraft.value = normalizeTavernSessionContract(sessionContract.value);
    contractModalOpen.value = true;
}

function closeContractModal() {
    contractError.value = '';
    contractModalOpen.value = false;
}

function toggleContractDraft(key: TavernContractPermissionKey) {
    contractDraft.value = {
        ...contractDraft.value,
        [key]: !contractDraft.value[key],
    };
}

async function sealContract() {
    if (!selectedSessionId.value) {
        contractError.value = '';
        contractModalOpen.value = false;
        return;
    }
    contractError.value = '';
    contractSaving.value = true;
    try {
        const saved = await saveSessionContract(contractDraft.value);
        if (!saved) {
            throw new Error('contract_save_failed');
        }
        contractModalOpen.value = false;
    } catch {
        contractError.value = '契约保存失败，请重试。';
    } finally {
        contractSaving.value = false;
    }
}

watch(() => sessionContract.value, (value) => {
    if (contractModalOpen.value) {return;}
    contractDraft.value = normalizeTavernSessionContract(value);
}, { deep: true });

watch(() => selectedSessionId.value, () => {
    contractError.value = '';
    contractModalOpen.value = false;
    contractDraft.value = normalizeTavernSessionContract(sessionContract.value);
});

onBeforeUpdate(() => {
    pendingChatScrollSnapshot = captureElementScrollState(chatScrollRef.value, {
        itemSelector: '.chat-bubble[data-chat-anchor-key], .chat-history-gate[data-chat-anchor-key]',
        datasetKey: 'chatAnchorKey',
    });
    pendingManagerScrollSnapshot = captureElementScrollState(managerScrollRef.value, {
        itemSelector: '[data-manager-anchor-key]',
        datasetKey: 'managerAnchorKey',
    });
});

onUpdated(() => {
    const shouldAutoScrollChat = activeView.value === 'chat' && chatFocus.value === 'chat' && chatAutoScroll.value !== false;
    const shouldAutoScrollManager = activeView.value === 'chat' && chatFocus.value === 'manager' && managerAutoScroll.value !== false;
    restoreElementScrollState(chatScrollRef.value, pendingChatScrollSnapshot, {
        itemSelector: '.chat-bubble[data-chat-anchor-key], .chat-history-gate[data-chat-anchor-key]',
        datasetKey: 'chatAnchorKey',
    }, {
        forceBottom: shouldAutoScrollChat,
        defaultToBottom: shouldAutoScrollChat,
        preserveScrollTop: !shouldAutoScrollChat,
    });
    restoreElementScrollState(managerScrollRef.value, pendingManagerScrollSnapshot, {
        itemSelector: '[data-manager-anchor-key]',
        datasetKey: 'managerAnchorKey',
    }, {
        forceBottom: shouldAutoScrollManager,
        defaultToBottom: shouldAutoScrollManager,
        preserveScrollTop: !shouldAutoScrollManager,
    });
    pendingChatScrollSnapshot = null;
    pendingManagerScrollSnapshot = null;
    updateChatScrollButtons();
    updateManagerScrollButtons();
});
</script>

<template>
  <section
    v-if="activeView === 'chat'"
    class="tavern-chat xb-page"
    :class="[
      `chat-focus-${chatFocus}`,
      `chat-layout-${chatLayout}`,
      {
        'is-mobile-directory-open': mobileChatPanel === 'directory',
        'is-mobile-workspace-open': mobileChatPanel === 'workspace',
      },
    ]"
  >
    <TavernCornerActions
      include-home
      :dark="homeThemeDark"
      @home="activeView = 'home'"
      @toggle-theme="homeThemeDark = !homeThemeDark"
      @exit="postToHost('xb-tavern:close')"
    />
    <header class="chat-mobile-topbar">
      <div class="chat-mobile-primary-row">
        <div
          class="chat-mobile-segment"
          role="tablist"
          aria-label="聊天视图"
        >
          <span aria-hidden="true" />
          <button
            type="button"
            role="tab"
            :aria-selected="chatFocus === 'chat'"
            :class="{ active: chatFocus === 'chat' }"
            @click="chatFocus = 'chat'; closeMobileChatPanel()"
          >
            角色
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="chatFocus === 'manager'"
            :class="{ active: chatFocus === 'manager' }"
            @click="chatFocus = 'manager'; closeMobileChatPanel()"
          >
            助手
          </button>
        </div>
        <div class="chat-mobile-action-group">
          <button
            type="button"
            class="chat-mobile-icon-button chat-mobile-utility-button"
            title="首页"
            aria-label="首页"
            @click="activeView = 'home'; closeMobileChatPanel()"
          >
            <svg
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5.5 10.5V20h13v-9.5" />
              <path d="M9.5 20v-5.5h5V20" />
            </svg>
          </button>
          <button
            type="button"
            class="chat-mobile-icon-button chat-mobile-utility-button"
            :title="homeThemeDark ? '切换到白天' : '切换到夜间'"
            :aria-label="homeThemeDark ? '切换到白天' : '切换到夜间'"
            @click="homeThemeDark = !homeThemeDark"
          >
            <svg
              v-if="homeThemeDark"
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="4"
              />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="m4.93 4.93 1.41 1.41" />
              <path d="m17.66 17.66 1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="m6.34 17.66-1.41 1.41" />
              <path d="m19.07 4.93-1.41 1.41" />
            </svg>
            <svg
              v-else
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20.2 14.5A7.3 7.3 0 0 1 9.5 3.8 8.7 8.7 0 1 0 20.2 14.5Z" />
            </svg>
          </button>
          <button
            type="button"
            class="chat-mobile-icon-button chat-mobile-utility-button"
            title="退出"
            aria-label="退出"
            @click="postToHost('xb-tavern:close')"
          >
            <svg
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        </div>
      </div>
      <div class="chat-mobile-context-row">
        <button
          type="button"
          class="chat-mobile-context-button"
          :class="{ 'is-active': mobileChatPanel === 'directory' }"
          title="会话"
          aria-label="会话"
          @click="toggleMobileSessionsPanel"
        >
          会话
        </button>
        <button
          type="button"
          class="chat-mobile-context-button"
          :class="{ 'is-active': mobileChatPanel === 'workspace' }"
          title="状态"
          aria-label="状态"
          @click="toggleMobileWorkspacePanel('state')"
        >
          状态
        </button>
        <button
          type="button"
          class="chat-mobile-context-button"
          title="契约"
          aria-label="契约"
          @click="closeMobileChatPanel(); openContractModal()"
        >
          契约
        </button>
        <button
          type="button"
          class="chat-mobile-context-button"
          title="请求日志"
          aria-label="请求日志"
          @click="closeMobileChatPanel(); openPromptInspector('history')"
        >
          日志
        </button>
      </div>
    </header>
    <button
      type="button"
      class="chat-mobile-sheet-scrim"
      title="收起面板"
      aria-label="收起面板"
      @click="closeMobileChatPanel"
    />
    <TavernChatSidebar @click="handleMobileDirectoryClick" />

    <section
      class="chat-workbench"
      :class="{ 'is-manager': chatFocus === 'manager' }"
    >
      <div class="chat-flip-card">
        <section
          class="chat-face chat-face-front chat-main"
          :aria-hidden="chatFocus === 'manager'"
        >
          <div
            v-if="visibleCharacterAvatar"
            class="chat-ambient-standee"
            aria-hidden="true"
          >
            <img
              :src="visibleCharacterAvatar"
              alt=""
              @error="rememberBrokenAvatar(visibleCharacterAvatar)"
            >
          </div>
          <header class="chat-head">
            <div class="chat-head-actions">
              <button
                type="button"
                class="contract-trigger"
                title="契约"
                aria-label="契约"
                @click="openContractModal"
              >
                契约
              </button>
              <button
                type="button"
                class="prompt-inspector-trigger"
                title="请求日志"
                aria-label="请求日志"
                @click="openPromptInspector('history')"
              >
                日志
              </button>
              <button
                type="button"
                class="chat-flip-trigger"
                title="助手聊天"
                aria-label="助手聊天"
                @click="chatFocus = 'manager'"
              >
                助手
              </button>
            </div>
          </header>
          <div
            class="chat-scroll-shell"
          >
            <div
              :ref="setChatScrollRef"
              class="chat-scroll"
              @scroll="handleChatScroll"
              @wheel.passive="handleChatWheel"
              @touchstart.passive="handleChatTouchStart"
              @touchmove.passive="handleChatTouchMove"
            >
              <div
                v-if="chatMessageWindow.hiddenBefore"
                class="chat-history-gate"
                :data-chat-anchor-key="`gate:${chatMessageWindow.hiddenBefore}`"
                role="button"
                tabindex="0"
                @click="revealOlderChatMessages(true)"
                @keydown.enter.prevent="revealOlderChatMessages(true)"
                @keydown.space.prevent="revealOlderChatMessages(true)"
              >
                展开较早记录 {{ chatMessageWindow.hiddenBefore }} 条
              </div>
              <template
                v-for="message in visibleChatMessages"
                :key="`${message.sessionId}-${message.order}`"
              >
                <div
                  :data-chat-anchor-key="`${message.sessionId}:${message.order}`"
                  class="chat-bubble"
                  :class="[
                    message.role === 'user' ? 'from-user' : 'from-assistant',
                    { 'is-error': message.error },
                  ]"
                >
                  <div class="bubble-meta">
                    <span class="bubble-nameplate">
                      <span class="bubble-avatar-stamp">
                        <img
                          v-if="message.role === 'user' && visibleUserAvatar"
                          :src="visibleUserAvatar"
                          alt=""
                          @error="rememberBrokenAvatar(visibleUserAvatar)"
                        >
                        <img
                          v-else-if="message.role !== 'user' && visibleCharacterAvatar"
                          :src="visibleCharacterAvatar"
                          alt=""
                          @error="rememberBrokenAvatar(visibleCharacterAvatar)"
                        >
                        <span v-else>{{ String(roleLabel(message.role)).slice(0, 1) }}</span>
                      </span>
                      <span class="bubble-role-name">{{ message.error ? '错误' : roleLabel(message.role) }}</span>
                    </span>
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
                        :disabled="!isEditingMessageDirty(message)"
                        @click="saveEditMessage(message)"
                      >
                        {{ message.role === 'user' ? '保存' : '保存修改' }}
                      </button>
                      <button
                        v-if="message.role === 'user'"
                        type="button"
                        :disabled="!isEditingMessageDirty(message)"
                        @click="saveEditMessage(message, { rerun: true })"
                      >
                        保存并重发
                      </button>
                      <button
                        type="button"
                        @click="cancelEditMessage"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                  <details
                    v-if="!isEditingMessage(message) && thoughtBlocks(message).length"
                    class="tavern-thought-details"
                  >
                    <summary>{{ thoughtSummaryLabel(message) }}</summary>
                    <div
                      v-for="(thought, thoughtIndex) in thoughtBlocks(message)"
                      :key="`${message.sessionId}-${message.order}-thought-${thoughtIndex}`"
                      class="tavern-thought-block"
                    >
                      <div class="tavern-thought-label">
                        {{ thought.label }}
                      </div>
                      <pre>{{ thought.text }}</pre>
                    </div>
                  </details>
                  <template v-if="!isEditingMessage(message)">
                    <template
                      v-for="render in [assistantMessageRenderState(message)]"
                      :key="`${messageKey(message)}:${render.signature}`"
                    >
                      <div
                        class="xb-tavern-markdown"
                        :data-markdown-signature="render.signature"
                        :data-action-check-groups="render.actionCheckGroups || null"
                        v-html="renderChatMarkdown(render.text)"
                      />
                    </template>
                  </template>
                  <div
                    v-if="!isEditingMessage(message)"
                    class="message-actions"
                    :class="{ 'has-status': !!drawMessageStatusText(message) }"
                  >
                    <span
                      v-if="drawMessageStatusText(message)"
                      class="message-draw-status"
                      :class="drawMessageStatusClass(message)"
                    >
                      {{ drawMessageStatusText(message) }}
                    </span>
                    <button
                      type="button"
                      :disabled="!canDrawMessage(message)"
                      :class="[actionFeedback(message, 'draw'), { 'is-running': isDrawingMessage(message) }]"
                      :title="drawMessageTitle(message)"
                      :aria-label="drawMessageTitle(message)"
                      @click="drawMessage(message)"
                    >
                      {{ isDrawingMessage(message) ? '■' : '🎨' }}
                    </button>
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
                      :disabled="!canRerunMessage(message)"
                      :class="actionFeedback(message, 'rerun')"
                      :title="message.role === 'user' ? '从这里重发' : '重新生成这条回复'"
                      :aria-label="message.role === 'user' ? '从这里重发' : '重新生成这条回复'"
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
                  v-for="(event, eventIndex) in (message.role === 'user' ? (message.runtimeEvents || []) : [])"
                  :key="`${message.sessionId}-${message.order}-runtime-event-${event.type}-${eventIndex}`"
                  class="chat-runtime-event scene-narration"
                  aria-hidden="true"
                >
                  <div class="scene-tag">
                    {{ event.label }}
                  </div>
                </div>
              </template>
              <div
                v-if="isRunning && liveAssistantVisible"
                data-chat-anchor-key="streaming:content"
                class="chat-bubble from-assistant streaming"
              >
                <div class="bubble-meta">
                  <span class="bubble-nameplate">
                    <span class="bubble-avatar-stamp">
                      <img
                        v-if="visibleCharacterAvatar"
                        :src="visibleCharacterAvatar"
                        alt=""
                        @error="rememberBrokenAvatar(visibleCharacterAvatar)"
                      >
                      <span v-else>{{ String(roleLabel('assistant')).slice(0, 1) }}</span>
                    </span>
                    <span class="bubble-role-name">{{ roleLabel('assistant') }}</span>
                  </span>
                  <small>生成中</small>
                </div>
                <details
                  v-if="thoughtBlocks(runtimeThoughts).length"
                  class="tavern-thought-details"
                  open
                >
                  <summary>{{ thoughtSummaryLabel(runtimeThoughts, true) }}</summary>
                  <div
                    v-for="(thought, thoughtIndex) in thoughtBlocks(runtimeThoughts)"
                    :key="`runtime-thought-${thoughtIndex}`"
                    class="tavern-thought-block"
                  >
                    <div class="tavern-thought-label">
                      {{ thought.label }}
                    </div>
                    <pre>{{ thought.text }}</pre>
                  </div>
                </details>
                <div
                  v-if="liveAssistantMarkdownVisible"
                  class="xb-tavern-markdown"
                  :data-action-check-groups="liveAssistantRenderState.actionCheckGroups || undefined"
                  :data-markdown-signature="liveAssistantRenderState.signature"
                  v-html="renderChatMarkdown(liveAssistantRenderState.text)"
                />
              </div>
              <div
                v-if="isRunning && !liveAssistantVisible"
                data-chat-anchor-key="streaming:empty"
                class="chat-bubble from-assistant streaming thinking"
              >
                <div class="bubble-meta">
                  <span class="bubble-nameplate">
                    <span class="bubble-avatar-stamp">
                      <img
                        v-if="visibleCharacterAvatar"
                        :src="visibleCharacterAvatar"
                        alt=""
                        @error="rememberBrokenAvatar(visibleCharacterAvatar)"
                      >
                      <span v-else>{{ String(roleLabel('assistant')).slice(0, 1) }}</span>
                    </span>
                    <span class="bubble-role-name">{{ roleLabel('assistant') }}</span>
                  </span>
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
                class="chat-compose-spacer"
                aria-hidden="true"
              />
            </div>
            <TavernScrollControls
              :active="chatScrollControlsActive"
              :show-top="showChatScrollTop"
              :show-bottom="showChatScrollBottom"
              @top="scrollChatToTop"
              @bottom="scrollChatToBottom(true, { collapseWindow: true, revealHelpers: true })"
            />
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
              :ref="setChatComposeTextareaRef"
              v-model="currentUserMessage"
              rows="2"
              placeholder="对角色说一句话..."
              :disabled="isRunning"
              @input="handleComposeInput"
              @keydown="handleComposeKeydown"
            />
            <button
              type="submit"
              class="primary-action"
              :disabled="!canSendMessage"
              :aria-label="isCancellingRun ? '正在停止' : isRunning ? '停止' : '发送'"
            >
              <span
                class="compose-send-icon"
                aria-hidden="true"
              >
                {{ isCancellingRun ? '...' : isRunning ? '■' : '➤' }}
              </span>
              <span class="compose-send-label">
                {{ isCancellingRun ? '正在停止' : isRunning ? '停止' : '发送' }}
              </span>
            </button>
          </form>
        </section>

        <section
          class="chat-face chat-face-back chat-manager"
          :aria-hidden="chatFocus === 'chat'"
        >
          <header class="manager-head">
            <div class="manager-head-actions">
              <button
                type="button"
                class="contract-trigger"
                title="契约"
                aria-label="契约"
                @click="openContractModal"
              >
                契约
              </button>
              <button
                type="button"
                class="chat-flip-trigger"
                title="角色聊天"
                aria-label="角色聊天"
                @click="chatFocus = 'chat'"
              >
                角色
              </button>
            </div>
          </header>

          <div class="chat-scroll-shell manager-scroll-shell">
            <div
              :ref="setManagerScrollRef"
              class="manager-chat-scroll"
              @scroll="handleManagerScroll"
              @wheel.passive="handleManagerWheel"
              @touchstart.passive="handleManagerTouchStart"
              @touchmove.passive="handleManagerTouchMove"
            >
              <div
                v-if="managerCompactionOverlay?.active"
                class="manager-compaction-overlay"
                :class="{ resolved: managerCompactionOverlay.resolved }"
                role="status"
                aria-live="polite"
              >
                <strong>{{ managerCompactionOverlay.status }}</strong>
                <small>
                  {{ managerCompactionOverlay.currentTokens }} / {{ managerCompactionOverlay.triggerTokens || '...' }}
                  <span v-if="managerCompactionOverlay.yieldTokens"> → {{ managerCompactionOverlay.yieldTokens }}</span>
                </small>
              </div>
              <div
                v-if="managerMessageWindow.hiddenBefore"
                class="chat-history-gate manager-history-gate"
                :data-manager-anchor-key="`gate:${managerMessageWindow.hiddenBefore}`"
                role="button"
                tabindex="0"
                @click="revealOlderManagerMessages(true)"
                @keydown.enter.prevent="revealOlderManagerMessages(true)"
                @keydown.space.prevent="revealOlderManagerMessages(true)"
              >
                展开较早记录 {{ managerMessageWindow.hiddenBefore }} 条
              </div>
              <template
                v-for="item in visibleManagerChatItems"
                :key="item.key"
              >
                <article
                  v-if="item.kind === 'message'"
                  :data-manager-anchor-key="item.anchorKey"
                  class="manager-card manager-message"
                  :class="item.message.role === 'user' ? 'manager-message-user' : 'manager-message-assistant'"
                >
                  <div class="manager-run-title">
                    <strong>{{ item.message.role === 'user' ? roleLabel('user') : '助手' }}</strong>
                    <small>{{ formatMessageTime(item.message.createdAt) }}</small>
                  </div>
                  <div
                    v-if="isEditingManagerMessage(item.message)"
                    class="message-edit-panel manager-message-edit-panel"
                  >
                    <textarea
                      v-model="editingMessageDraft"
                      class="message-edit-box"
                      rows="6"
                      :data-manager-message-editor="`manager:${item.message.sessionId}:${item.message.order}`"
                      @input="handleEditInput"
                      @keydown="handleManagerEditKeydown($event, item.message)"
                    />
                    <div class="message-edit-actions">
                      <button
                        type="button"
                        :disabled="!isEditingManagerMessageDirty(item.message)"
                        @click="saveEditManagerMessage(item.message)"
                      >
                        {{ item.message.role === 'user' ? '保存' : '保存修改' }}
                      </button>
                      <button
                        v-if="item.message.role === 'user'"
                        type="button"
                        :disabled="!isEditingManagerMessageDirty(item.message)"
                        @click="saveEditManagerMessage(item.message, { rerun: true })"
                      >
                        保存并重发
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
                    v-if="!isEditingManagerMessage(item.message)"
                    class="xb-tavern-markdown"
                    :data-markdown-signature="markdownSignature(item.message.content)"
                    v-html="renderChatMarkdown(item.message.content)"
                  />
                  <div
                    v-if="!isEditingManagerMessage(item.message)"
                    class="message-actions manager-message-actions"
                  >
                    <button
                      type="button"
                      :class="managerActionFeedback(item.message, 'copy')"
                      title="复制"
                      aria-label="复制"
                      @click="copyManagerMessage(item.message)"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      :disabled="!canEditManagerMessage(item.message)"
                      :class="managerActionFeedback(item.message, 'edit')"
                      title="编辑"
                      aria-label="编辑"
                      @click="startEditManagerMessage(item.message)"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      :disabled="!canRerunManagerMessage(item.message)"
                      :class="managerActionFeedback(item.message, 'rerun')"
                      :title="item.message.role === 'user' ? '从这里重问助手' : '重新生成这条助手回复'"
                      :aria-label="item.message.role === 'user' ? '从这里重问助手' : '重新生成这条助手回复'"
                      @click="rerunFromManagerMessage(item.message)"
                    >
                      ↻
                    </button>
                    <button
                      type="button"
                      :disabled="isManagerAssistantRunning"
                      :class="managerActionFeedback(item.message, 'delete')"
                      title="删除"
                      aria-label="删除"
                      @click="deleteManagerMessageTurn(item.message)"
                    >
                      ⌫
                    </button>
                  </div>
                </article>

                <details
                  v-else
                  class="manager-tool-turn manager-tool-turn-history"
                  :data-manager-anchor-key="item.anchorKey"
                >
                  <summary>
                    <span>{{ item.rounds.length > 1 ? `工具轮 ${item.rounds.length} 轮` : '工具轮' }}</span>
                    <small>{{ managerToolTurnSummary(item) }}</small>
                    <em>{{ managerToolTurnPreview(item) }}</em>
                  </summary>
                  <div class="manager-tool-turn-body">
                    <div
                      v-for="(round, roundIndex) in item.rounds"
                      :key="`${item.key}-round-${round.assistantMessage.order}`"
                      class="manager-tool-round"
                    >
                      <div class="manager-tool-round-title">
                        <strong>第 {{ Number(roundIndex) + 1 }} 轮 · {{ round.calls.length }} 个工具</strong>
                        <span>{{ formatMessageTime(round.assistantMessage.createdAt) }}</span>
                      </div>
                      <details
                        v-if="thoughtBlocks(round.assistantMessage.thoughts).length"
                        class="manager-tool-thoughts"
                      >
                        <summary>{{ thoughtSummaryLabel(thoughtBlocks(round.assistantMessage.thoughts), false) }}</summary>
                        <div
                          v-for="(thought, thoughtIndex) in thoughtBlocks(round.assistantMessage.thoughts)"
                          :key="`${item.key}-round-${roundIndex}-thought-${thoughtIndex}`"
                          class="chat-thought-block"
                        >
                          <strong>{{ thought.label }}</strong>
                          <pre>{{ thought.text }}</pre>
                        </div>
                      </details>
                      <div
                        v-if="round.assistantMessage.content"
                        class="manager-tool-preface xb-tavern-markdown"
                        :data-markdown-signature="markdownSignature(round.assistantMessage.content)"
                        v-html="renderChatMarkdown(round.assistantMessage.content)"
                      />
                      <div
                        v-for="call in round.calls"
                        :key="call.id"
                        class="manager-tool-item"
                        :class="call.ok ? 'is-resolved' : 'is-error'"
                      >
                        <div class="manager-tool-head">
                          <span>{{ call.name }}</span>
                          <em>{{ call.toolMessage ? (call.ok ? '已返回' : '失败') : '等待返回' }}</em>
                        </div>
                        <small v-if="call.argumentsText">{{ call.argumentsText }}</small>
                        <p>{{ call.resultText }}</p>
                      </div>
                    </div>
                  </div>
                </details>
              </template>

              <template
                v-for="item in liveManagerChatDisplayItems"
                :key="`live:${item.key}`"
              >
                <article
                  v-if="item.kind === 'message'"
                  :data-manager-anchor-key="`live:${item.anchorKey}`"
                  class="manager-card manager-message manager-message-live"
                  :class="item.message.role === 'user' ? 'manager-message-user' : 'manager-message-assistant'"
                >
                  <div class="manager-run-title">
                    <strong>{{ item.message.role === 'user' ? roleLabel('user') : '助手' }}</strong>
                    <small>正在处理</small>
                  </div>
                  <div
                    class="xb-tavern-markdown"
                    :data-markdown-signature="markdownSignature(item.message.content)"
                    v-html="renderChatMarkdown(item.message.content)"
                  />
                </article>

                <details
                  v-else
                  class="manager-tool-turn manager-tool-turn-live"
                  :data-manager-anchor-key="`live:${item.anchorKey}`"
                  open
                >
                  <summary>
                    <span>{{ item.rounds.length > 1 ? `工具轮 ${item.rounds.length} 轮` : '工具轮' }}</span>
                    <small>{{ managerToolTurnSummary(item) }}</small>
                    <em>{{ managerToolTurnPreview(item) }}</em>
                  </summary>
                  <div class="manager-tool-turn-body">
                    <div
                      v-for="(round, roundIndex) in item.rounds"
                      :key="`live:${item.key}-round-${round.assistantMessage.order}`"
                      class="manager-tool-round"
                    >
                      <div class="manager-tool-round-title">
                        <strong>第 {{ Number(roundIndex) + 1 }} 轮 · {{ round.calls.length }} 个工具</strong>
                        <span>正在处理</span>
                      </div>
                      <details
                        v-if="thoughtBlocks(round.assistantMessage.thoughts).length"
                        class="manager-tool-thoughts"
                        open
                      >
                        <summary>{{ thoughtSummaryLabel(thoughtBlocks(round.assistantMessage.thoughts), true) }}</summary>
                        <div
                          v-for="(thought, thoughtIndex) in thoughtBlocks(round.assistantMessage.thoughts)"
                          :key="`live:${item.key}-round-${roundIndex}-thought-${thoughtIndex}`"
                          class="chat-thought-block"
                        >
                          <strong>{{ thought.label }}</strong>
                          <pre>{{ thought.text }}</pre>
                        </div>
                      </details>
                      <div
                        v-if="round.assistantMessage.content"
                        class="manager-tool-preface xb-tavern-markdown"
                        :data-markdown-signature="markdownSignature(round.assistantMessage.content)"
                        v-html="renderChatMarkdown(round.assistantMessage.content)"
                      />
                      <div
                        v-for="call in round.calls"
                        :key="`live:${call.id}`"
                        class="manager-tool-item"
                        :class="call.ok ? 'is-resolved' : 'is-error'"
                      >
                        <div class="manager-tool-head">
                          <span>{{ call.name }}</span>
                          <em>{{ call.toolMessage ? (call.ok ? '已返回' : '失败') : '等待返回' }}</em>
                        </div>
                        <small v-if="call.argumentsText">{{ call.argumentsText }}</small>
                        <p>{{ call.resultText }}</p>
                      </div>
                    </div>
                  </div>
                </details>
              </template>

              <article
                v-if="isManagerAssistantRunning && !liveManagerChatDisplayItems.length"
                class="manager-card manager-message manager-message-assistant manager-message-live"
                data-manager-anchor-key="live:manager-thinking"
              >
                <div class="manager-run-title">
                  <strong>助手</strong>
                  <small>正在处理</small>
                </div>
                <p>正在思考...</p>
              </article>

              <details
                v-if="memoryFiles.length || managerRuns.length"
                class="manager-work-drawer"
                data-manager-anchor-key="meta:work"
              >
                <summary>
                  <strong>工作记录</strong>
                  <span v-if="currentManagerWorkRun">{{ managerStatusLabel(currentManagerWorkRun.status) }} · {{ formatRunInputLine(currentManagerWorkRun) }}</span>
                  <span v-else>{{ activeMemoryFiles.length }}/{{ memoryFiles.length }} 份档案</span>
                </summary>
                <article
                  v-if="currentManagerWorkRun"
                  :data-manager-anchor-key="`run:${currentManagerWorkRun.id}`"
                  class="manager-card manager-message manager-message-run manager-work-current"
                  :class="[`is-${currentManagerWorkRun.status}`, `tone-${managerRunTone(currentManagerWorkRun)}`]"
                >
                  <div class="manager-run-title">
                    <strong>本次后台工作</strong>
                    <small>{{ managerStatusLabel(currentManagerWorkRun.status) }}</small>
                  </div>
                  <p class="manager-work-source">
                    {{ formatRunInputLine(currentManagerWorkRun) }}
                  </p>
                  <small>{{ formatRunModelLine(currentManagerWorkRun) }}</small>
                  <small class="manager-run-activity">{{ formatRunActivityLine(currentManagerWorkRun) }}</small>
                  <div class="manager-work-status-grid">
                    <p>{{ formatRunMemoryLine(currentManagerWorkRun) }}</p>
                    <p>{{ formatRunMapLine(currentManagerWorkRun) }}</p>
                  </div>
                  <p v-if="currentManagerWorkRun.outputText">
                    结果：{{ shortText(currentManagerWorkRun.outputText, 180) }}
                  </p>
                  <p
                    v-if="formatRunIssueLine(currentManagerWorkRun)"
                    class="manager-work-issue-line"
                  >
                    {{ formatRunIssueLine(currentManagerWorkRun) }}
                  </p>
                  <details
                    v-if="managerToolTraceItems(currentManagerWorkRun.toolTrace).length"
                    class="manager-work-debug"
                  >
                    <summary>{{ toolTraceSummary(currentManagerWorkRun.toolTrace) }}</summary>
                    <div class="manager-tool-list">
                      <div
                        v-for="tool in managerToolTraceItems(currentManagerWorkRun.toolTrace)"
                        :key="tool.id"
                        class="manager-tool-item"
                        :class="managerToolTone(tool)"
                      >
                        <div class="manager-tool-head">
                          <span>{{ tool.name }}</span>
                          <em>{{ managerToolStatusLabel(tool) }}<template v-if="tool.elapsedLabel"> · {{ tool.elapsedLabel }}</template></em>
                        </div>
                        <details
                          v-if="tool.thoughts.length"
                          class="manager-tool-thoughts"
                        >
                          <summary>{{ thoughtSummaryLabel(tool.thoughts, false) }}</summary>
                          <div
                            v-for="(thought, thoughtIndex) in tool.thoughts"
                            :key="`${tool.id}-stored-thought-${thoughtIndex}`"
                            class="chat-thought-block"
                          >
                            <strong>{{ thought.label }}</strong>
                            <pre>{{ thought.text }}</pre>
                          </div>
                        </details>
                        <div
                          v-if="tool.preface"
                          class="manager-tool-preface xb-tavern-markdown"
                          :data-markdown-signature="markdownSignature(tool.preface)"
                          v-html="renderChatMarkdown(tool.preface)"
                        />
                        <small v-if="tool.args">{{ tool.args }}</small>
                        <p v-if="tool.summary">
                          {{ tool.summary }}
                        </p>
                        <p v-if="tool.path">
                          {{ tool.path }}
                        </p>
                      </div>
                    </div>
                  </details>
                  <button
                    v-if="currentManagerWorkRun.status === 'failed'"
                    type="button"
                    :disabled="managerBusy"
                    @click="retryManagerRun(currentManagerWorkRun)"
                  >
                    重试
                  </button>
                </article>
                <article
                  v-else
                  class="manager-card manager-message manager-message-system"
                  data-manager-anchor-key="meta:memory"
                >
                  <div class="manager-run-title">
                    <strong>记忆档案</strong>
                    <small>{{ activeMemoryFiles.length }}/{{ memoryFiles.length }}</small>
                  </div>
                  <p>{{ memoryIndexStatusLine }}</p>
                  <p v-if="selectedMemoryFile">
                    当前打开：{{ memoryFileDisplayName(selectedMemoryFile) }}
                  </p>
                </article>

                <details
                  v-if="archivedManagerRuns.length || hiddenManagerRunCount"
                  class="manager-work-history"
                >
                  <summary>
                    <strong>历史记录</strong>
                    <span>{{ archivedManagerRuns.length + hiddenManagerRunCount }} 条</span>
                  </summary>
                  <div
                    v-for="run in archivedManagerRuns"
                    :key="run.id"
                    class="manager-history-row"
                    :class="[`tone-${managerRunTone(run)}`]"
                  >
                    <div>
                      <strong>{{ managerStatusLabel(run.status) }}</strong>
                      <small>{{ formatRunInputLine(run) }}</small>
                    </div>
                    <span>{{ toolTraceSummary(run.toolTrace) || formatRunActivityLine(run) }}</span>
                  </div>
                  <p v-if="hiddenManagerRunCount">
                    更早 {{ hiddenManagerRunCount }} 条已收起。
                  </p>
                </details>
              </details>

              <p
                v-if="!visibleManagerChatItems.length"
                data-manager-anchor-key="empty"
                class="chat-empty"
              >
                还没有和助手对话。
              </p>
            </div>
            <TavernScrollControls
              extra-class="manager-scroll-helpers"
              :active="managerScrollControlsActive"
              :show-top="showManagerScrollTop"
              :show-bottom="showManagerScrollBottom"
              @top="scrollManagerToTop"
              @bottom="scrollManagerToBottom(true, { collapseWindow: true, revealHelpers: true })"
            />
          </div>

          <form
            class="manager-compose chat-compose"
            @submit.prevent="handleManagerSubmit"
          >
            <div
              v-if="managerInputStatus"
              class="compose-error"
            >
              {{ managerInputStatus }}
            </div>
            <textarea
              :ref="setManagerComposeTextareaRef"
              v-model="managerInputDraft"
              rows="3"
              placeholder="和助手说一句话..."
              :disabled="isManagerAssistantRunning"
              @input="handleComposeInput"
              @keydown="handleManagerComposeKeydown"
            />
            <button
              type="submit"
              class="primary-action"
              :disabled="!canSendManagerMessage"
            >
              {{ isManagerAssistantCancelling ? '正在停止' : isManagerAssistantRunning ? '停止' : '发送' }}
            </button>
          </form>
        </section>
      </div>
    </section>

    <aside class="tavern-workspace-panel">
      <button
        type="button"
        class="chat-mobile-sheet-handle"
        title="收起记忆面板"
        aria-label="收起记忆面板"
        @click="closeMobileChatPanel"
      />
      <div class="tavern-workspace-tabs">
        <button
          type="button"
          :class="{ active: chatWorkspacePanel === 'state' }"
          @click="chatWorkspacePanel = 'state'"
        >
          状态
        </button>
        <button
          type="button"
          :class="{ active: chatWorkspacePanel === 'memory' }"
          @click="chatWorkspacePanel = 'memory'"
        >
          记忆
        </button>
      </div>
      <section
        v-if="chatWorkspacePanel === 'state'"
        class="tavern-state-panel"
      >
        <TavernMapPanel
          compact
          :document="mapStateDocument"
          :patches="mapStatePatches"
        />
        <article class="tavern-current-state">
          <header>
            <strong>状态栏</strong>
            <small v-if="currentStateFile">{{ formatMemoryFileMeta(currentStateFile) }}</small>
          </header>
          <div
            v-if="currentStateContent"
            class="tavern-current-state-body xb-tavern-markdown"
            :data-markdown-signature="currentStatePreviewSignature"
            v-html="currentStatePreviewHtml"
          />
          <div
            v-else
            class="tavern-current-state-empty"
          >
            暂无当前状态。
          </div>
        </article>
      </section>
      <section
        v-else
        class="tavern-memory-workspace"
        :class="{ 'is-memory-directory-open': mobileMemoryDirectoryOpen }"
      >
        <aside class="tavern-memory-directory">
          <header class="tavern-memory-directory-head">
            <strong>记忆文档</strong>
            <span>{{ activeMemoryFiles.length }}</span>
          </header>
          <label
            v-if="memoryFiles.length"
            class="memory-search tavern-memory-search"
          >
            <span>检索档案</span>
            <input
              v-model="memoryFileSearchText"
              type="search"
              placeholder="剧情、状态、楼层"
            >
          </label>
          <div
            v-if="memoryFiles.length"
            class="memory-directory-list xb-files"
          >
            <div
              v-for="group in memoryDirectoryGroups"
              :key="group.key"
              class="memory-file-group"
            >
              <div class="memory-file-group-title">
                <span>{{ group.title }}</span>
                <em>{{ group.totalCount }}</em>
              </div>
              <div class="memory-file-tree">
                <button
                  v-for="file in group.files"
                  :key="file.path"
                  type="button"
                  class="memory-file"
                  :class="{ active: selectedMemoryFilePath === file.path, stale: file.status === 'stale' }"
                  @click="selectMobileMemoryFile(file.path)"
                >
                  <span class="memory-file-main">{{ memoryFileDisplayName(file) }}</span>
                </button>
                <button
                  v-if="group.hiddenCount"
                  type="button"
                  class="memory-file memory-file-more"
                  @click="expandMemoryFileGroup(group.key)"
                >
                  <span class="memory-file-main">再显示 {{ Math.min(group.hiddenCount, group.key === 'turns' ? MEMORY_TURN_BATCH_SIZE : MEMORY_FILE_BATCH_SIZE) }} 个</span>
                </button>
              </div>
            </div>
            <p
              v-if="memoryFileSearchText && !memoryDirectoryGroups.length"
              class="muted compact"
            >
              没有匹配的记忆档案。
            </p>
          </div>
          <p
            v-else
            class="muted compact"
          >
            还没有记忆档案。
          </p>
        </aside>
        <button
          type="button"
          class="tavern-mobile-memory-picker"
          :class="{ 'is-open': mobileMemoryDirectoryOpen }"
          :disabled="!memoryFiles.length"
          title="选择记忆文档"
          aria-label="选择记忆文档"
          @click="toggleMobileMemoryDirectory"
        >
          <span>{{ selectedMemoryFileEntry ? memoryFileDisplayName(selectedMemoryFileEntry) : '选择记忆文档' }}</span>
          <em aria-hidden="true">⌄</em>
        </button>
        <TavernMemoryEditor
          v-model:draft="memoryEditorDraft"
          :document-available="memoryEditorDocumentAvailable"
          :read-only="memoryEditorReadOnly"
          :dirty="memoryEditorDirty"
          :mode="memoryEditorMode"
          :preview-html="renderChatMarkdown(memoryEditorDraft)"
          :preview-signature="markdownSignature(memoryEditorDraft)"
          :status="memoryEditorStatus"
          :has-selected-file="!!selectedMemoryFileEntry"
          :loaded-path="memoryEditorLoadedPath"
          :file-meta="selectedMemoryFileEntry ? formatMemoryFileMeta(selectedMemoryFileEntry) : ''"
          @enter-edit="enterMemoryEditMode"
          @preview="previewMemoryDraft"
          @discard="discardMemoryDraft"
          @save="saveSelectedMemoryFile"
        />
      </section>
    </aside>

    <TavernContractModal
      v-if="contractModalOpen"
      :draft-contract="contractDraft"
      :dirty="contractDraftDirty"
      :saving="contractSaving"
      :can-save="!!selectedSessionId"
      :error-text="contractError"
      @close="closeContractModal"
      @toggle="toggleContractDraft"
      @save="sealContract"
    />
  </section>
</template>
