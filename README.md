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

## 发布与签名说明

根目录 `package.json.version` 是唯一版本源；`app/package.json.version` 只是 Electron Builder 必须保持一致的镜像。手工运行 Stable 或 Beta Release 工作流时，GitHub Actions 会从根版本自动生成不可移动的 `v${version}` Tag；Tag 推送后由官方 Runner 完成 required checks、Windows/Linux/macOS 构建、具备凭据时的产品签名、公证、GitHub Release 和 Actions Artifact。

正式发布禁止在本地重新构建、签名、压缩或打包。GitHub Actions 成功后，本地 Windows 只执行：

```powershell
$env:GH_TOKEN = "可选的 GitHub Token；公开仓库低频下载可不设置"
$env:OSS_ACCESS_KEY_ID = "本地 OSS AccessKey ID"
$env:OSS_ACCESS_KEY_SECRET = "本地 OSS AccessKey Secret"
$env:OSS_BUCKET = "OSS Bucket"
$env:OSS_ENDPOINT = "https://oss-cn-qingdao.aliyuncs.com"
$env:OSS_REGION = "oss-cn-qingdao"

yarn.cmd release:relay:oss --run-id <成功的 GitHub Actions Run ID> --channel stable
# Beta 使用：--channel beta
```

中转命令只从 `hyc0122/tj_app` 的指定成功 Run 对应 Release 下载原始资产，校验 Run、Tag、Commit、根版本、Sigstore、文件集合、大小和 SHA-256；`200 MiB` 以上对象使用 `8 MiB` 分片、并发 `4`、每片最多 `3` 次指数退避并保存 checkpoint。全部不可变对象完成 OSS 回读后，才更新 `latest.yml`、`latest.json` 等渠道指针。

OSS AccessKey 只能放在执行中转的本地环境变量或加密凭据存储中，不得配置到 GitHub Actions、源码、日志或 Issue。Windows/macOS 产品签名凭据仍只放在 GitHub Actions Secrets。当前正式产物在缺少签名凭据时会明确标记为 `unsigned`；Sigstore 证明覆盖发布清单来源，不能冒充产品代码签名。

客户端 GitHub Release 只允许发布到 `https://github.com/hyc0122/tj_app`；私有主仓库 `tianjiang-manchuang` 不创建客户端 Tag 或 Release。
