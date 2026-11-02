<script setup lang="ts">
import { ref, watch } from 'vue';
import { showToast } from 'vant';

const props = withDefaults(
  defineProps<{ modelValue: boolean; title?: string; placeholder?: string }>(),
  { title: '添加备注', placeholder: '例如：配合吊装作业，暂停计时' }
);
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'save', content: string): void;
}>();

const text = ref('');

watch(
  () => props.modelValue,
  (v) => {
    if (v) text.value = '';
  }
);

function onSave() {
  const t = text.value.trim();
  if (!t) {
    showToast('请输入备注内容');
    return;
  }
  emit('save', t);
}
</script>

<template>
  <van-dialog
    :show="modelValue"
    :title="title"
    show-cancel-button
    confirm-button-text="保存"
    @update:show="(v: boolean) => emit('update:modelValue', v)"
    @confirm="onSave"
  >
    <div style="padding: 12px 16px">
      <van-field
        v-model="text"
        type="textarea"
        rows="3"
        maxlength="200"
        show-word-limit
        :placeholder="placeholder"
        autosize
      />
    </div>
  </van-dialog>
</template>
