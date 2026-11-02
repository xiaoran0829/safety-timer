<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElSwitch,
  ElLoading,
  ElMessage,
  ElMessageBox,
} from 'element-plus';
import { adminOrganizations, adminSuppliers } from '@/api';
import { checkImportFile, downloadCsvTemplate } from '@/utils/importFile';
import type { Organization, Supplier } from '@/types';

const props = defineProps<{ kind: 'organizations' | 'suppliers' }>();

const api = computed(() => (props.kind === 'organizations' ? adminOrganizations : adminSuppliers));
const label = computed(() => (props.kind === 'organizations' ? '组织' : '供应商'));

const vLoading = ElLoading.directive;

const list = ref<(Organization | Supplier)[]>([]);
const loading = ref(false);
const showInactive = ref(true);
const fileInput = ref<HTMLInputElement>();

const show = ref(false);
const isEdit = ref(false);
const saving = ref(false);
const form = ref<any>({ name: '', code: '', active: 1, sort: 0, see_all: 0 });
const formRef = ref();

const rules = { name: [{ required: true, message: '名称必填', trigger: 'blur' }] };

async function load() {
  loading.value = true;
  try {
    list.value = await api.value.list({ active: showInactive.value ? '' : 1 });
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  isEdit.value = false;
  form.value = { name: '', code: '', active: 1, sort: 0, see_all: 0 };
  show.value = true;
}

function openEdit(row: any) {
  isEdit.value = true;
  form.value = { ...row };
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
      await api.value.update(form.value.id, form.value);
    } else {
      await api.value.create(form.value);
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

async function toggleActive(row: any) {
  const next = row.active ? 0 : 1;
  if (!next) {
    try {
      await ElMessageBox.confirm(`确认停用「${row.name}」？`, '提示', { type: 'warning' });
    } catch {
      return;
    }
  }
  try {
    await api.value.update(row.id, { active: next });
    row.active = next;
    ElMessage.success(next ? '已启用' : '已停用');
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

function downloadTemplate() {
  downloadCsvTemplate(
    `${label.value || '字典'}导入模板.csv`,
    ['名称', '编码', '排序'],
    [[`示例${label.value || ''}`, 'CODE-001', '1']]
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
    const r = await api.value.importCsv(f);
    ElMessage.success(`导入成功 ${r.inserted} 条，跳过 ${r.skipped} 条`);
    load();
  } catch (err: any) {
    ElMessage.error(err.message || '导入失败');
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <div>
        <el-button type="primary" @click="openAdd">新增{{ label }}</el-button>
        <el-button @click="fileInput?.click()">导入 CSV/Excel</el-button>
        <el-button @click="downloadTemplate">下载模板</el-button>
        <span class="hint">CSV 列：名称, 编码, 排序（首行为表头时自动跳过）</span>
        <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display: none" @change="onFile" />
      </div>
      <el-switch v-model="showInactive" active-text="含已停用" @change="load" />
    </div>

    <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 260px)">
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="name" :label="label + '名称'" min-width="160" />
      <el-table-column prop="code" label="编码" min-width="140" />
      <el-table-column v-if="kind === 'organizations'" label="可见全部组织" width="120">
        <template #default="{ row }">
          <el-tag :type="row.see_all ? 'warning' : 'info'">{{ row.see_all ? '是' : '否' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.active ? 'primary' : 'danger'">{{ row.active ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" />
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link :type="row.active ? 'danger' : 'success'" @click="toggleActive(row)">
            {{ row.active ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="show" :title="(isEdit ? '编辑' : '新增') + label" width="440px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item :label="label + '名称'" prop="name">
          <el-input v-model="form.name" placeholder="必填，唯一" />
        </el-form-item>
        <el-form-item label="编码">
          <el-input v-model="form.code" placeholder="选填" />
        </el-form-item>
        <el-form-item v-if="kind === 'organizations'" label="可见全部组织">
          <el-switch v-model="form.see_all" :active-value="1" :inactive-value="0" />
          <span class="hint" style="margin-left: 8px">开启后该组织账号可看全部组织的工单/车辆</span>
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model.number="form.sort" type="number" placeholder="越小越靠前" />
        </el-form-item>
        <el-form-item v-if="isEdit" label="启用">
          <el-switch v-model="form.active" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
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
