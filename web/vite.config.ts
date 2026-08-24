/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { TDesignResolver } from "@tdesign-vue-next/auto-import-resolver";
import { viteSingleFile } from "vite-plugin-singlefile";
import postcsspxtoviewport from "postcss-px-to-viewport";

export default defineConfig({
  base: "./",
  // node:test 风格的 .mjs 契约由 `node --test test/tianjiang/*.mjs` 执行；
  // vitest 无法识别其 suite，纳入扫描会以 “No test suite found” 失败关闭。
  test: {
    testTimeout: 15000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/test/tianjiang/**/*.mjs",
    ],
  },
  build: {
    assetsInlineLimit: Infinity,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    vue(),
    AutoImport({
      dts: "src/types/auto-imports.d.ts",
      imports: ["vue", "pinia", "vue-router"],
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
        TDesignResolver({
          library: "chat",
        }),
      ],
    }),
    Components({
      dts: "src/types/components.d.ts",
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
        TDesignResolver({
          library: "chat",
        }),
      ],
    }),
    viteSingleFile(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
    postcss: {
      plugins: [
        postcsspxtoviewport({
          // 要转化的单位
          unitToConvert: "px",
          // UI设计稿的大小
          viewportWidth: 1600,
          // 转换后的精度
          unitPrecision: 4,
          // 转换后的单位
          viewportUnit: "rem",
          // 字体转换后的单位
          fontViewportUnit: "rem",
          // 能转换的属性，*表示所有属性，!border表示border不转
          propList: ["*"],
          // 指定不转换为视窗单位的类名，
          selectorBlackList: ["ignore"],
          // 最小转换的值，小于等于1不转
          minPixelValue: 1,
          // 是否在媒体查询的css代码中也进行转换，默认false
          mediaQuery: true,
          // 是否转换后直接更换属性值
          replace: true,
          // 忽略某些文件夹下的文件或特定文件，例如 'node_modules' 下的文件
          exclude: [],
          // 包含那些文件或者特定文件
          include: [],
          // 是否处理横屏情况
          landscape: false,
        }),
      ],
    },
  },
  server: {
    // 开发命令仅启动服务，禁止构建或验证流程抢占用户浏览器。
    host: "127.0.0.1",
    open: false,
    port: 50188,
  },
  preview: {
    host: "127.0.0.1",
    open: false,
  },
});
