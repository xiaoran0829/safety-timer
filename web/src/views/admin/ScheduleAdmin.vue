<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElForm,
  ElFormItem,
  ElDatePicker,
  ElSelect,
  ElOption,
  ElInput,
  ElDialog,
  ElRadioGroup,
  ElRadio,
  ElTabs,
  ElTabPane,
  ElRow,
  ElCol,
  ElCard,
  ElMessage,
  ElMessageBox,
  ElLoading,
} from 'element-plus';
import { adminSchedules, adminShifts, adminListOperators, adminListVehicles } from '@/api';
import { checkImportFile, downloadCsvTemplate } from '@/utils/importFile';
import type { Operator, AdminVehicle, Shift, Schedule, ScheduleBoard, BatchAssignResult, CopyResult } from '@/types';
import { todayStr } from '@/utils/format';

const vLoading = ElLoading.directive;

const date = ref(todayStr());
const shiftId = ref<number | undefined>(undefined);
const list = ref<Schedule[]>([]);
const board = ref<ScheduleBoard | null>(null);
const loading = ref(false);

const ops = ref<Operator[]>([]);
const vehs = ref<AdminVehicle[]>([]);
const shifts = ref<Shift[]>([]);

async function loadRefs() {
  try {
    [ops.value, vehs.value, shifts.value] = await Promise.all([
      adminListOperators({ active: 1 }),
      adminListVehicles({ active: 1 }),
      adminShifts.list({ active: 1 }),
    ]);
  } catch (e: any) {
    ElMessage.error(e.message || '基础数据加载失败');
  }
}

async function load() {
  loading.value = true;
  try {
    const [rows, b] = await Promise.all([
      adminSchedules.list({ date: date.value || undefined, shiftId: shiftId.value }),
      adminSchedules.board(date.value || undefined),
    ]);
    list.value = rows;
    board.value = b;
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/* ---------- 新增 / 改派 ---------- */
const editVisible = ref(false);
const editing = ref<Schedule | null>(null);
const form = reactive<{ workDate: string; shiftId: number | null; operatorId: number | undefined; vehicleId: number | undefined; note: string }>({
  workDate: date.value,
  shiftId: null,
  operatorId: undefined,
  vehicleId: undefined,
  note: '',
});

function openCreate() {
  editing.value = null;
  form.workDate = date.value;
  form.shiftId = shiftId.value ?? null;
  form.operatorId = undefined;
  form.vehicleId = undefined;
  form.note = '';
  editVisible.value = true;
}

function openEdit(row: any) {
  editing.value = row;
  form.workDate = row.workDate;
  form.shiftId = row.shiftId;
  form.operatorId = row.operatorId;
  form.vehicleId = row.vehicleId;
  form.note = row.note || '';
  editVisible.value = true;
}

async function submitEdit() {
  if (!form.operatorId || !form.vehicleId) {
    ElMessage.warning('请选择安全员与车架号');
    return;
  }
  try {
    if (editing.value) {
      await adminSchedules.update(editing.value.id, {
        workDate: form.workDate,
        shiftId: form.shiftId,
        operatorId: form.operatorId,
        vehicleId: form.vehicleId,
        note: form.note,
      });
      ElMessage.success('已改派');
    } else {
      await adminSchedules.create({
        workDate: form.workDate,
        shiftId: form.shiftId,
        operatorId: form.operatorId,
        vehicleId: form.vehicleId,
        note: form.note,
      });
      ElMessage.success('已指派');
    }
    editVisible.value = false;
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '提交失败');
  }
}

async function cancelRow(row: any) {
  try {
    await ElMessageBox.confirm(`确认取消「${row.vin} · ${row.operatorName}」的排班？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await adminSchedules.remove(row.id);
    ElMessage.success('已取消');
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '取消失败');
  }
}

/* ---------- 批量指派 ---------- */
const batchVisible = ref(false);
const batch = reactive<{ workDate: string; shiftId: number | null; mode: 'cross' | 'pair'; operatorIds: number[]; vehicleIds: number[] }>({
  workDate: date.value,
  shiftId: null,
  mode: 'cross',
  operatorIds: [],
  vehicleIds: [],
});
const batchResult = ref<BatchAssignResult | null>(null);

function openBatch() {
  batch.workDate = date.value;
  batch.shiftId = shiftId.value ?? null;
  batch.mode = 'cross';
  batch.operatorIds = [];
  batch.vehicleIds = [];
  batchResult.value = null;
  batchVisible.value = true;
}

async function submitBatch() {
  if (!batch.operatorIds.length || !batch.vehicleIds.length) {
    ElMessage.warning('请至少各选一名安全员与一台车');
    return;
  }
  try {
    batchResult.value = await adminSchedules.batch({
      workDate: batch.workDate,
      shiftId: batch.shiftId,
      operatorIds: batch.operatorIds,
      vehicleIds: batch.vehicleIds,
      mode: batch.mode,
    });
    ElMessage.success(`成功 ${batchResult.value.inserted} 条，冲突/跳过 ${batchResult.value.skipped} 条`);
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '批量指派失败');
  }
}

/* ---------- 复制昨日 ---------- */
async function copyYesterday() {
  const to = date.value;
  const d = new Date(`${to}T00:00:00`);
  d.setDate(d.getDate() - 1);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    await ElMessageBox.confirm(`把 ${from} 的排班复制到 ${to}？（重复将自动跳过）`, '复制昨日', { type: 'info' });
  } catch {
    return;
  }
  try {
    const r: CopyResult = await adminSchedules.copy({ fromDate: from, toDate: to });
    ElMessage.success(`复制：新增 ${r.inserted}，跳过 ${r.skipped}（来源 ${r.sourceCount}）`);
    load();
  } catch (e: any) {
    ElMessage.error(e.message || '复制失败');
  }
}

/* ---------- CSV/Excel 导入 ---------- */
const fileInput = ref<HTMLInputElement | null>(null);
function pickFile() {
  fileInput.value?.click();
}
function downloadTemplate() {
  downloadCsvTemplate(
    '排班导入模板.csv',
    ['日期', '班次', '安全员', '车架号'],
    [['2026-09-30', '白班', '张三', 'LSVAB1234K5678901']]
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
    const r = await adminSchedules.importCsv(f);
    ElMessage.success(`导入：新增 ${r.inserted}，跳过 ${r.skipped}`);
    if (r.errors?.length) {
      ElMessage.warning(`有 ${r.errors.length} 行未导入，如：第 ${r.errors[0].line} 行 ${r.errors[0].reason}`);
    }
    load();
  } catch (err: any) {
    ElMessage.error(err.message || '导入失败');
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

/* ---------- 班次字典 ---------- */
const shiftDlg = ref(false);
const shiftForm = reactive<{ id: number | null; name: string; startTime: string; endTime: string; sort: number }>({
  id: null,
  name: '',
  startTime: '',
  endTime: '',
  sort: 0,
});
function openShift(row?: any) {
  shiftForm.id = row ? row.id : null;
  shiftForm.name = row ? row.name : '';
  shiftForm.startTime = row?.startTime || '';
  shiftForm.endTime = row?.endTime || '';
  shiftForm.sort = row ? row.sort : 0;
  shiftDlg.value = true;
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// 结束时间允许 24:00（与后端 normTime 一致；生产「夜班」end_time=24:00）
const END_TIME_RE = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
async function submitShift() {
  if (!shiftForm.name.trim()) {
    ElMessage.warning('班次名称必填');
    return;
  }
  // CR-08 批2（需求②）：班次开始/结束时间必填
  if (!TIME_RE.test(shiftForm.startTime)) {
    ElMessage.warning('请填写开始时间（HH:mm）');
    return;
  }
  if (!END_TIME_RE.test(shiftForm.endTime)) {
    ElMessage.warning('请填写结束时间（HH:mm 或 24:00）');
    return;
  }
  const body = {
    name: shiftForm.name.trim(),
    startTime: shiftForm.startTime,
    endTime: shiftForm.endTime,
    sort: shiftForm.sort,
  };
  try {
    if (shiftForm.id) await adminShifts.update(shiftForm.id, body);
    else await adminShifts.create(body);
    ElMessage.success('已保存');
    shiftDlg.value = false;
    await loadRefs();
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败');
  }
}
async function removeShift(row: any) {
  try {
    await ElMessageBox.confirm(`停用班次「${row.name}」？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await adminShifts.remove(row.id);
    ElMessage.success('已停用');
    await loadRefs();
  } catch (e: any) {
    ElMessage.error(e.message || '停用失败');
  }
}

const shiftLabel = (id: number | null) => (id ? shifts.value.find((s) => s.id === id)?.name || `#${id}` : '不分班次');

const tab = ref('list');

onMounted(async () => {
  await loadRefs();
  await load();
});
</script>

<template>
  <el-tabs v-model="tab" type="border-card">
    <!-- ============ 排班表 ============ -->
    <el-tab-pane label="排班表" name="list">
      <el-form :inline="true" class="filters">
        <el-form-item label="日期">
          <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="load" />
        </el-form-item>
        <el-form-item label="班次">
          <el-select v-model="shiftId" clearable placeholder="全部" style="width: 150px" @change="load">
            <el-option v-for="s in shifts" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="openCreate">新增指派</el-button>
          <el-button @click="openBatch">批量指派</el-button>
          <el-button @click="copyYesterday">复制昨日</el-button>
          <el-button @click="pickFile">CSV/Excel 导入</el-button>
        <el-button @click="downloadTemplate">下载模板</el-button>
        </el-form-item>
      </el-form>
      <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display: none" @change="onFile" />

      <el-row :gutter="12" class="board">
        <el-col :span="6">
          <el-card shadow="never"><div class="stat"><span class="k">已排</span><b>{{ board?.planned ?? 0 }}</b></div></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><div class="stat"><span class="k">已开始</span><b>{{ board?.started ?? 0 }}</b></div></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><div class="stat"><span class="k">已完成</span><b>{{ board?.done ?? 0 }}</b></div></el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="never"><div class="stat"><span class="k">未完成</span><b class="warn">{{ board?.unfinished ?? 0 }}</b></div></el-card>
        </el-col>
      </el-row>
      <div v-if="board && board.unscheduledVehicles.length" class="unsched">
        未排班车辆（{{ board.unscheduledVehicles.length }}）：
        <el-tag v-for="v in board.unscheduledVehicles" :key="v.id" type="info" class="tag">{{ v.vin }}</el-tag>
      </div>

      <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 420px)">
        <el-table-column label="班次" width="110">
          <template #default="{ row }">{{ shiftLabel(row.shiftId) }}</template>
        </el-table-column>
        <el-table-column prop="vin" label="车架号" min-width="170" />
        <el-table-column prop="operatorName" label="安全员" min-width="100" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'planned' ? 'success' : 'info'">{{ row.status === 'planned' ? '已排' : '已取消' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="计时情况" width="140">
          <template #default="{ row }">
            <el-tag v-if="row.status !== 'planned'" type="info">—</el-tag>
            <el-tag v-else-if="row.stoppedSessions > 0" type="success">已完成 ×{{ row.stoppedSessions }}</el-tag>
            <el-tag v-else-if="row.sessionCount > 0" type="warning">进行中</el-tag>
            <el-tag v-else>未完成</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" />
        <el-table-column prop="createdBy" label="发起人" width="100" />
        <el-table-column label="最后修改人" width="110">
          <template #default="{ row }">{{ row.updatedBy || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.status !== 'planned'" @click="openEdit(row)">改派</el-button>
            <el-button link type="danger" :disabled="row.status !== 'planned'" @click="cancelRow(row)">取消</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-tab-pane>

    <!-- ============ 班次字典 ============ -->
    <el-tab-pane label="班次字典" name="shifts">
      <el-form :inline="true" class="filters">
        <el-form-item>
          <el-button type="primary" @click="openShift()">新增班次</el-button>
        </el-form-item>
      </el-form>
      <el-table :data="shifts" border stripe>
        <el-table-column prop="name" label="名称" min-width="120" />
        <el-table-column prop="startTime" label="开始" width="100" />
        <el-table-column prop="endTime" label="结束" width="100" />
        <el-table-column prop="sort" label="排序" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="openShift(row)">编辑</el-button>
            <el-button link type="danger" :disabled="!row.active" @click="removeShift(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-tab-pane>
  </el-tabs>

  <!-- 新增 / 改派 -->
  <el-dialog v-model="editVisible" :title="editing ? '改派' : '新增指派'" width="460px">
    <el-form label-width="80px">
      <el-form-item label="日期">
        <el-date-picker v-model="form.workDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width: 100%" />
      </el-form-item>
      <el-form-item label="班次">
        <el-select v-model="form.shiftId" clearable placeholder="不分班次" style="width: 100%">
          <el-option v-for="s in shifts" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="安全员">
        <el-select v-model="form.operatorId" filterable placeholder="选择安全员" style="width: 100%">
          <el-option v-for="o in ops" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="车架号">
        <el-select v-model="form.vehicleId" filterable placeholder="选择车架号" style="width: 100%">
          <el-option v-for="v in vehs" :key="v.id" :label="v.vin" :value="v.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.note" placeholder="可选" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="submitEdit">保存</el-button>
    </template>
  </el-dialog>

  <!-- 批量指派 -->
  <el-dialog v-model="batchVisible" title="批量指派" width="560px">
    <el-form label-width="80px">
      <el-form-item label="日期">
        <el-date-picker v-model="batch.workDate" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width: 100%" />
      </el-form-item>
      <el-form-item label="班次">
        <el-select v-model="batch.shiftId" clearable placeholder="不分班次" style="width: 100%">
          <el-option v-for="s in shifts" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="安全员">
        <el-select v-model="batch.operatorIds" multiple filterable placeholder="可多选" style="width: 100%">
          <el-option v-for="o in ops" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="车架号">
        <el-select v-model="batch.vehicleIds" multiple filterable placeholder="可多选" style="width: 100%">
          <el-option v-for="v in vehs" :key="v.id" :label="v.vin" :value="v.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="配对方式">
        <el-radio-group v-model="batch.mode">
          <el-radio label="cross">交叉（笛卡尔积，同车同班次冲突自动跳过）</el-radio>
          <el-radio label="pair">一一配对（按顺序）</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <el-alert v-if="batchResult" type="success" :closable="false">
      成功 {{ batchResult.inserted }} 条，冲突/跳过 {{ batchResult.skipped }} 条。
      <span v-if="batchResult.conflicts.length">首条冲突：{{ batchResult.conflicts[0].reason }}</span>
    </el-alert>
    <template #footer>
      <el-button @click="batchVisible = false">关闭</el-button>
      <el-button type="primary" @click="submitBatch">提交</el-button>
    </template>
  </el-dialog>

  <!-- 班次编辑 -->
  <el-dialog v-model="shiftDlg" :title="shiftForm.id ? '编辑班次' : '新增班次'" width="420px">
    <el-form label-width="80px">
      <el-form-item label="名称"><el-input v-model="shiftForm.name" placeholder="白班 / 夜班" /></el-form-item>
      <el-form-item label="开始" required><el-input v-model="shiftForm.startTime" placeholder="必填，如 08:00" /></el-form-item>
      <el-form-item label="结束" required><el-input v-model="shiftForm.endTime" placeholder="必填，如 20:00 或 24:00" /></el-form-item>
      <el-form-item label="排序"><el-input v-model.number="shiftForm.sort" type="number" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="shiftDlg = false">取消</el-button>
      <el-button type="primary" @click="submitShift">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.filters {
  margin-bottom: 8px;
}
.board {
  margin-bottom: 10px;
}
.stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.stat .k {
  color: #909399;
}
.stat b {
  font-size: 22px;
  color: #303133;
}
.stat b.warn {
  color: #e6a23c;
}
.unsched {
  margin: 6px 0 10px;
  color: #606266;
  font-size: 13px;
}
.unsched .tag {
  margin: 0 4px;
}
</style>
