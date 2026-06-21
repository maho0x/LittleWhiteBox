<script setup lang="ts">
import { computed } from 'vue';
import type { TavernTaskRecord } from '../../shared/session-db';

const props = withDefaults(defineProps<{
  tasks?: TavernTaskRecord[];
  enabled?: boolean;
  assistantFloor?: number;
}>(), {
  tasks: () => [],
  enabled: false,
  assistantFloor: -1,
});

const visibleTasks = computed(() => (Array.isArray(props.tasks) ? props.tasks : [])
    .filter((task) => task.status !== 'abandoned')
    .sort((left, right) => Number(right.updatedOrder) - Number(left.updatedOrder) || Number(right.updatedAt) - Number(left.updatedAt)));
const activeTasks = computed(() => visibleTasks.value.filter((task) => task.status === 'active'));
const completedTasks = computed(() => visibleTasks.value.filter((task) => task.status === 'completed'));
const primaryTask = computed(() => activeTasks.value[0] || null);
const alternateTasks = computed(() => activeTasks.value.slice(1, 4));
const emptyTitle = computed(() => {
    if (!props.enabled) {return '事件功能未授权';}
    if (Number(props.assistantFloor) < 5) {return '剧情展开后会出现事件线索';}
    return '当前没有足够新鲜的方向';
});
const emptyText = computed(() => {
    if (!props.enabled) {return '开启契约里的织线者后，后台会维护可回滚的事件线索池。';}
    if (Number(props.assistantFloor) < 5) {return '先让人物、地点和关系沉淀几轮，系统不会过早生成方向。';}
    return '后台没有找到对味的新钩子时会保持空白。';
});

function orderLabel(task: TavernTaskRecord): string {
    const order = Number(task.updatedOrder);
    return Number.isFinite(order) && order >= 0 ? `#${order}` : '';
}
</script>

<template>
  <section class="tavern-event-panel">
    <div
      v-if="primaryTask"
      class="tavern-event-current"
    >
      <span class="tavern-event-kicker">当前目标</span>
      <h3>{{ primaryTask.current }}</h3>
      <p class="tavern-event-horizon">
        远景：{{ primaryTask.horizon }}
      </p>
      <p class="tavern-event-hook">
        {{ primaryTask.hookForUser }}
      </p>
      <small>{{ orderLabel(primaryTask) }}</small>
    </div>
    <div
      v-else
      class="tavern-event-empty"
    >
      <strong>{{ emptyTitle }}</strong>
      <p>{{ emptyText }}</p>
    </div>

    <div
      v-if="alternateTasks.length"
      class="tavern-event-section"
    >
      <header>
        <strong>其他线索</strong>
        <span>{{ alternateTasks.length }}</span>
      </header>
      <article
        v-for="task in alternateTasks"
        :key="task.id"
        class="tavern-event-card"
      >
        <div>
          <strong>{{ task.current }}</strong>
          <small>{{ orderLabel(task) }}</small>
        </div>
        <p>{{ task.hookForUser }}</p>
      </article>
    </div>

    <div
      v-if="completedTasks.length"
      class="tavern-event-section"
    >
      <header>
        <strong>已完成</strong>
        <span>{{ completedTasks.length }}</span>
      </header>
      <article
        v-for="task in completedTasks"
        :key="task.id"
        class="tavern-event-card is-completed"
      >
        <div>
          <strong>{{ task.current }}</strong>
          <small>{{ orderLabel(task) }}</small>
        </div>
        <p>{{ task.horizon }}</p>
      </article>
    </div>
  </section>
</template>
