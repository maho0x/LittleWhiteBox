<script setup lang="ts">
import TavernCornerActions from './TavernCornerActions.vue';

defineProps<{
    dark: boolean;
}>();

defineEmits<{
    (event: 'toggle-theme'): void;
    (event: 'back'): void;
}>();
</script>

<template>
  <section class="xb-page tavern-about-page">
    <TavernCornerActions
      compact
      :dark="dark"
      @toggle-theme="$emit('toggle-theme')"
    />
    <button
      type="button"
      class="about-return-inline"
      @click="$emit('back')"
    >
      RETURN TO INDEX
    </button>
    <section class="about-title-block">
      <h1 class="about-title">
        小白酒馆
      </h1>
      <div class="about-sub">
        A CLEANER WAY TO ROLEPLAY
      </div>
    </section>
    <section class="manifesto-body">
      <p class="intro-dropcap">
        当你与角色聊到数十万字时，故事不该变得卡顿，记忆也不该变成负担。小白酒馆彻底重构了渲染底层，剥离了原生框架庞大的 DOM 堆积。但流畅只是基石，我们真正带来的，是双线并行的 RP 新架构。
      </p>
      <p>在这里，角色扮演不再是一场对抗 AI 遗忘的马拉松，因为你多了一位后台统筹者。</p>
      <div class="feature-block">
        <h3>I. 幕后代理与双面板</h3>
        <p>舞台前，你与角色保持绝对沉浸的互动；舞台后，一个专注的 Agent 正在替你处理苦差事。它实时旁观对话，你可以随时翻转面板进入助手聊天，直接找它梳理当前线索、讨论伏笔设定，而不必出戏去干扰剧情里的角色。</p>
      </div>
      <div class="feature-block">
        <h3>II. 自动演进的可视化世界</h3>
        <p>代理不仅替你陪聊，更在后台自动提炼剧情脉络、归档阶段事件。在这套活的结构化数据之上，系统直接支撑起了可视化的空间地图与任务系统。你去过的地点、触发的事件都会在台面下自动生长。未来还会演化出更多可能。</p>
      </div>
      <div class="feature-block">
        <h3>III. 依然是你的酒馆</h3>
        <p>这套新基建依然扎根在你熟悉的土壤上。角色卡、世界书、聊天预设、正则，全都无缝直连酒馆本体。你可以在这里直接调取和修改旧设定，并在请求日志中，清晰地审视代理发出的每一条真实 log。</p>
      </div>
      <div class="feature-block quiet">
        <p>抛下那些沉重拥挤的参数窗口。选一张卡片，在这个干净的台面前，把心思还给故事本身。</p>
      </div>
    </section>
  </section>
</template>
