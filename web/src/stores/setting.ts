export default defineStore(
  "setting",
  () => {
    const showSetting = ref(false);
    const isElectron = ref(false);
    const runtimeStartupError = shallowRef<{
      code: string;
      message: string;
      logPath: string;
    } | null>(null);
    const canvasWheelEvent = ref("zoom");
    const activeMenu = ref("ui");
    /** 中文注释：旧 deep link dreaminaCli 迁到模型服务后，用此字段激活原生即梦卡片。 */
    const activeWorkspaceProviderId = ref("");

    const baseUrl = ref<string>("http://127.0.0.1:10588/api");

    const needUpdate = ref(false);

    const otherSetting = ref({
      axiosTimeOut: 60 * 10 * 1000,
      assetsBatchGenereateSize: 5,
      chapterReg: "/第\\s*([0-9０-９零一二三四五六七八九十百千万]+)\\s*[章回节]\\s*([^\\n\\r]*)/g",
      interacting: true,
      scriptEpisodeLength: 5000,
    });

    // 主题模式含正式第三主题 cyberpunk；持久化字段 themeSetting 由 pinia-plugin 写入本地。
    // 无历史偏好的新用户默认 cyberpunk；已 persist 的 light/dark/auto/cyberpunk 不被覆盖。
    const themeSetting = ref<{
      mode: "auto" | "light" | "dark" | "cyberpunk";
      primaryColor: string;
      fontSize: number;
    }>({
      mode: "cyberpunk",
      // 与赛博紫品牌 token 协调，避免首屏先闪 TDesign 默认蓝
      primaryColor: "#A855F7",
      fontSize: 16,
    });

    const language = ref<string>("zh-CN");
    let appearancePersistTimer: ReturnType<typeof setTimeout> | undefined;

    async function hydrateAccountAppearance(): Promise<void> {
      try {
        const { default: axios } = await import("@/utils/axios");
        const { data } = await axios.get("/setting/appearance/getAppearance");
        const payload = data?.data ?? data;
        if (payload?.theme && typeof payload.theme === "object") {
          themeSetting.value = { ...themeSetting.value, ...payload.theme };
        }
        if (typeof payload?.language === "string" && payload.language) {
          language.value = payload.language;
        }
      } catch {
        // 离线或未登录时继续使用本机缓存，不得假装已从账号同步。
      }
    }

    function schedulePersistAccountAppearance(): void {
      if (appearancePersistTimer) clearTimeout(appearancePersistTimer);
      appearancePersistTimer = setTimeout(() => {
        void persistAccountAppearance();
      }, 200);
    }

    async function persistAccountAppearance(): Promise<void> {
      try {
        const { default: axios } = await import("@/utils/axios");
        await axios.post("/setting/appearance/updateAppearance", {
          theme: themeSetting.value,
          language: language.value,
        });
      } catch {
        // 保存失败留给设置页同步状态展示，禁止伪造成功。
      }
    }

    return {
      showSetting,
      baseUrl,
      otherSetting,
      themeSetting,
      language,
      hydrateAccountAppearance,
      persistAccountAppearance,
      schedulePersistAccountAppearance,
      activeMenu,
      activeWorkspaceProviderId,
      isElectron,
      runtimeStartupError,
      canvasWheelEvent,
      needUpdate,
    };
  },
  // 本地服务地址只能来自当前进程握手，禁止恢复历史 localStorage 地址。
  { persist: { pick: ["otherSetting", "themeSetting", "language"] } },
);
