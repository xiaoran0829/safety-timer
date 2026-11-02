<script setup lang="ts">
import { computed } from 'vue';
import type { Vehicle } from '@/types';

const props = defineProps<{ vehicle: Vehicle; selected?: boolean }>();
const emit = defineEmits<{ (e: 'select', v: Vehicle): void }>();

const occupied = computed(() => props.vehicle.occupied);
</script>

<template>
  <div
    class="card"
    :class="{ disabled: !!occupied, selected }"
    @click="emit('select', vehicle)"
  >
    <div class="card-main">
      <div class="card-title mono">{{ vehicle.vin }}</div>
      <div class="card-sub">
        {{ vehicle.station || '—' }}
        <span v-if="vehicle.shiftName" class="tag" style="margin-left: 8px">{{ vehicle.shiftName }}</span>
        <span v-if="vehicle.done" class="tag gray" style="margin-left: 8px">今日已完成</span>
        <span v-if="occupied" class="tag gray" style="margin-left: 8px">使用中 · {{ occupied.operatorName }}</span>
      </div>
    </div>
    <van-icon :name="occupied ? 'clock-o' : 'arrow'" :color="occupied ? '#c8ccd4' : '#c8ccd4'" />
  </div>
</template>
