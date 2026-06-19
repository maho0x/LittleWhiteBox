<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import TavernMapPanel from '../TavernMapPanel.vue';
import TavernMemoryEditor from '../TavernMemoryEditor.vue';
import { useTavernMemoryContext, useTavernWorkspaceContext } from '../tavern-app-context';
import { useMobileSheetDrag } from './useMobileSheetDrag';
import { createSeedMapDocument } from '../../../shared/map-state-seed';
import type { TavernMapDocument, TavernMapElement } from '../../../shared/structured-state';

defineProps<{
    mobileMemoryDirectoryOpen: boolean;
}>();
const emit = defineEmits<{
    (event: 'close'): void;
    (event: 'close-memory-directory'): void;
    (event: 'toggle-memory-directory'): void;
}>();

const memory = useTavernMemoryContext();
const workspace = useTavernWorkspaceContext();
const {
    chatWorkspacePanel,
} = workspace;
const {
    activeMemoryFiles,
    discardMemoryDraft,
    enterMemoryEditMode,
    expandMemoryFileGroup,
    formatMemoryFileMeta,
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
    memoryFiles,
    memoryFileSearchText,
    markdownSignature,
    previewMemoryDraft,
    renderChatMarkdown,
    saveSelectedMemoryFile,
    selectedMemoryFileEntry,
    selectedMemoryFilePath,
    selectMemoryFile,
} = memory;
const {
    activeMapDocId,
    mapStateDocuments,
    mapStateDocument,
    mapStatePatches,
} = workspace;

const selectedMapDocId = ref('');
const selectedMapRecord = computed(() => {
    const docs = Array.isArray(mapStateDocuments.value) ? mapStateDocuments.value : [];
    const selectedId = String(selectedMapDocId.value || activeMapDocId.value || '').trim();
    return docs.find((document) => document.docId === selectedId)
        || docs.find((document) => document.docId === activeMapDocId.value)
        || mapStateDocument.value
        || null;
});
const selectedMapDocument = computed<TavernMapDocument | null>(() => {
    const data = selectedMapRecord.value?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {return null;}
    const source = data as Partial<TavernMapDocument>;
    const fallback = createSeedMapDocument();
    return {
        meta: source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta) ? { ...fallback.meta, ...source.meta } : fallback.meta,
        elements: Array.isArray(source.elements)
            ? source.elements.filter((element): element is TavernMapElement => !!element && typeof element === 'object' && !Array.isArray(element) && typeof (element as TavernMapElement).id === 'string')
            : [],
    };
});
const selectedMapElements = computed(() => selectedMapDocument.value?.elements || []);
const selectedMapTitle = computed(() => String(
    selectedMapDocument.value?.meta?.name
    || selectedMapRecord.value?.title
    || selectedMapRecord.value?.docId
    || '地图',
));
const selectedMapIsActive = computed(() => String(selectedMapRecord.value?.docId || '') === String(activeMapDocId.value || 'main'));
const mapDigestLines = computed(() => String(selectedMapRecord.value?.digest || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3));
const mapActorNames = computed(() => selectedMapElements.value
    .filter((element) => element.cat === 'actor')
    .map((element) => String(element.text || element.id || '').trim())
    .filter(Boolean)
    .slice(0, 6));
const selectedMapUpdatedLabel = computed(() => formatMapInfoTime(Number(selectedMapRecord.value?.updatedAt) || 0));
const latestMapPatchSummary = computed(() => selectedMapIsActive.value ? String(mapStatePatches.value.at(-1)?.summary || '').trim() : '');
const mapInfoStats = computed(() => {
    const elements = selectedMapElements.value;
    const countByCat = (cat: string) => elements.filter((element) => element.cat === cat).length;
    return [
        { label: '元素', value: String(elements.length) },
        { label: '人物', value: String(countByCat('actor')) },
        { label: '出入口', value: String(countByCat('door')) },
        { label: '标注', value: String(countByCat('label') + countByCat('marker')) },
    ];
});

watch([activeMapDocId, mapStateDocuments], ([docId]) => {
    const docs = Array.isArray(mapStateDocuments.value) ? mapStateDocuments.value : [];
    const selectedId = String(selectedMapDocId.value || '').trim();
    const selectedExists = selectedId && docs.some((document) => document.docId === selectedId);
    if (selectedExists) {return;}
    selectedMapDocId.value = String(docId || mapStateDocument.value?.docId || docs[0]?.docId || 'main');
}, { immediate: true });

function formatMapInfoTime(timestamp = 0) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {return '';}
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

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

function toggleMobileMemoryDirectory() {
    emit('toggle-memory-directory');
}

function selectMobileMemoryFile(path: string) {
    selectMemoryFile(path);
    emit('close-memory-directory');
}
</script>

<template>
  <aside class="tavern-workspace-panel">
    <button
      type="button"
      class="chat-mobile-sheet-handle"
      :class="{ 'is-dragging': sheetHandleDragging }"
      title="收起记忆面板"
      aria-label="收起记忆面板"
      @click="closeMobileChatPanel"
      @pointercancel="handleSheetHandlePointerCancel"
      @pointerdown="handleSheetHandlePointerDown"
      @pointermove="handleSheetHandlePointerMove"
      @pointerup="handleSheetHandlePointerUp"
    />
    <div class="tavern-workspace-tabs">
      <button
        type="button"
        :class="{ active: chatWorkspacePanel === 'state' }"
        @click="chatWorkspacePanel = 'state'"
      >
        地图
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
        v-model:selected-doc-id="selectedMapDocId"
        compact
        :documents="mapStateDocuments"
        :active-doc-id="activeMapDocId"
        :document="mapStateDocument"
        :patches="mapStatePatches"
      />
      <article class="tavern-map-info">
        <div
          v-if="selectedMapRecord"
          class="tavern-map-info-body"
        >
          <header class="tavern-map-info-head">
            <div>
              <strong>{{ selectedMapTitle }}</strong>
              <span>{{ selectedMapRecord.docId }}</span>
            </div>
            <em>{{ selectedMapIsActive ? '当前场景' : '地图档案' }}</em>
          </header>
          <dl class="tavern-map-info-grid">
            <div
              v-for="item in mapInfoStats"
              :key="item.label"
            >
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>
          <div
            v-if="mapActorNames.length"
            class="tavern-map-info-line"
          >
            <span>人物</span>
            <strong>{{ mapActorNames.join('、') }}</strong>
          </div>
          <div
            v-if="selectedMapUpdatedLabel"
            class="tavern-map-info-line"
          >
            <span>最近更新</span>
            <strong>{{ selectedMapUpdatedLabel }}</strong>
          </div>
          <div
            v-if="latestMapPatchSummary"
            class="tavern-map-info-line"
          >
            <span>变更摘要</span>
            <strong>{{ latestMapPatchSummary }}</strong>
          </div>
          <div
            v-if="mapDigestLines.length"
            class="tavern-map-info-digest"
          >
            <p
              v-for="line in mapDigestLines"
              :key="line"
            >
              {{ line }}
            </p>
          </div>
        </div>
        <div
          v-else
          class="tavern-map-info-empty"
        >
          暂无地图信息。
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
</template>
