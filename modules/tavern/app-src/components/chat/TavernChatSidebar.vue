<script setup lang="ts">
import { useTavernChatContext, useTavernMemoryContext, useTavernShellContext } from '../tavern-app-context';
import { useMobileSheetDrag } from './useMobileSheetDrag';

const emit = defineEmits<{
    (event: 'close'): void;
}>();

const shell = useTavernShellContext();
const chat = useTavernChatContext();
const memory = useTavernMemoryContext();
const {
    CHAT_SIDEBAR_BATCH_SIZE,
    chatLayout,
    chatSidebarSessionLimit,
    chatSidebarSessions,
    chatSidePanel,
    chatSubtitle,
    displayCharacterName,
    filteredChatSidebarSessionCount,
    hiddenChatSidebarSessionCount,
    removeSession,
    selectedSessionId,
    selectSession,
    sessionDisplayTitle,
    sessionFloorLabel,
    sessions,
    visibleCharacterAvatar,
} = chat;
const {
    activeMemoryFiles,
    expandMemoryFileGroup,
    MEMORY_FILE_BATCH_SIZE,
    MEMORY_TURN_BATCH_SIZE,
    memoryDirectoryGroups,
    memoryFileDisplayName,
    memoryFiles,
    memoryFileSearchText,
    selectedMemoryFilePath,
    selectMemoryFile,
} = memory;
const {
    rememberBrokenAvatar,
} = shell;

function closeMobileChatPanel() {
    emit('close');
}

const {
    dragging: sheetHandleDragging,
    handleSheetHandlePointerCancel,
    handleSheetHandlePointerDown,
    handleSheetHandlePointerMove,
    handleSheetHandlePointerUp,
} = useMobileSheetDrag(closeMobileChatPanel);
</script>

<template>
  <aside class="chat-side xb-sidebar">
    <button
      type="button"
      class="chat-mobile-sheet-handle"
      :class="{ 'is-dragging': sheetHandleDragging }"
      title="收起目录"
      aria-label="收起目录"
      @click="closeMobileChatPanel"
      @pointercancel="handleSheetHandlePointerCancel"
      @pointerdown="handleSheetHandlePointerDown"
      @pointermove="handleSheetHandlePointerMove"
      @pointerup="handleSheetHandlePointerUp"
    />
    <section class="chat-profile xb-brand">
      <div class="avatar-orb">
        <img
          v-if="visibleCharacterAvatar"
          :src="visibleCharacterAvatar"
          alt=""
          @error="rememberBrokenAvatar(visibleCharacterAvatar)"
        >
        <span v-else>{{ displayCharacterName.slice(0, 1) }}</span>
      </div>
      <div>
        <h2>{{ displayCharacterName }}</h2>
        <p>{{ chatSubtitle }}</p>
      </div>
      <div
        class="xb-workspace-controller chat-layout-controller"
        aria-label="区域大小"
      >
        <button
          type="button"
          class="xb-layout-button"
          :class="{ 'is-active': chatLayout === 'chat' }"
          @click="chatLayout = 'chat'"
        >
          聊天
        </button>
        <button
          type="button"
          class="xb-layout-button"
          :class="{ 'is-active': chatLayout === 'balanced' }"
          @click="chatLayout = 'balanced'"
        >
          平衡
        </button>
        <button
          type="button"
          class="xb-layout-button"
          :class="{ 'is-active': chatLayout === 'editor' }"
          @click="chatLayout = 'editor'"
        >
          记忆
        </button>
      </div>
    </section>

    <div
      class="chat-side-switch"
      role="tablist"
      aria-label="左侧目录"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="chatSidePanel === 'memory'"
        :class="{ active: chatSidePanel === 'memory' }"
        @click="chatSidePanel = 'memory'"
      >
        <strong>记忆</strong>
        <span>{{ activeMemoryFiles.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="chatSidePanel === 'sessions'"
        :class="{ active: chatSidePanel === 'sessions' }"
        @click="chatSidePanel = 'sessions'"
      >
        <strong>会话</strong>
        <span>{{ filteredChatSidebarSessionCount }}</span>
      </button>
    </div>

    <section
      v-if="chatSidePanel === 'sessions'"
      class="chat-side-block chat-directory-block"
    >
      <div class="side-block-head">
        <strong>会话目录</strong>
        <span>{{ filteredChatSidebarSessionCount }}</span>
      </div>
      <div class="session-list chat-directory-list xb-files">
        <div
          v-for="session in chatSidebarSessions"
          :key="session.id"
          class="session-card compact"
          :class="{ active: session.id === selectedSessionId }"
        >
          <button
            type="button"
            class="session-open"
            @click="selectSession(session.id)"
          >
            <strong>{{ sessionDisplayTitle(session) || '未选择角色' }}</strong>
            <small>{{ sessionFloorLabel(session) }}</small>
          </button>
          <button
            type="button"
            class="session-delete"
            title="删除会话"
            aria-label="删除会话"
            @click="removeSession(session.id, $event)"
          >
            删除
          </button>
        </div>
        <button
          v-if="hiddenChatSidebarSessionCount"
          type="button"
          class="session-more"
          @click="chatSidebarSessionLimit += CHAT_SIDEBAR_BATCH_SIZE"
        >
          再显示 {{ Math.min(hiddenChatSidebarSessionCount, CHAT_SIDEBAR_BATCH_SIZE) }} 个会话
        </button>
        <p
          v-if="!chatSidebarSessions.length"
          class="muted compact"
        >
          当前角色还没有其他会话。
        </p>
      </div>
    </section>

    <section
      v-if="chatSidePanel === 'memory'"
      class="chat-side-block chat-directory-block"
    >
      <div class="side-block-head">
        <strong>记忆目录</strong>
        <span>{{ activeMemoryFiles.length }}</span>
      </div>
      <label
        v-if="memoryFiles.length"
        class="memory-search"
      >
        <input
          v-model="memoryFileSearchText"
          type="search"
          placeholder="检索档案"
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
              @click="selectMemoryFile(file.path)"
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
    </section>
  </aside>
</template>
