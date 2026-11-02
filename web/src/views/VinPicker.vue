<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { getMyVehicles, h5Logout } from '@/api/h5';
import { OP_TOKEN_KEY } from '@/api/h5Client';
import { useAppStore } from '@/stores/app';
import VinCard from '@/components/VinCard.vue';
import type { Vehicle, ScheduledVehicle } from '@/types';

defineOptions({ name: 'VinPicker' });

const router = useRouter();
const store = useAppStore();

const q = ref('');
const list = ref<Vehicle[]>([]);
const loading = ref(false);

const selectedVin = computed(() => store.vehicle?.vin);

function toVehicle(s: ScheduledVehicle): Vehicle {
  return {
    id: s.vehicleId,
    vin: s.vin,
    station: null,
    active: 1,
    occupied: s.occupied,
    scheduled: true,
    shiftName: s.shiftName,
    shiftStart: s.shiftStart,
    shiftEnd: s.shiftEnd,
    done: s.done,
    started: s.started,
  };
}

/* CR-08 批2（需求⑤）：H5 只列「今天排给我的车」（后端硬拦，已取消「显示全部车辆」越权口） */
async function load() {
  loading.value = true;
  try {
    const kw = q.value.trim();
    const mine = await getMyVehicles();
    list.value = mine.filter((m) => !kw || m.vin.includes(kw)).map(toVehicle);
  } catch (e: any) {
    showToast(e?.message || '加载失败');
    list.value = [];
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

async function pick(v: Vehicle) {
  if (v.occupied) {
    // Q5：一车一人为软提示，允许继续（showConfirmDialog 确认 resolve / 取消 reject）
    try {
      await showConfirmDialog({
        title: '该车架号使用中',
        message: `${v.vin} 正在被「${v.occupied.operatorName}」计时，是否仍要继续？`,
        confirmButtonText: '仍要继续',
        cancelButtonText: '换一辆',
      });
    } catch {
      return;
    }
  }
  store.setVehicle({ ...v, unscheduled: false });
  router.push('/work');
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="topbar">
      <div class="who">当前安全员：{{ store.operatorName }} <van-icon name="arrow-down" /></div>
      <van-button size="small" plain type="primary" @click="logout">退出登录</van-button>
    </div>

    <div class="page-title" style="padding-top: 14px">请选择车架号</div>

    <div class="search-wrap">
      <van-search v-model="q" placeholder="搜索车架号 / 工位" shape="round" @update:model-value="load" />
    </div>

    <div class="list">
      <van-loading v-if="loading" size="20" style="padding: 20px" />
      <template v-else>
        <VinCard
          v-for="v in list"
          :key="v.id"
          :vehicle="v"
          :selected="v.vin === selectedVin"
          @select="pick"
        />
        <div v-if="list.length === 0" class="empty">今日暂无排给您的车架号，请联系管理员排班</div>
      </template>
    </div>
  </div>
</template>
