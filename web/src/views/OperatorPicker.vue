<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { getOperators } from '@/api';
import { useAppStore } from '@/stores/app';
import OperatorCard from '@/components/OperatorCard.vue';
import type { Operator } from '@/types';

defineOptions({ name: 'OperatorPicker' });

const router = useRouter();
const store = useAppStore();

const q = ref('');
const list = ref<Operator[]>([]);
const loading = ref(false);

const selectedId = computed(() => store.operator?.id);

async function load() {
  loading.value = true;
  try {
    list.value = await getOperators({ active: 1, q: q.value.trim() || undefined });
  } finally {
    loading.value = false;
  }
}

function pick(o: Operator) {
  store.setOperator(o);
  router.push('/vin');
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-title">请选择您的姓名</div>
    <div class="page-sub">选择后开始选择车架号并计时</div>

    <div class="search-wrap">
      <van-search v-model="q" placeholder="搜索姓名 / 标签" shape="round" @update:model-value="load" />
    </div>

    <div class="list">
      <van-loading v-if="loading" size="20" style="padding: 20px" />
      <template v-else>
        <OperatorCard
          v-for="o in list"
          :key="o.id"
          :operator="o"
          :selected="o.id === selectedId"
          @select="pick"
        />
        <div v-if="list.length === 0" class="empty">未找到安全员，请联系管理员在后台维护名单</div>
      </template>
    </div>

    <div class="footer-link">
      <router-link to="/records">查看今日/历史记录 →</router-link>
    </div>
  </div>
</template>
