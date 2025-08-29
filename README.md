# Visual Studio Code - 开源版本 ("Code - OSS")

[![功能请求](https://img.shields.io/github/issues/microsoft/vscode/feature-request.svg)](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
[![Bug](https://img.shields.io/github/issues/microsoft/vscode/bug.svg)](https://github.com/microsoft/vscode/issues?utf8=✓&q=is%3Aissue+is%3Aopen+label%3Abug)
[![Gitter](https://img.shields.io/badge/chat-on%20gitter-yellow.svg)](https://gitter.im/Microsoft/vscode)

## 代码仓库

本代码仓库（"`Code - OSS`"）是我们（微软）与社区一起开发 [Visual Studio Code](https://code.visualstudio.com) 产品的地方。我们不仅在这里进行代码开发和问题处理，还发布我们的[路线图](https://github.com/microsoft/vscode/wiki/Roadmap)、[月度迭代计划](https://github.com/microsoft/vscode/wiki/Iteration-Plans)和[最终发布计划](https://github.com/microsoft/vscode/wiki/Running-the-Endgame)。这份源代码以标准 [MIT 许可证](https://github.com/microsoft/vscode/blob/main/LICENSE.txt)对所有人开放。

## Visual Studio Code

<p align="center">
  <img alt="VS Code 运行中" src="https://user-images.githubusercontent.com/35271042/118224532-3842c400-b438-11eb-923d-a5f66fa6785a.png">
</p>

[Visual Studio Code](https://code.visualstudio.com) 是 `Code - OSS` 代码仓库的一个分发版本，包含微软特定的定制，并在传统的 [Microsoft 产品许可](https://code.visualstudio.com/License/) 下发布。

[Visual Studio Code](https://code.visualstudio.com) 将代码编辑器的简洁性与开发者核心编辑-构建-调试周期所需的功能相结合。它提供全面的代码编辑、导航和理解支持，以及轻量级调试、丰富的扩展模型和与现有工具的轻量级集成。

Visual Studio Code 每月更新，包含新功能和错误修复。您可以在 [Visual Studio Code 网站](https://code.visualstudio.com/Download) 上下载适用于 Windows、macOS 和 Linux 的版本。要获取每日最新版本，请安装 [Insiders 构建版](https://code.visualstudio.com/insiders)。

## 参与贡献

您可以通过多种方式参与此项目，例如：

* [提交 bug 和功能请求](https://github.com/microsoft/vscode/issues)，并在问题被检查时帮助我们验证
* 审查[源代码变更](https://github.com/microsoft/vscode/pulls)
* 审查[文档](https://github.com/microsoft/vscode-docs)并提交拉取请求，包括修正错别字、补充和新内容

如果您有兴趣修复问题并直接向代码库贡献，请参阅 [如何贡献](https://github.com/microsoft/vscode/wiki/How-to-Contribute) 文档，其中包括：

* [如何从源代码构建和运行](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
* [开发工作流，包括调试和运行测试](https://github.com/microsoft/vscode/wiki/How-to-Contribute#debugging)
* [编码指南](https://github.com/microsoft/vscode/wiki/Coding-Guidelines)
* [提交拉取请求](https://github.com/microsoft/vscode/wiki/How-to-Contribute#pull-requests)
* [寻找可处理的问题](https://github.com/microsoft/vscode/wiki/How-to-Contribute#where-to-contribute)
* [参与翻译](https://aka.ms/vscodeloc)

## 反馈

* 在 [Stack Overflow](https://stackoverflow.com/questions/tagged/vscode) 上提问
* [请求新功能](CONTRIBUTING.md)
* 为[热门功能请求](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)投票
* [提交问题](https://github.com/microsoft/vscode/issues)
* 在 [GitHub Discussions](https://github.com/microsoft/vscode-discussions/discussions) 或 [Slack](https://aka.ms/vscode-dev-community) 上与扩展开发者社区联系
* 关注 [@code](https://twitter.com/code) 并告诉我们您的想法！

查看我们的 [wiki](https://github.com/microsoft/vscode/wiki/Feedback-Channels)，了解每个渠道的描述以及一些其他可用的社区驱动渠道的信息。

## 相关项目

VS Code 的许多核心组件和扩展都在 GitHub 上有自己的代码仓库。例如，[node debug adapter](https://github.com/microsoft/vscode-node-debug) 和 [mono debug adapter](https://github.com/microsoft/vscode-mono-debug) 代码仓库是彼此独立的。有关完整列表，请访问我们 [wiki](https://github.com/microsoft/vscode/wiki) 上的 [相关项目](https://github.com/microsoft/vscode/wiki/Related-Projects) 页面。

## 内置扩展

VS Code 包含一组位于 [extensions](extensions) 文件夹中的内置扩展，包括许多语言的语法和代码片段。为语言提供丰富支持（代码补全、转到定义）的扩展带有 `language-features` 后缀。例如，`json` 扩展为 `JSON` 提供着色，而 `json-language-features` 扩展为 `JSON` 提供丰富的语言支持。

## 开发容器

此代码仓库包含一个 Visual Studio Code Dev Containers / GitHub Codespaces 开发容器。

* 对于 [Dev Containers](https://aka.ms/vscode-remote/download/containers)，使用 **Dev Containers: Clone Repository in Container Volume...** 命令，它会创建一个 Docker 卷以在 macOS 和 Windows 上获得更好的磁盘 I/O。
  * 如果您已安装 VS Code 和 Docker，您也可以点击[这里](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode)开始。这将使 VS Code 自动安装 Dev Containers 扩展（如果需要）、将源代码克隆到容器卷中，并启动一个开发容器。

* 对于 Codespaces，在 VS Code 中安装 [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) 扩展，并使用 **Codespaces: Create New Codespace** 命令。

Docker / Codespace 应该至少有 **4 个核心和 6 GB 内存（推荐 8 GB）**以运行完整构建。有关更多信息，请参阅[开发容器 README](.devcontainer/README.md)。

## 行为准则

本项目采用了 [Microsoft 开源行为准则](https://opensource.microsoft.com/codeofconduct/)。有关更多信息，请参阅[行为准则常见问题解答](https://opensource.microsoft.com/codeofconduct/faq/)或联系 [opencode@microsoft.com](mailto:opencode@microsoft.com) 获取任何其他问题或意见。

## 许可证

版权所有 (c) Microsoft Corporation。保留所有权利。

基于 [MIT](LICENSE.txt) 许可证授权。
