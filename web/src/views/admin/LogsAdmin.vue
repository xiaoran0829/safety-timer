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
import { adminListLoginLogs } from '@/api';
import type { LoginLog } from '@/types';

/* CR-11：日志查看（登录记录）。仅 admin 可见/可访问（后端 403 兜底）。 */
const vLoading = ElLoading.directive;

const account = ref('');
const source = ref<'' | 'admin' | 'h5'>('');
const result = ref<'' | 'ok' | 'fail'>('');
const range = ref<[string, string] | null>(null);

const list = ref<LoginLog[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  engineer: '工程师',
  fleet_admin: '车队管理员',
  operator: '安全员',
};

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await adminListLoginLogs({
      account: account.value.trim() || undefined,
      source: source.value || undefined,
      result: result.value || undefined,
      from: range.value?.[0] || undefined,
      to: range.value?.[1] || undefined,
      page: p,
      pageSize: pageSize.value,
    });
    list.value = r.items;
    total.value = r.total;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function reset() {
  account.value = '';
  source.value = '';
  result.value = '';
  range.value = null;
  load(1);
}

onMounted(() => load(1));
</script>

<template>
  <div class="logs-admin">
    <el-form inline @submit.prevent>
      <el-form-item label="账号">
        <el-input v-model="account" placeholder="账号/工号（模糊）" clearable style="width: 180px" @keyup.enter="load(1)" />
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="source" placeholder="全部" clearable style="width: 140px">
          <el-option label="后台" value="admin" />
          <el-option label="安全员 H5" value="h5" />
        </el-select>
      </el-form-item>
      <el-form-item label="结果">
        <el-select v-model="result" placeholder="全部" clearable style="width: 120px">
          <el-option label="成功" value="ok" />
          <el-option label="失败" value="fail" />
        </el-select>
      </el-form-item>
      <el-form-item label="时间">
        <el-date-picker
          v-model="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width: 260px"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load(1)">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="list" border stripe size="small" style="width: 100%">
      <el-table-column prop="createdAt" label="时间" width="170" />
      <el-table-column prop="account" label="账号" width="140">
        <template #default="{ row }">{{ row.account || '—' }}</template>
      </el-table-column>
      <el-table-column prop="name" label="姓名" width="120">
        <template #default="{ row }">{{ row.name || '—' }}</template>
      </el-table-column>
      <el-table-column label="角色" width="110">
        <template #default="{ row }">{{ row.role ? ROLE_LABEL[row.role] || row.role : '—' }}</template>
      </el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="row.source === 'h5' ? 'success' : 'primary'" size="small">
            {{ row.source === 'h5' ? '安全员 H5' : '后台' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag :type="row.result === 'ok' ? 'success' : 'danger'" size="small">
            {{ row.result === 'ok' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reason" label="失败原因" width="160">
        <template #default="{ row }">{{ row.reason || '—' }}</template>
      </el-table-column>
      <el-table-column prop="ip" label="IP" width="150">
        <template #default="{ row }">{{ row.ip || '—' }}</template>
      </el-table-column>
      <el-table-column prop="ua" label="UA" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ row.ua || '—' }}</template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        background
        layout="total, sizes, prev, pager, next"
        :total="total"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[20, 50, 100, 200]"
        @current-change="load"
        @size-change="
          (s: number) => {
            pageSize = s;
            load(1);
          }
        "
      />
    </div>
  </div>
</template>

<style scoped>
.logs-admin {
  padding: 4px;
}
.pager {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
</style>
