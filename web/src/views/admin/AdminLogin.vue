<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElCard, ElForm, ElFormItem, ElInput, ElButton, ElMessage } from 'element-plus';
import { User } from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import { adminLogin } from '@/api';
import { TOKEN_KEY } from '@/api/client';

const router = useRouter();
const username = ref('');
const pwd = ref('');
const loading = ref(false);

async function login() {
  if (!username.value.trim()) {
    ElMessage.warning('请输入用户名');
    return;
  }
  if (!pwd.value) {
    ElMessage.warning('请输入密码');
    return;
  }
  loading.value = true;
  try {
    const r = await adminLogin(username.value.trim(), pwd.value);
    // CR-05：兼容两种返回形状（拦截器已剥外层，仍做兼容写法），禁止再写入 "undefined"
    const token = (r as any)?.token ?? (r as any)?.data?.token ?? '';
    if (!token) {
      ElMessage.error('登录失败：未取到凭证');
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    // CR-06：未改密账号登录后必须先去改密，不得进业务页
    const mustChange = !!(r as any)?.mustChangePwd || !!(r as any)?.data?.mustChangePwd;
    ElMessage.success('登录成功');
    router.replace(mustChange ? '/admin/password' : '/admin');
  } catch (e: any) {
    ElMessage.error(e.message || '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <div class="login-title">安全员计时 · 管理后台</div>
      <div class="login-sub">维护安全员 / 车架号 / 组织·供应商 / 账号，并查询导出计时记录</div>
      <el-form @submit.prevent>
        <el-form-item>
          <el-input
            v-model="username"
            size="large"
            placeholder="请输入用户名"
            :prefix-icon="User"
            @keyup.enter="login"
          />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="pwd"
            type="password"
            size="large"
            placeholder="请输入密码"
            show-password
            @keyup.enter="login"
          />
        </el-form-item>
      </el-form>
      <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="login">登录</el-button>
      <div class="login-foot">
        <router-link to="/">← 返回安全员端</router-link>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f2f5;
}
.login-card {
  width: 380px;
}
.login-title {
  font-size: 20px;
  font-weight: 700;
  text-align: center;
}
.login-sub {
  font-size: 12px;
  color: #909399;
  text-align: center;
  margin: 8px 0 20px;
  line-height: 1.6;
}
.login-foot {
  margin-top: 14px;
  text-align: center;
  font-size: 13px;
}
</style>
