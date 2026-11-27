import { defineConfig } from "vitest/config"
import base from "./vitest.config"

/** 性能用例单独一份配置：`pnpm test:perf`。默认的 `pnpm test` 不含它们（它们不匹配 vitest.config.ts 的 *.test.ts）。 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/perf/**/*.perf.ts"],
    // 文件之间也串行，免得互相抢 CPU 把时间测歪
    fileParallelism: false,
  },
})
