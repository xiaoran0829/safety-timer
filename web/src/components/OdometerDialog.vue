<script setup lang="ts">
import { ref, watch } from 'vue';
import { showToast } from 'vant';

const props = withDefaults(
  defineProps<{ modelValue: boolean; title?: string; label?: string; placeholder?: string }>(),
  { title: '填写里程', label: '里程数（km）', placeholder: '请输入里程数（km）' }
);
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'save', value: number): void;
}>();

const v = ref('');

watch(
  () => props.modelValue,
  (open) => {
    if (open) v.value = '';
  }
);

function onSave() {
  const t = v.value.trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n) || n < 0) {
    showToast('请输入有效的里程数');
    return;
  }
  emit('save', n);
}
</script>

<template>
  <van-dialog
    :show="modelValue"
    :title="title"
    show-cancel-button
    confirm-button-text="确定"
    @update:show="(s: boolean) => emit('update:modelValue', s)"
    @confirm="onSave"
  >
    <div style="padding: 12px 16px">
      <van-field v-model="v" type="number" inputmode="decimal" :label="label" :placeholder="placeholder" clearable />
    </div>
  </van-dialog>
</template>
