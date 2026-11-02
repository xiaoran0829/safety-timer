<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElSelect,
  ElOption,
  ElSwitch,
  ElLoading,
  ElMessage,
  ElMessageBox,
} from 'element-plus';
import { adminUsers, adminOrganizations, adminSuppliers } from '@/api';
import type { AdminUser, AdminRole } from '@/types';
import { ALL_ROLES, ROLE_LABEL } from '@/stores/admin';

const vLoading = ElLoading.directive;

/* CR-10：角色下拉选项 */
const roleOptions = ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
// 2026-10-08 需求③④：所属组织/供应商字典（账号绑定用）
const orgOptions = ref<{ id: number; name: string }[]>([]);
const supOptions = ref<{ id: number; name: string }[]>([]);
async function loadUnits() {
  try {
    const [o, sp] = await Promise.all([adminOrganizations.list({ active: 1 }), adminSuppliers.list({ active: 1 })]);
    orgOptions.value = o as any;
    supOptions.value = sp as any;
  } catch {
    /* 忽略：字典加载失败不影响账号管理 */
  }
}
function unitLabel(row: any) {
  if ((row.role || 'admin') === 'engineer') return row.orgName || '未绑定组织';
  if (row.role === 'fleet_admin') return row.supplierName || '未绑定供应商';
  return '—';
}

const list = ref<AdminUser[]>([]);
const loading = ref(false);
const showInactive = ref(true);
const q = ref('');

/* 新增账号 */
const show = ref(false);
const saving = ref(false);
const form = ref<{ username: string; name: string; password: string; role: AdminRole; orgId: number | null; supplierId: number | null }>({
  username: '',
  name: '',
  password: '',
  role: 'admin',
  orgId: null,
  supplierId: null,
});
const formRef = ref();
const rules = {
  username: [{ required: true, message: '用户名必填', trigger: 'blur' }],
  password: [
    { required: true, message: '密码必填', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

/* 重置密码 */
const pwdShow = ref(false);
const pwdSaving = ref(false);
const pwdTarget = ref<AdminUser | null>(null);
const newPwd = ref('');
const pwdRef = ref();
const pwdRules = {
  newPwd: [
    { required: true, message: '新密码必填', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

async function load() {
  loading.value = true;
  try {
    list.value = await adminUsers.list({ active: showInactive.value ? '' : 1, q: q.value.trim() || undefined });
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  form.value = { username: '', name: '', password: '', role: 'admin', orgId: null, supplierId: null };
  show.value = true;
}

async function save() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  saving.value = true;
  try {
    await adminUsers.create({
      username: form.value.username.trim(),
      name: form.value.name.trim() || undefined,
      password: form.value.password,
      role: form.value.role,
      orgId: form.value.role === 'engineer' ? form.value.orgId : undefined,
      supplierId: form.value.role === 'fleet_admin' ? form.value.supplierId : undefined,
    });
    show.value = false;
    ElMessage.success('已创建');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '创建失败');
  } finally {
    saving.value = false;
  }
}

async function toggleActive(u: any) {
  const next: 0 | 1 = u.active ? 0 : 1;
  if (!next) {
    try {
      await ElMessageBox.confirm(`确认禁用「${u.username}」？禁用后该账号将无法登录。`, '提示', { type: 'warning' });
    } catch {
      return;
    }
  }
  try {
    await adminUsers.update(u.id, { active: next });
    u.active = next;
    ElMessage.success(next ? '已启用' : '已禁用');
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

// 2026-10-08 需求③④：角色 + 所属组织/供应商 一起编辑（管理员专属操作）
const editShow = ref(false);
const editSaving = ref(false);
const editForm = ref<{ id: number; username: string; role: AdminRole; orgId: number | null; supplierId: number | null }>({
  id: 0,
  username: '',
  role: 'admin',
  orgId: null,
  supplierId: null,
});
function openEdit(u: any) {
  editForm.value = { id: u.id, username: u.username, role: u.role || 'admin', orgId: u.orgId ?? null, supplierId: u.supplierId ?? null };
  editShow.value = true;
}
async function saveEdit() {
  const f = editForm.value;
  if (f.role === 'engineer' && f.orgId == null) return ElMessage.warning('请选择所属组织');
  if (f.role === 'fleet_admin' && f.supplierId == null) return ElMessage.warning('请选择所属供应商');
  editSaving.value = true;
  try {
    await adminUsers.update(f.id, {
      role: f.role,
      orgId: f.role === 'engineer' ? f.orgId : null,
      supplierId: f.role === 'fleet_admin' ? f.supplierId : null,
    });
    editShow.value = false;
    ElMessage.success('已更新');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
    load();
  } finally {
    editSaving.value = false;
  }
}

function openReset(u: any) {
  pwdTarget.value = u as AdminUser;
  newPwd.value = '';
  pwdShow.value = true;
}

async function savePwd() {
  try {
    await pwdRef.value?.validate();
  } catch {
    return;
  }
  if (!pwdTarget.value) return;
  pwdSaving.value = true;
  try {
    await adminUsers.resetPassword(pwdTarget.value.id, newPwd.value);
    pwdShow.value = false;
    ElMessage.success('密码已重置');
  } catch (e: any) {
    ElMessage.error(e.message || '重置失败');
  } finally {
    pwdSaving.value = false;
  }
}

async function remove(u: any) {
  try {
    await ElMessageBox.confirm(`确认删除账号「${u.username}」？此操作不可恢复。`, '提示', {
      type: 'warning',
      confirmButtonText: '删除',
    });
  } catch {
    return;
  }
  try {
    await adminUsers.remove(u.id);
    ElMessage.success('已删除');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '删除失败');
  }
}

function fmtTime(s?: string | null) {
  return s ? s.replace('T', ' ').slice(0, 19) : '—';
}

onMounted(() => {
  load();
  loadUnits();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <div>
        <el-button type="primary" @click="openAdd">新增账号</el-button>
        <el-input
          v-model="q"
          placeholder="搜索用户名 / 姓名"
          clearable
          style="width: 220px; margin-left: 12px"
          @keyup.enter="load"
          @clear="load"
        />
      </div>
      <el-switch v-model="showInactive" active-text="含已禁用" @change="load" />
    </div>

    <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 200px)">
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="username" label="用户名" min-width="140" />
      <el-table-column prop="name" label="姓名" min-width="140" />
      <el-table-column label="角色" width="110">
        <template #default="{ row }">
          <el-tag>{{ ROLE_LABEL[(row.role || 'admin') as AdminRole] }}</el-tag>
        </template>
      </el-table-column>
      <!-- 2026-10-08 需求③④：所属单位（工程师=组织，车队=供应商） -->
      <el-table-column label="所属单位" min-width="150">
        <template #default="{ row }">{{ unitLabel(row) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'primary' : 'danger'">{{ row.active ? '启用' : '已禁用' }}</el-tag>
          <el-tag v-if="row.mustChangePwd" type="warning" style="margin-left: 6px">须改密</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="180">
        <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="openReset(row)">改密</el-button>
          <el-button link :type="row.active ? 'danger' : 'success'" @click="toggleActive(row)">
            {{ row.active ? '禁用' : '启用' }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增账号 -->
    <el-dialog v-model="show" title="新增账号" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="必填，唯一（允许中文）" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="form.name" placeholder="选填，缺省用用户名" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="o in roleOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.role === 'engineer'" label="所属组织">
          <el-select v-model="form.orgId" style="width: 100%" placeholder="选择组织">
            <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="form.role === 'fleet_admin'" label="所属供应商">
          <el-select v-model="form.supplierId" style="width: 100%" placeholder="选择供应商">
            <el-option v-for="s in supOptions" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 2026-10-08 需求③④：编辑角色 / 所属单位 -->
    <el-dialog v-model="editShow" :title="`编辑账号 · ${editForm.username}`" width="460px">
      <el-form label-width="90px">
        <el-form-item label="角色">
          <el-select v-model="editForm.role" style="width: 100%">
            <el-option v-for="o in roleOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editForm.role === 'engineer'" label="所属组织">
          <el-select v-model="editForm.orgId" style="width: 100%" placeholder="选择组织">
            <el-option v-for="o in orgOptions" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="editForm.role === 'fleet_admin'" label="所属供应商">
          <el-select v-model="editForm.supplierId" style="width: 100%" placeholder="选择供应商">
            <el-option v-for="s in supOptions" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editShow = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="pwdShow" :title="`重置密码 · ${pwdTarget?.username || ''}`" width="420px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="重置后该账号下次登录必须修改密码"
        style="margin-bottom: 14px"
      />
      <el-form ref="pwdRef" :model="{ newPwd }" :rules="pwdRules" label-width="90px">
        <el-form-item label="新密码" prop="newPwd">
          <el-input v-model="newPwd" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdShow = false">取消</el-button>
        <el-button type="primary" :loading="pwdSaving" @click="savePwd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
