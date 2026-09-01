import { createRouter, createWebHashHistory } from "vue-router";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/:catchAll(.*)",
      name: "404",
      meta: {
        title: "404",
      },
      component: () => import("@/pages/error/404.vue"),
    },
    {
      path: "/",
      redirect: "/workbench",
    },
    {
      path: "/workbench",
      component: () => import("@/pages/workbench/index.vue"),
      redirect: "/project",
      children: [
        {
          path: "/project",
          component: () => import("@/views/project/index.vue"),
        },
        {
          path: "/task",
          component: () => import("@/views/task/index.vue"),
        },
        {
          path: "/team",
          component: () => import("@/views/team/index.vue"),
        },
        {
          path: "/infinite-canvas",
          meta: { canvasHome: true },
          component: () => import("@/views/infiniteCanvas/index.vue"),
        },
        {
          path: "/infinite-canvas/:projectUuid",
          meta: { canvasEditor: true },
          component: () => import("@/views/infiniteCanvas/editor.vue"),
        },
        {
          path: "/settings",
          component: () => import("@/views/settings/index.vue"),
        },
        {
          path: "/project-recovery",
          component: () => import("@/views/projectRecovery/index.vue"),
        },
        // {
        //   path: "/detail",
        //   component: () => import("@/views/detail/index.vue"),
        // },
        {
          path: "/novel",
          component: () => import("@/views/novel/index.vue"),
        },
        {
          path: "/script",
          component: () => import("@/views/script/index.vue"),
        },
        {
          path: "/storyboard-project",
          component: () => import("@/views/storyboardProject/index.vue"),
        },
        {
          path: "/scriptAgent",
          component: () => import("@/views/scriptAgent/index.vue"),
        },
        {
          path: "/cornerScape",
          component: () => import("@/views/cornerScape/index.vue"),
        },
        {
          path: "/production",
          component: () => import("@/views/production/index.vue"),
        },
        {
          path: "/assets",
          component: () => import("@/views/assets/index.vue"),
        },
        {
          path: "/test",
          component: () => import("@/views/test/index.vue"),
        },
      ],
    },
    {
      path: "/login",
      component: () => import("@/pages/login/index.vue"),
    },
  ],
});
router.beforeEach(async (to, from, next) => {
  if (to.path === "/login") {
    next();
  } else {
    const { restoreCentralSession } = await import("@/features/tianjiang/auth/client");
    if (await restoreCentralSession()) {
      const projectPaths = new Set([
        "/novel", "/script", "/storyboard-project", "/scriptAgent", "/cornerScape", "/production",
        "/assets", "/project-recovery",
      ]);
      if (to.path.startsWith("/infinite-canvas/") && to.params.projectUuid) {
        next();
        return;
      }
      if (projectPaths.has(to.path)) {
        const { default: useProjectStore } = await import("@/stores/project");
        if (!useProjectStore().project) {
          next("/project");
          return;
        }
      }
      next();
    } else {
      next("/login");
    }
  }
});
export default router;
