<script setup lang="ts">
// CR-08（需求⑥）：详细工时（含备注）——查看 + 导出（排班备注 + 计时备注）
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
import { adminListSessionDetail, adminDetailExportUrl, adminListOperators } from '@/api';
import { TOKEN_KEY } from '@/api/client';
import type { Operator, SessionDetailRow } from '@/types';
import { billableHours, fmtDuration, toMinute } from '@/utils/format';
import { downloadWithAuth } from '@/utils/download';

const vLoading = ElLoading.directive;

const dateRange = ref<string[] | null>(null);
const operatorId = ref<number | undefined>(undefined);
const vin = ref('');

const list = ref<SessionDetailRow[]>([]);
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

// 状态中文化（与「详细工时」导出一致）：进行中/已暂停/已结束
const STATUS_TEXT: Record<string, string> = { running: '进行中', paused: '已暂停', stopped: '已结束' };
function statusText(s: string) {
  return STATUS_TEXT[s] || s;
}
function statusType(s: string) {
  return s === 'stopped' ? 'info' : s === 'paused' ? 'warning' : 'success';
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await adminListSessionDetail({
      from: dateRange.value?.[0] || undefined,
      to: dateRange.value?.[1] || undefined,
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

// CR-09（需求⑧）：备注归段 = 段 startedAt ≤ ts 中最末一段（同秒冲突归后段；末段之后归末段）
function ownerSeg(row: SessionDetailRow, ts: string) {
  const segs = row.segments || [];
  let pick: SessionDetailRow['segments'][number] | null = segs[0] || null;
  for (const g of segs) if (g.startedAt <= ts) pick = g;
  return pick;
}
function notesFor(row: SessionDetailRow, seg: SessionDetailRow['segments'][number]) {
  return (row.remarks || []).filter((r) => ownerSeg(row, r.ts) === seg);
}

// CR-09（需求⑪）：暂停明细（序号 / 暂停开始 / 暂停结束 / 该段时长）
function pauseRows(row: SessionDetailRow) {
  return (row.segments || [])
    .filter((s) => s.kind === 'pause')
    .map((s, i) => ({
      idx: i + 1,
      start: toMinute(s.startedAt),
      end: s.endedAt ? toMinute(s.endedAt) : '进行中',
      dur: fmtDuration(s.seconds),
    }));
}

function reset() {
  dateRange.value = null;
  operatorId.value = undefined;
  vin.value = '';
  load(1);
}

async function doExport(format: 'xlsx' | 'csv') {
  exporting.value = format;
  const token = localStorage.getItem(TOKEN_KEY);
  const from = dateRange.value?.[0];
  const to = dateRange.value?.[1];
  const tag = from ? `${from}${to && to !== from ? `_${to}` : ''}` : '全部';
  const name = `安全员计时_${tag}_详细工时.${format}`;
  const params = {
    from: from || undefined,
    to: to || undefined,
    operatorId: operatorId.value,
    vin: vin.value.trim() || undefined,
    format,
  } as const;
  try {
    await downloadWithAuth(adminDetailExportUrl(params), name, token);
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
      <el-form-item label="日期范围">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="→"
          unlink-panels
          clearable
        />
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
      <!-- CR-09（需求⑧）：行展开 = 时间轴（几点–几点 + 该段备注） -->
      <el-table-column type="expand" width="46">
        <template #default="{ row }">
          <div class="timeline">
            <div v-for="(seg, i) in row.segments || []" :key="i" class="tl-item">
              <span class="tl-dot" :class="seg.kind"></span>
              <div class="tl-body">
                <div class="tl-head">
                  <el-tag size="small" :type="seg.kind === 'pause' ? 'warning' : 'success'" effect="plain">
                    {{ seg.kind === 'pause' ? '暂停' : '计时' }}
                  </el-tag>
                  <span class="tl-time">
                    {{ toMinute(seg.startedAt) }} –
                    <template v-if="seg.endedAt">{{ toMinute(seg.endedAt) }}</template>
                    <span v-else class="tl-running">进行中</span>
                  </span>
                </div>
                <div class="tl-notes">
                  <template v-if="notesFor(row, seg).length">
                    <div v-for="(n, j) in notesFor(row, seg)" :key="j" class="tl-note">{{ n.content }}</div>
                  </template>
                  <span v-else class="dim">未填</span>
                </div>
              </div>
            </div>
            <div v-if="!(row.segments || []).length" class="dim">无时间段</div>

            <!-- CR-09（需求⑪）：暂停明细子表（序号/暂停开始/暂停结束/该段时长） -->
            <div v-if="pauseRows(row).length" class="pause-detail">
              <div class="pd-title">暂停明细（共 {{ pauseRows(row).length }} 次）</div>
              <table class="pd-table">
                <thead>
                  <tr><th>#</th><th>暂停开始</th><th>暂停结束</th><th>该段时长</th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in pauseRows(row)" :key="p.idx">
                    <td>{{ p.idx }}</td>
                    <td class="mono">{{ p.start }}</td>
                    <td class="mono">{{ p.end }}</td>
                    <td class="mono">{{ p.dur }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="dim">无暂停</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="workOrderNo" label="工单号" min-width="160" />
      <el-table-column prop="vin" label="车架号" min-width="170" />
      <el-table-column prop="operatorName" label="安全员" min-width="100" />
      <!-- 主人令（2026-10-09）：行驶里程 = 收车里程 − 出车里程（缺任一显示 —） -->
      <el-table-column label="行驶里程（km）" width="130" align="right">
        <template #default="{ row }">
          <span class="mono">{{
            row.odometerOut != null && row.odometerIn != null ? row.odometerIn - row.odometerOut : '—'
          }}</span>
        </template>
      </el-table-column>
      <el-table-column label="试验开始时间" min-width="150">
        <template #default="{ row }">{{ toMinute(row.startAt) }}</template>
      </el-table-column>
      <el-table-column label="试验实际时长" width="130">
        <template #default="{ row }"><b class="mono">{{ fmtDuration(row.netSeconds) }}</b></template>
      </el-table-column>
      <el-table-column label="有效计费时长（h）" width="140" align="right">
        <template #default="{ row }"><span class="mono">{{ billableHours(row.netSeconds) }}</span></template>
      </el-table-column>
      <el-table-column label="排班备注" min-width="160">
        <template #default="{ row }">
          <span v-if="row.scheduleNote">{{ row.scheduleNote }}</span>
          <span v-else class="dim">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
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
.dim {
  color: #c0c4cc;
}

/* CR-09（需求⑧）：时间轴样式 */
.timeline {
  padding: 6px 4px 6px 12px;
}
/* CR-09（需求⑪）：暂停明细子表 */
.pause-detail {
  margin: 8px 0 2px 20px;
}
.pd-title {
  font-size: 12px;
  color: #909399;
  margin-bottom: 4px;
}
.pd-table {
  border-collapse: collapse;
  font-size: 12px;
}
.pd-table th,
.pd-table td {
  border: 1px solid #ebeef5;
  padding: 2px 10px;
  text-align: center;
}
.pd-table th {
  background: #fafafa;
  color: #606266;
  font-weight: 500;
}
.tl-item {
  position: relative;
  padding: 0 0 12px 20px;
  border-left: 2px solid #e4e7ed;
}
.tl-item:last-child {
  border-left-color: transparent;
  padding-bottom: 0;
}
.tl-dot {
  position: absolute;
  left: -7px;
  top: 4px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #67c23a;
}
.tl-dot.pause {
  border-color: #e6a23c;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tl-time {
  font-family: Menlo, Consolas, monospace;
  font-size: 13px;
  color: #303133;
}
.tl-running {
  color: #67c23a;
  font-weight: 600;
}
.tl-notes {
  margin-top: 4px;
  font-size: 13px;
  color: #606266;
}
.tl-note {
  line-height: 1.6;
}
</style>
