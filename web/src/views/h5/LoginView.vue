<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { h5Login } from '@/api/h5';
import { OP_TOKEN_KEY } from '@/api/h5Client';
import { useAppStore } from '@/stores/app';

defineOptions({ name: 'H5Login' });

const router = useRouter();
const store = useAppStore();

const username = ref('');
const password = ref('');
const loading = ref(false);

async function onSubmit() {
  if (loading.value) return;
  if (!username.value.trim()) {
    showToast('请输入账号');
    return;
  }
  if (!password.value) {
    showToast('请输入密码');
    return;
  }
  loading.value = true;
  try {
    const r = await h5Login(username.value.trim(), password.value);
    const token = (r as any)?.token ?? '';
    if (!token) {
      showToast('登录失败：未取到凭证');
      return;
    }
    localStorage.setItem(OP_TOKEN_KEY, token);
    // 新登录会话：清掉上一人的车辆选择，回填本人
    store.clearVehicle();
    store.setOperator(r.operator);
    store.markAuthChecked(!!r.mustChangePwd);
    router.replace(r.mustChangePwd ? '/change-password' : '/vin');
  } catch (e: any) {
    showToast(e?.message || '账号或密码错误');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="login-brand">
      <div class="login-logo">安全员计时</div>
      <div class="login-tip">请使用本人账号登录</div>
    </div>

    <van-form @submit="onSubmit">
      <van-cell-group inset>
        <van-field
          v-model="username"
          name="username"
          label="账号"
          placeholder="请输入账号"
          autocomplete="username"
          :rules="[{ required: true, message: '请输入账号' }]"
        />
        <van-field
          v-model="password"
          type="password"
          name="password"
          label="密码"
          placeholder="请输入密码"
          autocomplete="current-password"
          :rules="[{ required: true, message: '请输入密码' }]"
        />
      </van-cell-group>

      <div class="login-submit">
        <van-button round block type="primary" native-type="submit" :loading="loading">登录</van-button>
      </div>
    </van-form>

    <div class="login-foot">账号由管理员在后台创建，如遗忘密码请联系管理员重置</div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  padding-top: 15vh;
  background: var(--st-bg);
}
.login-brand {
  text-align: center;
  margin-bottom: 24px;
}
.login-logo {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 1px;
}
.login-tip {
  color: var(--st-sub);
  font-size: 13px;
  margin-top: 8px;
}
.login-submit {
  margin: 20px 16px 0;
}
.login-foot {
  color: var(--st-sub);
  font-size: 12px;
  text-align: center;
  margin-top: 24px;
  padding: 0 24px;
  line-height: 1.6;
}
</style>
