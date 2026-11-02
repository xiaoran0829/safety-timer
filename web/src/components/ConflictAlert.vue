<script setup lang="ts">
defineProps<{ modelValue: boolean; message: string }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'go-current'): void;
}>();
</script>

<template>
  <van-dialog
    :model-value="modelValue"
    title="无法开始计时"
    show-cancel-button
    confirm-button-text="返回当前计时"
    cancel-button-text="关闭"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @confirm="emit('go-current')"
  >
    <div style="padding: 16px; line-height: 1.6; color: var(--st-red)">
      {{ message }}
    </div>
  </van-dialog>
</template>
