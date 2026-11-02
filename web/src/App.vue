<script setup lang="ts">
// 根组件：仅承载路由视图
</script>

<template>
  <router-view v-slot="{ Component }">
    <keep-alive :include="['OperatorPicker', 'VinPicker']">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>
