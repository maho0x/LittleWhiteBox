<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated, ref, watch } from 'vue';
import { captureElementScrollState, restoreElementScrollState, type ElementScrollSnapshot } from '../../scroll-state';
import TavernCornerActions from '../TavernCornerActions.vue';
import TavernContractModal from './TavernContractModal.vue';
import {
    useTavernChatContext,
    useTavernManagerContext,
    useTavernSettingsContext,
    useTavernShellContext,
    useTavernWorkspaceContext,
} from '../tavern-app-context';
import TavernChatSidebar from './TavernChatSidebar.vue';
import TavernChatPresetSettingsPanel from '../settings/TavernChatPresetSettingsPanel.vue';
import TavernConversationPanel from './TavernConversationPanel.vue';
import TavernManagerPanel from './TavernManagerPanel.vue';
import TavernWorkspacePanel from './TavernWorkspacePanel.vue';
import TavernWorldbooksSettingsPanel from '../settings/TavernWorldbooksSettingsPanel.vue';
import {
    normalizeTavernSessionContract,
    type TavernContractPermissionKey,
    type TavernSessionContract,
} from '../../../shared/session-contract';

const shell = useTavernShellContext();
const chat = useTavernChatContext();
const manager = useTavernManagerContext();
const settings = useTavernSettingsContext();
const workspace = useTavernWorkspaceContext();
const {
    activeView,
    chatFocus,
    homeThemeDark,
    openPromptInspector,
} = shell;
const {
    chatAutoScroll,
    chatLayout,
    chatScrollRef,
    chatSidePanel,
    updateChatScrollButtons,
} = chat;
const {
    managerAutoScroll,
    managerScrollRef,
    updateManagerScrollButtons,
} = manager;
const {
    chatWorkspacePanel,
    saveSessionContract,
    selectedSessionId,
    sessionContract,
} = workspace;
const {
    activeSettingsWorkspace,
    apiSettingsRootRef,
    syncChatPresetFromHost,
    syncGlobalWorldbooksFromHost,
    syncWorldbooksForCurrentCharacter,
} = settings;

let pendingChatScrollSnapshot: ElementScrollSnapshot | null = null;
let pendingManagerScrollSnapshot: ElementScrollSnapshot | null = null;
const contractModalOpen = ref(false);
const quickSettingsOpen = ref<'api' | 'chatPreset' | 'worldbooks' | null>(null);
const contractSaving = ref(false);
const contractError = ref('');
const contractDraft = ref<TavernSessionContract>(normalizeTavernSessionContract(sessionContract.value));
const mobileChatPanel = ref<'none' | 'directory' | 'workspace'>('none');
const mobileMemoryDirectoryOpen = ref(false);

const contractDraftDirty = computed(() => JSON.stringify(contractDraft.value) !== JSON.stringify(sessionContract.value));

function closeMobileChatPanel() {
    mobileChatPanel.value = 'none';
    mobileMemoryDirectoryOpen.value = false;
}

function toggleMobileChatPanel(panel: 'directory' | 'workspace') {
    mobileChatPanel.value = mobileChatPanel.value === panel ? 'none' : panel;
}

function openMobileSessionsPanel() {
    chatSidePanel.value = 'sessions';
    mobileChatPanel.value = 'directory';
    mobileMemoryDirectoryOpen.value = false;
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

function openContractModal() {
    contractError.value = '';
    contractDraft.value = normalizeTavernSessionContract(sessionContract.value);
    contractModalOpen.value = true;
}

function closeContractModal() {
    contractError.value = '';
    contractModalOpen.value = false;
}

const quickSettingsTitle = computed(() => {
    if (quickSettingsOpen.value === 'worldbooks') {return '世界书';}
    if (quickSettingsOpen.value === 'chatPreset') {return '聊天预设';}
    return 'API 配置';
});

const quickSettingsLayoutClass = computed(() => (
    quickSettingsOpen.value ? `is-${quickSettingsOpen.value}-workspace` : ''
));

function openQuickSettingsModal(workspace: 'api' | 'chatPreset' | 'worldbooks') {
    closeMobileChatPanel();
    activeSettingsWorkspace.value = workspace;
    quickSettingsOpen.value = workspace;
    if (workspace === 'chatPreset') {
        void syncChatPresetFromHost();
    }
    if (workspace === 'worldbooks') {
        void syncWorldbooksForCurrentCharacter();
        void syncGlobalWorldbooksFromHost();
    }
}

function closeQuickSettingsModal() {
    quickSettingsOpen.value = null;
}

function setChatApiSettingsRootRef(element: Element | null) {
    apiSettingsRootRef.value = element instanceof HTMLElement ? element : null;
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

watch(() => activeView.value, (view) => {
    if (view !== 'chat') {
        quickSettingsOpen.value = null;
    }
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
      include-api
      include-chat-preset
      include-home
      include-worldbooks
      home-last
      :dark="homeThemeDark"
      @api="openQuickSettingsModal('api')"
      @chat-preset="openQuickSettingsModal('chatPreset')"
      @home="activeView = 'home'"
      @toggle-theme="homeThemeDark = !homeThemeDark"
      @worldbooks="openQuickSettingsModal('worldbooks')"
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
            title="聊天预设"
            aria-label="聊天预设"
            @click="openQuickSettingsModal('chatPreset')"
          >
            <svg
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                stroke-width="1.6"
                d="M5 5h14v10H9l-4 4V5ZM8 9h8M8 12h5"
              />
            </svg>
          </button>
          <button
            type="button"
            class="chat-mobile-icon-button chat-mobile-utility-button"
            title="API 配置"
            aria-label="API 配置"
            @click="openQuickSettingsModal('api')"
          >
            <svg
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                stroke-width="1.6"
                d="M9 7V3M15 7V3M7 11h10M8 7h8v5a4 4 0 0 1-8 0V7ZM12 16v5"
              />
            </svg>
          </button>
          <button
            type="button"
            class="chat-mobile-icon-button chat-mobile-utility-button"
            title="世界书"
            aria-label="世界书"
            @click="openQuickSettingsModal('worldbooks')"
          >
            <svg
              class="chat-mobile-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                stroke-width="1.6"
                d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM3.8 9h16.4M3.8 15h16.4M12 3c2 2.2 3 5.2 3 9s-1 6.8-3 9M12 3c-2 2.2-3 5.2-3 9s1 6.8 3 9"
              />
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
        </div>
      </div>
      <div class="chat-mobile-context-row">
        <button
          type="button"
          class="chat-mobile-context-button"
          :class="{ 'is-active': mobileChatPanel === 'workspace' && chatWorkspacePanel === 'state' }"
          title="地图"
          aria-label="地图"
          @click="toggleMobileWorkspacePanel('state')"
        >
          地图
        </button>
        <button
          type="button"
          class="chat-mobile-context-button"
          :class="{ 'is-active': mobileChatPanel === 'workspace' && chatWorkspacePanel === 'memory' }"
          title="记忆"
          aria-label="记忆"
          @click="toggleMobileWorkspacePanel('memory')"
        >
          记忆
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
    <TavernChatSidebar
      @click="handleMobileDirectoryClick"
      @close="closeMobileChatPanel"
    />

    <section
      class="chat-workbench"
      :class="{ 'is-manager': chatFocus === 'manager' }"
    >
      <div class="chat-flip-card">
        <TavernConversationPanel
          @open-contract="openContractModal"
          @open-session-archive="openMobileSessionsPanel"
        />
        <TavernManagerPanel @open-contract="openContractModal" />
      </div>
    </section>

    <TavernWorkspacePanel
      :mobile-memory-directory-open="mobileMemoryDirectoryOpen"
      @close="closeMobileChatPanel"
      @close-memory-directory="mobileMemoryDirectoryOpen = false"
      @toggle-memory-directory="toggleMobileMemoryDirectory"
    />
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
    <div
      v-if="quickSettingsOpen"
      class="chat-quick-settings-overlay"
      role="presentation"
    >
      <section
        class="chat-quick-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-quick-settings-title"
      >
        <header class="chat-quick-settings-head">
          <h2 id="chat-quick-settings-title">
            {{ quickSettingsTitle }}
          </h2>
          <button
            type="button"
            class="chat-quick-settings-close"
            title="关闭"
            aria-label="关闭"
            @click="closeQuickSettingsModal"
          >
            ×
          </button>
        </header>
        <div class="chat-quick-settings-body">
          <div
            v-if="quickSettingsOpen === 'api'"
            :ref="setChatApiSettingsRootRef"
            class="tavern-api-settings chat-quick-api-root"
          />
          <div
            v-else
            class="settings-layout chat-quick-settings-layout"
            :class="quickSettingsLayoutClass"
          >
            <section class="xb-main">
              <TavernChatPresetSettingsPanel />
              <TavernWorldbooksSettingsPanel />
            </section>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>
