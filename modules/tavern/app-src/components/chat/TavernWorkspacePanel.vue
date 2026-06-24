<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import TavernAtlasPanel from '../TavernAtlasPanel.vue';
import TavernEventPanel from '../TavernEventPanel.vue';
import TavernMapPanel from '../TavernMapPanel.vue';
import TavernMemoryEditor from '../TavernMemoryEditor.vue';
import { useTavernMemoryContext, useTavernWorkspaceContext } from '../tavern-app-context';
import { useMobileSheetDrag } from './useMobileSheetDrag';
import { createSeedMapDocument } from '../../../shared/map-state-seed';
import type { TavernAtlasDocument, TavernMapDocument, TavernMapElement } from '../../../shared/structured-state';

defineProps<{
    memoryDirectoryOpen: boolean;
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
    atlasActiveLocationKey,
    atlasStateDocument,
    atlasStatePatches,
    currentAssistantFloor,
    mapStateDocuments,
    mapStateDocument,
    mapStatePatches,
    sessionContract,
    tavernTasks,
} = workspace;

const stateWorkspaceView = ref<'scene' | 'world'>('scene');
const mapPreviewDocId = ref('');
const mapPreviewPinned = ref(false);
const atlasDocument = computed<TavernAtlasDocument>(() => {
    const raw = atlasStateDocument.value?.data;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<TavernAtlasDocument> : {};
    return {
        version: 1,
        activeLocationKey: String(source.activeLocationKey || atlasActiveLocationKey.value || '').trim() || undefined,
        locations: Array.isArray(source.locations) ? source.locations as TavernAtlasDocument['locations'] : [],
        links: Array.isArray(source.links) ? source.links as TavernAtlasDocument['links'] : [],
        actors: Array.isArray(source.actors) ? source.actors as TavernAtlasDocument['actors'] : [],
    };
});
const atlasActiveLocation = computed(() => {
    const activeKey = atlasDocument.value.activeLocationKey || atlasActiveLocationKey.value || '';
    return atlasDocument.value.locations.find((location) => location.key === activeKey) || null;
});
const atlasActiveMapDocId = computed(() => String(atlasActiveLocation.value?.mapDocId || '').trim());
const selectedMapDocId = computed({
    get() {
        if (mapPreviewPinned.value) {return String(mapPreviewDocId.value || '').trim();}
        if (atlasDocument.value.activeLocationKey) {return atlasActiveMapDocId.value;}
        return String(activeMapDocId.value || 'main').trim();
    },
    set(value: string) {
        mapPreviewDocId.value = String(value || '').trim();
        mapPreviewPinned.value = !!mapPreviewDocId.value;
    },
});
const selectedMapRecord = computed(() => {
    const docs = Array.isArray(mapStateDocuments.value) ? mapStateDocuments.value : [];
    const selectedId = String(selectedMapDocId.value || '').trim();
    return selectedId ? docs.find((document) => document.docId === selectedId) || null : null;
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
const selectedMapPatches = computed(() => selectedMapIsActive.value ? mapStatePatches.value : []);
const currentLocationHasNoMap = computed(() => !mapPreviewPinned.value && !!atlasDocument.value.activeLocationKey && !atlasActiveMapDocId.value);
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
const memoryDirectoryButtonLabel = computed(() => (
    selectedMemoryFileEntry.value ? memoryFileDisplayName(selectedMemoryFileEntry.value) : ''
));

watch([atlasActiveMapDocId, mapStateDocuments], () => {
    const docs = Array.isArray(mapStateDocuments.value) ? mapStateDocuments.value : [];
    const selectedId = String(mapPreviewDocId.value || '').trim();
    const selectedExists = selectedId && docs.some((document) => document.docId === selectedId);
    if (selectedExists) {return;}
    if (mapPreviewPinned.value) {
        mapPreviewPinned.value = false;
        mapPreviewDocId.value = '';
    }
}, { immediate: true });

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

function toggleMemoryDirectory() {
    emit('toggle-memory-directory');
}

function selectDirectoryMemoryFile(path: string) {
    void selectMemoryFile(path).then((selected) => {
        if (selected) {
            emit('close-memory-directory');
        }
    });
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
      <button
        type="button"
        :class="{ active: chatWorkspacePanel === 'event' }"
        @click="chatWorkspacePanel = 'event'"
      >
        事件
      </button>
    </div>
    <section
      v-if="chatWorkspacePanel === 'state'"
      class="tavern-state-panel"
    >
      <div
        class="tavern-state-viewport"
        :class="`is-${stateWorkspaceView}`"
      >
        <div
          class="tavern-state-inline-switcher"
          role="tablist"
          aria-label="地图视图"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="stateWorkspaceView === 'scene'"
            :class="{ active: stateWorkspaceView === 'scene' }"
            @click="stateWorkspaceView = 'scene'"
          >
            场景图
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="stateWorkspaceView === 'world'"
            :class="{ active: stateWorkspaceView === 'world' }"
            @click="stateWorkspaceView = 'world'"
          >
            世界图
          </button>
        </div>
        <TavernMapPanel
          v-if="stateWorkspaceView === 'scene' && selectedMapRecord"
          v-model:selected-doc-id="selectedMapDocId"
          compact
          :documents="mapStateDocuments"
          :active-doc-id="activeMapDocId"
          :document="selectedMapRecord"
          :patches="selectedMapPatches"
        />
        <TavernAtlasPanel
          v-else-if="stateWorkspaceView === 'world'"
          display-mode="graph"
          :document="atlasStateDocument"
          :patches="atlasStatePatches"
          :active-location-key="atlasActiveLocationKey"
          :active-map-doc-id="activeMapDocId"
          :preview-map-doc-id="selectedMapDocId"
          :map-documents="mapStateDocuments"
        />
        <div
          v-else
          class="tavern-map-current-empty"
        >
          <strong>{{ atlasActiveLocation?.name || '当前地点' }}</strong>
          <p>{{ currentLocationHasNoMap ? '当前地点暂无详细地图。' : '暂无地图信息。' }}</p>
        </div>
      </div>
      <article
        class="tavern-map-info"
        :class="{ 'is-world': stateWorkspaceView === 'world' }"
      >
        <TavernAtlasPanel
          v-if="stateWorkspaceView === 'world'"
          display-mode="detail"
          :document="atlasStateDocument"
          :patches="atlasStatePatches"
          :active-location-key="atlasActiveLocationKey"
          :active-map-doc-id="activeMapDocId"
          :preview-map-doc-id="selectedMapDocId"
          :map-documents="mapStateDocuments"
        />
        <div
          v-else-if="selectedMapRecord"
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
      v-else-if="chatWorkspacePanel === 'memory'"
      class="tavern-memory-workspace"
      :class="{ 'is-memory-directory-open': memoryDirectoryOpen }"
    >
      <button
        type="button"
        class="tavern-memory-selector"
        :class="{ 'is-open': memoryDirectoryOpen }"
        :disabled="!memoryFiles.length"
        :aria-expanded="memoryDirectoryOpen ? 'true' : 'false'"
        aria-controls="xb-tavern-memory-directory"
        title="选择记忆文档"
        aria-label="选择记忆文档"
        @click="toggleMemoryDirectory"
      >
        <span>记忆文档</span>
        <strong>{{ memoryDirectoryButtonLabel || '选择记忆档案' }}</strong>
        <em>{{ activeMemoryFiles.length }} 个</em>
        <i aria-hidden="true" />
      </button>
      <aside
        id="xb-tavern-memory-directory"
        class="tavern-memory-directory"
      >
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
            <div class="memory-file-tree">
              <button
                v-for="file in group.files"
                :key="file.path"
                type="button"
                class="memory-file"
                :class="{ active: selectedMemoryFilePath === file.path, stale: file.status === 'stale' }"
                @click="selectDirectoryMemoryFile(file.path)"
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
    <TavernEventPanel
      v-else
      :tasks="tavernTasks"
      :enabled="sessionContract.questOrchestration"
      :assistant-floor="currentAssistantFloor"
    />
  </aside>
</template>
