<script setup lang="ts">
defineProps<{ status: 'idle' | 'running' | 'paused' | 'stopped' }>();
const emit = defineEmits<{
  (e: 'start'): void;
  (e: 'pause'): void;
  (e: 'resume'): void;
  (e: 'stop'): void;
  (e: 'remark'): void;
}>();
</script>

<template>
  <div class="controlbar">
    <template v-if="status === 'idle' || status === 'stopped'">
      <van-button type="primary" size="large" block round icon="play-circle-o" @click="emit('start')">
        开始计时
      </van-button>
    </template>

    <template v-else-if="status === 'running'">
      <div class="row">
        <van-button type="warning" size="large" round block icon="pause-circle-o" @click="emit('pause')">暂停</van-button>
        <van-button type="danger" size="large" round block icon="stop-circle-o" @click="emit('stop')">停止</van-button>
      </div>
      <van-button plain type="primary" size="large" block round icon="records-o" class="mt" @click="emit('remark')">
        备注
      </van-button>
    </template>

    <template v-else-if="status === 'paused'">
      <div class="row">
        <van-button type="success" size="large" round block icon="play-circle-o" @click="emit('resume')">恢复</van-button>
        <van-button type="danger" size="large" round block icon="stop-circle-o" @click="emit('stop')">停止</van-button>
      </div>
      <van-button plain type="primary" size="large" block round icon="records-o" class="mt" @click="emit('remark')">
        备注
      </van-button>
    </template>
  </div>
</template>

<style scoped>
.controlbar {
  padding: 12px 16px 8px;
}
.row {
  display: flex;
  gap: 12px;
}
.mt {
  margin-top: 12px;
}
</style>
