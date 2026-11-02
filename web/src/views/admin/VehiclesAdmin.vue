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
import {
  adminListVehicles,
  adminCreateVehicle,
  adminUpdateVehicle,
  adminImportVehicles,
  adminOrganizations,
  adminSuppliers,
  getVehicles,
} from '@/api';
import { checkImportFile, downloadCsvTemplate } from '@/utils/importFile';
import type { AdminVehicle, Organization, Supplier, Vehicle } from '@/types';

const vLoading = ElLoading.directive;

const list = ref<AdminVehicle[]>([]);
const loading = ref(false);
const showInactive = ref(true);
const fileInput = ref<HTMLInputElement>();

const orgs = ref<Organization[]>([]);
const sups = ref<Supplier[]>([]);

const show = ref(false);
const isEdit = ref(false);
const saving = ref(false);
const form = ref<Partial<AdminVehicle>>({
  vin: '',
  station: '',
  orgId: null,
  supplierId: null,
  sort: 0,
  active: 1,
});
const formRef = ref();

const rules = { vin: [{ required: true, message: '车架号必填', trigger: 'blur' }] };

async function load() {
  loading.value = true;
  try {
    // 后台列表不含占用态；用公开 /api/vehicles 的 occupied 按 id 合并（状态列「空闲/使用中·XXX」）
    const [rows, pub] = await Promise.all([
      adminListVehicles({ active: showInactive.value ? '' : 1 }),
      getVehicles({ active: 1 }).catch(() => [] as Vehicle[]),
    ]);
    const occ = new Map<number, Vehicle['occupied']>();
    pub.forEach((v) => occ.set(v.id, v.occupied));
    list.value = rows.map((v) => ({ ...v, occupied: occ.get(v.id) ?? null }));
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadDicts() {
  try {
    [orgs.value, sups.value] = await Promise.all([
      adminOrganizations.list({ active: '' }),
      adminSuppliers.list({ active: '' }),
    ]);
  } catch {
    /* 字典接口未就绪时降级为空列表，不阻塞列表展示 */
  }
}

function openAdd() {
  isEdit.value = false;
  form.value = { vin: '', station: '', orgId: null, supplierId: null, sort: 0, active: 1 };
  show.value = true;
}

function openEdit(v: any) {
  isEdit.value = true;
  form.value = {
    ...v,
    orgId: v.orgId ?? null,
    supplierId: v.supplierId ?? null,
  };
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
    // 后端挂靠字段用 snake_case（org_id/supplier_id/default_initiator_id）；响应则用 camelCase
    const payload: any = {
      vin: form.value.vin,
      station: form.value.station ?? null,
      sort: form.value.sort ?? 0,
      org_id: form.value.orgId ?? null,
      supplier_id: form.value.supplierId ?? null,
    };
    if (isEdit.value && form.value.id) {
      payload.active = form.value.active ?? 1;
      await adminUpdateVehicle(form.value.id, payload);
    } else {
      await adminCreateVehicle(payload);
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

async function toggleActive(v: any) {
  const next = v.active ? 0 : 1;
  if (!next) {
    try {
      await ElMessageBox.confirm(`确认停用「${v.vin}」？（软删，历史记录保留）`, '提示', { type: 'warning' });
    } catch {
      return;
    }
  }
  try {
    await adminUpdateVehicle(v.id, { active: next });
    v.active = next;
    ElMessage.success(next ? '已启用' : '已停用');
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

function downloadTemplate() {
  downloadCsvTemplate(
    '车辆导入模板.csv',
    ['车架号', '工位', '组织', '供应商', '排序', 'org_id', 'supplier_id', 'default_initiator_id'],
    [['LSVAB1234K5678901', '工位A', '', '', '1', '', '', '']]
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
    const r = await adminImportVehicles(f);
    ElMessage.success(`导入成功 ${r.inserted} 条，跳过 ${r.skipped} 条`);
    load();
  } catch (err: any) {
    ElMessage.error(err.message || '导入失败');
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

onMounted(() => {
  load();
  loadDicts();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <div>
        <el-button type="primary" @click="openAdd">新增车架号</el-button>
        <el-button @click="fileInput?.click()">导入 CSV/Excel</el-button>
        <el-button @click="downloadTemplate">下载模板</el-button>
        <span class="hint">CSV 建议带表头：车架号, 工位, 组织, 供应商（挂靠 ID：org_id, supplier_id）；车架号需 17 位字母数字、不含 I/O/Q</span>
        <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display: none" @change="onFile" />
      </div>
      <el-switch v-model="showInactive" active-text="含已停用" @change="load" />
    </div>

    <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 200px)">
      <el-table-column prop="vin" label="车架号" min-width="180" />
      <el-table-column prop="orgName" label="组织" min-width="130" />
      <el-table-column prop="supplierName" label="供应商" min-width="130" />
      <el-table-column prop="station" label="工位" min-width="110" />
      <el-table-column label="状态" width="160">
        <template #default="{ row }">
          <el-tag v-if="row.occupied" type="warning">使用中·{{ row.occupied.operatorName }}</el-tag>
          <el-tag v-else-if="!row.active" type="danger">已停用</el-tag>
          <el-tag v-else type="success">空闲</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link :type="row.active ? 'danger' : 'success'" @click="toggleActive(row)">
            {{ row.active ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="show" :title="isEdit ? '编辑车架号' : '新增车架号'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="车架号" prop="vin">
          <el-input v-model="form.vin" placeholder="必填，唯一" />
        </el-form-item>
        <el-form-item label="组织">
          <el-select v-model="form.orgId" clearable filterable placeholder="选择组织" style="width: 100%">
            <el-option v-for="o in orgs" :key="o.id" :label="o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="供应商">
          <el-select v-model="form.supplierId" clearable filterable placeholder="选择供应商" style="width: 100%">
            <el-option v-for="s in sups" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="工位">
          <el-input v-model="form.station" placeholder="选填" />
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
