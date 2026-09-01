# 导演台 3D 素体模型署名

本目录下的 3D 角色素体模型用于导演台（directorConsole）3D blocking。

| 文件 | 来源 | 许可证 |
|---|---|---|
| `xbot.glb` | Adobe Mixamo「X Bot」（经 three.js 官方示例仓库分发；标准 Mixamo 骨骼、T-pose 绑定，**当前默认素体**） | Mixamo 使用条款（项目内免版税使用） |
| `cesium-man.glb` | Cesium（glTF 官方示例模型 CesiumMan，已不默认使用，保留回退） | CC-BY 4.0 |
| `rigged-figure.glb` | Cesium（glTF 官方示例模型 RiggedFigure，已不默认使用，保留回退） | CC-BY 4.0 |

- 许可证全文：https://creativecommons.org/licenses/by/4.0/
- 模型由 Cesium 捐赠给 Khronos glTF 项目用于测试：https://github.com/KhronosGroup/glTF-Sample-Models
- 按 CC-BY 4.0 要求，已在产品「3D导演台」界面内展示署名（模型 © Cesium，CC-BY 4.0）。

替换为自有/其它授权模型时，设置环境变量 `VITE_DIRECTOR_GLB_MALE` / `VITE_DIRECTOR_GLB_FEMALE` 即可，并相应更新本署名文件。
