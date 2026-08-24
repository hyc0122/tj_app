# 天将漫创客户端

本仓库是天将漫创桌面客户端的公开源码快照，采用 Apache License 2.0。源码来自私有主仓库中的一个已审计提交；对应提交记录在根目录 `UPSTREAM_COMMIT`。

公开范围仅包括：

- `app/`：Electron 主进程、本地服务、客户端资源、测试和打包脚本；
- `web/`：桌面客户端内嵌的 Vue 用户界面及测试；
- `.github/workflows/`：客户端 Beta 与 Stable 发布工作流。

云端后台、管理端、部署配置、生产凭据和私有 Git 历史不在本仓库中。本仓库不是私有主仓库的迁移目标，也不接受从公开仓库反向合并私有业务代码。

## 开发环境

- Node.js 24.13.1
- Yarn 1.22.22

请为 `app` 和 `web` 分别安装独立依赖：

```powershell
cd web
yarn.cmd install --frozen-lockfile --non-interactive
yarn.cmd type-check
yarn.cmd build

cd ..\app
yarn.cmd install --frozen-lockfile --non-interactive
yarn.cmd native:node
yarn.cmd native:verify:node
yarn.cmd lint
yarn.cmd build
```

Windows x64 正式打包入口：

```powershell
cd app
$env:TIANJIANG_UPDATE_FEED_URL = "https://api.j11.com.cn/desktop/stable/windows/x64"
yarn.cmd dist:win:x64
```

打包脚本会先执行 Web/App 的 Node 门禁，然后切换并验证 Electron 原生 ABI。请勿在打包入口前手工把 `better-sqlite3` 切换为 Electron ABI。

## 发布与签名说明

GitHub Actions 从 Tag 重新构建客户端并发布 OSS 更新源和 GitHub Release。当前正式产物可能未使用 Authenticode 或 Apple Developer ID 签名；Sigstore 证明只覆盖发布清单来源，不能替代产品代码签名。

任何真实密钥必须配置为 GitHub Actions Secret，禁止写入源码、日志或 Issue。
