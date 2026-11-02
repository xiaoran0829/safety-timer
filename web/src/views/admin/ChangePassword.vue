<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElCard, ElMessage } from 'element-plus';
import 'element-plus/dist/index.css';
import ChangePwdForm from '@/components/ChangePwdForm.vue';
import { adminChangePassword } from '@/api';
import { TOKEN_KEY } from '@/api/client';

const router = useRouter();
const loading = ref(false);

async function onSubmit(oldPassword: string, newPassword: string) {
  loading.value = true;
  try {
    const r = await adminChangePassword(oldPassword, newPassword);
    // 改密成功后后端返回新 token，覆盖旧 token（旧 token 已随 pwd_ver 失效）
    if (r?.token) localStorage.setItem(TOKEN_KEY, r.token);
    ElMessage.success('密码已修改');
    router.replace('/admin');
  } catch (e: any) {
    ElMessage.error(e?.message || '修改失败，请确认原密码是否正确');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="admin-pwd">
    <el-card>
      <template #header>
        <div class="card-hd">修改密码</div>
      </template>
      <div class="hint">首次登录（或密码被管理员重置）需先修改密码，方可进入后台业务页面。</div>
      <ChangePwdForm :loading="loading" submit-text="确认修改" @submit="onSubmit" />
    </el-card>
  </div>
</template>

<style scoped>
.admin-pwd {
  padding: 8px;
  max-width: 520px;
}
.card-hd {
  font-weight: 600;
}
.hint {
  background: #fdf6ec;
  color: #b88230;
  border: 1px solid #faecd8;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 18px;
}
</style>
