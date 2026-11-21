import process from "node:process"
import { join } from "node:path"
import viteNitro from "vite-plugin-with-nitro"
import { RollopGlob } from "./tools/rollup-glob"
import { projectDir } from "./shared/dir"

const nitroOption: Parameters<typeof viteNitro>[0] = {
  experimental: {
    database: true,
    tasks: true,
  },
  // 采集守护进程的心跳（#2184）：每分钟一次，由 collect:tick 按各源 interval 决定抓哪些。
  // node-server / bun 预设由进程内的 croner 触发；Cloudflare Pages 不支持 cron 触发器，
  // 那里需要另配 Worker 或外部定时调用 collect:tick。
  scheduledTasks: {
    "* * * * *": ["collect:tick"],
  },
  rollupConfig: {
    plugins: [RollopGlob()],
  },
  sourceMap: false,
  database: {
    default: {
      connector: "better-sqlite3",
    },
  },
  devDatabase: {
    default: {
      connector: "better-sqlite3",
    },
  },
  imports: {
    dirs: ["server/utils", "shared"],
  },
  preset: "node-server",
  alias: {
    "@shared": join(projectDir, "shared"),
    "#": join(projectDir, "server"),
  },
}

if (process.env.VERCEL) {
  nitroOption.preset = "vercel-edge"
  // You can use other online database, do it yourself. For more info: https://db0.unjs.io/connectors
  nitroOption.database = undefined
  // vercel-edge 没有进程内调度，也没有库可写，采集不适用
  nitroOption.scheduledTasks = {}
  // nitroOption.vercel = {
  //   config: {
  //     cache: []
  //   },
  // }
} else if (process.env.CF_PAGES) {
  nitroOption.preset = "cloudflare-pages"
  nitroOption.unenv = {
    alias: {
      "safer-buffer": "node:buffer",
    },
  }
  nitroOption.database = {
    default: {
      connector: "cloudflare-d1",
      options: {
        bindingName: "NEWSNOW_DB",
      },
    },
  }
} else if (process.env.BUN) {
  nitroOption.preset = "bun"
  nitroOption.database = {
    default: {
      connector: "bun-sqlite",
    },
  }
}

export default function () {
  return viteNitro(nitroOption)
}
