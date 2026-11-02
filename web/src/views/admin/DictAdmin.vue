<script setup lang="ts">
import { ref } from 'vue';
import { ElTabs, ElTabPane } from 'element-plus';
import DictTable from '@/components/admin/DictTable.vue';

const tab = ref('organizations');
</script>

<template>
  <div>
    <el-tabs v-model="tab" type="border-card">
      <el-tab-pane label="组织" name="organizations">
        <!-- key 保证切换时重建，避免复用组件实例串数据 -->
        <DictTable v-if="tab === 'organizations'" kind="organizations" />
      </el-tab-pane>
      <el-tab-pane label="供应商" name="suppliers">
        <DictTable v-if="tab === 'suppliers'" kind="suppliers" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
