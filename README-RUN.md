# 如何为 Visual Studio Code 做贡献

为 Visual Studio Code 项目做贡献的方式有很多种：报告 bug、提交 pull request、报告问题以及提出建议。

克隆并构建仓库后，请查看 [issues 列表](https://github.com/Microsoft/vscode/issues?utf8=%E2%9C%93&q=is%3Aopen+is%3Aissue)。标记为 [`help wanted`](https://github.com/Microsoft/vscode/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) 的 issue 是提交 PR 的好选择。标记为 [`good first issue`](https://github.com/Microsoft/vscode/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) 的 issue 非常适合初次接触代码库的开发者。如果您要贡献重大的更改，或者 issue 已经被分配到特定的月份里程碑，请在开始工作前先与 issue 的负责人讨论。

## 先决条件

为了下载必要的工具、克隆仓库并通过 `npm` 安装依赖，您需要网络访问权限。

**注意**：您应该将仓库克隆到一个**不含空格**的路径中，以避免编译原生模块时出现问题。

您将需要以下工具：

- [Git](https://git-scm.com)
- [Node.JS](https://nodejs.org/en/download/prebuilt-binaries)，**x64** 或 **ARM64**，版本 `>=20.x` （也可参考 [`.nvmrc`](https://github.com/microsoft/vscode/blob/main/.nvmrc)，其中可能提供了更精确的安装版本）
  - 如果使用 `nvm`，请考虑使用 `nvm alias default <VERSION>` 更新您的默认 node 安装
  - Windows：请勿选择安装 Windows 构建工具的选项，请参阅下文的步骤说明
- [Python](https://www.python.org/downloads/)（node-gyp 需要；请查看 [node-gyp readme](https://github.com/nodejs/node-gyp#installation) 以了解当前支持的 Python 版本）
  - 确保 `python` 可以在命令行提示符下无错误运行
  - 您的 Python 版本可能未包含所有必要的工具，建议安装 `setuptools` 包 (`pip install setuptools`)，否则可能会遇到难以调试的错误。
- 适用于您平台的 C/C++ 编译器工具链：
  - **Windows 10/11 (x64 或 ARM64)**
    - 通过安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools) 或 [Visual Studio Community Edition](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) 来安装 Visual C++ 构建环境。需要安装的最小工作负载是 `使用 C++ 的桌面开发`。但还有来自"单个组件"的其他组件：
      - `MSVC v143 - VS 2022 C++ x64/x86 Spectre 缓解库 (最新)` (对于 Windows on ARM，请使用 `ARM64`，但 x64/x86 可能仍然需要)
      - `适用于最新 v143 生成工具的 C++ ATL (Spectre 缓解措施)`
      - `适用于最新 v143 生成工具的 C++ MFC (Spectre 缓解措施)`
    - 打开命令提示符并运行 `npm config edit`，添加或修改 `msvs_version` 设置，使其等于您的 VS 版本（例如，对于 Visual Studio 2022，`msvs_version=2022`）。
    - **警告：** 确保您的配置文件路径仅包含 ASCII 字母，例如 *John*，否则可能导致 [node-gyp 使用问题 (nodejs/node-gyp/issues#297)](https://github.com/nodejs/node-gyp/issues/297)。
    - **注意：** 目前不支持通过 Linux 的 Windows 子系统 (WSL) 进行构建和调试。
  - **Windows WSL2**: https://github.com/microsoft/vscode/wiki/Selfhosting-on-Windows-WSL
  - **macOS**
    - [Xcode](https://developer.apple.com/xcode/resources/) 和命令行工具，它们将安装 `gcc` 和包含 `make` 的相关工具链。
      - 运行 `xcode-select --install` 来安装命令行工具。
    - **Linux**
      * 基于 Debian 的 Linux：`sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
      * 基于 Red Hat 的 Linux：`sudo yum groupinstall "Development Tools" && sudo yum install libX11-devel.x86_64 libxkbfile-devel.x86_64 libsecret-devel krb5-devel # 或 .i686`。
      * 其他：
        * `make`
        * [pkg-config](https://www.freedesktop.org/wiki/Software/pkg-config/)
        * [GCC](https://gcc.gnu.org) 或其他编译工具链
      * 构建 deb 和 rpm 包需要 `fakeroot` 和 `rpm`；运行：`sudo apt-get install fakeroot rpm`

### 故障排除

确保您将 `vscode` 克隆到了路径层次结构中没有任何空格的文件夹中。

如果遇到问题，请先尝试删除 `~/.node-gyp`（Linux 为 `~/.cache/node-gyp`，macOS 为 `~/Library/Caches/node-gyp/`，Windows 为 `%USERPROFILE%\AppData\Local\node-gyp`）的内容，然后运行 `git clean -xfd`，再重试。

> 如果您在 Windows 或 Linux 64 位系统上，并且希望编译为 32 位，则需要在运行 `npm` 之前将 `npm_config_arch` 环境变量设置为 `ia32`。这将为 32 位架构编译所有原生 node 模块。类似地，当为 ARM 交叉编译时，将 `npm_config_arch` 设置为 `arm`。

> **注意：** 有关如何在 UNIX 系统上全局安装 NPM 模块而不使用 `sudo` 的更多信息，请参阅[此指南](http://www.johnpapa.net/how-to-use-npm-global-without-sudo-on-osx/)。

> 如果您安装了 Visual Studio 2019，使用默认版本的 node-gyp 时可能会遇到问题。如果您安装了 Visual Studio 2019，可能需要遵循[此处](https://github.com/nodejs/node-gyp/issues/1747)的解决方案。

#### Windows 上缺少 Spectre 缓解库

如果您使用 npm >= 10.2.3 或 node-gyp >= 10.0.0，则在构建此项目的原生模块时可能会看到错误：

> 此项目需要 Spectre 缓解库。

要修复此错误，请打开 Visual Studio 安装程序，添加与您要构建的体系结构 (x64/ARM/ARM64) 对应的以下组件，然后重新启动您的构建会话：

- MSVC Spectre 缓解库 (最新)
- 适用于最新生成工具的 C++ ATL (Spectre 缓解措施)
- 适用于最新生成工具的 C++ MFC (Spectre 缓解措施)

#### Windows ARM 上与 node-gyp 相关的故障

对于构建工具的单个组件，您可能需要指定版本，例如 v14.41-17.11，而不是（最新），但请选择一个未停止支持的版本。

#### macOS 上与 node-gyp 相关的故障

如果您在使用 node-gyp 和 clang 构建原生模块时遇到错误，请通过 `export CXX="c++ -v"` 启用调试日志记录以获取更详细的错误消息。

### 开发容器

或者，您可以避免本地依赖安装，因为此仓库包含 Visual Studio Code Remote - Containers / Codespaces [开发容器](https://github.com/microsoft/vscode/tree/main/.devcontainer)。

- 对于 [Remote - Containers](https://aka.ms/vscode-remote/download/containers)，使用 **Remote-Containers: Open Repository in Container...** 命令，该命令会创建一个 Docker 卷，以在 macOS 和 Windows 上获得更好的磁盘 I/O。
- 对于 Codespaces，在 VS Code 中安装 [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) 扩展，并使用 **Codespaces: Create New Codespace** 命令。

Docker / Codespace 应至少具有 **4 核和 6 GB 内存 (建议 8 GB)** 才能运行完整构建。有关更多信息，请参阅[开发容器 README](https://github.com/microsoft/vscode/blob/main/.devcontainer/README.md)。

如果您想为 Remote - Containers 扩展中可用的开发容器列表做出贡献，可以查看 vscode-dev-containers 仓库中的[贡献文档](https://github.com/microsoft/vscode-dev-containers/blob/master/CONTRIBUTING.md)。

## 启用 Commit 签名

如果您是社区成员，可以跳过此步骤。

否则，如果您是 VS Code 团队的成员，请遵循[Commit 签名](https://github.com/microsoft/vscode/wiki/Commit-Signing)指南。

## 构建和运行

如果您想了解 VS Code 的工作原理或想调试问题，您需要获取源代码、构建它并在本地运行该工具。

> 注意：如果您需要在 64 位 Windows 上调试 32 位版本的 VS Code，请遵循[如何操作的指南](https://github.com/microsoft/vscode/wiki/Build-and-run-32bit-Code---OSS-on-Windows)。

### 获取源代码

首先，fork VS Code 仓库，以便您可以创建 pull request。然后，在本地克隆您的 fork：

```
git clone https://github.com/<<<您的 GitHub 帐户>>>/vscode.git
```

有时您需要将上游仓库（官方代码仓库）的更改合并到您的 fork 中。

```
cd vscode
git checkout main
git pull https://github.com/microsoft/vscode.git main
```

处理任何合并冲突，提交它们，然后将它们推送到您的 fork。

**注意**：`microsoft/vscode` 仓库包含一系列 GitHub Actions，可帮助我们进行 issue 分类。由于您可能不希望这些在您的 fork 上运行，您可以通过 `https://github.com/<<您的用户名>>/vscode/settings/actions` 为您的 fork 禁用 Actions。

### 构建

使用 `npm` 安装和构建所有依赖项：

```
cd vscode
npm install
```

然后您有两个选择：

- 如果您想在 VS Code 内部构建，可以打开 `vscode` 文件夹，并使用 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>）启动构建任务。即使您关闭 VS Code，构建任务也会在后台持续运行。如果您碰巧关闭并重新打开 VS Code，只需再次按下 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>）即可恢复构建。您可以通过运行 `Kill Build VS Code` 任务或在任务终端中按 <kbd>Ctrl</kbd>+<kbd>D</kbd> 来终止它。
- 如果您想从终端构建，请运行 `npm run watch`。这将在单个终端中运行核心 watch 任务和 watch-extension 任务。

增量构建器将执行初始的完整构建，并在初始构建完成后显示包含"Finished compilation"短语的消息。构建器将监视文件更改并增量编译这些更改，为您提供快速、迭代的编码体验。

**故障排除：**

- **Windows：** 如果您安装了 Visual Studio 2017 作为构建工具，则需要打开 **x64 Native Tools Command Prompt for VS 2017**。如果已安装，请勿将其与 *VS2015 x64 Native Tools Command Prompt* 混淆。
- **Linux：** 运行构建时可能会遇到 ENOSPC 错误。要解决此问题，请遵循[常见问题](https://code.visualstudio.com/docs/setup/linux#_common-questions)中的说明。

如果构建步骤失败，或者构建的版本无法运行（请参阅下一节），请在您的 `vscode` 文件夹中运行 `git clean -xfd`，然后重新运行 `npm install`。

#### 错误和警告
在开发 VS Code 时，错误和警告将显示在控制台中。如果您使用 VS Code 开发 VS Code，错误和警告会显示在编辑器左下角的状态栏中。您可以使用 `View | Errors and Warnings` 或按 <kbd>Ctrl</kbd>+<kbd>P</kbd> 然后按 <kbd>!</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>P</kbd> 然后按 <kbd>!</kbd>）来查看错误列表。

👉 **提示！** 您无需在每次更改后停止并重新启动 VS Code 的开发版本。您只需从命令面板执行 `Reload Window`。我们喜欢为此命令分配键盘快捷键 <kbd>Ctrl</kbd>+<kbd>R</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>R</kbd>）。

### 运行

要测试更改，您可以在当前正在编辑的 `vscode` 工作区上启动 VS Code 的开发版本。

要使用远程测试更改，请在您的 Code - OSS 窗口中使用"TestResolver"，它会创建一个伪远程窗口。在命令面板中搜索 `TestResolver`。更多信息请参见 https://github.com/microsoft/vscode/issues/162874#issuecomment-1271774905。

#### 桌面

在 Electron 上运行，扩展在 NodeJS 中运行：

##### macOS 和 Linux

```bash
./scripts/code.sh
./scripts/code-cli.sh # 用于运行 CLI 命令（例如 --version）
```

##### Windows

```bat
.\scripts\code.bat
.\scripts\code-cli.bat
```

👉 **提示！** 如果您收到错误消息，指出该应用程序不是有效的 Electron 应用程序，这可能意味着您没有先运行 `npm run watch`。

#### VS Code for the Web

扩展和 UI 在浏览器中运行。

👉 除了 `npm run watch` 之外，还要运行 `npm run watch-web` 来为内置扩展构建 Web 部分。

##### macOS 和 Linux

```bash
./scripts/code-web.sh
```

##### Windows

```bat
.\scripts\code-web.bat
```
#### Code Server Web

UI 在浏览器中，扩展在 code server (NodeJS) 中运行：

##### macOS 和 Linux

```bash
./scripts/code-server.sh --launch
```

##### Windows

```bat
.\scripts\code-server.bat --launch
```

您可以通过 Dock 或任务栏中的以下图标来识别 VS Code 的开发版本 ("Code - OSS")：

[![VS Code 默认图标](https://i.imgur.com/D2CeX0y.png)](https://i.imgur.com/D2CeX0y.png)


### 调试
VS Code 采用多进程架构，您的代码在不同的进程中执行。

**渲染**进程在 Shell 窗口内运行 UI 代码。要调试在**渲染**进程中运行的代码，您可以使用 VS Code 或 Chrome 开发者工具。

#### 使用 VS Code
* 打开 `vscode` 仓库文件夹
* 从调试视图的启动下拉列表中选择 `VS Code` 启动配置，然后按 <kbd>F5</kbd>。


#### 使用 Chrome 开发者工具

* 在 VS Code 的开发实例中，从命令面板运行 `Developer: Toggle Developer Tools` 命令以启动 Chrome 工具。
* 也可以调试 VS Code 的发布版本，因为源代码链接到在线托管的 sourcemap。

[![sourcemaps](http://i.imgur.com/KU3TdjO.png)](http://i.imgur.com/KU3TdjO.png)

**扩展主机**进程运行由插件实现的代码。要调试在扩展主机进程中运行的扩展（包括与 VS Code 打包在一起的扩展），您可以使用 VS Code 本身。切换到调试视图，选择 `Attach to Extension Host` 配置，然后按 <kbd>F5</kbd>。

**搜索**进程可以进行调试，但必须先启动。在尝试附加之前，请按 <kbd>Ctrl</kbd>+<kbd>P</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>P</kbd>）启动搜索，否则附加将失败并超时。

### 自动化测试
通过在 `vscode` 文件夹中运行 `./scripts/test.sh`（在 Windows 上为 `scripts\test`）直接从终端运行单元测试。[测试 README](https://github.com/Microsoft/vscode/blob/main/test/README.md) 提供了有关如何运行和调试测试以及如何生成覆盖率报告的完整详细信息。

我们还有自动化 UI 测试。[冒烟测试 README](https://github.com/Microsoft/vscode/blob/main/test/smoke/README.md) 包含所有详细信息。

### 单元测试
通过在 `vscode` 文件夹中运行 `./scripts/test.sh`（在 Windows 上为 `scripts\test`）直接从终端运行测试。[测试 README](https://github.com/Microsoft/vscode/blob/main/test/README.md) 提供了有关如何运行和调试测试以及如何生成覆盖率报告的完整详细信息。

### Linting（代码检查）
我们使用 [eslint](https://eslint.org/) 来检查我们的源代码。您可以通过从终端或命令提示符调用 `npm run eslint` 来对源代码运行 eslint。您还可以通过按 <kbd>Ctrl</kbd>+<kbd>P</kbd>（在 macOS 上为 <kbd>CMD</kbd>+<kbd>P</kbd>）并输入 `task eslint` 将 `npm run eslint` 作为 VS Code 任务运行。

要在进行更改时检查源代码，您可以安装 [eslint 扩展](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)。

### 扩展
Visual Studio Marketplace 在 `vscode` 开源构建中不可用。如果您需要使用或调试扩展，您可以检查扩展作者是否在其仓库中发布了构建版本（检查 `Builds` 页面），或者如果它是开源的，您可以在本地克隆并构建该扩展。获得 .VSIX 文件后，您可以通过命令行或使用扩展视图命令下拉菜单中的 **Install from VSIX** 命令来"旁加载"该扩展（有关命令行扩展管理的更多信息，请参阅[此处](https://code.visualstudio.com/docs/editor/extension-gallery#_command-line-extension-management)）。

## 工作分支
即使您对 Microsoft/vscode 仓库拥有推送权限，您也应该创建一个个人 fork，并在需要时在那里创建功能分支。这样可以保持主仓库的整洁，并将您的个人工作流程的杂乱内容隐藏起来。

## Pull Requests
在我们接受您的 pull request 之前，您需要签署一份[[贡献者许可协议 (CLA)|Contributor-License-Agreement]]。这是一个自动化的过程，您只需要做一次。

为了使我们能够快速审查和接受您的 pull request，请始终为每个 issue 创建一个 pull request，并在 [pull request 中链接该 issue](https://github.com/blog/957-introducing-issue-mentions)。除非多个请求具有相同的根本原因，否则切勿将它们合并到一个请求中。请务必遵循我们的[[编码准则|Coding-Guidelines]]，并使代码更改尽可能小。避免对未修改的代码进行纯格式化更改。Pull request 应尽可能包含测试。

### 通过 PR 引入新的 Electron API 用法
依赖于 VS Code 当前未使用的 Electron API 的 pull request 带有一定的风险，可能会被拒绝。每当我们更新 Electron 时，不太流行的 Electron API 就有可能中断，而且很难事先发现。一旦 PR 合并到 VS Code 中，维护该功能的角色就转移到了团队，因此我们必须与上游组件跟进以确保该功能仍然受支持。因此，经验法则是：
* 避免使用 Electron API，改用 Web 标准（这也确保您的功能在我们的 Web 客户端中得到支持）
* 如果您必须使用 Electron API，我们需要在 https://github.com/electron/electron 进行单元测试，以防止将来出现中断。

### 在何处贡献
查看[完整的 issues 列表](https://github.com/Microsoft/vscode/issues?utf8=%E2%9C%93&q=is%3Aopen+is%3Aissue)，了解所有可能的贡献领域。请注意，仅仅因为存储库中存在某个 issue，并不意味着我们会接受对其核心编辑器的贡献。我们可能不接受 pull request 的原因有多种，例如：

* 性能 - Visual Studio Code 的核心价值之一是提供一个*轻量级*的代码编辑器，这意味着它在实际和感知性能方面都应该表现良好。
* 用户体验 - 由于我们希望提供一个*轻量级*的代码编辑器，UX 也应该感觉轻量级，而不是杂乱无章。对 UI 的大多数更改都应经过 issue 负责人和/或 UX 团队的审查。
* 架构 - 团队和/或功能负责人需要同意更改可能带来的任何架构影响。像新的扩展 API 这样的东西*必须*与功能负责人讨论并获得其同意。

为了提高 pull request 被合并的机会，您应该选择标有 [`help-wanted`](https://github.com/Microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22) 或 [`bug`](https://github.com/Microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3A%22bug%22) 标签的 issue。如果您想处理的 issue 没有标记为 `help-wanted` 或 `bug`，您可以与 issue 负责人开始对话，询问是否会考虑外部贡献。

为避免多个 pull request 解决同一个 issue，请通过评论告知其他人您正在处理该 issue。

### 拼写检查错误

欢迎修复**可翻译字符串**（`nls.localize(...)` 调用中的字符串）中拼写检查错误的 pull request，但请确保它不涉及多个[功能区域](https://github.com/microsoft/vscode/wiki/Feature-Areas)，否则将难以审查。**不建议**仅修复源代码中拼写检查错误的 pull request。

## 打包

VS Code 可以打包用于以下平台：`win32-ia32 | win32-x64 | darwin-x64 | darwin-arm64 | linux-ia32 | linux-x64 | linux-arm`

可以使用以下 `gulp` 任务：

* `vscode-[platform]`: 为 `[platform]` 构建打包版本。
* `vscode-[platform]-min`: 为 `[platform]` 构建打包和压缩版本。

👉 **提示！** 通过 `npm` 运行 `gulp` 以避免潜在的内存不足问题，例如 `npm run gulp vscode-linux-x64`

另请参阅：[为基于 Debian 的 Linux 进行交叉编译](https://github.com/Microsoft/vscode/wiki/Cross-Compiling-for-Debian-Based-Linux)

## 建议
我们对您关于 VS Code 未来的反馈也很感兴趣。您可以通过 issue tracker 提交建议或功能请求。为了使这个过程更有效，我们要求这些建议包含更多信息以帮助更清晰地定义它们。

## 翻译
我们通过我们的[本地化仓库](https://github.com/Microsoft/vscode-loc/issues)中的 GitHub issues 接受对语言包翻译的反馈，该仓库包含我们当前支持的语言包。

## 讨论礼仪

为了保持对话清晰透明，请将讨论限制在英语，并围绕 issue 主题进行。请体谅他人，并始终保持礼貌和专业。
