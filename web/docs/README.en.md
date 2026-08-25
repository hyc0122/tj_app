# Tianjiang Web

[简体中文](../README.md) · [English](./README.en.md)

This directory contains the Vue frontend embedded in the Tianjiang desktop client. It handles central sign-in, the workbench, production workflows, task state, and local settings. It works with the authenticated local runtime shipped in the same installer and is not an unauthenticated standalone public web service. The Apache-2.0 client source is published at [hyc0122/tj_app](https://github.com/hyc0122/tj_app); central services and administration are not included.

## Requirements

- Node.js 24.13.1
- Yarn 1.22.22
- End users should install the controlled Tianjiang Windows x64 package; the commands below are for source development.

## Install and run

```powershell
cd web
yarn install --frozen-lockfile
yarn dev
```

The development server does not open a browser automatically. Electron integration must wait for the App runtime handshake. Desktop actions use `tianjiang://`.

## First use

1. Sign in to the App with a central account.
2. Configure text, image, and video model providers in Settings.
3. Create or import a project, then work through screenplay, assets, storyboard, and video.
4. Track remote generation in Task Center. Team write access depends on central permissions and locks.

## Verification

```powershell
yarn test:tianjiang-ui
yarn type-check
yarn build
```

The generated `dist` directory is a frontend artifact, not a verified desktop installer.

## Security boundaries

- The frontend must not persist central JWTs, refresh tokens, or model keys.
- Provider secrets stay in the active account's local runtime and must not enter logs or team synchronization.
- The update manifest URL is configured by the backend; the frontend cannot submit a custom update URL.
- Project databases and user data must not be embedded in static assets.

## Stable and Beta updates

- The App reads fixed Stable and Beta Windows x64 platform catalogs; Web only displays results validated by the local runtime.
- A newer Stable release is mandatory at sign-in. Beta is an optional test release selected by the user.
- Web `dist` is not an independent updater payload and cannot pass an arbitrary URL to the installer.

## Troubleshooting

- Separate central API, local-runtime, and authentication failures.
- Keep the public error code and request ID; do not use administrator mode as a generic workaround.
- If desktop actions fail, confirm that the App handshake completed and the build was not opened as a plain local file.
- Missing update hints must be fixed in backend deployment configuration, not by entering a frontend URL.

## License and notices

The client uses Apache-2.0; complete terms are in [LICENSE](../LICENSE). Third-party components and attribution are in [NOTICES.txt](../NOTICES.txt). Preserve both files when redistributing the frontend.
