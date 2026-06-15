<script setup lang="ts">
interface RequestSnapshotLike {
    requestKind?: string;
    providerLabel?: string;
    provider?: string;
    model?: string;
}

const props = defineProps<{
    tab: 'history' | 'simulate';
    lastRequestRawJson: string;
    lastRequestSnapshot: RequestSnapshotLike | null | undefined;
    simulateInput: string;
    simulateStatus: string;
    simulateError: string;
    simulateJson: string;
}>();

const emit = defineEmits<{
    (event: 'close'): void;
    (event: 'update:tab', value: 'history' | 'simulate'): void;
    (event: 'update:simulateInput', value: string): void;
    (event: 'simulate'): void;
}>();

function handleInput(event: Event) {
    emit('update:simulateInput', (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <div
    class="prompt-inspector-overlay"
    role="dialog"
    aria-modal="true"
    @click.self="$emit('close')"
    @keydown.esc="$emit('close')"
  >
    <section
      class="prompt-inspector-modal"
      tabindex="-1"
    >
      <header class="prompt-inspector-head">
        <div class="prompt-inspector-heading">
          <h2>请求日志</h2>
        </div>
        <button
          type="button"
          class="prompt-inspector-close"
          aria-label="关闭日志"
          @click="$emit('close')"
        >
          关闭
        </button>
      </header>

      <div
        class="prompt-inspector-tabs"
        aria-label="API 请求视图"
      >
        <button
          type="button"
          :class="{ active: tab === 'history' }"
          @click="$emit('update:tab', 'history')"
        >
          上次调用
        </button>
        <button
          type="button"
          :class="{ active: tab === 'simulate' }"
          @click="$emit('update:tab', 'simulate')"
        >
          模拟发送
        </button>
      </div>

      <div class="prompt-inspector-body">
        <section
          v-show="tab === 'history'"
          class="prompt-inspector-view"
        >
          <div class="prompt-inspector-summary">
            <span>{{ lastRequestRawJson ? '有记录' : '暂无记录' }}</span>
            <span>{{ lastRequestSnapshot?.requestKind || 'history' }}</span>
            <span>{{ lastRequestSnapshot?.providerLabel || lastRequestSnapshot?.provider || '未调用' }}</span>
            <span>{{ lastRequestSnapshot?.model || '未选择模型' }}</span>
          </div>
          <pre
            v-if="lastRequestRawJson"
            class="prompt-request-json"
          >{{ lastRequestRawJson }}</pre>
          <p
            v-else
            class="prompt-empty-state"
          >
            暂无请求历史。
          </p>
        </section>

        <section
          v-show="tab === 'simulate'"
          class="prompt-inspector-view"
        >
          <div class="prompt-simulate-panel">
            <div>
              <label for="request-simulate-input">模拟本轮发言</label>
              <textarea
                id="request-simulate-input"
                :value="simulateInput"
                rows="5"
                placeholder="写一句要模拟发送的话"
                @input="handleInput"
              />
            </div>
            <button
              type="button"
              @click="$emit('simulate')"
            >
              生成请求
            </button>
          </div>
          <p
            v-if="simulateStatus"
            class="muted compact"
          >
            {{ simulateStatus }}
          </p>
          <p
            v-if="simulateError"
            class="error"
          >
            {{ simulateError }}
          </p>
          <pre
            v-if="simulateJson"
            class="prompt-request-json"
          >{{ simulateJson }}</pre>
        </section>
      </div>
    </section>
  </div>
</template>
