# 天將漫創 App

[简体中文](../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md) · [ไทย](./README.th.md) · [Tiếng Việt](./README.vi.md) · [繁體中文](./README.zhtw.md)

天將漫創是 Windows AI 漫劇製作客戶端，涵蓋小說整理、劇本改編、角色與場景資產、分鏡、生成佇列及任務中心。Apache-2.0 客戶端原始碼發布於 [hyc0122/tj_app](https://github.com/hyc0122/tj_app)；中央帳號、團隊服務、管理後台及部署設定不在公開倉庫範圍內。

## 系統需求

- 目前受控發行平台為 Windows x64。
- 原始碼開發需要 Node.js 24.13.1 與 Yarn 1.22.22。
- 安裝程式名稱為 `天将漫创-<version>-win-x64-setup.exe`。

## 安裝

1. 從維護者公布的正式 Release 管道取得 Windows x64 安裝程式；不要使用猜測網址或未驗證鏡像。
2. 執行安裝精靈並選擇目標資料夾，程式會直接安裝到該資料夾。
3. 安裝包已內含 Microsoft VC++ x64 執行階段，可離線安裝。
4. 啟動天將漫創並使用中央帳號登入；歷史本機預設帳密不再適用。

## 首次使用

1. 開啟「設定 → 模型服務」，設定文字、圖片及影片供應商。
2. 建立專案，或匯入小說／劇本。
3. 依序完成故事整理、劇本、資產、分鏡及影片；遠端任務可在任務中心查看。
4. 個人專案與模型設定依帳號隔離，團隊權限、鎖定與同步狀態由中央服務決定。

## 模型供應商設定

- 端點、模型名稱及金鑰屬於目前帳號的本機設定。
- 私密資料不得寫入日誌、團隊同步或其他帳號目錄。
- 請分別驗證文字、圖片及影片供應商。
- 客戶端同時檢查 Stable 與 Beta；新版 Stable 在登入時強制更新，Beta 則由使用者選擇是否安裝測試版。
- Windows x64 固定目錄為 `https://cdn.j11.com.cn/desktop/{stable|beta}/windows/x64`，前端不能提交任意更新網址。

## 資料遷移

目前機器識別為 `tianjiang`，桌面協定為 `tianjiang://`。版本化單向遷移會升級供應商 ID、模型參照、帳號目錄及動態檔案，寫入前先建立 SQLite 備份。驗證、備份或解析失敗時會停止且不覆寫唯一原始資料。

## 開發與驗證

```powershell
cd app
yarn install --frozen-lockfile
yarn dev
yarn lint
yarn build
```

請以 `node --import tsx --test <定向測試檔>` 執行本次變更相關 App 測試。Beta 使用 `.github/workflows/app-release.yml`，Stable 使用 `.github/workflows/app-stable-release.yml`。

## 疑難排解

- 登入失敗時，分別檢查中央網路、驗證及本機執行環境。
- 模型失敗時，檢查 URL、金鑰、模型名稱、目前帳號、錯誤碼及 request ID。
- 遷移衝突時保留 `migration-backups` 與 recovery 目錄，不要刪除任一資料庫。
- 安裝問題請確認使用正式 Windows x64 安裝包。

## 授權與第三方聲明

客戶端採 Apache-2.0，完整條款見 [LICENSE](../LICENSE)，第三方元件與來源歸屬見 [NOTICES.txt](../NOTICES.txt)。重新散布時必須保留兩者。
