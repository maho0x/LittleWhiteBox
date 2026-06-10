<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import TavernCornerActions from './TavernCornerActions.vue';

interface TavernCharacterOption {
    id: string;
    name: string;
    avatar?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMessage?: string;
    alternateGreetings?: string[];
    mesExample?: string;
    creatorNotes?: string;
    characterDepthPrompt?: string;
}

const props = defineProps<{
    dark: boolean;
    pendingError: string;
    characters: TavernCharacterOption[];
    visibleCharacters: TavernCharacterOption[];
    filteredCount: number;
    liveCharacterId: string;
    selectedCharacter: TavernCharacterOption | null | undefined;
    selectedGreetingIndex: number;
    pendingCharacterSessionId: string;
    searchText: string;
    hiddenCount: number;
    batchSize: number;
    avatarAvailable: (avatar?: string) => boolean;
    shortText: (text: string, limit?: number) => string;
}>();

const emit = defineEmits<{
    (event: 'toggle-theme'): void;
    (event: 'exit'): void;
    (event: 'back'): void;
    (event: 'refresh'): void;
    (event: 'update:searchText', value: string): void;
    (event: 'select', id: string): void;
    (event: 'enter-selected'): void;
    (event: 'enter-character', id: string): void;
    (event: 'select-greeting', index: number): void;
    (event: 'load-more'): void;
    (event: 'keydown', value: KeyboardEvent): void;
    (event: 'avatar-error', avatar?: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);

const greetingOptions = computed(() => {
    const selected = props.selectedCharacter;
    if (!selected) {return [];}
    return [
        String(selected.firstMessage || '').trim(),
        ...(selected.alternateGreetings || []),
    ].filter(Boolean);
});

function scrollSelectedIntoView() {
    void nextTick(() => {
        const root = listRef.value;
        const selectedId = String(props.selectedCharacter?.id || '').trim();
        if (!root || !selectedId) {return;}
        const target = Array.from(root.querySelectorAll<HTMLElement>('[data-character-card-id]'))
            .find((node) => node.dataset.characterCardId === selectedId);
        target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
}

function handleSearchInput(event: Event) {
    emit('update:searchText', (event.target as HTMLInputElement).value);
}

watch(
    () => props.selectedCharacter?.id,
    () => scrollSelectedIntoView(),
);

defineExpose({ scrollSelectedIntoView });
</script>

<template>
  <section class="xb-page character-select-page">
    <TavernCornerActions
      :dark="dark"
      @toggle-theme="$emit('toggle-theme')"
      @exit="$emit('exit')"
    />
    <div class="character-desk">
      <header class="character-select-head">
        <div class="head-left">
          <button
            type="button"
            class="os-sys-button"
            @click="$emit('back')"
          >
            <span class="icon">↵</span>
            首页
          </button>
        </div>
        <div class="character-title-copy">
          <p class="eyebrow">
            SYSTEM // DESK
          </p>
          <h2>角色档案库</h2>
        </div>
        <div class="head-right">
          <button
            type="button"
            class="os-sys-button primary"
            @click="$emit('refresh')"
          >
            <span class="icon">⟳</span>
            同步
          </button>
        </div>
      </header>

      <div
        v-if="pendingError"
        class="character-select-error"
      >
        [SYS_ERROR] {{ pendingError }}
      </div>

      <section
        v-if="characters.length"
        class="character-archive"
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
              {{ visibleCharacters.length }} / {{ filteredCount }} ENTRIES
            </div>
          </div>

          <div
            ref="listRef"
            class="character-card-grid"
            tabindex="0"
            aria-label="角色卡列表"
            @keydown="$emit('keydown', $event)"
          >
            <button
              v-for="character in visibleCharacters"
              :key="character.id"
              type="button"
              class="character-card-option"
              :data-character-card-id="character.id"
              :class="{
                current: character.id === liveCharacterId,
                selected: character.id === selectedCharacter?.id,
                pending: character.id === pendingCharacterSessionId,
              }"
              :disabled="!!pendingCharacterSessionId"
              @click="$emit('select', character.id)"
              @dblclick="$emit('enter-character', character.id)"
            >
              <div class="card-focus-indicator" />
              <span class="character-card-avatar">
                <img
                  v-if="avatarAvailable(character.avatar)"
                  :src="character.avatar"
                  loading="lazy"
                  decoding="async"
                  alt=""
                  @error="$emit('avatar-error', character.avatar)"
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
                    v-if="character.id === liveCharacterId"
                    class="tag active"
                  >ACTIVE</small>
                  <small
                    v-if="character.id === pendingCharacterSessionId"
                    class="tag loading"
                  >LOADING...</small>
                </span>
              </span>
            </button>
            <button
              v-if="hiddenCount"
              type="button"
              class="archive-load-more character-load-more"
              @click="$emit('load-more')"
            >
              加载更多残卷 ({{ Math.min(hiddenCount, batchSize) }})
            </button>
          </div>

          <div
            v-if="!visibleCharacters.length"
            class="empty-note"
          >
            [SYS_WARN] 未检索到匹配档案。
          </div>
        </aside>

        <main
          v-if="selectedCharacter"
          class="character-preview-panel dossier-view"
        >
          <div class="dossier-header">
            <div class="dossier-identity">
              <p class="sys-mono">
                ID: {{ selectedCharacter.id.substring(0, 8) || 'UNKNOWN' }}
              </p>
              <div class="dossier-title-row">
                <h3>{{ selectedCharacter.name }}</h3>
                <button
                  type="button"
                  class="os-system-act-btn"
                  :class="{ 'is-loading': selectedCharacter.id === pendingCharacterSessionId }"
                  :disabled="!!pendingCharacterSessionId"
                  @click="$emit('enter-selected')"
                >
                  {{ selectedCharacter.id === pendingCharacterSessionId ? '进入中...' : '进入聊天' }}
                </button>
              </div>
              <div class="dossier-summary">
                {{ selectedCharacter.description || selectedCharacter.personality || selectedCharacter.scenario || '暂无角色描述。' }}
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
                    class="greeting-choice-list"
                  >
                    <button
                      v-for="(greeting, index) in greetingOptions"
                      :key="`${selectedCharacter.id}-greeting-${index}`"
                      type="button"
                      class="greeting-choice"
                      :class="{ selected: index === selectedGreetingIndex }"
                      :disabled="!!pendingCharacterSessionId"
                      @click="$emit('select-greeting', index)"
                    >
                      <span class="greeting-choice-name">{{ index === 0 ? '主开场白' : `备用 ${index}` }}</span>
                      <span class="greeting-choice-text">{{ greeting }}</span>
                    </button>
                  </div>
                  <div
                    v-else
                    class="data-block"
                  >
                    未填写
                  </div>
                </dd>
              </div>
              <details class="data-section">
                <summary class="data-section-title">
                  高级定义
                </summary>
                <div class="data-row">
                  <dt>性格摘要 <span>Personality summary</span></dt>
                  <dd>
                    <div class="data-block">
                      {{ selectedCharacter.personality || '未填写' }}
                    </div>
                  </dd>
                </div>
                <div class="data-row">
                  <dt>情景 <span>Scenario</span></dt>
                  <dd>
                    <div class="data-block">
                      {{ selectedCharacter.scenario || '未填写' }}
                    </div>
                  </dd>
                </div>
                <div class="data-row">
                  <dt>角色备注 <span>Character's Note</span></dt>
                  <dd>
                    <div class="data-block">
                      {{ selectedCharacter.characterDepthPrompt || '未填写' }}
                    </div>
                  </dd>
                </div>
                <div class="data-row">
                  <dt>制作者备注 <span>Creator's Notes</span></dt>
                  <dd>
                    <div class="data-block">
                      {{ selectedCharacter.creatorNotes || '未填写' }}
                    </div>
                  </dd>
                </div>
              </details>
            </dl>
          </div>
        </main>

        <main
          v-else
          class="character-preview-panel dossier-empty"
        >
          <div class="cyber-placeholder">
            <div class="ring" />
            <span>AWAITING<br>SELECTION</span>
          </div>
        </main>
      </section>

      <section
        v-else
        class="character-empty"
      >
        <div class="empty-content">
          <h2>数据库脱节</h2>
          <p>本地缓存在酒馆内未找到可用角色，请在主控端加载后重试。</p>
          <button
            type="button"
            class="os-sys-button primary"
            @click="$emit('refresh')"
          >
            重新唤醒数据
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
