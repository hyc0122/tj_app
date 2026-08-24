# Tianjiang App

[简体中文](../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md) · [ไทย](./README.th.md) · [Tiếng Việt](./README.vi.md) · [繁體中文](./README.zhtw.md)

Tianjiang is a local AI manga-drama production client for story preparation, screenplay adaptation, character and scene assets, storyboards, and video generation. Projects and personal model settings are stored in the local data area of the signed-in central account.

## Requirements

- Windows x64 is the currently controlled release target.
- Source development requires Node.js 24.13.1 and Yarn 1.22.22.
- The installer is named `天将漫创-<version>-win-x64-setup.exe`.

## Installation

1. Obtain the Windows x64 installer from the official release channel announced by the maintainers. Do not guess a download URL or use an unverified mirror.
2. Run the installer and choose a target folder. The application installs directly into that folder.
3. The Microsoft VC++ x64 runtime is bundled for offline installation.
4. Start Tianjiang and sign in with a central account; historical local default credentials no longer apply.

## First use

1. Open **Settings → Model Services** and configure the text, image, and video providers you need.
2. Create a project or import a novel or screenplay.
3. Work through story preparation, screenplay, assets, storyboard, and video generation. Follow remote jobs in Task Center.
4. Personal projects and model settings are isolated by account; team permissions, locks, and sync state come from the central service.

## Model providers

- Provider endpoints, model names, and keys belong to the active account's local settings.
- Secrets must not enter logs, team synchronization, or another account's directory.
- Verify text, image, and video providers independently.
- Update checks require the deployment variable `TIANJIANG_UPDATE_MANIFEST_URL`; a missing manifest disables update hints without blocking the workbench.

## Data migration

The current machine identifier is `tianjiang` and the desktop protocol is `tianjiang://`. Versioned one-way migrations upgrade vendor IDs, model references, account folders, and dynamic vendor files. SQLite is backed up before migration. Validation, backup, or parsing failures stop startup without overwriting the only source copy.

## Development and verification

```powershell
cd app
yarn install --frozen-lockfile
yarn dev
yarn test:tianjiang
yarn lint
yarn build
```

Use `yarn dev:gui` for Electron debugging. The active Windows x64 release workflow is `.github/workflows/app-release.yml` at the repository root.

## Troubleshooting

- Sign-in failures: distinguish central-network, authentication, and local-runtime errors.
- Model failures: verify the endpoint, key, model name, active account, public error code, and request ID.
- Migration conflicts: preserve `migration-backups` and recovery folders; do not delete either database copy.
- Native module or installer failures: confirm that the controlled Windows x64 package is being used.

## License and notices

Copyright, license terms, and historical transition terms are in [LICENSE](../LICENSE). Third-party components and attribution are listed in [NOTICES.txt](../NOTICES.txt). Both files must be reviewed and preserved when redistributing the application.
