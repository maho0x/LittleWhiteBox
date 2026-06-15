<script setup lang="ts">
defineProps<{
  dark: boolean;
  includeHome?: boolean;
  includeExit?: boolean;
  compact?: boolean;
}>();

const emit = defineEmits<{
  home: [];
  toggleTheme: [];
  exit: [];
}>();
</script>

<template>
  <div
    class="home-corner-actions"
    :class="{ 'page-corner-actions': includeHome || compact }"
  >
    <button
      v-if="includeHome"
      type="button"
      class="home-icon-button page-home-button"
      title="首页"
      aria-label="首页"
      @click="emit('home')"
    >
      <svg
        class="xb-home-icon"
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
    <button
      type="button"
      class="home-icon-button home-theme-button"
      :title="dark ? '切换到白天' : '切换到夜间'"
      :aria-label="dark ? '切换到白天' : '切换到夜间'"
      @click="emit('toggleTheme')"
    >
      <svg
        v-if="dark"
        class="xb-theme-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
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
      <span
        v-else
        class="xb-theme-glyph"
        aria-hidden="true"
      >☾</span>
    </button>
    <button
      v-if="includeExit"
      type="button"
      class="home-icon-button home-exit-button"
      title="退出"
      aria-label="退出"
      @click="emit('exit')"
    >
      <svg
        class="xb-exit-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </svg>
    </button>
  </div>
</template>
