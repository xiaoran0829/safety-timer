<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { getOperators, listSessions, exportUrl } from '@/api/h5';
import type { Operator, Session } from '@/types';
import { fmtDuration, hms, toMinute, todayStr } from '@/utils/format';

const router = useRouter();

const date = ref(todayStr());
const vin = ref('');
const operatorId = ref<number | undefined>(undefined);
const operatorName = ref('');

const list = ref<Session[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);

const ops = ref<Operator[]>([]);
const showOpPicker = ref(false);
const opQ = ref('');

async function loadOps() {
  ops.value = await getOperators({ active: 1, q: opQ.value.trim() || undefined });
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await listSessions({
      date: date.value || undefined,
      vin: vin.value.trim() || undefined,
      operatorId: operatorId.value,
      page: p,
      pageSize,
    });
    list.value = r.list;
    total.value = r.total;
  } catch (e: any) {
    showToast(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function pickOp(o: Operator) {
  operatorId.value = o.id;
  operatorName.value = o.name;
  showOpPicker.value = false;
  load(1);
}

function clearOp() {
  operatorId.value = undefined;
  operatorName.value = '';
  load(1);
}

function doExport(format: 'xlsx' | 'csv') {
  const url = exportUrl({
    date: date.value || undefined,
    vin: vin.value.trim() || undefined,
    operatorId: operatorId.value,
    format,
  });
  window.location.href = url;
}

onMounted(() => {
  load(1);
  loadOps();
});
</script>

<template>
  <div class="page">
    <div class="topbar">
      <div class="who">记录查询</div>
      <van-button size="small" plain @click="router.back()">返回</van-button>
    </div>

    <div style="padding: 12px">
      <van-cell-group inset>
        <van-field v-model="date" type="date" label="日期" placeholder="选择日期" @change="load(1)" />
        <van-field
          :model-value="operatorName"
          label="安全员"
          placeholder="全部"
          readonly
          is-link
          @click="showOpPicker = true"
        />
        <van-field v-model="vin" label="车架号" placeholder="模糊匹配" @keyup.enter="load(1)" @blur="load(1)" />
      </van-cell-group>

      <div style="display: flex; gap: 10px; margin-top: 12px">
        <van-button type="primary" block @click="load(1)">查询</van-button>
        <van-button plain block @click="clearOp">重置安全员</van-button>
      </div>

      <div style="display: flex; gap: 10px; margin-top: 10px">
        <van-button type="success" block icon="down" @click="doExport('xlsx')">导出 Excel</van-button>
        <van-button plain type="success" block icon="down" @click="doExport('csv')">导出 CSV</van-button>
      </div>

      <div class="rec-meta">共 {{ total }} 条</div>

      <van-loading v-if="loading" size="20" style="padding: 20px; text-align: center" />
      <template v-else>
        <div v-for="s in list" :key="s.id" class="rec-card">
          <div class="rec-line">
            <span class="mono rec-wo">{{ s.workOrderNo }}</span>
            <span class="mono rec-dur">{{ fmtDuration(s.netSeconds) }}</span>
          </div>
          <div class="rec-line sub">
            <span class="mono">{{ s.vin }}</span>
            <span>{{ s.operatorName }}</span>
          </div>
          <div class="rec-line sub">
            <span>{{ toMinute(s.startAt) }} → {{ s.endAt ? hms(s.endAt) : '进行中' }}</span>
            <van-tag :type="s.status === 'stopped' ? 'default' : 'success'">{{ s.status }}</van-tag>
          </div>
        </div>
        <div v-if="list.length === 0" class="empty">无匹配记录</div>

        <div v-if="total > pageSize" style="display: flex; gap: 10px; margin-top: 12px">
          <van-button size="small" :disabled="page <= 1" @click="load(page - 1)">上一页</van-button>
          <div style="flex: 1; text-align: center; line-height: 32px; color: var(--st-sub)">{{ page }} / {{ Math.ceil(total / pageSize) }}</div>
          <van-button size="small" :disabled="page >= Math.ceil(total / pageSize)" @click="load(page + 1)">下一页</van-button>
        </div>
      </template>
    </div>

    <van-popup v-model:show="showOpPicker" position="bottom" round style="max-height: 70%">
      <div style="padding: 12px">
        <van-search v-model="opQ" placeholder="搜索安全员" @update:model-value="loadOps" />
        <div style="max-height: 45vh; overflow: auto">
          <van-cell v-for="o in ops" :key="o.id" :title="o.name" :label="o.label || ''" is-link @click="pickOp(o)" />
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.rec-meta {
  color: var(--st-sub);
  font-size: 12px;
  padding: 14px 4px 6px;
}
.rec-card {
  background: #fff;
  border-radius: 10px;
  padding: 12px 14px;
  margin: 8px 0;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.rec-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.rec-line.sub {
  margin-top: 4px;
  color: var(--st-sub);
  font-size: 12px;
}
.rec-wo {
  font-weight: 600;
  font-size: 14px;
}
.rec-dur {
  font-weight: 700;
  color: var(--st-primary);
}
</style>
