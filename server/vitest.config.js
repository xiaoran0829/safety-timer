// CR-04：单测使用固定密钥，保证 hermetic —— 不读写 ~/.safety-timer，不依赖运行环境。
// 生产运行不使用本配置（生产由 env AUTH_SECRET / AUTH_SECRET_FILE / 默认文件中解析）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      AUTH_SECRET: 'cr04-vitest-fixed-secret-not-for-production',
    },
  },
});
