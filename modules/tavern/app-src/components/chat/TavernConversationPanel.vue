<script setup lang="ts">
import { computed, watch } from 'vue';
import TavernScrollControls from '../TavernScrollControls.vue';
import { useTavernChatContext, useTavernShellContext } from '../tavern-app-context';
import { useTavernEphemeralDisclosureScope } from '../useTavernEphemeralDisclosureScope';
import {
    hasRenderableLiveAssistantContent,
    hasRenderableLiveAssistantMarkdown,
} from './live-assistant-state';
import {
    getActionCheckEvents,
    injectActionCheckRenderMarkers,
} from '../../../shared/runtime-events';
import type { TavernMessageRecord } from '../../../shared/session-db';

const emit = defineEmits<{
    (event: 'open-contract'): void;
}>();

const shell = useTavernShellContext();
const chat = useTavernChatContext();
const {
    activeView,
    homeThemeDark,
    openPromptInspector,
    rememberBrokenAvatar,
} = shell;
const {
    actionFeedback,
    cancelEditMessage,
    canDrawMessage,
    canEditMessage,
    canRerunMessage,
    canSendMessage,
    chatComposeTextareaRef,
    chatFocus,
    chatMessages,
    chatMessageWindow,
    chatScrollControlsActive,
    chatScrollRef,
    copyMessage,
    currentUserMessage,
    deleteMessageTurn,
    drawMessage,
    drawMessageStatusClass,
    drawMessageStatusText,
    drawMessageTitle,
    editingMessageDraft,
    formatMessageTime,
    handleChatScroll,
    handleChatSubmit,
    handleChatTouchMove,
    handleChatTouchStart,
    handleChatWheel,
    handleComposeInput,
    handleComposeKeydown,
    handleEditInput,
    handleEditKeydown,
    isDrawingMessage,
    isEditingMessage,
    isEditingMessageDirty,
    isCancellingRun,
    isRunning,
    latestErrorMessage,
    markdownSignature,
    messageKey,
    renderChatMarkdown,
    rerunFromMessage,
    revealOlderChatMessages,
    roleLabel,
    runtimeActionCheckEvents,
    runtimeText,
    runtimeThoughts,
    saveEditMessage,
    scrollChatToBottom,
    scrollChatToTop,
    selectedSessionId,
    showChatScrollBottom,
    showChatScrollTop,
    startEditMessage,
    thoughtBlocks,
    thoughtSummaryLabel,
    visibleCharacterAvatar,
    visibleChatMessages,
    visibleUserAvatar,
} = chat;

function setChatScrollRef(element: Element | null) {
    chatScrollRef.value = element instanceof HTMLElement ? element : null;
}

function setChatComposeTextareaRef(element: Element | null) {
    chatComposeTextareaRef.value = element instanceof HTMLTextAreaElement ? element : null;
}

function openContractModal() {
    emit('open-contract');
}

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
const thoughtDisclosure = useTavernEphemeralDisclosureScope();
const runtimeThoughtDisclosureId = 'chat:runtime-thoughts';

function messageThoughtDisclosureId(message: TavernMessageRecord) {
    return `chat:thought:${messageKey(message)}`;
}

watch(
    [activeView, chatFocus, selectedSessionId],
    ([view, focus]) => {
        if (view !== 'chat' || focus !== 'chat') {
            thoughtDisclosure.reset();
        }
    },
);

watch(
    () => `${selectedSessionId.value}:${chatMessageWindow.value.startIndex}:${chatMessageWindow.value.visibleCount}`,
    () => thoughtDisclosure.reset(),
);
</script>

<template>
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
                  保存并从这里重来
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
              :open="thoughtDisclosure.isOpen(messageThoughtDisclosureId(message))"
              @toggle="thoughtDisclosure.setOpenFromEvent(messageThoughtDisclosureId(message), $event)"
            >
              <summary>{{ thoughtSummaryLabel(message) }}</summary>
              <template
                v-if="thoughtDisclosure.isOpen(messageThoughtDisclosureId(message))"
              >
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
              </template>
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
                :title="message.role === 'user' ? '发送最后一楼' : '重新生成最后回复'"
                :aria-label="message.role === 'user' ? '发送最后一楼' : '重新生成最后回复'"
                @click="rerunFromMessage(message)"
              >
                ↻
              </button>
              <button
                type="button"
                :disabled="isRunning"
                :class="actionFeedback(message, 'delete')"
                title="从这里删除后续剧情"
                aria-label="从这里删除后续剧情"
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
              {{ String((event as { label?: string }).label || '') }}
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
            :open="thoughtDisclosure.isOpen(runtimeThoughtDisclosureId, true)"
            @toggle="thoughtDisclosure.setOpenFromEvent(runtimeThoughtDisclosureId, $event)"
          >
            <summary>{{ thoughtSummaryLabel(runtimeThoughts, true) }}</summary>
            <template
              v-if="thoughtDisclosure.isOpen(runtimeThoughtDisclosureId, true)"
            >
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
            </template>
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
</template>


