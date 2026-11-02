<script setup lang="ts">
import { ref, watch } from 'vue';
import { listSessions, getSessionDetail } from '@/api/h5';
import type { Session, SessionDetail } from '@/types';
import { fmtDuration, hms, todayStr } from '@/utils/format';

const props = defineProps<{ operatorId: number }>();

const items = ref<Session[]>([]);
const expanded = ref<Record<number, SessionDetail | null>>({});
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const page = await listSessions({ date: todayStr(), operatorId: props.operatorId, page: 1, pageSize: 100 });
    items.value = page.list;
  } finally {
    loading.value = false;
  }
}

async function toggle(s: Session) {
  if (expanded.value[s.id]) {
    delete expanded.value[s.id];
    return;
  }
  expanded.value[s.id] = await getSessionDetail(s.id);
}

watch(() => props.operatorId, load, { immediate: true });
defineExpose({ load });
</script>

<template>
  <div class="today">
    <div class="today-head">
      <span>今日记录</span>
      <van-icon name="replay" @click="load" />
    </div>

    <van-loading v-if="loading" size="20" style="padding: 16px" />

    <div v-else-if="items.length === 0" class="empty" style="padding: 24px">今日暂无记录</div>

    <template v-else>
      <div v-for="s in items" :key="s.id" class="rec" @click="toggle(s)">
        <div class="rec-line">
          <span class="mono rec-wo">{{ s.workOrderNo }}</span>
          <span class="rec-dur mono">{{ fmtDuration(s.netSeconds) }}</span>
        </div>
        <div class="rec-line sub">
          <span class="mono">{{ s.vin }}</span>
          <span>{{ hms(s.startAt) }}–{{ s.endAt ? hms(s.endAt) : '进行中' }}</span>
        </div>

        <div v-if="expanded[s.id]" class="rec-detail" @click.stop>
          <div class="rec-secs">
            <div v-for="seg in expanded[s.id]!.segments" :key="seg.id" class="seg">
              <span :class="seg.kind === 'work' ? 'kind-work' : 'kind-pause'">{{ seg.kind === 'work' ? '计时段' : '暂停段' }}</span>
              <span class="mono">{{ hms(seg.startedAt) }}–{{ seg.endedAt ? hms(seg.endedAt) : '…' }}</span>
              <span class="mono">{{ fmtDuration(seg.seconds) }}</span>
            </div>
            <div v-if="expanded[s.id]!.remarks.length" class="remarks">
              <div v-for="r in expanded[s.id]!.remarks" :key="r.id" class="remark">
                <span class="mono ts">{{ hms(r.ts) }}</span> {{ r.content }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.today {
  padding: 4px 12px 24px;
}
.today-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 4px 6px;
  font-weight: 700;
  font-size: 15px;
  color: var(--st-text);
}
.rec {
  background: #fff;
  border-radius: 10px;
  padding: 12px 14px;
  margin: 8px 0;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.rec-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.rec-line.sub {
  margin-top: 4px;
  color: var(--st-sub);
  font-size: 12px;
}
.rec-wo {
  font-size: 14px;
  font-weight: 600;
}
.rec-dur {
  font-size: 16px;
  font-weight: 700;
  color: var(--st-primary);
}
.rec-detail {
  margin-top: 10px;
  border-top: 1px dashed #eef0f3;
  padding-top: 8px;
}
.seg {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: #5a6572;
  padding: 3px 0;
}
.kind-work {
  color: var(--st-green);
}
.kind-pause {
  color: var(--st-orange);
}
.remarks {
  margin-top: 6px;
  border-top: 1px dashed #eef0f3;
  padding-top: 6px;
}
.remark {
  font-size: 12px;
  color: #5a6572;
  padding: 3px 0;
  line-height: 1.5;
}
.remark .ts {
  color: var(--st-sub);
  margin-right: 6px;
}
</style>
