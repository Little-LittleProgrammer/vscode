# 项目目录结构说明

## VS Code 项目目录结构 (树状视图)

```
├── .git/                      # Git 版本控制系统目录
├── .github/                   # GitHub 相关配置 (Workflows, Issue Templates)
├── .vscode/                   # VS Code 编辑器特定配置 (launch.json, settings.json)
├── .devcontainer/             # 开发容器配置 (Remote Containers, Codespaces)
├── build/                     # 构建脚本和相关工具 (Gulp Tasks)
├── cli/                       # 命令行接口 (CLI) 源代码
├── docs/                      # 项目文档 (包括此文件)
├── extensions/                # VS Code 内置扩展源代码
├── node_modules/              # Node.js 依赖包 (由 npm install 生成)
├── out/                       # 编译后的 JavaScript 输出目录 (运行时的代码)
├── remote/                    # 远程开发相关代码
├── resources/                 # 应用程序资源文件 (图标, 平台特定文件)
├── scripts/                   # 辅助脚本 (启动, 测试等)
├── src/                       # TypeScript 核心源代码目录
│   ├── vs/                    # VS Code 核心实现
│   │   ├── base/              # 基础工具库和通用服务 (与平台无关)
│   │   │   ├── browser/       # 浏览器环境特有的基础实现 (DOM 操作等)
│   │   │   ├── common/        # 通用基础代码 (事件, 生命周期, URI, 异步, diff, markdown解析, worker协议, 工具函数等)
│   │   │   ├── node/          # Node.js 环境特有的基础实现 (文件系统, 进程通信等)
│   │   │   ├── parts/         # 核心组件 (IPC协议, quickopen, tree组件等)
│   │   │   └── test/          # `base` 模块的单元测试用例
│   │   │   └── worker/        # Worker factory 和 main Worker 实现
│   │   ├── code/              # VS Code 扩展 API 的实现和管理
│   │   │   ├── browser/       # 浏览器环境下的扩展 API 实现
│   │   │   ├── electron-sandbox/ #渲染进程api, 可以调用common, brower, node, 依赖electron renderer-process API
│   │   │   ├── electron-main/ # 主进程api, 可以调用: common, node 依赖于electron main-process AP
│   │   │   └── node/          # Node.js 环境下的扩展 API 实现（如文件系统访问、进程管理等）

│   │   ├── editor/            # 编辑器核心实现 (Monaco Editor 基础)
│   │   │   ├── browser/       # 编辑器在浏览器环境下的 UI 实现和交互
│   │   │   ├── common/        # 编辑器通用模型、接口和逻辑 (文本模型, 视图模型, 语言特性, 命令, 配置)
│   │   │   ├── contrib/       # 编辑器附加功能 (查找, 替换, 片段, 括号匹配, 建议等)
│   │   │   └── standalone/    # Monaco Editor 作为独立编辑器使用的特有代码
│   │   ├── platform/          # 平台抽象层 (服务接口定义和跨环境实现)
│   │   ├── server/            # VS Code 服务器端实现 (远程开发, Web 版本)
│   │   │   ├── node/          # Node.js 环境下的服务器实现
│   │   │   ├── browser/       # 浏览器环境下的服务器连接逻辑
│   │   │   └── common/        # 服务器端通用代码和接口
│   │   └── workbench/         # 工作台 UI 和核心服务实现
│   │       ├── api/           # 暴露给扩展的 API 的具体实现
│   │       ├── browser/       # 工作台在浏览器环境下的 UI 实现 (视图, 状态栏, 活动栏等)
│   │       ├── common/        # 工作台通用的模型、接口和逻辑
│   │       ├── contrib/       # 工作台附加功能 (调试, 终端, 搜索, SCM, 扩展管理 UI 等)
│   │       ├── electron-sandbox/ # Electron 沙盒环境特定实现
│   │       ├── electron-main/ # Electron 主进程环境特定实现
│   │       └── services/      # 工作台核心服务的实现 (依赖 platform)
│   ├── vscode-dts/            # VS Code 扩展 API 的 TypeScript 定义文件
│   │   ├── vscode.d.ts        # 稳定的 API 定义
│   │   └── vscode.proposed.*.d.ts # 提案阶段 (不稳定) 的 API 定义
│   ├── typings/               # 项目内部使用的或第三方的 TypeScript 类型定义
│   ├── bootstrap-*.ts         # 不同环境的启动脚本·
│   ├── main.ts                # Electron 主进程入口点
│   ├── cli.ts                 # 命令行接口 (CLI) 入口点
│   ├── server-main.ts         # VS Code Server 主入口点
│   ├── server-cli.ts          # VS Code Server CLI 入口点
│   ├── tsconfig.*.json        # TypeScript 编译配置文件
│   └── tsec.exemptions.json   # TypeScript 安全检查 (tsec) 豁免配置
├── test/                      # 测试文件 (单元测试, 集成测试, 冒烟测试)
├── .editorconfig              # 跨编辑器代码风格规则
├── .eslint*                   # ESLint 代码检查配置
├── .git*                      # Git 相关配置 (.gitignore, .gitattributes等)
├── .nvmrc                     # 项目推荐的 Node.js 版本
├── CodeQL.yml                 # GitHub CodeQL (代码扫描) 配置
├── CONTRIBUTING.md            # 贡献指南
├── gulpfile.js                # Gulp 构建工具配置
├── LICENSE.txt                # 开源许可证 (MIT)
├── package.json               # Node.js 项目核心配置 (元数据, 依赖, 脚本)
├── package-lock.json          # 锁定依赖版本
├── product.json               # 产品信息 (名称, 版本, 图标等)
├── README.md                  # 项目主要说明文件
├── README-RUN.md              # 翻译后的贡献指南
├── SECURITY.md                # 安全策略说明
├── ThirdPartyNotices.txt      # 第三方库许可证声明
└── tsfmt.json                 # TypeScript 格式化配置 (可能)
```

## 详细

这是 VS Code (code-oss-dev) 项目的主要目录结构和文件说明：

*   **`.git/`**: Git 版本控制系统目录，包含仓库的所有历史记录和元数据。
*   **`.github/`**: 包含 GitHub 相关配置，如 workflows (CI/CD), issue templates 等。
*   **`.vscode/`**: 包含 VS Code 编辑器特定的配置文件，如 `launch.json` (调试配置) 和 `settings.json` (工作区设置)。
*   **`.devcontainer/`**: 包含用于 VS Code Remote - Containers 和 GitHub Codespaces 的开发容器配置。
*   **`build/`**: 存放构建脚本和相关工具（例如 gulp tasks）。
*   **`cli/`**: 包含命令行接口 (CLI) 的源代码。
*   **`docs/`**: （此目录刚创建）用于存放项目文档。
*   **`extensions/`**: 包含 VS Code 内置扩展的源代码。
*   **`node_modules/`**: 存放项目的所有 Node.js 依赖包（通过 `npm install` 安装）。
*   **`out/`**: 编译后的 JavaScript 输出目录。TypeScript 源代码编译后会放在这里。运行 VS Code 开发版本时，执行的是这个目录下的代码。
*   **`remote/`**: 包含与远程开发（Remote Development）相关的代码。
*   **`resources/`**: 存放应用程序所需的各种资源文件，如图标、不同平台的特定文件等。
*   **`scripts/`**: 包含各种辅助脚本，如启动脚本 (`code.sh`, `code.bat`)、测试脚本等。
*   **`src/`**: 项目的核心源代码目录，主要是 TypeScript 代码。
    *   `vs/` 子目录包含了编辑器、工作台等核心功能的实现。
*   **`test/`**: 包含各种测试文件，包括单元测试、集成测试和冒烟测试。
*   **`.editorconfig`**: 定义代码编辑器（如 VS Code, Sublime Text 等）的代码风格规则，确保跨编辑器和开发者的代码风格一致性。
*   **`.eslint*`**: ESLint 配置文件 (`eslint.config.js`, `.eslint-ignore`)，用于代码风格检查和规范。
*   **`.git*`**: Git 相关配置文件，如 `.gitignore` (指定 Git 忽略的文件/目录), `.gitattributes` (定义文件属性), `.git-blame-ignore-revs` (指定 blame 时忽略的提交)。
*   **`.nvmrc`**: 指定项目推荐使用的 Node.js 版本，供 `nvm` (Node Version Manager) 使用。
*   **`CodeQL.yml`**: GitHub CodeQL (代码扫描工具) 的配置文件。
*   **`CONTRIBUTING.md`**: 贡献指南，为想要参与项目贡献的开发者提供说明。
*   **`gulpfile.js`**: Gulp 构建工具的配置文件。
*   **`LICENSE.txt`**: 项目的开源许可证文件 (MIT License)。
*   **`package.json`**: Node.js 项目的核心配置文件，定义项目元数据、依赖、脚本 (`scripts`) 等。
*   **`package-lock.json`**: 锁定项目依赖的具体版本，确保不同环境下安装的依赖版本一致。
*   **`product.json`**: 定义产品相关的信息，如应用程序名称、版本、图标路径等。
*   **`README.md`**: 项目的主要说明文件，通常包含项目介绍、安装、使用方法等。
*   **`README-RUN.md`**: （您之前创建的）包含翻译后的贡献指南。
*   **`SECURITY.md`**: 安全策略说明文件。
*   **`ThirdPartyNotices.txt`**: 第三方库的许可证声明。
*   **`tsfmt.json`**: 可能与 TypeScript 格式化相关的配置文件。

*其他隐藏目录/文件*: 如 `.cursor/`, `.profile-oss/`, `.build/`, `.config/`, `.lsifrc.json`, `.mailmap`, `.mention-bot`, `cglicenses.json`, `cgmanifest.json` 等通常是特定工具、缓存或构建过程产生的，对于理解核心项目结构不是必需的。


## `src/` 目录结构说明

`src` 目录是 VS Code 项目的核心源代码所在，主要使用 TypeScript 编写。其主要子目录和文件包括：

*   **`vs/`**: 这是最重要的子目录，包含了 VS Code 的核心实现，按照功能模块划分，例如：
    *   `base/`: 基础工具库和通用服务 (如事件、生命周期、DOM 操作等)。
    *   `code/`: 实现 VS Code 扩展 API 的代码。
    *   `editor/`: 编辑器核心 (Monaco Editor 的基础)，包含文本模型、视图模型、语言功能等。
    *   `platform/`: 平台抽象层，提供跨环境 (Electron 主进程、渲染进程、Web Worker、Node.js) 的服务接口和实现 (如文件系统、配置、日志、IPC 通信等)。
    *   `workbench/`: 工作台 UI 和核心服务实现 (视图、面板、编辑器管理、命令、文件管理、主题、通知等)。
    *   `server/`: 用于远程开发 (Remote SSH, WSL, Containers) 和 Web 版本 (vscode.dev) 的服务器端代码。
*   **`vscode-dts/`**: 包含了 VS Code 扩展 API 的 TypeScript 定义文件 (`vscode.d.ts`, `vscode.proposed.d.ts`)。扩展开发者会使用这些类型定义来开发插件。
*   **`typings/`**: 存放项目中使用的第三方库或其他模块的类型定义文件 (`.d.ts`)，用于 TypeScript 的类型检查，确保代码类型安全。
*   **`bootstrap-*.ts`**: 一系列启动脚本，负责在不同环境（如 Electron 主进程 `bootstrap-node.ts`、渲染进程/窗口 `bootstrap-window.ts`、扩展主机 `bootstrap-fork.ts`、Web Worker、CLI `bootstrap-cli.ts` 等）初始化应用程序、加载必要的模块和启动核心服务。
*   **`main.ts`**: Electron 主进程的入口点，负责创建浏览器窗口 (渲染进程)、管理应用程序生命周期 (启动、退出)、处理进程间通信等。
*   **`cli.ts`**: VS Code 命令行接口 (CLI) 的入口点和实现，处理命令行参数和执行相应操作。
*   **`server-main.ts`, `server-cli.ts`**: VS Code Server (用于远程连接和 Web 版本) 的主入口点和 CLI 入口点。
*   **`tsconfig.*.json`**: 多个 TypeScript 配置文件，用于不同的编译目标或场景（例如，核心代码 `tsconfig.json`、Monaco 编辑器单独部分 `tsconfig.monaco.json`、生成 API 类型定义文件 `tsconfig.vscode-dts.json` 等）。它们定义了编译选项、包含/排除的文件等。
*   **`tsec.exemptions.json`**: TypeScript 安全检查 (tsec) 工具的豁免配置文件，用于标记某些已知或允许的不安全代码模式。


### `src/vs/` 子目录说明

`src/vs/` 是 VS Code 最核心的代码实现部分，其下的二级子目录按照主要功能领域划分：

*   **`base/`**: 提供最基础的、与具体平台或环境无关的工具和核心服务。
    *   `common/`: 通用的基础代码，如事件处理 (`event.ts`)、生命周期管理 (`lifecycle.ts`)、URI 处理 (`uri.ts`)、异步编程工具 (`async.ts`) 等。
    *   `browser/`: 浏览器环境特有的基础实现，如 DOM 操作、浏览器 API 封装等。
    *   `node/`: Node.js 环境特有的基础实现，如文件系统操作、进程通信等。
*   **`code/`**: 主要包含 VS Code 扩展 API 的实现和管理。它连接 `platform` 和 `workbench` 的功能，将其暴露给扩展开发者。
*   **`editor/`**: 编辑器核心实现 (Monaco Editor 的基础)。
    *   `common/`: 编辑器的通用模型、接口和逻辑，如文本模型 (`model/`)、视图模型 (`viewModel/`)、语言特性 (`languages/`)、命令 (`commands/`)、配置 (`config/`) 等。
    *   `browser/`: 编辑器在浏览器环境下的 UI 实现和交互逻辑。
    *   `contrib/`: 编辑器的各种附加功能（Contributions），如查找、替换、代码片段、括号匹配、建议等。
*   **`platform/`**: 平台抽象层，定义核心服务的接口，并提供不同环境（主进程、渲染进程、Web Worker、Node.js、浏览器）下的具体实现。这是实现跨平台和跨环境的关键。
    *   包含各种服务的接口定义 (`common/`) 和具体实现 (`node/`, `browser/`, `electron-main/`, `electron-sandbox/`, `worker/`)，例如：文件服务、配置服务、日志服务、通知服务、IPC 通信、扩展管理、存储、遥测等。
*   **`server/`**: 包含 VS Code 服务器端实现，用于远程开发场景和 Web 版本。
    *   `node/`: 服务器在 Node.js 环境下的实现。
    *   `browser/`: 浏览器环境下的服务器端连接逻辑。
    *   `common/`: 服务器端通用的代码和接口。
*   **`workbench/`**: 工作台（用户界面）的实现。
    *   `common/`: 工作台通用的模型、接口和逻辑。
    *   `browser/`: 工作台在浏览器环境下的 UI 实现，包括各种视图（编辑器、侧边栏、面板）、状态栏、活动栏、菜单、命令面板等的具体实现。
    *   `contrib/`: 工作台的各种附加功能，如调试、终端、搜索、源代码管理、扩展管理 UI 等。
    *   `electron-sandbox/`, `electron-main/`: 工作台在 Electron 沙盒环境和主进程环境下的特定实现。
    *   `services/`: 工作台核心服务的实现，这些服务通常会依赖 `platform` 层的接口。
    *   `api/`: 工作台暴露给扩展的 API 的具体实现。
*   **`loader.js`**: AMD (Asynchronous Module Definition) 加载器，用于在运行时异步加载模块。
*   **`monaco.d.ts`**: Monaco Editor 的 API 类型定义文件（这是 `src/vs/editor` 部分的一个子集，单独暴露给外部使用）。
*   **`nls.ts`, `nls.messages.ts`**: 本地化 (National Language Support) 相关的文件，用于处理多语言字符串。
*   **`amdX.ts`**: AMD 加载器的扩展或辅助模块。

### `src/vscode-dts/` 子目录说明

此目录包含 VS Code 扩展 API 的 TypeScript 定义文件 (`.d.ts`)。

*   **`vscode.d.ts`**: 包含稳定版本的 VS Code 扩展 API 的类型定义。扩展开发者依赖此文件进行开发和类型检查。
*   **`vscode.proposed.*.d.ts`**: 包含 **提案阶段 (Proposed)** 的 API 类型定义。这些 API 尚未稳定，可能会在未来版本中更改或移除。扩展开发者需要显式启用才能使用这些 API。这个目录下有大量文件，每个文件对应一个特定的提案 API，例如：
    *   `vscode.proposed.languageModelDataPart.d.ts`: 与语言模型交互相关的提案 API。
    *   `vscode.proposed.terminalExecuteCommandEvent.d.ts`: 与终端命令执行事件相关的提案 API。
    *   `vscode.proposed.notebookVariableProvider.d.ts`: 与 Notebook 变量提供者相关的提案 API。
    *   ... 等等，涵盖了调试、测试、UI、文件系统、语言特性等多个方面的实验性功能。

### `src/typings/` 子目录说明

此目录包含项目内部使用的、非 VS Code API 的，或者对第三方库进行的补充或全局性的 TypeScript 类型定义 (`.d.ts`)。

*   **`*.d.ts`**: 这些文件为项目提供类型信息，确保 TypeScript 编译器能够正确理解代码中使用的各种对象和函数，即使它们是用 JavaScript 编写的或者类型定义不完整。例如：
    *   `thenable.d.ts`: 可能定义了 `Thenable` 接口（类似 Promise）。
    *   `vscode-globals-*.d.ts`: 定义了一些 VS Code 内部使用的全局变量或类型，如 `vscode-globals-nls.d.ts` 可能与全局本地化函数有关，`vscode-globals-product.d.ts` 可能与全局产品信息有关。
    *   `crypto.d.ts`: 可能包含 Web Crypto API 的类型定义。
    *   `css.d.ts`: 可能包含 CSS 相关操作的类型定义。
    *   `editContext.d.ts`: 可能与 Web API EditContext 相关。
