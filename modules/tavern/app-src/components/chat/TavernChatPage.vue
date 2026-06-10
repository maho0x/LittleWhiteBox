<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated } from 'vue';
import { captureElementScrollState, restoreElementScrollState, type ElementScrollSnapshot } from '../../scroll-state';
import TavernCornerActions from '../TavernCornerActions.vue';
import TavernMapPanel from '../TavernMapPanel.vue';
import TavernMemoryEditor from '../TavernMemoryEditor.vue';
import TavernScrollControls from '../TavernScrollControls.vue';
import { useTavernAppUiContext } from '../tavern-app-context';
import TavernChatSidebar from './TavernChatSidebar.vue';

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
    chatSubtitle,
    chatWorkspacePanel,
    copyMessage,
    copyManagerMessage,
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
    episodeSummaries,
    formatRunActivityLine,
    formatRunInputLine,
    formatRunMapLine,
    formatRunMemoryLine,
    formatManagerSource,
    formatMemoryFileMeta,
    formatMessageTime,
    formatRunModelLine,
    formatSummarySource,
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
    isManagerAssistantRunning,
    isRunning,
    latestErrorMessage,
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
    memoryEditorDirty,
    memoryEditorDocumentAvailable,
    memoryEditorDraft,
    memoryEditorLoadedPath,
    memoryEditorMode,
    memoryEditorReadOnly,
    memoryEditorStatus,
    memoryFileDisplayName,
    memoryFiles,
    memoryIndexStatusLine,
    mapStateDocument,
    mapStatePatches,
    messageKey,
    openPromptInspector,
    postToHost,
    previewMemoryDraft,
    recentTurnSummaries,
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
    saveEditMessage,
    saveEditManagerMessage,
    saveSelectedMemoryFile,
    scrollChatToBottom,
    scrollChatToTop,
    scrollManagerToBottom,
    scrollManagerToTop,
    selectedMemoryFile,
    shortText,
    showChatScrollBottom,
    showChatScrollTop,
    showManagerScrollBottom,
    showManagerScrollTop,
    startEditMessage,
    startEditManagerMessage,
    thoughtBlocks,
    thoughtSummaryLabel,
    toolTraceSummary,
    turnSummaries,
    updateChatScrollButtons,
    updateManagerScrollButtons,
    visibleChatMessages,
    visibleCharacterAvatar,
    visibleManagerChatItems,
    visibleManagerChatMessages,
    visibleManagerRuns,
    visibleUserAvatar,
} = ui;

let pendingChatScrollSnapshot: ElementScrollSnapshot | null = null;
let pendingManagerScrollSnapshot: ElementScrollSnapshot | null = null;

const currentStateFile = computed(() => (
    (memoryFiles.value || []).find((file: { path?: string }) => file.path === 'memory/state.md') || null
));
const currentStateContent = computed(() => String(currentStateFile.value?.content || '').trim());
const currentStatePreviewHtml = computed(() => renderChatMarkdown(currentStateContent.value));
const liveManagerRun = computed(() => (
    (managerRuns.value || []).find((run: { status?: string }) => ['queued', 'running'].includes(String(run.status || ''))) || null
));
const currentStatePreviewSignature = computed(() => markdownSignature(currentStateContent.value));

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

onBeforeUpdate(() => {
    pendingChatScrollSnapshot = captureElementScrollState(chatScrollRef.value, {
        itemSelector: '[data-chat-anchor-key]',
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
        itemSelector: '[data-chat-anchor-key]',
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
    :class="[`chat-focus-${chatFocus}`, `chat-layout-${chatLayout}`]"
  >
    <TavernCornerActions
      include-home
      :dark="homeThemeDark"
      @home="activeView = 'home'"
      @toggle-theme="homeThemeDark = !homeThemeDark"
      @exit="postToHost('xb-tavern:close')"
    />
    <TavernChatSidebar />

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
            <div>
              <h2>角色聊天</h2>
              <p>{{ chatSubtitle }}</p>
            </div>
            <div class="chat-head-actions">
              <button
                type="button"
                class="contract-trigger"
                title="契约"
                aria-label="契约"
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
              <div
                v-for="message in visibleChatMessages"
                :key="`${message.sessionId}-${message.order}`"
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
                <div
                  v-if="!isEditingMessage(message)"
                  class="xb-tavern-markdown"
                  :data-markdown-signature="markdownSignature(message.content)"
                  v-html="renderChatMarkdown(message.content)"
                />
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
                v-if="isRunning && (runtimeText || runtimeThoughts.length)"
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
                  v-if="runtimeText"
                  class="xb-tavern-markdown"
                  :data-markdown-signature="markdownSignature(runtimeText)"
                  v-html="renderChatMarkdown(runtimeText)"
                />
              </div>
              <div
                v-if="isRunning && !runtimeText && !thoughtBlocks(runtimeThoughts).length"
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
            </div>
            <TavernScrollControls
              :active="chatScrollControlsActive"
              :show-top="showChatScrollTop"
              :show-bottom="showChatScrollBottom"
              @top="scrollChatToTop"
              @bottom="scrollChatToBottom(true, { collapseWindow: true })"
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

        <section
          class="chat-face chat-face-back chat-manager"
          :aria-hidden="chatFocus === 'chat'"
        >
          <header class="manager-head">
            <div>
              <p class="eyebrow">
                Assistant
              </p>
              <h2>助手聊天</h2>
              <p>{{ managerStatusLine }}</p>
            </div>
            <div class="manager-head-actions">
              <button
                type="button"
                class="contract-trigger"
                title="契约"
                aria-label="契约"
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

              <details
                v-if="liveManagerRun"
                class="manager-tool-turn manager-tool-turn-live"
                data-manager-anchor-key="meta:live-manager-run"
                open
              >
                <summary>
                  <span>正在处理</span>
                  <small>{{ toolTraceSummary(liveManagerRun.toolTrace) || managerStatusLabel(liveManagerRun.status) }}</small>
                </summary>
                <div class="manager-tool-turn-body">
                  <div class="manager-tool-round">
                    <div class="manager-tool-round-title">
                      <strong>{{ managerStatusLabel(liveManagerRun.status) }}</strong>
                      <span>{{ formatRunActivityLine(liveManagerRun) }}</span>
                    </div>
                    <p v-if="formatRunMemoryLine(liveManagerRun)">
                      {{ formatRunMemoryLine(liveManagerRun) }}
                    </p>
                    <p v-if="formatRunMapLine(liveManagerRun)">
                      {{ formatRunMapLine(liveManagerRun) }}
                    </p>
                    <div
                      v-for="tool in managerToolTraceItems(liveManagerRun.toolTrace)"
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
                        open
                      >
                        <summary>{{ thoughtSummaryLabel(tool.thoughts, tool.status === 'running') }}</summary>
                        <div
                          v-for="(thought, thoughtIndex) in tool.thoughts"
                          :key="`${tool.id}-thought-${thoughtIndex}`"
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
                </div>
              </details>

              <details
                v-if="memoryFiles.length || episodeSummaries.length || managerRuns.length || turnSummaries.length"
                class="manager-work-drawer"
                data-manager-anchor-key="meta:work"
              >
                <summary>
                  <strong>工作记录</strong>
                  <span>{{ memoryFiles.length }} 份档案 · {{ managerRuns.length }} 次运行</span>
                </summary>
                <article
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

                <article
                  v-for="episode in episodeSummaries.slice(0, 2)"
                  :key="episode.id"
                  :data-manager-anchor-key="`episode:${episode.id}`"
                  class="manager-card manager-message manager-message-episode"
                >
                  <div class="manager-run-title">
                    <strong>{{ episode.title }}</strong>
                    <small>第 {{ episode.startTurn }}-{{ episode.endTurn }} 轮</small>
                  </div>
                  <p>{{ episode.summary || '暂无摘要。' }}</p>
                  <p v-if="episode.unresolved?.length">
                    未解决：{{ episode.unresolved.join('、') }}
                  </p>
                </article>

                <article
                  v-for="run in visibleManagerRuns"
                  :key="run.id"
                  :data-manager-anchor-key="`run:${run.id}`"
                  class="manager-card manager-message manager-message-run"
                  :class="[`is-${run.status}`, `tone-${managerRunTone(run)}`]"
                >
                  <div class="manager-run-title">
                    <strong>{{ managerStatusLabel(run.status) }}</strong>
                    <small>{{ formatManagerSource(run) }}</small>
                  </div>
                  <p>{{ formatRunInputLine(run) }}</p>
                  <small>{{ formatRunModelLine(run) }}</small>
                  <small class="manager-run-activity">{{ formatRunActivityLine(run) }}</small>
                  <p v-if="run.parsedAction">
                    动作：{{ run.parsedAction }}
                  </p>
                  <p>{{ formatRunMemoryLine(run) }}</p>
                  <p>{{ formatRunMapLine(run) }}</p>
                  <p v-if="run.outputText">
                    结论：{{ shortText(run.outputText, 220) }}
                  </p>
                  <p v-if="run.toolTrace">
                    {{ toolTraceSummary(run.toolTrace) }}
                  </p>
                  <div
                    v-if="managerToolTraceItems(run.toolTrace).length"
                    class="manager-tool-list"
                  >
                    <div
                      v-for="tool in managerToolTraceItems(run.toolTrace)"
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
                <article
                  v-if="hiddenManagerRunCount"
                  class="manager-card manager-message manager-message-run manager-message-archive-note"
                >
                  <div class="manager-run-title">
                    <strong>较早工作记录</strong>
                    <small>{{ hiddenManagerRunCount }} 条</small>
                  </div>
                  <p>较早的管理员运行记录已收起，避免长会话持续占用界面资源。</p>
                </article>

                <article
                  v-for="summary in recentTurnSummaries.slice(0, 4)"
                  :key="summary.id"
                  :data-manager-anchor-key="`summary:${summary.id}`"
                  class="manager-card manager-message manager-message-turn"
                >
                  <div class="manager-run-title">
                    <strong>{{ formatSummarySource(summary) }}</strong>
                    <small v-if="summary.tags?.length">{{ summary.tags.join('、') }}</small>
                  </div>
                  <p>{{ summary.summary }}</p>
                </article>
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
              @bottom="scrollManagerToBottom(true, { collapseWindow: true })"
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
              {{ isManagerAssistantRunning ? '停止' : '发送' }}
            </button>
          </form>
        </section>
      </div>
    </section>

    <aside class="tavern-workspace-panel">
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
      <TavernMemoryEditor
        v-else
        v-model:draft="memoryEditorDraft"
        :document-available="memoryEditorDocumentAvailable"
        :read-only="memoryEditorReadOnly"
        :dirty="memoryEditorDirty"
        :mode="memoryEditorMode"
        :preview-html="renderChatMarkdown(memoryEditorDraft)"
        :preview-signature="markdownSignature(memoryEditorDraft)"
        :status="memoryEditorStatus"
        :has-selected-file="!!selectedMemoryFile"
        :loaded-path="memoryEditorLoadedPath"
        :file-meta="selectedMemoryFile ? formatMemoryFileMeta(selectedMemoryFile) : ''"
        @enter-edit="enterMemoryEditMode"
        @preview="previewMemoryDraft"
        @discard="discardMemoryDraft"
        @save="saveSelectedMemoryFile"
      />
    </aside>
  </section>
</template>
