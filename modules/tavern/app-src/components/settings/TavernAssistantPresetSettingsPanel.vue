<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTavernSettingsContext, useTavernShellContext } from '../tavern-app-context';
import { DEFAULT_TAVERN_ASSISTANT_PRESET_ID } from '../../../shared/assistant-presets';
import type { TavernAssistantPresetRecord } from '../../../shared/session-db';

const settings = useTavernSettingsContext();
const shell = useTavernShellContext();
const {
    activeAssistantPresetId,
    activeSettingsWorkspace,
    assistantPreset,
    assistantPresetDirty,
    assistantPresetItems,
    assistantPresets,
    assistantPresetStatus,
    createAssistantPreset,
    deleteCurrentAssistantPreset,
    importAssistantPreset,
    saveCurrentAssistantPreset,
    selectAssistantPreset,
    selectAssistantPresetItem,
    selectedAssistantPresetItem,
    shortText,
    updateAssistantPresetPatch,
    updateSelectedAssistantPresetItem,
} = settings;

const selectedAssistantPresetId = computed(() => String(activeAssistantPresetId.value || assistantPreset.value.id || '').trim());
const currentAssistantPresetRecord = computed(() => assistantPresets.value.find((item: TavernAssistantPresetRecord) => item.id === selectedAssistantPresetId.value) || null);
const importInputRef = ref<HTMLInputElement | null>(null);

async function renameCurrentPreset() {
    const currentName = String(assistantPreset.value.name || '').trim() || '助手预设';
    const nextName = await shell.promptTavernDialog({
        title: '重命名助手预设',
        message: '输入预设名称：',
        defaultValue: currentName,
        confirmText: '保存',
    });
    if (nextName === null) {return;}
    const normalized = String(nextName || '').trim();
    if (!normalized || normalized === currentName) {return;}
    updateAssistantPresetPatch({ name: normalized });
}

function triggerImportPreset() {
    importInputRef.value?.click();
}

async function handleImportPreset(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {return;}
    try {
        const text = await file.text();
        await importAssistantPreset(JSON.parse(text));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '导入失败');
        await shell.alertTavernDialog({
            title: '导入失败',
            message: message || '导入失败',
        });
    } finally {
        if (input) {
            input.value = '';
        }
    }
}

function exportCurrentPreset() {
    const name = String(assistantPreset.value.name || 'assistant-preset').trim() || 'assistant-preset';
    const payload = {
        kind: 'littlewhitebox-assistant-preset',
        version: 1,
        exportedAt: new Date().toISOString(),
        preset: assistantPreset.value,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'assistant-preset'}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}
</script>

<template>
  <div
    v-show="activeSettingsWorkspace === 'assistantPreset'"
    class="panel step-panel preset-workspace"
  >
    <div class="panel-head preset-page-head">
      <div>
        <h2>助手预设</h2>
      </div>
      <div class="panel-pills">
        <span
          v-if="assistantPresetDirty"
          class="pill warning"
        >未保存</span>
      </div>
    </div>
    <div class="preset-command-bar assistant-preset-command-bar">
      <label class="assistant-preset-picker">
        <select
          :value="selectedAssistantPresetId"
          @change="selectAssistantPreset(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-if="!assistantPresets.length"
            value=""
          >
            没有可用助手预设
          </option>
          <option
            v-for="item in assistantPresets"
            :key="item.id"
            :value="item.id"
          >
            {{ item.name }}{{ item.isBuiltIn ? ' · 内置' : '' }}
          </option>
        </select>
      </label>
      <div class="assistant-preset-toolstrip">
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="改名"
          aria-label="改名"
          @click="renameCurrentPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="保存"
          aria-label="保存"
          :disabled="!assistantPresetDirty"
          @click="saveCurrentAssistantPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M5 21h14a1 1 0 0 0 1-1V7.5L16.5 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1Z" />
            <path d="M8 21v-7h8v7" />
            <path d="M8 4v5h7" />
          </svg>
        </button>
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="删除"
          aria-label="删除"
          :disabled="!currentAssistantPresetRecord || currentAssistantPresetRecord.id === DEFAULT_TAVERN_ASSISTANT_PRESET_ID"
          @click="deleteCurrentAssistantPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="新增"
          aria-label="新增"
          @click="createAssistantPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="导入"
          aria-label="导入"
          @click="triggerImportPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 4v11" />
            <path d="m7 11 5 5 5-5" />
            <path d="M4 20h16" />
          </svg>
        </button>
        <button
          type="button"
          class="assistant-preset-tool icon-button"
          title="导出"
          aria-label="导出"
          :disabled="!selectedAssistantPresetId"
          @click="exportCurrentPreset"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 20V9" />
            <path d="m17 13-5-5-5 5" />
            <path d="M4 20h16" />
          </svg>
        </button>
        <input
          ref="importInputRef"
          class="assistant-preset-import-input"
          type="file"
          accept="application/json,.json"
          @change="handleImportPreset"
        >
      </div>
    </div>
    <div
      v-if="assistantPresetStatus"
      class="preset-status-line"
    >
      <span>{{ assistantPresetStatus }}</span>
    </div>
    <div class="assistant-preset-studio">
      <aside class="assistant-preset-item-list archive-item-list">
        <div class="assistant-preset-nav-head">
          <strong>维护规则</strong>
        </div>
        <button
          v-for="item in assistantPresetItems"
          :key="item.id"
          type="button"
          class="assistant-preset-nav-row"
          :class="{ selected: selectedAssistantPresetItem?.id === item.id }"
          @click="selectAssistantPresetItem(item.id)"
        >
          <strong>{{ item.label }}</strong>
          <small>{{ shortText(item.content || '未填写职责。', 54) }}</small>
        </button>
      </aside>

      <section class="assistant-preset-detail-panel archive-editor-panel">
        <div class="assistant-preset-line-head">
          <div>
            <strong>{{ selectedAssistantPresetItem?.label || '维护规则' }}</strong>
          </div>
        </div>
        <div
          v-if="selectedAssistantPresetItem"
          class="assistant-preset-detail-fields"
        >
          <label>
            <span>职责说明</span>
            <textarea
              :value="selectedAssistantPresetItem.content"
              rows="12"
              placeholder="写这条维护规则应该要求什么、保留什么、避免什么。"
              @input="updateSelectedAssistantPresetItem(($event.target as HTMLTextAreaElement).value)"
            />
          </label>
        </div>
        <button
          v-else
          type="button"
          class="assistant-preset-empty-add"
          disabled
        >
          没有可编辑规则
        </button>
      </section>
    </div>
  </div>
</template>
