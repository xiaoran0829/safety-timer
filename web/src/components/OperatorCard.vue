<script setup lang="ts">
import type { Operator } from '@/types';
defineProps<{ operator: Operator; selected?: boolean }>();
const emit = defineEmits<{ (e: 'select', o: Operator): void }>();
</script>

<template>
  <div class="card" :class="{ selected }" @click="emit('select', operator)">
    <div class="card-main">
      <div class="card-title">{{ operator.name }}</div>
      <div class="card-sub">{{ operator.label || '安全员' }}</div>
    </div>
    <van-icon v-if="selected" name="success" color="#1989fa" size="22" />
    <van-icon v-else name="arrow" color="#c8ccd4" />
  </div>
</template>
