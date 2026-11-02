<script setup lang="ts">
import { computed } from 'vue';
import { fmtDuration } from '@/utils/format';

const props = defineProps<{ seconds: number; status: 'idle' | 'running' | 'paused' | 'stopped' }>();

const text = computed(() => fmtDuration(props.seconds));
const color = computed(() => (props.status === 'paused' ? 'var(--st-orange)' : 'var(--st-text)'));
</script>

<template>
  <div class="timer">
    <div class="timer-status">
      <span v-if="status === 'running'" class="dot green" /> <span v-if="status === 'running'">● 计时中</span>
      <span v-else-if="status === 'paused'" style="color: var(--st-orange)">⏸ 已暂停</span>
      <span v-else-if="status === 'stopped'" style="color: var(--st-sub)">已停止</span>
      <span v-else style="color: var(--st-sub)">未开始</span>
    </div>
    <div class="timer-value mono" :style="{ color }">{{ text }}</div>
    <div class="timer-hint">试验实际时长（净时长，已扣暂停）</div>
  </div>
</template>

<style scoped>
.timer {
  text-align: center;
  padding: 22px 16px 10px;
}
.timer-status {
  font-size: 14px;
  font-weight: 600;
  min-height: 20px;
}
.dot.green {
  color: var(--st-green);
}
.timer-value {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
  margin: 10px 0 6px;
  line-height: 1.05;
}
.timer-hint {
  color: var(--st-sub);
  font-size: 12px;
}
</style>
