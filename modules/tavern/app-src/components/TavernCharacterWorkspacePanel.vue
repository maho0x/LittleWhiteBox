<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useTavernCharacterContext } from './tavern-app-context';
import { useTavernEphemeralDisclosureScope } from './useTavernEphemeralDisclosureScope';
import type { TavernSessionRecord } from '../../shared/session-db';

const {
    avatarAvailable,
    batchSize,
    characterWorldbookBusy,
    characterWorldbookState,
    characters,
    enterSelected,
    filteredCount,
    hiddenCount,
    liveCharacterKey,
    loadMore,
    movePreview,
    openCharacterWorldbook,
    openSession: openSessionById,
    removeSession,
    pendingCharacterSessionKey,
    pendingError,
    pendingPreviewCharacterKey,
    refresh,
    rememberBrokenAvatar,
    searchText,
    select,
    selectFirstVisible,
    selectGreeting,
    selectLastVisible,
    selectedCharacter,
    selectedCharacterSessions,
    selectedGreetingIndex,
    sessionFloorLabel,
    shortText,
    syncWorldbookState,
    visibleCharacters,
} = useTavernCharacterContext();

const listRef = ref<HTMLElement | null>(null);
const sessionArchiveOpen = ref(false);
const characterDefinitionOpen = ref(false);
const advancedDefinitionDisclosure = useTavernEphemeralDisclosureScope();

const greetingOptions = computed(() => {
    const selected = selectedCharacter.value;
    if (!selected) {return [];}
    return [
        String(selected.firstMessage || '').trim(),
        ...(selected.alternateGreetings || []),
    ].filter(Boolean);
});
const selectedGreetingText = computed(() => {
    if (!greetingOptions.value.length) {return '';}
    const index = Math.min(Math.max(0, Number(selectedGreetingIndex.value) || 0), greetingOptions.value.length - 1);
    return greetingOptions.value[index] || '';
});
const hasMultipleGreetings = computed(() => greetingOptions.value.length > 1);
const selectedCharacterSessionCount = computed(() => selectedCharacterSessions.value.length);
const characterDefinitionFields = computed(() => {
    const character = selectedCharacter.value;
    return [
        { label: '性格摘要', value: character?.personality || '' },
        { label: '情景', value: character?.scenario || '' },
        { label: '角色备注', value: character?.characterDepthPrompt || '' },
        { label: '制作者备注', value: character?.creatorNotes || '' },
        { label: '示例对话', value: character?.mesExample || '' },
    ];
});

const selectedCharacterPreviewLoading = computed(() => (
    !!selectedCharacter.value
    && String(pendingPreviewCharacterKey.value || '') === String(selectedCharacter.value.characterKey || '')
));

const characterWorldbookButtonTitle = computed(() => {
    const state = characterWorldbookState.value;
    if (!state) {return '读取角色世界书';}
    if (state.boundWorldbookName && state.boundExists) {return `打开 ${state.boundWorldbookName}`;}
    if (state.hasEmbeddedBook) {return `导入 ${state.embeddedBookName}`;}
    return '选择一本世界书绑定';
});
const characterWorldbookBound = computed(() => (
    characterWorldbookState.value?.boundExists === true
));

function scrollSelectedIntoView() {
    void nextTick(() => {
        const root = listRef.value;
        const selectedKey = String(selectedCharacter.value?.characterKey || '').trim();
        if (!root || !selectedKey) {return;}
        const target = Array.from(root.querySelectorAll<HTMLElement>('[data-character-card-id]'))
            .find((node) => node.dataset.characterCardId === selectedKey);
        target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
}

function handleSearchInput(event: Event) {
    searchText.value = (event.target as HTMLInputElement).value;
}

function handleArchiveKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        movePreview(1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        movePreview(-1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        selectFirstVisible();
    } else if (event.key === 'End') {
        event.preventDefault();
        selectLastVisible();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        openSessionArchive();
    }
}

function characterDataDisclosureId(key: string) {
    return `character-data:${selectedCharacter.value?.characterKey || 'none'}:${key}`;
}

function greetingLabel(index: number) {
    return index === 0 ? '主开场白' : `备用 ${index}`;
}

function formatSessionTime(value: unknown) {
    const time = Number(value) || 0;
    if (!time) {return '未知时间';}
    return new Date(time).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function sessionArchiveTitle(session: TavernSessionRecord) {
    return String(session.title || session.characterName || selectedCharacter.value?.name || '未命名会话').trim();
}

function sessionArchiveMeta(session: TavernSessionRecord) {
    return `${formatSessionTime(session.updatedAt || session.createdAt)} · ${sessionFloorLabel(session)}`;
}

function openSessionArchive() {
    if (!selectedCharacter.value || pendingCharacterSessionKey.value) {return;}
    sessionArchiveOpen.value = true;
}

function closeSessionArchive() {
    sessionArchiveOpen.value = false;
}

function openCharacterDefinition() {
    if (!selectedCharacter.value) {return;}
    characterDefinitionOpen.value = true;
}

function closeCharacterDefinition() {
    characterDefinitionOpen.value = false;
}

function openSession(sessionId: string) {
    const id = String(sessionId || '').trim();
    if (!id) {return;}
    closeSessionArchive();
    void openSessionById(id);
}

async function deleteArchivedSession(sessionId: string, event: Event) {
    await removeSession(sessionId, event);
}

watch(
    () => selectedCharacter.value?.characterKey,
    (characterKey) => {
        advancedDefinitionDisclosure.reset();
        closeCharacterDefinition();
        closeSessionArchive();
        scrollSelectedIntoView();
        const targetKey = String(characterKey || '').trim();
        if (targetKey) {
            void syncWorldbookState(targetKey);
        }
    },
    { immediate: true },
);
</script>

<template>
  <div class="character-workspace-panel">
    <div
      v-if="pendingError"
      class="character-select-error"
    >
      角色列表读取失败：{{ pendingError }}
    </div>

    <section
      v-if="characters.length"
      class="character-archive"
      :class="{ 'has-character-selection': !!selectedCharacter }"
    >
      <aside class="character-index-panel">
        <div class="index-panel-toolbar">
          <label class="os-search-bar">
            <span class="icon">⌕</span>
            <input
              :value="searchText"
              type="search"
              placeholder="检索角色特征..."
              @input="handleSearchInput"
            >
          </label>
          <div class="index-meta">
            {{ visibleCharacters.length }} / {{ filteredCount }} 项
          </div>
        </div>

        <div
          ref="listRef"
          class="character-card-grid"
          tabindex="0"
          aria-label="角色卡列表"
          @keydown="handleArchiveKeydown"
        >
          <button
            v-for="character in visibleCharacters"
            :key="character.characterKey"
            type="button"
            class="character-card-option"
            :data-character-card-id="character.characterKey"
            :class="{
              current: character.characterKey === liveCharacterKey,
              selected: character.characterKey === selectedCharacter?.characterKey,
              pending: character.characterKey === pendingCharacterSessionKey,
            }"
            :disabled="!!pendingCharacterSessionKey"
            @click="select(character.characterKey)"
          >
            <div class="card-focus-indicator" />
            <span class="character-card-avatar">
              <img
                v-if="avatarAvailable(character.avatar)"
                :src="character.avatar"
                loading="lazy"
                decoding="async"
                alt=""
                @error="rememberBrokenAvatar(character.avatar)"
              >
              <span v-else>{{ character.name.slice(0, 1) }}</span>
            </span>
            <span class="character-card-body">
              <span class="character-card-title">
                <strong>{{ character.name }}</strong>
              </span>
              <span class="character-card-desc">
                {{ shortText(character.description || character.personality || character.scenario || character.firstMessage || '暂无数据存档。', 72) }}
              </span>
              <span class="card-status-tags">
                <small
                  v-if="character.characterKey === liveCharacterKey"
                  class="tag active"
                >当前</small>
                <small
                  v-if="character.characterKey === pendingCharacterSessionKey"
                  class="tag loading"
                >打开中</small>
                <small
                  v-else-if="character.characterKey === pendingPreviewCharacterKey"
                  class="tag loading"
                >读取中</small>
              </span>
            </span>
          </button>
          <button
            v-if="hiddenCount"
            type="button"
            class="archive-load-more character-load-more"
            @click="loadMore"
          >
            加载更多角色 ({{ Math.min(hiddenCount, batchSize) }})
          </button>
        </div>

        <div
          v-if="!visibleCharacters.length"
          class="empty-note"
        >
          没有匹配的角色。
        </div>
      </aside>

      <main
        v-if="selectedCharacter"
        class="character-preview-panel dossier-view"
      >
        <div class="dossier-header">
          <div class="dossier-identity">
            <div class="dossier-title-row">
              <h3>{{ selectedCharacter.name }}</h3>
              <div class="dossier-title-actions">
                <button
                  type="button"
                  class="os-system-act-btn character-definition-button"
                  title="角色卡详情"
                  aria-label="角色卡详情"
                  @click="openCharacterDefinition"
                >
                  <svg
                    class="character-definition-icon"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="1.7"
                      d="M5.5 4.7c1.8-.9 4.1-.9 6.5.3 2.4-1.2 4.7-1.2 6.5-.3v14.4c-1.8-.8-4.1-.7-6.5.5-2.4-1.2-4.7-1.3-6.5-.5V4.7Z"
                    />
                    <path
                      stroke-linecap="round"
                      stroke-width="1.3"
                      d="M12 5v14.2M8 8.5h1.9M8 11.5h1.9M14.1 8.5H16M14.1 11.5H16"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  class="os-system-act-btn character-worldbook-button"
                  :class="{ 'is-loading': characterWorldbookBusy, 'is-bound': characterWorldbookBound }"
                  :disabled="!!pendingCharacterSessionKey || characterWorldbookBusy"
                  :title="characterWorldbookButtonTitle"
                  aria-label="角色世界书"
                  @click="openCharacterWorldbook"
                >
                  <svg
                    class="character-worldbook-icon"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-width="1.6"
                      d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM3.8 9h16.4M3.8 15h16.4M12 3c2 2.2 3 5.2 3 9s-1 6.8-3 9M12 3c-2 2.2-3 5.2-3 9s1 6.8 3 9"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  class="os-system-act-btn session-archive-button"
                  :disabled="!!pendingCharacterSessionKey"
                  @click="openSessionArchive"
                >
                  会话档案
                  <span v-if="selectedCharacterSessionCount">{{ selectedCharacterSessionCount }}</span>
                </button>
                <button
                  type="button"
                  class="os-system-act-btn enter-chat-button"
                  :class="{ 'is-loading': selectedCharacter.characterKey === pendingCharacterSessionKey }"
                  :disabled="!!pendingCharacterSessionKey"
                  @click="enterSelected"
                >
                  {{ selectedCharacter.characterKey === pendingCharacterSessionKey ? '新建中...' : '新建聊天' }}
                </button>
              </div>
            </div>
            <div class="dossier-summary">
              {{ selectedCharacterPreviewLoading ? '正在读取角色卡...' : selectedCharacter.description || selectedCharacter.personality || selectedCharacter.scenario || '暂无角色描述。' }}
            </div>
          </div>
        </div>

        <div class="dossier-details">
          <dl class="data-group">
            <div class="data-row">
              <dt>开场白 <span v-if="greetingOptions.length > 1">{{ selectedGreetingIndex + 1 }} / {{ greetingOptions.length }}</span></dt>
              <dd>
                <div
                  v-if="greetingOptions.length"
                  class="greeting-current-card"
                >
                  <div class="greeting-current-head">
                    <strong>{{ greetingLabel(selectedGreetingIndex) }}</strong>
                    <span v-if="greetingOptions.length > 1">{{ greetingOptions.length }} 个可选</span>
                  </div>
                  <div class="data-block greeting-current-text">
                    {{ selectedGreetingText }}
                  </div>
                  <details
                    :open="advancedDefinitionDisclosure.isOpen(characterDataDisclosureId('greetings'))"
                    class="data-section greeting-picker"
                    :class="{ 'is-empty': !hasMultipleGreetings }"
                    @toggle="advancedDefinitionDisclosure.setOpenFromEvent(characterDataDisclosureId('greetings'), $event)"
                  >
                    <summary class="greeting-section-title">
                      切换开场白
                    </summary>
                    <div
                      v-if="hasMultipleGreetings && advancedDefinitionDisclosure.isOpen(characterDataDisclosureId('greetings'))"
                      class="greeting-choice-list"
                    >
                      <button
                        v-for="(greeting, index) in greetingOptions"
                        :key="`${selectedCharacter.characterKey}-greeting-${index}`"
                        type="button"
                        class="greeting-choice"
                        :class="{ selected: index === selectedGreetingIndex }"
                        :disabled="!!pendingCharacterSessionKey"
                        @click="selectGreeting(index)"
                      >
                        <span class="greeting-choice-name">{{ greetingLabel(index) }}</span>
                        <span class="greeting-choice-text">{{ shortText(greeting, 120) }}</span>
                      </button>
                    </div>
                  </details>
                </div>
                <div
                  v-else-if="selectedCharacterPreviewLoading"
                  class="data-block"
                >
                  正在读取角色卡...
                </div>
                <div
                  v-else
                  class="data-block"
                >
                  未填写
                </div>
              </dd>
            </div>
          </dl>
        </div>
      </main>

      <div
        v-if="characterDefinitionOpen && selectedCharacter"
        class="character-definition-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="角色卡详情"
      >
        <section class="character-definition-dialog">
          <header>
            <div>
              <strong>角色卡详情</strong>
              <span>{{ selectedCharacter.name }}</span>
            </div>
            <button
              type="button"
              class="session-archive-close character-definition-close"
              aria-label="关闭角色卡详情"
              @click="closeCharacterDefinition"
            />
          </header>
          <dl class="character-definition-list">
            <div
              v-for="field in characterDefinitionFields"
              :key="field.label"
              class="character-definition-section"
            >
              <dt>{{ field.label }}</dt>
              <dd :class="{ 'is-empty': !field.value }">
                {{ field.value || (selectedCharacterPreviewLoading ? '正在读取角色卡...' : '未填写') }}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <div
        v-if="sessionArchiveOpen && selectedCharacter"
        class="character-session-archive-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="会话档案"
      >
        <section class="character-session-archive">
          <header>
            <div>
              <strong>会话档案</strong>
              <span>{{ selectedCharacter.name }}</span>
            </div>
            <button
              type="button"
              class="session-archive-close"
              aria-label="关闭会话档案"
              @click="closeSessionArchive"
            />
          </header>
          <div
            v-if="selectedCharacterSessions.length"
            class="session-archive-list"
          >
            <div
              v-for="session in selectedCharacterSessions"
              :key="session.id"
              class="session-archive-item"
            >
              <button
                type="button"
                class="session-archive-open"
                @click="openSession(session.id)"
              >
                <span class="session-archive-item-title">{{ sessionArchiveTitle(session) }}</span>
                <span class="session-archive-item-meta">{{ sessionArchiveMeta(session) }}</span>
                <span
                  v-if="session.summary"
                  class="session-archive-item-summary"
                >{{ shortText(session.summary, 96) }}</span>
              </button>
              <button
                type="button"
                class="session-archive-delete"
                title="删除会话"
                aria-label="删除会话"
                @click="deleteArchivedSession(session.id, $event)"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M6 6l1 15h10l1-15" />
                </svg>
              </button>
            </div>
          </div>
          <div
            v-else
            class="session-archive-empty"
          >
            这张角色卡还没有旧会话。
          </div>
        </section>
      </div>

      <main
        v-if="!selectedCharacter"
        class="character-preview-panel dossier-empty"
      >
        <div class="cyber-placeholder">
          <div class="ring" />
          <span>选择角色</span>
        </div>
      </main>
    </section>

    <section
      v-else
      class="character-empty"
    >
      <div class="empty-content">
        <h2>暂无角色卡</h2>
        <p>本地缓存在酒馆内未找到可用角色，请在主控端加载后重试。</p>
        <button
          type="button"
          class="os-sys-button primary"
          @click="refresh"
        >
          重新唤醒数据
        </button>
      </div>
    </section>
  </div>
</template>
