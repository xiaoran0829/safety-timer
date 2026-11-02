<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { useAppStore } from '@/stores/app';
import { getActiveSession, startSession, pauseSession, resumeSession, stopSession, addRemark, h5Logout } from '@/api/h5';
import { OP_TOKEN_KEY } from '@/api/h5Client';
import type { Session } from '@/types';
import { fmtDuration, uuid, nowDateTime } from '@/utils/format';
import TimerDisplay from '@/components/TimerDisplay.vue';
import ControlBar from '@/components/ControlBar.vue';
import RemarkDialog from '@/components/RemarkDialog.vue';
import OdometerDialog from '@/components/OdometerDialog.vue';
import ConflictAlert from '@/components/ConflictAlert.vue';
import TodayRecords from '@/components/TodayRecords.vue';

const router = useRouter();
const store = useAppStore();

const session = ref<Session | null>(null);
const loading = ref(true);
const busy = ref(false);
const showRemark = ref(false);
// 2026-10-08 需求①：出车/收车里程弹窗
const showOdoOut = ref(false);
const showOdoIn = ref(false);
// CR-09（需求⑩）：暂停前强制备注
const showPauseRemark = ref(false);
const conflict = ref({ show: false, message: '' });
const todayRef = ref<InstanceType<typeof TodayRecords>>();
const displaySeconds = ref(0);

let baseNet = 0;
let baseAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const status = computed<'idle' | 'running' | 'paused' | 'stopped'>(() => {
  if (!session.value) return 'idle';
  return session.value.status;
});

const vin = computed(() => session.value?.vin || store.vehicle?.vin || '');
const workOrderNo = computed(() => session.value?.workOrderNo || '');
// CR-03：发起人由后台按登录账号自动取值，H5 仅只读展示会话返回值
const sessionInitiatorName = computed(() => session.value?.initiatorName || '');

function tick() {
  // CR-09（需求⑭）：备注弹窗期间（点按—提交）秒表冻结在「点击时刻」，不再跳动
  if (pausePending.value) {
    displaySeconds.value = freezeSeconds.value;
    return;
  }
  if (session.value?.status === 'running') {
    displaySeconds.value = baseNet + Math.floor((Date.now() - baseAt) / 1000);
  } else {
    displaySeconds.value = baseNet;
  }
}

function setSession(s: Session | null) {
  session.value = s;
  baseNet = s ? s.netSeconds : 0;
  baseAt = Date.now();
  tick();
}

async function load() {
  loading.value = true;
  try {
    setSession((await getActiveSession(store.operatorId!))?.session ?? null);
  } catch (e: any) {
    showToast(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function logout() {
  try {
    await showConfirmDialog({ title: '提示', message: '确认退出登录？' });
  } catch {
    return;
  }
  try {
    await h5Logout();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(OP_TOKEN_KEY);
  store.clearOperator();
  router.replace('/login');
}

async function start() {
  if (busy.value) return;
  if (!store.vehicle) {
    router.push('/vin');
    return;
  }
  // 2026-10-08 需求①：开始前必须填写出车里程
  showOdoOut.value = true;
}

async function doStart(odometerOut: number) {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await startSession(store.operatorId!, store.vehicle!.id, odometerOut, uuid());
    showOdoOut.value = false;
    setSession(r.session);
    todayRef.value?.load();
  } catch (e: any) {
    if (e.code === 'OPERATOR_BUSY') {
      const act = e.data?.activeSession;
      conflict.value = {
        show: true,
        message: `您（${store.operatorName}）正在对 ${act?.vin || '某车架号'} 计时中，请先停止当前任务。`,
      };
    } else if (e.code === 'NOT_SCHEDULED') {
      // CR-08 批2（需求⑤）：后端硬拦非排班车（已无越权放行口），直接提示
      showToast(e.message || '该车未排给您');
    } else if (e.code === 'BEFORE_SHIFT_START') {
      // CR-08 批2（需求②）：未到班次开始时间
      showToast(e.message || '未到班次开始时间');
    } else if (e.code === 'DAY_CLOSED') {
      // CR-08 批2（需求⑦）：该车今日任务已结束
      showToast(e.message || '该车今日任务已结束');
    } else {
      showToast(e.message || '开始失败');
    }
  } finally {
    busy.value = false;
  }
}

// CR-09（需求⑩）：暂停必须填备注（前端弹窗拦截，不可空）
// CR-09（需求⑫）：点按「暂停」瞬间记下 at；真正停表以该时刻为准（备注填写耗时不计入工作段）
// CR-09（需求⑭）：点按瞬间冻结展示秒表；取消/关闭 → 解冻（实际仍在工作，秒表自然跳回）
const pauseClickAt = ref('');
const pausePending = ref(false);
const freezeSeconds = ref(0);
function openPause() {
  pauseClickAt.value = nowDateTime();
  // 冻结值＝点击时刻的展示值（与 at 同源，仅用于显示）
  freezeSeconds.value =
    session.value?.status === 'running'
      ? baseNet + Math.floor((Date.now() - baseAt) / 1000)
      : displaySeconds.value;
  pausePending.value = true;
  displaySeconds.value = freezeSeconds.value;
  showPauseRemark.value = true;
}
// 弹窗关闭（取消/点遮罩/提交后）→ 解冻；提交成功时 setSession 已以服务端值为准
watch(showPauseRemark, (v) => {
  if (!v) pausePending.value = false;
});

const END_WORD_RE = /(结束|完成|完工|收工|下班|收车|停止|停了|终止|end|stop|finish|done)/i;

async function doPause(content: string) {
  if (busy.value || !session.value) return;
  // CR-13：备注含「结束」类字样 → 提示 + 二次确认（暂停≠结束）
  if (END_WORD_RE.test(content || '')) {
    try {
      await showConfirmDialog({
        title: '确认按「暂停」提交？',
        message:
          '您填写的备注含「结束」类字样。\n\n「暂停」只是暂停计时，并不会结束工单；若确实要结束，请用「停止计时」。\n\n仍要按「暂停」提交吗？',
        confirmButtonText: '仍按暂停',
        cancelButtonText: '再想想',
      });
    } catch {
      return; // 取消 → 保留弹窗与已填内容
    }
  }
  busy.value = true;
  try {
    setSession((await pauseSession(session.value.id, store.operatorId!, content, pauseClickAt.value)).session);
    showPauseRemark.value = false;
  } catch (e: any) {
    showToast(e.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

async function resume() {
  if (busy.value || !session.value) return;
  busy.value = true;
  try {
    setSession((await resumeSession(session.value.id, store.operatorId!)).session);
  } catch (e: any) {
    showToast(e.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

async function stop() {
  if (busy.value || !session.value) return;
  // 2026-10-08 需求①：停止前必须填写收车里程
  showOdoIn.value = true;
}

async function doStop(odometerIn: number) {
  if (busy.value || !session.value) return;
  const s = session.value;
  try {
    await showConfirmDialog({
      title: '确认停止计时？',
      message: `本次试验实际时长：${fmtDuration(displaySeconds.value)}\n收车里程：${odometerIn} km`,
      confirmButtonText: '确认停止',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  busy.value = true;
  try {
    await stopSession(s.id, store.operatorId!, odometerIn, uuid());
    showOdoIn.value = false;
    setSession(null);
    todayRef.value?.load();
    showToast('已停止');
  } catch (e: any) {
    showToast(e.message || '停止失败');
  } finally {
    busy.value = false;
  }
}

async function saveRemark(content: string) {
  if (!session.value) return;
  try {
    await addRemark(session.value.id, store.operatorId!, content);
    showRemark.value = false;
    todayRef.value?.load();
    showToast('备注已保存');
  } catch (e: any) {
    showToast(e.message || '备注失败');
  }
}

function goCurrent() {
  conflict.value.show = false;
  load();
}

onMounted(() => {
  load();
  timer = setInterval(tick, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <div class="topbar">
      <div class="who">当前安全员：{{ store.operatorName }}</div>
      <div>
        <van-button size="small" plain type="primary" @click="router.push('/vin')">换车</van-button>
        <van-button size="small" plain @click="logout" style="margin-left: 8px">退出登录</van-button>
      </div>
    </div>

    <van-loading v-if="loading" size="22" style="display: block; padding: 40px; text-align: center" />

    <template v-else>
      <div class="infobar">
        <div class="info-row">
          <span class="k">车架号</span>
          <span class="v mono">{{ vin || '未选择' }}</span>
        </div>
        <div class="info-row">
          <span class="k">工单号</span>
          <span class="v mono">{{ workOrderNo || '系统生成' }}</span>
        </div>
        <div class="info-row">
          <span class="k">发起人</span>
          <span class="v">{{ sessionInitiatorName || '—' }}</span>
        </div>
      </div>

      <TimerDisplay :seconds="displaySeconds" :status="status" />

      <ControlBar
        :status="status"
        @start="start"
        @pause="openPause()"
        @resume="resume"
        @stop="stop"
        @remark="showRemark = true"
      />

      <TodayRecords v-if="store.operatorId" ref="todayRef" :operator-id="store.operatorId" />
    </template>

    <RemarkDialog v-model="showRemark" @save="saveRemark" />
    <OdometerDialog v-model="showOdoOut" title="出车里程（必填）" label="出车里程数（km）" @save="doStart" />
    <OdometerDialog v-model="showOdoIn" title="收车里程（必填）" label="收车里程数（km）" @save="doStop" />
    <RemarkDialog
      v-model="showPauseRemark"
      title="暂停备注（必填）"
      placeholder="请填写本次暂停原因（必填）"
      @save="doPause"
    />
    <ConflictAlert v-model="conflict.show" :message="conflict.message" @go-current="goCurrent" />
  </div>
</template>

<style scoped>
.infobar {
  background: #fff;
  margin: 12px;
  border-radius: 12px;
  padding: 10px 14px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.info-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 14px;
}
.info-row .k {
  color: var(--st-sub);
}
.info-row .v {
  font-weight: 600;
}
</style>
