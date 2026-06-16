<script setup lang="ts">
import { computed } from 'vue';
import { useTavernSettingsContext, type TavernUserOption } from '../tavern-app-context';

const settings = useTavernSettingsContext();
const {
    activeSettingsWorkspace,
    baseSettingsLoading,
    baseSettingsSaving,
    baseSettingsStatus,
    currentTavernUser,
    displaySettings,
    shortText,
    switchingTavernUserId,
    switchTavernUser,
    tavernUsers,
    updateDisplaySettingsPatch,
} = settings;

const currentUserLabel = computed(() => currentTavernUser.value?.name || '未选择 USER');
const currentUserDescription = computed(() => currentTavernUser.value?.description || '聊天上下文会沿用这位 USER 的身份与头像。');
const currentUserInitial = computed(() => currentTavernUser.value ? userCardInitial(currentTavernUser.value) : 'U');
const selectedUserId = computed(() => currentTavernUser.value?.id || tavernUsers.value.find((user) => user.active)?.id || '');

function userCardInitial(user: TavernUserOption) {
    return (String(user.name || user.id || 'U').trim().slice(0, 1) || 'U').toUpperCase();
}

function handleUserSelect(value: string) {
    const nextUserId = String(value || '').trim();
    if (!nextUserId || nextUserId === selectedUserId.value) {return;}
    void switchTavernUser(nextUserId);
}

function handleHiddenOutsideInput(value: string) {
    const next = Number(value);
    if (!Number.isFinite(next)) {return;}
    updateDisplaySettingsPatch({ hiddenOutsideCount: next });
}

function handleLoadBatchInput(value: string) {
    const next = Number(value);
    if (!Number.isFinite(next)) {return;}
    updateDisplaySettingsPatch({ loadBatchSize: next });
}
</script>

<template>
  <div
    v-show="activeSettingsWorkspace === 'base'"
    class="panel step-panel base-settings-workspace"
  >
    <div class="panel-head preset-page-head">
      <div>
        <h2>基础设定</h2>
      </div>
    </div>
    <div
      v-if="baseSettingsStatus"
      class="preset-status-line"
    >
      <span>{{ baseSettingsStatus }}</span>
    </div>
    <div class="base-settings-scroll">
      <section class="base-settings-section">
        <h3>USER身份切换</h3>
        <select
          class="base-user-select"
          :value="selectedUserId"
          :disabled="baseSettingsLoading || !!switchingTavernUserId || !tavernUsers.length"
          @change="handleUserSelect(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-if="!tavernUsers.length"
            value=""
          >
            {{ baseSettingsLoading ? '正在读取 USER 列表' : '没有可切换的 USER' }}
          </option>
          <option
            v-for="user in tavernUsers"
            :key="user.id"
            :value="user.id"
          >
            {{ user.name }}
          </option>
        </select>
        <div class="base-user-detail">
          <div class="base-user-avatar">
            <img
              v-if="currentTavernUser?.avatarUrl"
              :src="currentTavernUser.avatarUrl"
              :alt="currentUserLabel"
            >
            <span v-else>{{ currentUserInitial }}</span>
          </div>
          <div class="base-user-copy">
            <strong>{{ currentUserLabel }}</strong>
            <p>{{ shortText(currentUserDescription, 120) }}</p>
          </div>
        </div>
      </section>

      <section class="base-settings-section">
        <h3>楼层隐藏</h3>
        <div class="base-setting-row">
          <div>
            <strong>显示楼层</strong>
            <span>数字外楼层将隐藏</span>
          </div>
          <input
            :value="displaySettings.hiddenOutsideCount"
            type="number"
            min="1"
            max="20"
            step="1"
            :disabled="baseSettingsSaving"
            @change="handleHiddenOutsideInput(($event.target as HTMLInputElement).value)"
          >
        </div>
        <div class="base-setting-row">
          <div>
            <strong>翻旧楼</strong>
            <span>每次加载楼数</span>
          </div>
          <input
            :value="displaySettings.loadBatchSize"
            type="number"
            min="5"
            max="50"
            step="5"
            :disabled="baseSettingsSaving"
            @change="handleLoadBatchInput(($event.target as HTMLInputElement).value)"
          >
        </div>
      </section>

      <section class="base-settings-section">
        <h3>上下文管理</h3>
        <div class="base-context-block">
          <strong>当前暂不支持调节</strong>
          <p>超过 20 楼时触发压缩并保留最近 10 楼；删楼后窗口内不足 5 楼时，回退窗口补到 10 楼；窗口外记忆由契约中的记忆系统处理。</p>
        </div>
      </section>
    </div>
  </div>
</template>
