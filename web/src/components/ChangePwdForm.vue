<script setup lang="ts">
import { ref } from 'vue';

/**
 * CR-06：共用改密表单（H5 与后台复用，不依赖 Vant / Element Plus）。
 * 校验：原密码必填（requireOld）、新密码 ≥6、两次新密一致。
 * 提交由父组件处理：@submit(oldPassword, newPassword)
 */
const props = withDefaults(
  defineProps<{
    loading?: boolean;
    submitText?: string;
    requireOld?: boolean;
  }>(),
  { loading: false, submitText: '确认修改', requireOld: true }
);

const emit = defineEmits<{ (e: 'submit', oldPassword: string, newPassword: string): void }>();

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const err = ref('');

function submit() {
  err.value = '';
  if (props.requireOld && !oldPassword.value) {
    err.value = '请输入原密码';
    return;
  }
  if (!newPassword.value) {
    err.value = '请输入新密码';
    return;
  }
  if (newPassword.value.length < 6) {
    err.value = '新密码至少 6 位';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    err.value = '两次输入的新密码不一致';
    return;
  }
  emit('submit', oldPassword.value, newPassword.value);
}

function reset() {
  oldPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  err.value = '';
}

defineExpose({ reset });
</script>

<template>
  <form class="cpw" @submit.prevent="submit">
    <div v-if="requireOld" class="cpw-item">
      <label class="cpw-label">原密码</label>
      <input
        v-model="oldPassword"
        class="cpw-input"
        type="password"
        autocomplete="current-password"
        placeholder="请输入原密码"
      />
    </div>
    <div class="cpw-item">
      <label class="cpw-label">新密码</label>
      <input
        v-model="newPassword"
        class="cpw-input"
        type="password"
        autocomplete="new-password"
        placeholder="至少 6 位"
      />
    </div>
    <div class="cpw-item">
      <label class="cpw-label">确认新密码</label>
      <input
        v-model="confirmPassword"
        class="cpw-input"
        type="password"
        autocomplete="new-password"
        placeholder="再次输入新密码"
      />
    </div>

    <div v-if="err" class="cpw-err">{{ err }}</div>

    <button class="cpw-submit" type="submit" :disabled="loading">
      {{ loading ? '提交中…' : submitText }}
    </button>
  </form>
</template>

<style scoped>
.cpw {
  display: block;
  max-width: 420px;
}
.cpw-item {
  margin-bottom: 14px;
}
.cpw-label {
  display: block;
  font-size: 13px;
  color: #5a6572;
  margin-bottom: 6px;
}
.cpw-input {
  width: 100%;
  box-sizing: border-box;
  height: 42px;
  padding: 0 12px;
  font-size: 15px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  background: #fff;
  color: #1f2329;
  outline: none;
  -webkit-appearance: none;
}
.cpw-input:focus {
  border-color: var(--st-primary, #1989fa);
}
.cpw-err {
  color: var(--st-red, #ee0a24);
  font-size: 13px;
  margin: 4px 0 10px;
}
.cpw-submit {
  width: 100%;
  height: 44px;
  border: none;
  border-radius: 8px;
  background: var(--st-primary, #1989fa);
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}
.cpw-submit:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
