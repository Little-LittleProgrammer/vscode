# VS Code Copilot 指南

## 项目概述

Visual Studio Code 采用分层架构，使用 TypeScript、Web API 和 Electron 构建，将 Web 技术与原生应用功能相结合。代码库按照以下关键架构层组织：

### 根目录
- `src/`：主要 TypeScript 源代码，单元测试位于 `src/vs/*/test/` 文件夹中
- `build/`：构建脚本和 CI/CD 工具
- `extensions/`：随 VS Code 一起发布的内置扩展
- `test/`：集成测试和测试基础设施
- `scripts/`：开发和构建脚本
- `resources/`：静态资源（图标、主题等）
- `out/`：编译后的 JavaScript 输出（构建过程中生成）

### 核心架构（`src/` 文件夹）
- `src/vs/base/` - 基础工具和跨平台抽象
- `src/vs/platform/` - 平台服务和依赖注入基础设施
- `src/vs/editor/` - 文本编辑器实现，包括语言服务、语法高亮和编辑功能
- `src/vs/workbench/` - Web 和桌面版的主应用工作台
  - `workbench/browser/` - 核心工作台 UI 组件（部件、布局、操作）
  - `workbench/services/` - 服务实现
  - `workbench/contrib/` - 功能贡献（git、调试、搜索、终端等）
  - `workbench/api/` - 扩展宿主和 VS Code API 实现
- `src/vs/code/` - Electron 主进程特定实现
- `src/vs/server/` - 服务器特定实现

核心架构遵循以下原则：
- **分层架构** - 从 `base`、`platform`、`editor` 到 `workbench`
- **依赖注入** - 通过构造函数参数注入服务
- **贡献模型** - 功能通过注册表和扩展点进行贡献
- **跨平台兼容性** - 抽象分离平台特定代码

### 内置扩展（`extensions/` 文件夹）
`extensions/` 目录包含随 VS Code 一起发布的第一方扩展：
- **语言支持** - `typescript-language-features/`、`html-language-features/`、`css-language-features/` 等
- **核心功能** - `git/`、`debug-auto-launch/`、`emmet/`、`markdown-language-features/`
- **主题** - 默认颜色主题的 `theme-*` 文件夹
- **开发工具** - `extension-editing/`、`vscode-api-tests/`

每个扩展都遵循标准 VS Code 扩展结构，包含 `package.json`、TypeScript 源代码，以及通过扩展 API 来扩展工作台的贡献点。

### 查找相关代码
1. **首先进行语义搜索**：使用文件搜索查找一般概念
2. **使用 grep 搜索精确字符串**：用于错误消息或特定函数名称
3. **跟踪导入**：检查哪些文件导入了有问题的模块
4. **检查测试文件**：通常能揭示使用模式和预期行为

## 编码规范

### 缩进

我们使用制表符（tabs），而不是空格。

### 命名约定

- 对 `类型（type）` 名称使用大驼峰命名法（PascalCase）
- 对 `枚举（enum）` 值使用大驼峰命名法
- 对 `函数（function）` 和 `方法（method）` 名称使用小驼峰命名法（camelCase）
- 对 `属性（property）` 名称和 `局部变量` 使用小驼峰命名法
- 尽可能在名称中使用完整单词

### 类型

- 除非需要在多个组件之间共享，否则不要导出 `类型` 或 `函数`
- 不要向全局命名空间引入新的 `类型` 或 `值`

### 注释

- 对 `函数`、`接口`、`枚举` 和 `类` 使用 JSDoc 风格的注释

### 字符串

- 对需要外部化（本地化）的、显示给用户的字符串使用"双引号"
- 其他情况使用'单引号'
- 所有对用户可见的字符串都需要外部化处理

### UI 标签
- 对命令标签、按钮和菜单项使用标题风格的大写（每个单词首字母大写）
- 不要对四个或更少字母的介词大写，除非它是第一个或最后一个单词（例如"in"、"with"、"for"）。

### 代码风格

- 优先使用箭头函数 `=>` 而不是匿名函数表达式
- 只在必要时才给箭头函数参数加括号。例如，`(x) => x + x` 是错误的，但以下写法是正确的：

```typescript
x => x + x
(x, y) => x + y
<T>(x: T, y: T) => x === y
```

- 始终用花括号包围循环和条件语句的主体
- 左花括号总是与引起它们的语句在同一行
- 带括号的结构不应有周围的空白。逗号、冒号和分号后跟一个空格。例如：

```typescript
for (let i = 0, n = str.length; i < 10; i++) {
    if (x < 10) {
        foo();
    }
}
function f(x: number, y: string): void { }
```

- 尽可能在顶级作用域使用 `export function x(…) {…}` 而不是 `export const x = (…) => {…}`。使用 `function` 关键字的一个优势是在调试时堆栈跟踪会显示更好的名称。

### 代码质量

- 所有文件必须包含 Microsoft 版权头
- 优先使用 `async` 和 `await` 而不是 `Promise` 和 `then` 调用
- 所有面向用户的消息必须使用适用的本地化框架进行本地化处理（例如 `nls.localize()` 方法）
- 不要将测试添加到错误的测试套件中（例如，添加到文件末尾而不是相关套件内）
- 在创建新结构之前查看现有测试模式
- 一致地使用 `describe` 和 `test` 与现有模式保持一致
- 如果创建任何临时新文件、脚本或帮助文件用于迭代，请在任务结束时通过删除它们来清理这些文件
