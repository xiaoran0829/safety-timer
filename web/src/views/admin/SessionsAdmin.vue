<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  ElPagination,
  ElLoading,
  ElMessage,
} from 'element-plus';
import { adminListSessions, adminExportUrl, adminListOperators, exportUrl } from '@/api';
import { TOKEN_KEY } from '@/api/client';
import type { Operator, Session } from '@/types';
import { billableHours, fmtDuration, toMinute } from '@/utils/format';
import { downloadWithAuth } from '@/utils/download';

const vLoading = ElLoading.directive;

const date = ref('');
const operatorId = ref<number | undefined>(undefined);
const vin = ref('');

const list = ref<Session[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const exporting = ref<'xlsx' | 'csv' | ''>('');

const ops = ref<Operator[]>([]);

async function loadOps() {
  try {
    ops.value = await adminListOperators({ active: 1 });
  } catch {
    /* 忽略 */
  }
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await adminListSessions({
      date: date.value || undefined,
      operatorId: operatorId.value,
      vin: vin.value.trim() || undefined,
      page: p,
      pageSize: pageSize.value,
    });
    list.value = r.list;
    total.value = r.total;
  } catch (e: any) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function reset() {
  date.value = '';
  operatorId.value = undefined;
  vin.value = '';
  load(1);
}

async function doExport(format: 'xlsx' | 'csv') {
  exporting.value = format;
  const token = localStorage.getItem(TOKEN_KEY);
  const name = `安全员计时_${date.value || 'export'}.${format}`;
  const params = {
    date: date.value || undefined,
    operatorId: operatorId.value,
    vin: vin.value.trim() || undefined,
    format,
  } as const;
  try {
    try {
      await downloadWithAuth(adminExportUrl(params), name, token);
    } catch (e: any) {
      // §11.4 的 /api/admin/export 尚未就绪时，回退到同口径的公开 /api/export
      if (e?.status === 404) await downloadWithAuth(exportUrl(params), name);
      else throw e;
    }
    ElMessage.success('导出已开始');
  } catch (e: any) {
    ElMessage.error(e.message || '导出失败');
  } finally {
    exporting.value = '';
  }
}

onMounted(() => {
  load(1);
  loadOps();
});
</script>

<template>
  <div>
    <el-form :inline="true" class="filters">
      <el-form-item label="日期">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" clearable />
      </el-form-item>
      <el-form-item label="安全员">
        <el-select v-model="operatorId" clearable filterable placeholder="全部" style="width: 160px">
          <el-option v-for="o in ops" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="车架号">
        <el-input v-model="vin" placeholder="模糊匹配" clearable style="width: 180px" @keyup.enter="load(1)" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
      <el-form-item class="export-cell">
        <el-button type="success" :loading="exporting === 'xlsx'" @click="doExport('xlsx')">导出 Excel</el-button>
        <el-button :loading="exporting === 'csv'" @click="doExport('csv')">导出 CSV</el-button>
      </el-form-item>
    </el-form>

    <el-table :data="list" v-loading="loading" border stripe height="calc(100vh - 260px)">
      <el-table-column prop="workOrderNo" label="工单号" min-width="160" />
      <el-table-column prop="vin" label="车架号" min-width="170" />
      <el-table-column prop="orgName" label="组织" min-width="110" />
      <el-table-column prop="supplierName" label="供应商" min-width="110" />
      <el-table-column prop="initiatorName" label="发起人" min-width="100" />
      <el-table-column prop="operatorName" label="安全员" min-width="100" />
      <el-table-column label="试验开始时间" min-width="150">
        <template #default="{ row }">{{ toMinute(row.startAt) }}</template>
      </el-table-column>
      <el-table-column label="试验实际时长" width="130">
        <template #default="{ row }"><b class="mono">{{ fmtDuration(row.netSeconds) }}</b></template>
      </el-table-column>
      <el-table-column label="有效计费时长（h）" width="140" align="right">
        <template #default="{ row }"><span class="mono">{{ billableHours(row.netSeconds) }}</span></template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'stopped' ? 'info' : 'success'">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @current-change="load"
        @size-change="() => load(1)"
      />
    </div>
  </div>
</template>

<style scoped>
.filters {
  margin-bottom: 8px;
  align-items: flex-start;
}
.filters :deep(.el-form-item) {
  margin-bottom: 10px;
}
.export-cell {
  margin-left: auto;
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.mono {
  font-family: Menlo, Consolas, monospace;
}
</style>
