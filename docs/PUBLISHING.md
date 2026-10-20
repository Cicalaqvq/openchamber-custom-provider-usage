# 发布与仓库维护清单

本文面向维护者。用户安装说明默认见[中文 README](../README.md)，另有[英文版](../README.en.md)。仓库地址以中英文 README 中列出的 GitHub 页面和克隆 URL 为准；不要添加虚构徽章、Stars、已发布版本或未经验证的兼容性声明。

## 当前状态与声明边界

- 项目已确认采用 MIT 许可证，根目录 `LICENSE` 是许可证正文；SDK 等第三方代码的归属及许可另见 `THIRD_PARTY_NOTICES.txt`。
- `package.json` 中的 `private: true` 仅阻止 npm 发布，不影响把源码提交到 GitHub，也不代表项目不是开源项目。
- 保持本地提交、远端仓库与发布状态的描述准确；不要声称已推送仓库或发布 release，除非已实际完成并核实。
- 对源码、测试、脚本、文档与分发产物的文本检查未发现可确认的真实凭据；测试令牌为占位值，内部会话引用只出现在已忽略的本机 `AGENTS.md`。这不是安全保证，也不能替代审计。不要在仓库、问题单、截图或日志中放入站点令牌、服务令牌或用户数据。
- 自动化测试不等于宿主端到端验收；目前没有真实 OpenChamber 宿主和 New API 站点的端到端验证记录。发布前需人工完成下方验收。

## 应纳入 Git 的文件

首次公开仓库时，逐项确认并提交以下项目文件（若文件在最终工作树中存在）：

- 根目录：`package.json`、`package-lock.json`、`tsconfig.json`、`README.md`、`README.en.md`、`LICENSE`、`THIRD_PARTY_NOTICES.txt`、`.gitignore`、`.gitattributes`。
- 源码与构建：`src/`、`scripts/`、`panel/`、`status/`。
- 测试：`tests/`。
- 文档及自动化：`docs/`、`.github/`（包括 CI 工作流，如果已添加）。
- **`dist/extension/`**：按项目当前分发约定纳入可直接由 OpenChamber 导入的扩展产物。发布时确保它与当前源码构建结果一致。

不要提交 `node_modules/`、`dist/` 下的 ZIP、其他生成物或无关的 `dist` 内容。也不要提交本机 `AGENTS.md`（其中可能含私人会话信息）、凭据、令牌、日志、临时文件或站点配置。提交前检查 Git 暂存区和忽略规则。

## 发布前检查顺序

在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run check:dist
```

`check:dist` 用于核对已提交的 `dist/extension/` 与源码构建产物一致。**不要先在 CI 中构建再运行此检查**，否则检查只会比较刚生成的文件，无法发现仓库内陈旧或漏更新的分发产物。

如果源码或构建配置有变更，维护者需先在工作区运行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
npm run check:dist
```

检查通过后审阅变更，按白名单只暂存预期源码、测试、配置、文档、许可文件及 `dist/extension/`；不要把 ZIP 或其他 `dist/` 内容带入仓库。`package-lock.json` 应随依赖变更更新。

## 版本与人工验收

持续集成结果应以仓库中实际运行的工作流为准；不要把本地检查结果表述为 CI 通过。这些自动化检查仅覆盖代码、包结构与分发产物，不代表宿主端到端验收完成。

- 每个要发布的 Git 版本都应增加扩展 manifest 中的 `version`，并核实根 `package.json` 与打包产物中的扩展标识、版本和入口路径一致。
- 在真实 OpenChamber 环境分别用**项目根目录、ZIP、Git 仓库来源**安装验收（某种来源不受当前宿主支持时，记录宿主版本与限制，不要泛化为全平台支持）。检查扩展能启用、授权提示符合预期、面板能配置站点、Work Status 能显示余额、刷新与错误状态正常；使用测试账号和测试令牌。
- 远程部署时确认 Git 拉取、目录路径和本地服务运行于 OpenChamber 宿主侧，而非用户浏览器电脑。目录拖放等导入行为需按具体宿主确认。
- 验收记录中写明实际 OpenChamber 版本、部署方式、安装来源和结果。没有完成的项目明确标记未验证，不得仅凭 manifest 最低版本推断兼容性。

仓库维护期间保持中英文 README 的仓库页和克隆 URL 一致；只有确实存在并核实后，才添加 Release、兼容性、下载或社区入口信息。
