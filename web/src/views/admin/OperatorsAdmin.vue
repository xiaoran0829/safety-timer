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
  ElAlert,
  ElMessage,
  ElMessageBox,
} from 'element-plus';
import {
  adminListOperators,
  adminCreateOperator,
  adminUpdateOperator,
  adminDeleteOperator,
  adminImportOperators,
  adminSetOperatorAccount,
  adminClearOperatorAccount,
  adminBatchOpenOperatorAccounts,
} from '@/api';
import { checkImportFile, downloadCsvTemplate } from '@/utils/importFile';
import type { Operator } from '@/types';

const vLoading = ElLoading.directive;

const list = ref<Operator[]>([]);
const loading = ref(false);
const showInactive = ref(true);
const fileInput = ref<HTMLInputElement>();

const show = ref(false);
const isEdit = ref(false);
const saving = ref(false);
const form = ref<Partial<Operator>>({ name: '', employeeNo: '', groupName: '', employed: 1, active: 1, sort: 0 });
const formRef = ref();

const rules = {
  name: [{ required: true, message: '姓名必填', trigger: 'blur' }],
  employeeNo: [{ required: true, message: '工号必填（同时作为登录账号默认值）', trigger: 'blur' }],
};

async function load() {
  loading.value = true;
  try {
    list.value = await adminListOperators({ active: showInactive.value ? '' : 1 });
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  isEdit.value = false;
  form.value = { name: '', employeeNo: '', groupName: '', employed: 1, active: 1, sort: 0 };
  show.value = true;
}

function openEdit(o: any) {
  isEdit.value = true;
  form.value = { ...o, employed: o.employed ?? 1 };
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
    if (isEdit.value && form.value.id) {
      await adminUpdateOperator(form.value.id, form.value);
    } else {
      await adminCreateOperator(form.value);
    }
    show.value = false;
    ElMessage.success('已保存');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/* CR-06：H5 登录账号（开号 / 重置口令 / 清除） */
const accShow = ref(false);
const accSaving = ref(false);
const accTarget = ref<any>(null);
const accForm = ref({ username: '', password: '' });

function openAccount(o: any) {
  accTarget.value = o;
  // CR-08（需求①）：默认口令 = 工号后 6 位（与批量开号一致）
  const emp = String(o.employeeNo || o.username || '').trim();
  accForm.value = { username: o.username || o.employeeNo || '', password: emp ? emp.slice(-6) : '' };
  accShow.value = true;
}

async function saveAccount() {
  const u = (accForm.value.username || '').trim();
  const p = accForm.value.password || '';
  if (!u) return ElMessage.error('请先填工号（或手动填写账号）');
  if (p.trim().length < 6) return ElMessage.error('口令不得少于 6 位');
  accSaving.value = true;
  try {
    await adminSetOperatorAccount(accTarget.value.id, { username: u, password: p });
    ElMessage.success('已保存，该安全员首次登录必须修改密码');
    accShow.value = false;
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    accSaving.value = false;
  }
}

async function clearAccount(o: any) {
  try {
    await ElMessageBox.confirm(`确认清除「${o.name}」的登录账号？清除后该账号将无法登录 H5。`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await adminClearOperatorAccount(o.id);
    ElMessage.success('已清除登录账号');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

async function toggleActive(o: any) {
  const next = o.active ? 0 : 1;
  if (!next) {
    try {
      await ElMessageBox.confirm(`确认停用「${o.name}」？（软删，历史记录保留）`, '提示', { type: 'warning' });
    } catch {
      return;
    }
  }
  try {
    await adminUpdateOperator(o.id, { active: next });
    o.active = next;
    ElMessage.success(next ? '已启用' : '已停用');
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

function downloadTemplate() {
  downloadCsvTemplate(
    '安全员导入模板.csv',
    ['姓名', '标签', '电话', '排序', '工号', '分组', '在职'],
    [['张三', '安全员A', '13800000000', '1', 'E1001', '一组', '1']]
  );
}

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const bad = checkImportFile(f);
  if (bad) {
    ElMessage.error(bad);
    if (fileInput.value) fileInput.value.value = '';
    return;
  }
  try {
    const r = await adminImportOperators(f);
    const extra = r.accountsOpened ? `，自动开号 ${r.accountsOpened} 个` : '';
    ElMessage.success(`导入成功 ${r.inserted} 条，跳过 ${r.skipped} 条${extra}`);
    load();
  } catch (err: any) {
    ElMessage.error(err.message || '导入失败');
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

/* CR-08（需求①）：未开号的全量批量开号 */
const batching = ref(false);
async function batchOpenAccounts() {
  try {
    await ElMessageBox.confirm(
      '将为所有「已启用且未开号」的安全员批量开号：账号=工号，默认口令=工号后6位，首登强制改密。继续？',
      '批量开号',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  batching.value = true;
  try {
    const r = await adminBatchOpenOperatorAccounts();
    if (r.errors?.length) {
      ElMessageBox.alert(
        `共 ${r.total} 人：成功 ${r.created}，跳过 ${r.skipped}。<br/>` +
          r.errors.map((e: any) => `· ${e.name || e.id}：${e.reason}`).join('<br/>'),
        '批量开号结果',
        { dangerouslyUseHTMLString: true }
      );
    } else {
      ElMessage.success(`批量开号完成：成功 ${r.created}，跳过 ${r.skipped}`);
    }
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '批量开号失败');
  } finally {
    batching.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <div>
        <el-button type="primary" @click="openAdd">新增安全员</el-button>
        <el-button type="success" plain :loading="batching" @click="batchOpenAccounts">批量开号</el-button>
        <el-button @click="fileInput?.click()">导入 CSV/Excel</el-button>
        <el-button @click="downloadTemplate">下载模板</el-button>
        <span class="hint">CSV 建议带表头：姓名, 工号, 分组, 在职(1/0)</span>
        <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display: none" @change="onFile" />
      </div>
      <el-switch v-model="showInactive" active-text="含已停用" @change="load" />
    </div>

    <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 200px)">
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="name" label="姓名" min-width="120" />
      <el-table-column prop="employeeNo" label="工号" min-width="120" />
      <el-table-column prop="groupName" label="分组" min-width="120" />
      <el-table-column label="在职状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.employed ? 'success' : 'info'">{{ row.employed ? '在职' : '离职' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="名单状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'primary' : 'danger'">{{ row.active ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" />
      <el-table-column label="登录账号" width="130">
        <template #default="{ row }">
          <el-tag v-if="row.hasAccount" type="success" size="small">{{ row.username }}</el-tag>
          <el-tag v-else type="info" size="small">未开通</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="openAccount(row)">{{ row.hasAccount ? '重置口令' : '开账号' }}</el-button>
          <el-button v-if="row.hasAccount" link type="warning" @click="clearAccount(row)">清账号</el-button>
          <el-button link :type="row.active ? 'danger' : 'success'" @click="toggleActive(row)">
            {{ row.active ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="show" :title="isEdit ? '编辑安全员' : '新增安全员'" width="460px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="必填" />
        </el-form-item>
        <el-form-item label="工号" prop="employeeNo">
          <el-input v-model="form.employeeNo" placeholder="必填（同时用作登录账号默认值）" />
        </el-form-item>
        <el-form-item label="分组">
          <el-input v-model="form.groupName" placeholder="选填" />
        </el-form-item>
        <el-form-item label="在职状态">
          <el-select v-model="form.employed" style="width: 100%">
            <el-option label="在职" :value="1" />
            <el-option label="离职" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model.number="form.sort" type="number" placeholder="越小越靠前" />
        </el-form-item>
        <el-form-item v-if="isEdit" label="名单启用">
          <el-switch v-model="form.active" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- CR-06：设置 / 重置 H5 登录账号 -->
    <el-dialog v-model="accShow" :title="`登录账号 · ${accTarget?.name || ''}`" width="440px">
      <el-form label-width="90px">
        <el-form-item label="账号">
          <el-input v-model="accForm.username" placeholder="默认=工号，可覆盖（全站唯一）" />
        </el-form-item>
        <el-form-item label="初始口令">
          <el-input v-model="accForm.password" type="password" show-password placeholder="不少于 6 位" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="保存后该安全员首次登录必须修改密码；忘记口令时点「重置口令」即可。"
      />
      <template #footer>
        <el-button @click="accShow = false">取消</el-button>
        <el-button type="primary" :loading="accSaving" @click="saveAccount">保存</el-button>
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
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #909399;
}
</style>
