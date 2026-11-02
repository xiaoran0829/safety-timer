<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElContainer, ElHeader, ElAside, ElMain, ElMenu, ElMenuItem, ElButton, ElTag, ElMessageBox } from 'element-plus';
import 'element-plus/dist/index.css';
import { adminLogout } from '@/api';
import { TOKEN_KEY } from '@/api/client';
import { useAdminStore, ROLE_LABEL, NAV_ITEMS } from '@/stores/admin';

const route = useRoute();
const router = useRouter();
const admin = useAdminStore();

/* CR-10：菜单按角色过滤（真正的权限以后端 403 NO_PERMISSION 为准，这里只管可见性） */
const nav = computed(() => admin.navItems.map((n) => ({ path: n.path, label: n.label })));
const roleLabel = computed(() => (admin.role ? ROLE_LABEL[admin.role] : ''));

onMounted(async () => {
  // 进后台时刷新一次角色；若当前页已无权（如角色被改）→ 跳到第一个有权页
  await admin.load(true);
  const hit = NAV_ITEMS.find((n) => route.path.startsWith(n.path));
  if (hit && !admin.can(hit.key)) router.replace(admin.firstAllowedPath());
});

// 高亮匹配当前子路由（默认 active 用第一个命中项）
const active = computed(() => {
  const hit = nav.value.find((n) => route.path.startsWith(n.path));
  return hit ? hit.path : route.path;
});

async function logout() {
  try {
    await ElMessageBox.confirm('确认退出后台登录？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await adminLogout();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(TOKEN_KEY);
  admin.clear();
  router.replace('/admin/login');
}
</script>

<template>
  <el-container class="admin-shell">
    <el-header class="admin-header">
      <div class="brand">安全员工作计时 · 管理后台</div>
      <div class="hdr-right">
        <el-tag v-if="roleLabel" size="small" type="info" style="margin-right: 8px">{{ roleLabel }}</el-tag>
        <el-button text @click="router.push('/')">安全员端入口</el-button>
        <el-button text @click="router.push('/admin/password')">修改密码</el-button>
        <el-button type="danger" plain @click="logout">退出</el-button>
      </div>
    </el-header>
    <el-container class="admin-body">
      <el-aside width="200px" class="admin-aside">
        <el-menu :default-active="active" router>
          <el-menu-item v-for="n in nav" :key="n.path" :index="n.path">{{ n.label }}</el-menu-item>
        </el-menu>
      </el-aside>
      <el-main class="admin-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.admin-shell {
  min-height: 100vh;
}
.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1f2d3d;
  color: #fff;
}
.admin-header .brand {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.5px;
}
.admin-header .hdr-right :deep(.el-button.is-text) {
  color: #c8d0da;
}
.admin-body {
  height: calc(100vh - 60px);
}
.admin-aside {
  border-right: 1px solid #ebeef5;
  background: #fff;
}
.admin-aside :deep(.el-menu) {
  border-right: none;
}
.admin-main {
  background: #f5f7fa;
}
</style>
