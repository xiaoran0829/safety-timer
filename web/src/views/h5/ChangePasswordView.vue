<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showConfirmDialog } from 'vant';
import ChangePwdForm from '@/components/ChangePwdForm.vue';
import { h5ChangePassword, h5Logout, h5Me } from '@/api/h5';
import { OP_TOKEN_KEY } from '@/api/h5Client';
import { useAppStore } from '@/stores/app';

defineOptions({ name: 'H5ChangePassword' });

const router = useRouter();
const store = useAppStore();

const loading = ref(false);

async function onSubmit(oldPassword: string, newPassword: string) {
  loading.value = true;
  try {
    const r = await h5ChangePassword(oldPassword, newPassword);
    // 改密成功后后端返回新 token，覆盖旧 token
    if (r?.token) localStorage.setItem(OP_TOKEN_KEY, r.token);
    // 回填本人（直开改密页时登录态可能未回填 operator）
    try {
      const me = await h5Me();
      store.setOperator(me.operator);
      store.markAuthChecked(!!me.mustChangePwd);
    } catch {
      store.markAuthChecked(false);
    }
    showToast('密码已修改');
    router.replace('/vin');
  } catch (e: any) {
    showToast(e?.message || '修改失败，请确认原密码是否正确');
  } finally {
    loading.value = false;
  }
}

async function logout() {
  try {
    await showConfirmDialog({ title: '提示', message: '确认退出登录？' });
  } catch {
    return;
  }
  try {
    await h5Logout();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(OP_TOKEN_KEY);
  store.clearOperator();
  router.replace('/login');
}
</script>

<template>
  <div class="page">
    <div class="topbar">
      <div class="who">修改密码</div>
      <van-button size="small" plain @click="logout">退出登录</van-button>
    </div>

    <div class="cpw-wrap">
      <div class="cpw-hint">首次登录（或密码被重置）需先修改密码，方可进入计时。</div>
      <ChangePwdForm :loading="loading" submit-text="确认修改" @submit="onSubmit" />
    </div>
  </div>
</template>

<style scoped>
.cpw-wrap {
  padding: 18px 16px;
}
.cpw-hint {
  background: #fff7e6;
  color: #ad6800;
  border: 1px solid #ffe7ba;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 18px;
}
</style>
