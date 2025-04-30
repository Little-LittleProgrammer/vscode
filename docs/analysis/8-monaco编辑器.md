# Monaco 编辑器

Monaco 编辑器是 VSCode 的核心组件，提供了代码编辑的核心功能。它不仅是 VSCode 的基础，也可以作为独立组件在 Web 应用中使用。

## 架构概述

Monaco 编辑器采用模块化设计，分为以下几个核心层次：

### 1. 编辑器核心 (Editor Core)

位于 `src/vs/editor/common` 目录，提供编辑器的核心数据结构和模型：

```ts
// 位置表示
export class Position implements IPosition {
  readonly lineNumber: number;
  readonly column: number;

  constructor(lineNumber: number, column: number) {
    this.lineNumber = lineNumber;
    this.column = column;
  }

  // 位置比较
  isBefore(other: IPosition): boolean {
    return Position.isBefore(this, other);
  }

  // 静态工具方法
  static isBefore(a: IPosition, b: IPosition): boolean {
    if (a.lineNumber < b.lineNumber) {
      return true;
    }
    if (b.lineNumber < a.lineNumber) {
      return false;
    }
    return a.column < b.column;
  }
}

// 范围表示
export class Range implements IRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;

  constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
  }

  // 范围是否包含位置
  containsPosition(position: IPosition): boolean {
    return Range.containsPosition(this, position);
  }
}
```

### 2. 文本模型 (Text Model)

管理编辑器的文本内容和编辑操作：

```ts
export class TextModel implements ITextModel {
  private readonly _lines: TextBuffer;

  // 获取文本行
  getLineContent(lineNumber: number): string {
    return this._lines.getLineContent(lineNumber);
  }

  // 获取值
  getValue(eol?: EndOfLinePreference, preserveBOM?: boolean): string {
    return this._lines.getValue(eol);
  }

  // 编辑操作
  pushEditOperations(
    beforeCursorState: Selection[] | null,
    editOperations: IIdentifiedSingleEditOperation[],
    cursorStateComputer: ICursorStateComputer
  ): Selection[] | null {
    // 应用编辑操作
    // 计算新的光标位置
    // 触发模型变更事件
    // ...
  }
}
```

### 3. 编辑器视图 (Editor View)

处理文本渲染、滚动、光标和选择等界面元素：

```ts
export class View extends ViewEventHandler {
  private readonly _scrollbar: ScrollableElement;
  private readonly _viewLines: ViewLines;

  // 处理视图布局
  layout(dimensions: IDimension): void {
    // 更新视图尺寸
    // 重新布局滚动条
    // 重新计算可见行
    // ...
  }

  // 渲染视图
  render(viewportData: IViewportData): void {
    this._viewLines.renderViewportData(viewportData);
  }
}
```

## 核心功能实现

### 1. 文本编辑和操作

Monaco 编辑器通过编辑操作抽象实现文本编辑：

```ts
// 编辑操作接口
export interface ITextEdit {
  range: IRange;
  text: string;
  forceMoveMarkers?: boolean;
}

// 应用编辑操作
function applyEdits(model: ITextModel, edits: ITextEdit[]): void {
  model.pushEditOperations(
    null,
    edits.map(edit => ({
      range: edit.range,
      text: edit.text,
      forceMoveMarkers: edit.forceMoveMarkers
    })),
    () => null
  );
}
```

### 2. 语法高亮

通过可扩展的 Token Provider 系统实现语法高亮：

```ts
// 语法标记提供者
export interface ITokenizationSupport {
  getInitialState(): IState;
  tokenize(line: string, state: IState): ITokenizationResult;
}

// 注册语法高亮提供者
export function registerTokenizationSupport(languageId: string, support: ITokenizationSupport): IDisposable {
  return TokenizationRegistry.register(languageId, support);
}

// 使用示例：注册 JavaScript 语法高亮
registerTokenizationSupport('javascript', {
  getInitialState: () => new JSState(),
  tokenize: (line, state) => {
    // 分析行内容，返回标记结果
    return {
      tokens: [...], // 标记数组
      endState: newState // 行末状态
    };
  }
});
```

### 3. 代码自动补全

通过 Suggestion Provider 实现代码补全功能：

```ts
// 补全项提供者
export interface ISuggestProvider {
  provideCompletionItems(
    model: ITextModel,
    position: Position,
    context: CompletionContext
  ): ProviderResult<CompletionList>;
}

// 注册补全提供者
export function registerCompletionItemProvider(
  languageId: string,
  provider: ISuggestProvider
): IDisposable {
  return SuggestRegistry.register(languageId, provider);
}

// 使用示例
registerCompletionItemProvider('typescript', {
  provideCompletionItems: (model, position) => {
    // 分析代码上下文
    // 返回补全建议列表
    return {
      items: [
        {
          label: 'console',
          kind: CompletionItemKind.Method,
          insertText: 'console',
          detail: 'Console object'
        },
        // 更多补全项...
      ]
    };
  }
});
```

### 4. 错误诊断和问题标记

通过 Marker 系统显示问题和诊断信息：

```ts
// 标记数据
export interface IMarkerData {
  severity: MarkerSeverity;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// 设置标记
export function setModelMarkers(model: ITextModel, owner: string, markers: IMarkerData[]): void {
  // 内部实现：更新模型的标记数据
  // 触发标记变更事件
}

// 使用示例：设置语法错误标记
setModelMarkers(model, 'typescript', [
  {
    severity: MarkerSeverity.Error,
    message: 'Cannot find name "foo"',
    startLineNumber: 10,
    startColumn: 5,
    endLineNumber: 10,
    endColumn: 8
  }
]);
```

## 编辑器扩展点

### 1. 编辑器贡献 (Contributions)

Monaco 编辑器提供了多种扩展点，允许添加自定义功能：

```ts
// 注册编辑器动作
export function registerEditorAction(action: EditorAction): IDisposable {
  return EditorContributionRegistry.registerEditorAction(action);
}

// 自定义编辑器动作示例
class FormatCodeAction extends EditorAction {
  constructor() {
    super({
      id: 'editor.action.formatDocument',
      label: 'Format Document',
      alias: 'Format Document',
      precondition: undefined
    });
  }

  run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
    // 获取格式化服务
    const formatService = accessor.get(IEditorFormatService);
    // 执行格式化
    return formatService.formatDocument(editor.getModel());
  }
}

// 注册动作
registerEditorAction(new FormatCodeAction());
```

### 2. 编辑器命令

注册可通过快捷键或命令面板调用的编辑器命令：

```ts
// 注册编辑器命令
export function registerEditorCommand<T>(command: EditorCommand): IDisposable {
  return EditorContributionRegistry.registerEditorCommand(command);
}

// 命令示例
registerEditorCommand(new class extends EditorCommand {
  constructor() {
    super({
      id: 'editor.action.commentLine',
      precondition: undefined,
      kbOpts: {
        primary: KeyMod.CtrlCmd | KeyCode.Slash
      }
    });
  }

  runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor): void {
    // 获取注释服务
    const commentService = accessor.get(ICommentService);
    // 执行注释操作
    commentService.toggleLineComment(editor.getModel(), editor.getSelection());
  }
});
```

## 主题和样式

Monaco 编辑器支持自定义主题，控制语法高亮和界面外观：

```ts
// 定义主题
export function defineTheme(themeName: string, themeData: IStandaloneThemeData): void {
  StandaloneThemeService.defineTheme(themeName, themeData);
}

// 设置主题
export function setTheme(themeName: string): void {
  StandaloneThemeService.setTheme(themeName);
}

// 使用示例：定义暗色主题
defineTheme('myDarkTheme', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A9955' },
    { token: 'keyword', foreground: '569CD6' }
  ],
  colors: {
    'editor.background': '#1E1E1E',
    'editor.foreground': '#D4D4D4'
  }
});

// 使用自定义主题
setTheme('myDarkTheme');
```

## Web 集成

Monaco 编辑器可以作为独立组件在 Web 应用中使用：

```javascript
// 创建编辑器实例
const editor = monaco.editor.create(document.getElementById('container'), {
  value: 'function hello() {\n\tconsole.log("Hello world!");\n}',
  language: 'javascript',
  theme: 'vs-dark'
});

// 获取/设置值
const code = editor.getValue();
editor.setValue('// New code');

// 监听变化
editor.onDidChangeModelContent(event => {
  console.log('Content changed:', event);
});

// 处理编辑器布局
window.addEventListener('resize', () => {
  editor.layout();
});
```

Monaco 编辑器作为 VSCode 的核心组件，提供了丰富的编辑功能和可扩展接口，使 VSCode 能够支持数百种编程语言和各种编程场景。其模块化设计和清晰的架构，允许它不仅在 VSCode 中使用，也可以嵌入到各种 Web 应用中，成为当前最强大的开源代码编辑器之一。
