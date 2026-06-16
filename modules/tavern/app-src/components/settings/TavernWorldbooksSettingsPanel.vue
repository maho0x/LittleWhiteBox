<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useTavernSettingsContext } from '../tavern-app-context';
import { useTavernEphemeralDisclosureScope } from '../useTavernEphemeralDisclosureScope';

const settings = useTavernSettingsContext();
const {
    activeSettingsWorkspace,
    cancelWorldbookEntryEdit,
    globalWorldbookOptions,
    globalWorldbookSelected,
    globalWorldbookSaving,
    globalWorldbookStatus,
    hiddenWorldbookPreviewEntryCount,
    isEditingWorldbookEntry,
    linesFromList,
    listFromLines,
    saveWorldbookEntryDraft,
    selectedWorldbook,
    selectedWorldbookName,
    showMoreWorldbookPreviewEntries,
    startWorldbookEntryEdit,
    toggleGlobalWorldbook,
    updateWorldbookEntryDraftPatch,
    WORLDBOOK_PREVIEW_BATCH_SIZE,
    worldbookEntryDirty,
    worldbookEntryDraft,
    worldbookEntrySaving,
    worldbookEntryStatus,
    worldbookOptions,
    worldbookPreview,
    worldbookPreviewStatus,
    worldbookSearchText,
    worldbookStatus,
} = settings;

const worldbookSelectOptions = computed(() => {
    const query = String(worldbookSearchText.value || '').trim().toLocaleLowerCase();
    const selectedName = String(selectedWorldbookName.value || '').trim();
    const selected = worldbookOptions.value.find((item) => item.name === selectedName);
    const filtered = query
        ? worldbookOptions.value.filter((item) => item.name.toLocaleLowerCase().includes(query))
        : worldbookOptions.value;
    if (selected && !filtered.some((item) => item.name === selected.name)) {
        return [selected, ...filtered];
    }
    return filtered;
});

const worldbookDisclosure = useTavernEphemeralDisclosureScope();
const globalWorldbookPickerOpen = ref(false);

const globalWorldbookSummary = computed(() => {
    const count = globalWorldbookSelected.value.length;
    if (!count) {return '未启用';}
    if (count === 1) {return globalWorldbookSelected.value[0] || '1 本';}
    return `${count} 本`;
});

function worldbookEntryDisclosureId(entry: { uid?: string | number; name: string; order?: number }) {
    const entryId = entry.uid !== undefined && entry.uid !== null && String(entry.uid).trim()
        ? String(entry.uid).trim()
        : entry.order !== undefined && entry.order !== null && String(entry.order).trim()
            ? String(entry.order).trim()
            : entry.name;
    return `worldbook:${selectedWorldbookName.value}:${entryId}`;
}

watch(
    [activeSettingsWorkspace, selectedWorldbookName, () => worldbookPreview.value?.name],
    () => worldbookDisclosure.reset(),
);
</script>

<template>
  <div
    v-show="activeSettingsWorkspace === 'worldbooks'"
    class="panel step-panel native-workspace"
  >
    <div class="panel-head preset-page-head">
      <div>
        <h2>世界书</h2>
      </div>
      <div class="panel-pills panel-head-actions">
        <span class="pill">{{ worldbookOptions.length }} 本</span>
      </div>
    </div>
    <div
      v-if="worldbookStatus"
      class="preset-status-line"
    >
      <span>{{ worldbookStatus }}</span>
    </div>
    <div class="worldbook-global-enable">
      <div class="worldbook-global-enable-head">
        <span>已启用的世界书（全局有效）</span>
        <button
          type="button"
          class="worldbook-global-toggle"
          :aria-expanded="globalWorldbookPickerOpen"
          :disabled="globalWorldbookSaving"
          @click="globalWorldbookPickerOpen = !globalWorldbookPickerOpen"
        >
          {{ globalWorldbookSummary }}
        </button>
      </div>
      <div
        v-if="globalWorldbookStatus"
        class="worldbook-global-status"
      >
        {{ globalWorldbookStatus }}
      </div>
      <div
        v-if="globalWorldbookPickerOpen"
        class="worldbook-global-list"
      >
        <label
          v-for="name in globalWorldbookOptions"
          :key="name"
          class="worldbook-global-option"
        >
          <input
            type="checkbox"
            :checked="globalWorldbookSelected.includes(name)"
            :disabled="globalWorldbookSaving"
            @change="toggleGlobalWorldbook(name, ($event.target as HTMLInputElement).checked)"
          >
          <span>{{ name }}</span>
        </label>
        <span
          v-if="!globalWorldbookOptions.length"
          class="worldbook-global-empty"
        >没有世界书</span>
      </div>
    </div>
    <div class="preset-command-bar worldbook-command-bar">
      <label class="preset-source-select worldbook-source-select">
        <select
          :value="selectedWorldbookName"
          @change="selectedWorldbookName = ($event.target as HTMLSelectElement).value"
        >
          <option
            v-if="!worldbookSelectOptions.length"
            value=""
          >
            没有世界书
          </option>
          <option
            v-for="item in worldbookSelectOptions"
            :key="item.name"
            :value="item.name"
          >
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="archive-search native-search worldbook-search-field">
        <input
          v-model="worldbookSearchText"
          type="search"
          aria-label="筛选世界书"
          placeholder="筛选世界书"
        >
      </label>
    </div>
    <div class="native-settings-studio worldbook-overview-grid">
      <section class="native-detail-panel worldbook-overview-detail worldbook-gateway-panel">
        <div
          v-if="selectedWorldbook"
          class="worldbook-preview-surface"
        >
          <div class="preset-preview-head worldbook-selected-head">
            <div>
              <strong>{{ selectedWorldbook.name }}</strong>
            </div>
          </div>
          <div
            v-if="worldbookPreviewStatus"
            class="worldbook-preview-status"
          >
            {{ worldbookPreviewStatus }}
          </div>
          <template v-else-if="worldbookPreview && worldbookPreview.name === selectedWorldbook.name">
            <div class="worldbook-metric-grid">
              <span>
                <strong>{{ worldbookPreview.entryCount }}</strong>
                <small>条目</small>
              </span>
              <span>
                <strong>{{ worldbookPreview.enabledCount }}</strong>
                <small>启用</small>
              </span>
              <span>
                <strong>{{ worldbookPreview.constantCount }}</strong>
                <small>常驻</small>
              </span>
              <span>
                <strong>{{ worldbookPreview.keywordCount }}</strong>
                <small>关键词</small>
              </span>
              <span>
                <strong>{{ worldbookPreview.totalChars }}</strong>
                <small>正文字符</small>
              </span>
            </div>
            <div
              v-if="worldbookPreview.entries.length"
              class="worldbook-entry-preview-list"
            >
              <details
                v-for="entry in worldbookPreview.entries"
                :key="worldbookEntryDisclosureId(entry)"
                class="worldbook-entry-preview"
                :class="{ disabled: !entry.enabled }"
                :open="worldbookDisclosure.isOpen(worldbookEntryDisclosureId(entry))"
                @toggle="worldbookDisclosure.setOpenFromEvent(worldbookEntryDisclosureId(entry), $event)"
              >
                <summary>
                  <span class="worldbook-entry-title">
                    <strong>{{ entry.name }}</strong>
                  </span>
                  <span class="worldbook-entry-state">{{ entry.constant ? '常驻' : entry.enabled ? '启用' : '关闭' }}</span>
                </summary>
                <div
                  v-if="worldbookDisclosure.isOpen(worldbookEntryDisclosureId(entry))"
                  class="worldbook-entry-body"
                >
                  <template v-if="isEditingWorldbookEntry(entry) && worldbookEntryDraft">
                    <form
                      class="worldbook-entry-editor"
                      @submit.prevent="saveWorldbookEntryDraft"
                    >
                      <div class="worldbook-entry-editor-head">
                        <span v-if="worldbookEntryStatus">{{ worldbookEntryStatus }}</span>
                        <span v-else>编辑条目</span>
                        <button
                          type="button"
                          class="worldbook-row-open"
                          :disabled="worldbookEntrySaving"
                          @click="cancelWorldbookEntryEdit"
                        >
                          取消
                        </button>
                      </div>
                      <div class="worldbook-entry-editor-grid">
                        <label>
                          <span>备注</span>
                          <input
                            :value="worldbookEntryDraft.comment"
                            type="text"
                            @input="updateWorldbookEntryDraftPatch({ comment: ($event.target as HTMLInputElement).value })"
                          >
                        </label>
                        <label>
                          <span>名称</span>
                          <input
                            :value="worldbookEntryDraft.name"
                            type="text"
                            @input="updateWorldbookEntryDraftPatch({ name: ($event.target as HTMLInputElement).value })"
                          >
                        </label>
                        <label>
                          <span>标题</span>
                          <input
                            :value="worldbookEntryDraft.title"
                            type="text"
                            @input="updateWorldbookEntryDraftPatch({ title: ($event.target as HTMLInputElement).value })"
                          >
                        </label>
                        <label>
                          <span>排序</span>
                          <input
                            :value="worldbookEntryDraft.order"
                            type="number"
                            step="1"
                            @input="updateWorldbookEntryDraftPatch({ order: Number(($event.target as HTMLInputElement).value) })"
                          >
                        </label>
                      </div>
                      <label class="worldbook-entry-editor-lines">
                        <span>关键词</span>
                        <textarea
                          :value="linesFromList(worldbookEntryDraft.key)"
                          rows="3"
                          @input="updateWorldbookEntryDraftPatch({ key: listFromLines(($event.target as HTMLTextAreaElement).value) })"
                        />
                      </label>
                      <label class="worldbook-entry-editor-lines">
                        <span>次级关键词</span>
                        <textarea
                          :value="linesFromList(worldbookEntryDraft.keysecondary.length ? worldbookEntryDraft.keysecondary : worldbookEntryDraft.secondary_keys)"
                          rows="3"
                          @input="updateWorldbookEntryDraftPatch({ keysecondary: listFromLines(($event.target as HTMLTextAreaElement).value) })"
                        />
                      </label>
                      <label class="worldbook-entry-editor-lines">
                        <span>内容</span>
                        <textarea
                          :value="worldbookEntryDraft.content"
                          rows="9"
                          @input="updateWorldbookEntryDraftPatch({ content: ($event.target as HTMLTextAreaElement).value })"
                        />
                      </label>
                      <div class="worldbook-entry-editor-toggles">
                        <label>
                          <input
                            type="checkbox"
                            :checked="!worldbookEntryDraft.disable"
                            @change="updateWorldbookEntryDraftPatch({ disable: !($event.target as HTMLInputElement).checked, enabled: ($event.target as HTMLInputElement).checked })"
                          >
                          <span>启用</span>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            :checked="worldbookEntryDraft.constant"
                            @change="updateWorldbookEntryDraftPatch({ constant: ($event.target as HTMLInputElement).checked })"
                          >
                          <span>常驻</span>
                        </label>
                        <button
                          type="submit"
                          class="primary-action"
                          :disabled="!worldbookEntryDirty || worldbookEntrySaving"
                        >
                          保存
                        </button>
                      </div>
                    </form>
                  </template>
                  <template v-else>
                    <div class="worldbook-entry-actions">
                      <button
                        type="button"
                        class="worldbook-row-open"
                        @click="startWorldbookEntryEdit(entry)"
                      >
                        编辑
                      </button>
                      <span v-if="worldbookEntryStatus && isEditingWorldbookEntry(entry)">{{ worldbookEntryStatus }}</span>
                    </div>
                    <p
                      v-if="entry.keys.length || entry.secondaryKeys.length"
                      class="worldbook-entry-keys"
                    >
                      {{ [...entry.keys, ...entry.secondaryKeys].join(' / ') }}
                    </p>
                    <p
                      v-if="entry.contentPreview"
                      class="worldbook-entry-content"
                    >
                      {{ entry.contentPreview }}
                    </p>
                  </template>
                </div>
              </details>
              <button
                v-if="hiddenWorldbookPreviewEntryCount"
                type="button"
                class="native-add-row worldbook-preview-more"
                @click="showMoreWorldbookPreviewEntries"
              >
                再显示 {{ Math.min(hiddenWorldbookPreviewEntryCount, WORLDBOOK_PREVIEW_BATCH_SIZE) }} 条
              </button>
            </div>
            <div
              v-else
              class="empty-note"
            >
              这本世界书暂无条目。
            </div>
          </template>
        </div>
        <div
          v-else
          class="empty-note"
        >
          选择一本世界书后查看预览。
        </div>
      </section>
    </div>
  </div>
</template>
