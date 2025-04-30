/*---------------------------------------------------------------------------------------------
 *  文件主要作用：实现了VSCode窗口管理的核心类，包括BaseWindow基类和CodeWindow具体实现，负责窗口的创建、加载、状态管理、消息通信等
 *  Copyright (c) Microsoft Corporation. 保留所有权利。
 *  使用MIT许可证。有关许可信息，请参阅项目根目录中的License.txt。
 *--------------------------------------------------------------------------------------------*/

import electron, { BrowserWindowConstructorOptions } from 'electron';
import { DeferredPromise, RunOnceScheduler, timeout, Delayer } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../base/common/network.js';
import { getMarks, mark } from '../../../base/common/performance.js';
import { isBigSurOrNewer, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { release } from 'os';
import { ISerializableCommandAction } from '../../action/common/action.js';
import { IBackupMainService } from '../../backup/electron-main/backup.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../configuration/common/configuration.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { isLaunchedFromCli } from '../../environment/node/argvHelper.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IIPCObjectUrl, IProtocolMainService } from '../../protocol/electron-main/protocol.js';
import { resolveMarketplaceHeaders } from '../../externalServices/common/marketplace.js';
import { IApplicationStorageMainService, IStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { getMenuBarVisibility, IFolderToOpen, INativeWindowConfiguration, IWindowSettings, IWorkspaceToOpen, MenuBarVisibility, hasNativeTitlebar, useNativeFullScreen, useWindowControlsOverlay, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, TitlebarStyle } from '../../window/common/window.js';
import { defaultBrowserWindowOptions, getAllWindowsExcludingOffscreen, IWindowsMainService, OpenContext, WindowStateValidator } from './windows.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, toWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IWorkspacesManagementMainService } from '../../workspaces/electron-main/workspacesManagementMainService.js';
import { IWindowState, ICodeWindow, ILoadEvent, WindowMode, WindowError, LoadReason, defaultWindowState, IBaseWindow } from '../../window/electron-main/window.js';
import { IPolicyService } from '../../policy/common/policy.js';
import { IUserDataProfile } from '../../userDataProfile/common/userDataProfile.js';
import { IStateService } from '../../state/node/state.js';
import { IUserDataProfilesMainService } from '../../userDataProfile/electron-main/userDataProfile.js';
import { ILoggerMainService } from '../../log/electron-main/loggerService.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { errorHandler } from '../../../base/common/errors.js';

export interface IWindowCreationOptions {
	readonly state: IWindowState;
	readonly extensionDevelopmentPath?: string[];
	readonly isExtensionTestHost?: boolean;
}

interface ITouchBarSegment extends electron.SegmentedControlSegment {
	readonly id: string;
}

interface ILoadOptions {
	readonly isReload?: boolean;
	readonly disableExtensions?: boolean;
}

/**
 * 窗口就绪状态枚举
 */
const enum ReadyState {

	/**
	 * 此窗口尚未加载任何内容，
	 * 这是每个窗口的初始状态。
	 */
	NONE,

	/**
	 * 此窗口正在导航中，可能是首次
	 * 导航或后续导航。
	 */
	NAVIGATING,

	/**
	 * 此窗口已完成加载并已准备好
	 * 将IPC请求转发到Web内容。
	 */
	READY
}

export abstract class BaseWindow extends Disposable implements IBaseWindow {

	//#region 事件

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidMaximize = this._register(new Emitter<void>());
	readonly onDidMaximize = this._onDidMaximize.event;

	private readonly _onDidUnmaximize = this._register(new Emitter<void>());
	readonly onDidUnmaximize = this._onDidUnmaximize.event;

	private readonly _onDidTriggerSystemContextMenu = this._register(new Emitter<{ x: number; y: number }>());
	readonly onDidTriggerSystemContextMenu = this._onDidTriggerSystemContextMenu.event;

	private readonly _onDidEnterFullScreen = this._register(new Emitter<void>());
	readonly onDidEnterFullScreen = this._onDidEnterFullScreen.event;

	private readonly _onDidLeaveFullScreen = this._register(new Emitter<void>());
	readonly onDidLeaveFullScreen = this._onDidLeaveFullScreen.event;

	//#endregion

	abstract readonly id: number;

	protected _lastFocusTime = Date.now(); // 窗口在创建时显示，因此取当前时间
	get lastFocusTime(): number { return this._lastFocusTime; }

	protected _win: electron.BrowserWindow | null = null;
	get win() { return this._win; }
	protected setWin(win: electron.BrowserWindow, options?: BrowserWindowConstructorOptions): void {
		this._win = win;

		// 窗口事件
		this._register(Event.fromNodeEventEmitter(win, 'maximize')(() => this._onDidMaximize.fire()));
		this._register(Event.fromNodeEventEmitter(win, 'unmaximize')(() => this._onDidUnmaximize.fire()));
		this._register(Event.fromNodeEventEmitter(win, 'closed')(() => {
			this._onDidClose.fire();

			this.dispose();
		}));
		this._register(Event.fromNodeEventEmitter(win, 'focus')(() => {
			this._lastFocusTime = Date.now();
		}));
		this._register(Event.fromNodeEventEmitter(this._win, 'enter-full-screen')(() => this._onDidEnterFullScreen.fire()));
		this._register(Event.fromNodeEventEmitter(this._win, 'leave-full-screen')(() => this._onDidLeaveFullScreen.fire()));

		// Sheet 偏移量
		const useCustomTitleStyle = !hasNativeTitlebar(this.configurationService, options?.titleBarStyle === 'hidden' ? TitlebarStyle.CUSTOM : undefined /* unknown */);
		if (isMacintosh && useCustomTitleStyle) {
			win.setSheetOffset(isBigSurOrNewer(release()) ? 28 : 22); // 如果有自定义标题栏，则根据自定义标题栏的高度偏移对话框
		}

		// 根据缓存或默认值立即更新窗口控件
		if (useCustomTitleStyle && useWindowControlsOverlay(this.configurationService)) {
			const cachedWindowControlHeight = this.stateService.getItem<number>((BaseWindow.windowControlHeightStateStorageKey));
			if (cachedWindowControlHeight) {
				this.updateWindowControls({ height: cachedWindowControlHeight });
			} else {
				this.updateWindowControls({ height: DEFAULT_CUSTOM_TITLEBAR_HEIGHT });
			}
		}

		// 设置Windows系统上下文菜单，使其仅在特定情况下允许使用
		if (isWindows && useCustomTitleStyle) {
			this._register(Event.fromNodeEventEmitter(win, 'system-context-menu', (event: Electron.Event, point: Electron.Point) => ({ event, point }))((e) => {
				const [x, y] = win.getPosition();
				const cursorPos = electron.screen.screenToDipPoint(e.point);
				const cx = Math.floor(cursorPos.x) - x;
				const cy = Math.floor(cursorPos.y) - y;

				// 在某些情况下，显示默认系统上下文菜单
				// 1) 鼠标位置不在标题栏内
				// 2) 鼠标位置在标题栏内，但在应用图标上
				// 我们无法确切知道标题栏的高度，但我们根据窗口高度进行估计
				const shouldTriggerDefaultSystemContextMenu = () => {
					// 当鼠标在标题栏上但不在应用图标上时使用自定义上下文菜单
					// 应用图标估计宽度为30px
					// 标题栏高度估计为窗口高度的15%，至少35px
					if (cx > 30 && cy >= 0 && cy <= Math.max(win.getBounds().height * 0.15, 35)) {
						return false;
					}

					return true;
				};

				if (!shouldTriggerDefaultSystemContextMenu()) {
					e.event.preventDefault();

					this._onDidTriggerSystemContextMenu.fire({ x: cx, y: cy });
				}
			}));
		}

		// 如果命令行参数指示，则打开开发者工具
		if (this.environmentMainService.args['open-devtools'] === true) {
			win.webContents.openDevTools();
		}

		// macOS: 窗口全屏过渡
		if (isMacintosh) {
			this._register(this.onDidEnterFullScreen(() => {
				this.joinNativeFullScreenTransition?.complete(true);
			}));

			this._register(this.onDidLeaveFullScreen(() => {
				this.joinNativeFullScreenTransition?.complete(true);
			}));
		}
	}

	constructor(
		protected readonly configurationService: IConfigurationService,
		protected readonly stateService: IStateService,
		protected readonly environmentMainService: IEnvironmentMainService,
		protected readonly logService: ILogService
	) {
		super();
	}

	protected applyState(state: IWindowState, hasMultipleDisplays = electron.screen.getAllDisplays().length > 0): void {

		// TODO@electron (Electron 4 regression): when running on multiple displays where the target display
		// to open the window has a larger resolution than the primary display, the window will not size
		// correctly unless we set the bounds again (https://github.com/microsoft/vscode/issues/74872)
		//
		// Extended to cover Windows as well as Mac (https://github.com/microsoft/vscode/issues/146499)
		//
		// However, when running with native tabs with multiple windows we cannot use this workaround
		// because there is a potential that the new window will be added as native tab instead of being
		// a window on its own. In that case calling setBounds() would cause https://github.com/microsoft/vscode/issues/75830

		const windowSettings = this.configurationService.getValue<IWindowSettings | undefined>('window');
		const useNativeTabs = isMacintosh && windowSettings?.nativeTabs === true;
		if ((isMacintosh || isWindows) && hasMultipleDisplays && (!useNativeTabs || getAllWindowsExcludingOffscreen().length === 1)) {
			if ([state.width, state.height, state.x, state.y].every(value => typeof value === 'number')) {
				this._win?.setBounds({
					width: state.width,
					height: state.height,
					x: state.x,
					y: state.y
				});
			}
		}

		if (state.mode === WindowMode.Maximized || state.mode === WindowMode.Fullscreen) {

			// this call may or may not show the window, depends
			// on the platform: currently on Windows and Linux will
			// show the window as active. To be on the safe side,
			// we show the window at the end of this block.
			this._win?.maximize();

			if (state.mode === WindowMode.Fullscreen) {
				this.setFullScreen(true, true);
			}

			// to reduce flicker from the default window size
			// to maximize or fullscreen, we only show after
			this._win?.show();
		}
	}

	private representedFilename: string | undefined;

	setRepresentedFilename(filename: string): void {
		if (isMacintosh) {
			this.win?.setRepresentedFilename(filename);
		} else {
			this.representedFilename = filename;
		}
	}

	getRepresentedFilename(): string | undefined {
		if (isMacintosh) {
			return this.win?.getRepresentedFilename();
		}

		return this.representedFilename;
	}

	private documentEdited: boolean | undefined;

	setDocumentEdited(edited: boolean): void {
		if (isMacintosh) {
			this.win?.setDocumentEdited(edited);
		}

		this.documentEdited = edited;
	}

	isDocumentEdited(): boolean {
		if (isMacintosh) {
			return Boolean(this.win?.isDocumentEdited());
		}

		return !!this.documentEdited;
	}

	/**
	 * 使窗口获取焦点
	 * @param options 焦点选项
	 */
	focus(options?: { force: boolean }): void {
		if (isMacintosh && options?.force) {
			electron.app.focus({ steal: true });
		}

		const win = this.win;
		if (!win) {
			return;
		}

		if (win.isMinimized()) {
			win.restore();
		}

		win.focus();
	}

	//#region Window Control Overlays

	private static readonly windowControlHeightStateStorageKey = 'windowControlHeight';

	/**
	 * 更新窗口控制按钮
	 */
	updateWindowControls(options: { height?: number; backgroundColor?: string; foregroundColor?: string }): void {
		const win = this.win;
		if (!win) {
			return;
		}

		// 缓存高度以便在启动时快速查找
		if (options.height) {
			this.stateService.setItem((CodeWindow.windowControlHeightStateStorageKey), options.height);
		}

		// Windows/Linux: 通过setTitleBarOverlay()更新窗口控件
		if (!isMacintosh && useWindowControlsOverlay(this.configurationService)) {
			win.setTitleBarOverlay({
				color: options.backgroundColor?.trim() === '' ? undefined : options.backgroundColor,
				symbolColor: options.foregroundColor?.trim() === '' ? undefined : options.foregroundColor,
				height: options.height ? options.height - 1 : undefined // 考虑窗口边框
			});
		}

		// macOS: 通过setWindowButtonPosition()更新窗口控件
		else if (isMacintosh && options.height !== undefined) {
			// 交通灯按钮高度为12px。顶部和底部有2px的不可见边距，
			// 左右各有1px的边距。因此，居中的高度为12px + 2 * 2px = 16px。
			// 当设置位置时，水平边距被偏移以确保交通灯按钮与窗口框架
			// 的距离在两个方向上相等。
			const offset = Math.floor((options.height - 16) / 2);
			if (!offset) {
				win.setWindowButtonPosition(null);
			} else {
				win.setWindowButtonPosition({ x: offset + 1, y: offset });
			}
		}
	}

	//#endregion

	//#region 全屏

	private transientIsNativeFullScreen: boolean | undefined = undefined;
	private joinNativeFullScreenTransition: DeferredPromise<boolean> | undefined = undefined;

	/**
	 * 切换全屏状态
	 */
	toggleFullScreen(): void {
		this.setFullScreen(!this.isFullScreen, false);
	}

	/**
	 * 设置窗口的全屏状态
	 * @param fullscreen 是否进入全屏模式
	 * @param fromRestore 是否从恢复状态触发
	 */
	protected setFullScreen(fullscreen: boolean, fromRestore: boolean): void {

		// 设置全屏状态
		if (useNativeFullScreen(this.configurationService)) {
			this.setNativeFullScreen(fullscreen, fromRestore);
		} else {
			this.setSimpleFullScreen(fullscreen);
		}
	}

	/**
	 * 获取窗口是否处于全屏状态
	 */
	get isFullScreen(): boolean {
		if (isMacintosh && typeof this.transientIsNativeFullScreen === 'boolean') {
			return this.transientIsNativeFullScreen;
		}

		const win = this.win;
		const isFullScreen = win?.isFullScreen();
		const isSimpleFullScreen = win?.isSimpleFullScreen();

		return Boolean(isFullScreen || isSimpleFullScreen);
	}

	/**
	 * 设置原生全屏模式
	 */
	private setNativeFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		const win = this.win;
		if (win?.isSimpleFullScreen()) {
			win?.setSimpleFullScreen(false);
		}

		this.doSetNativeFullScreen(fullscreen, fromRestore);
	}

	/**
	 * 执行原生全屏模式切换
	 */
	private doSetNativeFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		if (isMacintosh) {

			// macOS: Electron窗口在全屏转换动画进行期间会为`isFullScreen()`
			// 报告`false`。因此，我们需要监听转换事件并维护一个中间状态
			// 以了解我们是否处于全屏模式
			// 参考: https://github.com/electron/electron/issues/35360

			this.transientIsNativeFullScreen = fullscreen;

			const joinNativeFullScreenTransition = this.joinNativeFullScreenTransition = new DeferredPromise<boolean>();
			(async () => {
				const transitioned = await Promise.race([
					joinNativeFullScreenTransition.p,
					timeout(10000).then(() => false)
				]);

				if (this.joinNativeFullScreenTransition !== joinNativeFullScreenTransition) {
					return; // 稍后请求了另一个转换
				}

				this.transientIsNativeFullScreen = undefined;
				this.joinNativeFullScreenTransition = undefined;

				// macOS上有一个有趣的问题：当你从一个全屏窗口打开一个新窗口时，
				// 新窗口会立即以全屏模式打开，并在我们到达此方法之前就触发
				// `enter-full-screen`事件。在这种情况下，我们实际上会在10秒后
				// 超时检测转换，因此重要的是我们只在窗口报告不处于全屏模式时
				// 发出退出全屏的信号。

				if (!transitioned && fullscreen && fromRestore && this.win && !this.win.isFullScreen()) {

					// 我们见过全屏请求最终在一段时间后失败的情况，
					// 例如当执行操作系统更新并恢复窗口时。
					// 在这些情况下，用户会发现一个既不处于全屏状态
					// 也不显示任何自定义标题栏（因此没有窗口控件）的窗口，
					// 因为我们认为窗口处于全屏状态。
					//
					// 在这种情况下，我们会发出警告并退出全屏模式，
					// 以便至少恢复窗口控件。

					this.logService.warn('window: 从恢复状态触发的macOS原生全屏转换在10秒内未完成');

					this._onDidLeaveFullScreen.fire();
				}
			})();
		}

		const win = this.win;
		win?.setFullScreen(fullscreen);
	}

	/**
	 * 设置简单全屏模式
	 */
	private setSimpleFullScreen(fullscreen: boolean): void {
		const win = this.win;
		if (win?.isFullScreen()) {
			this.doSetNativeFullScreen(false, false);
		}

		win?.setSimpleFullScreen(fullscreen);
		win?.webContents.focus(); // 解决焦点无法进入窗口的问题
	}

	//#endregion

	abstract matches(webContents: electron.WebContents): boolean;

	override dispose(): void {
		super.dispose();

		this._win = null!; // Important to dereference the window object to allow for GC
	}
}

/**
 * VSCode 窗口管理系统的核心实现，负责处理窗口的创建、配置、生命周期管理、错误处理、状态保存/恢复等重要功能。所有涉及到 VSCode 窗口显示和管理的核心逻辑都在这个文件中实现
 * BaseWindow 抽象类：实现了 VSCode 窗口管理的基础功能，包括窗口状态、全屏切换、事件处理等
 * CodeWindow 类：继承自 BaseWindow，实现了 VSCode 代码窗口的具体功能，包括加载配置、处理错误、管理生命周期等
 * UnresponsiveError 类：用于处理窗口无响应情况的错误类
 */
export class CodeWindow extends BaseWindow implements ICodeWindow {

	//#region 事件

	private readonly _onWillLoad = this._register(new Emitter<ILoadEvent>());
	readonly onWillLoad = this._onWillLoad.event;

	private readonly _onDidSignalReady = this._register(new Emitter<void>());
	readonly onDidSignalReady = this._onDidSignalReady.event;

	private readonly _onDidDestroy = this._register(new Emitter<void>());
	readonly onDidDestroy = this._onDidDestroy.event;

	//#endregion


	//#region 属性

	private _id: number;
	get id(): number { return this._id; }

	protected override _win: electron.BrowserWindow;

	get backupPath(): string | undefined { return this._config?.backupPath; }

	get openedWorkspace(): IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined { return this._config?.workspace; }

	get profile(): IUserDataProfile | undefined {
		if (!this.config) {
			return undefined;
		}

		const profile = this.userDataProfilesService.profiles.find(profile => profile.id === this._config?.profiles.profile.id);
		if (this.isExtensionDevelopmentHost && profile) {
			return profile;
		}

		return this.userDataProfilesService.getProfileForWorkspace(this.config.workspace ?? toWorkspaceIdentifier(this.backupPath, this.isExtensionDevelopmentHost)) ?? this.userDataProfilesService.defaultProfile;
	}

	get remoteAuthority(): string | undefined { return this._config?.remoteAuthority; }

	private _config: INativeWindowConfiguration | undefined;
	get config(): INativeWindowConfiguration | undefined { return this._config; }

	get isExtensionDevelopmentHost(): boolean { return !!(this._config?.extensionDevelopmentPath); }

	get isExtensionTestHost(): boolean { return !!(this._config?.extensionTestsPath); }

	get isExtensionDevelopmentTestFromCli(): boolean { return this.isExtensionDevelopmentHost && this.isExtensionTestHost && !this._config?.debugId; }

	//#endregion

	private readonly windowState: IWindowState;
	private currentMenuBarVisibility: MenuBarVisibility | undefined;

	private readonly whenReadyCallbacks: { (window: ICodeWindow): void }[] = [];

	private readonly touchBarGroups: electron.TouchBarSegmentedControl[] = [];

	private currentHttpProxy: string | undefined = undefined;
	private currentNoProxy: string | undefined = undefined;

	private customZoomLevel: number | undefined = undefined;

	private readonly configObjectUrl: IIPCObjectUrl<INativeWindowConfiguration>;
	private pendingLoadConfig: INativeWindowConfiguration | undefined;
	private wasLoaded = false;

	private readonly jsCallStackMap: Map<string, number>;
	private readonly jsCallStackEffectiveSampleCount: number;
	private readonly jsCallStackCollector: Delayer<void>;
	private readonly jsCallStackCollectorStopScheduler: RunOnceScheduler;

	constructor(
		config: IWindowCreationOptions,
		@ILogService logService: ILogService,
		@ILoggerMainService private readonly loggerMainService: ILoggerMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IPolicyService private readonly policyService: IPolicyService,
		@IUserDataProfilesMainService private readonly userDataProfilesService: IUserDataProfilesMainService,
		@IFileService private readonly fileService: IFileService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@IStorageMainService private readonly storageMainService: IStorageMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IWorkspacesManagementMainService private readonly workspacesManagementMainService: IWorkspacesManagementMainService,
		@IBackupMainService private readonly backupMainService: IBackupMainService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IProductService private readonly productService: IProductService,
		@IProtocolMainService protocolMainService: IProtocolMainService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IStateService stateService: IStateService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(configurationService, stateService, environmentMainService, logService);

		//#region create browser window
		{
			this.configObjectUrl = this._register(protocolMainService.createIPCObjectUrl<INativeWindowConfiguration>());

			// Load window state
			const [state, hasMultipleDisplays] = this.restoreWindowState(config.state);
			this.windowState = state;
			this.logService.trace('window#ctor: using window state', state);

			const options = instantiationService.invokeFunction(defaultBrowserWindowOptions, this.windowState, undefined, {
				preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-sandbox/preload.js').fsPath,
				additionalArguments: [`--vscode-window-config=${this.configObjectUrl.resource.toString()}`],
				v8CacheOptions: this.environmentMainService.useCodeCache ? 'bypassHeatCheck' : 'none',
			});

			// Create the browser window
			mark('code/willCreateCodeBrowserWindow');
			this._win = new electron.BrowserWindow(options);
			mark('code/didCreateCodeBrowserWindow');

			this._id = this._win.id;
			this.setWin(this._win, options);

			// Apply some state after window creation
			this.applyState(this.windowState, hasMultipleDisplays);

			this._lastFocusTime = Date.now(); // since we show directly, we need to set the last focus time too
		}
		//#endregion

		//#region JS Callstack Collector

		let sampleInterval = parseInt(this.environmentMainService.args['unresponsive-sample-interval'] || '1000');
		let samplePeriod = parseInt(this.environmentMainService.args['unresponsive-sample-period'] || '15000');
		if (sampleInterval <= 0 || samplePeriod <= 0 || sampleInterval > samplePeriod) {
			this.logService.warn(`Invalid unresponsive sample interval (${sampleInterval}ms) or period (${samplePeriod}ms), using defaults.`);
			sampleInterval = 1000;
			samplePeriod = 15000;
		}

		this.jsCallStackMap = new Map<string, number>();
		this.jsCallStackEffectiveSampleCount = Math.round(sampleInterval / samplePeriod);
		this.jsCallStackCollector = this._register(new Delayer<void>(sampleInterval));
		this.jsCallStackCollectorStopScheduler = this._register(new RunOnceScheduler(() => {
			this.stopCollectingJScallStacks(); // Stop collecting after 15s max
		}, samplePeriod));

		//#endregion

		// respect configured menu bar visibility
		this.onConfigurationUpdated();

		// macOS: touch bar support
		this.createTouchBar();

		// Eventing
		this.registerListeners();
	}

	private readyState = ReadyState.NONE;

	/**
	 * 设置窗口就绪状态
	 */
	setReady(): void {
		this.logService.trace(`window#load: 窗口报告已就绪 (id: ${this._id})`);

		this.readyState = ReadyState.READY;

		// 通知所有等待的promise我们现在已就绪
		while (this.whenReadyCallbacks.length) {
			this.whenReadyCallbacks.pop()!(this);
		}

		// 触发事件
		this._onDidSignalReady.fire();
	}

	/**
	 * 返回一个Promise，当窗口就绪时解析
	 */
	ready(): Promise<ICodeWindow> {
		return new Promise<ICodeWindow>(resolve => {
			if (this.isReady) {
				return resolve(this);
			}

			// 否则保存回调并在就绪时调用
			this.whenReadyCallbacks.push(resolve);
		});
	}

	/**
	 * 窗口是否已就绪
	 */
	get isReady(): boolean {
		return this.readyState === ReadyState.READY;
	}

	/**
	 * 返回一个Promise，当窗口关闭或加载时解析
	 */
	get whenClosedOrLoaded(): Promise<void> {
		return new Promise<void>(resolve => {

			function handle() {
				closeListener.dispose();
				loadListener.dispose();

				resolve();
			}

			const closeListener = this.onDidClose(() => handle());
			const loadListener = this.onWillLoad(() => handle());
		});
	}

	/**
	 * 注册事件监听器
	 */
	private registerListeners(): void {

		// 需要处理的窗口错误条件
		this._register(Event.fromNodeEventEmitter(this._win, 'unresponsive')(() => this.onWindowError(WindowError.UNRESPONSIVE)));
		this._register(Event.fromNodeEventEmitter(this._win, 'responsive')(() => this.onWindowError(WindowError.RESPONSIVE)));
		this._register(Event.fromNodeEventEmitter(this._win.webContents, 'render-process-gone', (event, details) => details)(details => this.onWindowError(WindowError.PROCESS_GONE, { ...details })));
		this._register(Event.fromNodeEventEmitter(this._win.webContents, 'did-fail-load', (event, exitCode, reason) => ({ exitCode, reason }))(({ exitCode, reason }) => this.onWindowError(WindowError.LOAD, { reason, exitCode })));

		// 通过DOM事件防止窗口/iframe阻止卸载。
		// 我们有自己的窗口卸载逻辑，不应该与DOM方式混淆。
		// (https://github.com/microsoft/vscode/issues/122736)
		this._register(Event.fromNodeEventEmitter<electron.Event>(this._win.webContents, 'will-prevent-unload')(event => event.preventDefault()));

		// 记住我们已经加载
		this._register(Event.fromNodeEventEmitter(this._win.webContents, 'did-finish-load')(() => {

			// 如果提供，关联加载请求中的属性
			if (this.pendingLoadConfig) {
				this._config = this.pendingLoadConfig;

				this.pendingLoadConfig = undefined;
			}
		}));

		// 窗口(取消)最大化
		this._register(this.onDidMaximize(() => {
			if (this._config) {
				this._config.maximized = true;
			}
		}));

		this._register(this.onDidUnmaximize(() => {
			if (this._config) {
				this._config.maximized = false;
			}
		}));

		// 窗口全屏
		this._register(this.onDidEnterFullScreen(() => {
			this.sendWhenReady('vscode:enterFullScreen', CancellationToken.None);
		}));

		this._register(this.onDidLeaveFullScreen(() => {
			this.sendWhenReady('vscode:leaveFullScreen', CancellationToken.None);
		}));

		// 处理配置变更
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));

		// 处理工作区事件
		this._register(this.workspacesManagementMainService.onDidDeleteUntitledWorkspace(e => this.onDidDeleteUntitledWorkspace(e)));

		// 当请求进入时注入头信息
		const urls = ['https://marketplace.visualstudio.com/*', 'https://*.vsassets.io/*'];
		this._win.webContents.session.webRequest.onBeforeSendHeaders({ urls }, async (details, cb) => {
			const headers = await this.getMarketplaceHeaders();

			cb({ cancel: false, requestHeaders: Object.assign(details.requestHeaders, headers) });
		});
	}

	private marketplaceHeadersPromise: Promise<object> | undefined;
	/**
	 * 获取应用商店请求所需的HTTP头
	 */
	private getMarketplaceHeaders(): Promise<object> {
		if (!this.marketplaceHeadersPromise) {
			this.marketplaceHeadersPromise = resolveMarketplaceHeaders(
				this.productService.version,
				this.productService,
				this.environmentMainService,
				this.configurationService,
				this.fileService,
				this.applicationStorageMainService,
				this.telemetryService);
		}

		return this.marketplaceHeadersPromise;
	}

	/**
	 * 处理窗口错误
	 */
	private async onWindowError(error: WindowError.UNRESPONSIVE): Promise<void>;
	private async onWindowError(error: WindowError.RESPONSIVE): Promise<void>;
	private async onWindowError(error: WindowError.PROCESS_GONE, details: { reason: string; exitCode: number }): Promise<void>;
	private async onWindowError(error: WindowError.LOAD, details: { reason: string; exitCode: number }): Promise<void>;
	private async onWindowError(type: WindowError, details?: { reason?: string; exitCode?: number }): Promise<void> {

		switch (type) {
			case WindowError.PROCESS_GONE:
				this.logService.error(`CodeWindow: 渲染进程已终止 (原因: ${details?.reason || '<未知>'}, 代码: ${details?.exitCode || '<未知>'})`);
				break;
			case WindowError.UNRESPONSIVE:
				this.logService.error('CodeWindow: 检测到无响应');
				break;
			case WindowError.RESPONSIVE:
				this.logService.error('CodeWindow: 从无响应状态恢复');
				break;
			case WindowError.LOAD:
				this.logService.error(`CodeWindow: 加载失败 (原因: ${details?.reason || '<未知>'}, 代码: ${details?.exitCode || '<未知>'})`);
				break;
		}

		// 遥测
		type WindowErrorClassification = {
			type: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: '窗口错误的类型，以便更好地理解错误的性质。' };
			reason: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: '窗口错误的原因，以便更好地理解错误的性质。' };
			code: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: '窗口进程的退出代码，以便更好地理解错误的性质' };
			owner: 'bpasero';
			comment: '提供对vscode窗口发生错误原因的洞察。';
		};
		type WindowErrorEvent = {
			type: WindowError;
			reason: string | undefined;
			code: number | undefined;
		};
		this.telemetryService.publicLog2<WindowErrorEvent, WindowErrorClassification>('windowerror', {
			type,
			reason: details?.reason,
			code: details?.exitCode
		});

		// 如果无法恢复，通知用户
		switch (type) {
			case WindowError.UNRESPONSIVE:
			case WindowError.PROCESS_GONE:

				// 如果我们从CLI运行扩展测试，我们想通过
				// 以非零退出代码退出来向测试运行器发送
				// 此状态的信号。
				if (this.isExtensionDevelopmentTestFromCli) {
					this.lifecycleMainService.kill(1);
					return;
				}

				// 如果我们运行冒烟测试，我们希望尽可能有序地
				// 关闭，方法是销毁窗口，然后调用正常的
				// 'quit'程序。
				if (this.environmentMainService.args['enable-smoke-test-driver']) {
					await this.destroyWindow(false, false);
					this.lifecycleMainService.quit(); // 仍允许有序关闭
					return;
				}

				// 无响应
				if (type === WindowError.UNRESPONSIVE) {
					if (this.isExtensionDevelopmentHost || this.isExtensionTestHost || (this._win && this._win.webContents && this._win.webContents.isDevToolsOpened())) {
						// TODO@electron 解决 https://github.com/microsoft/vscode/issues/56994 的问题
						// 在某些情况下，窗口可能会报告无响应，因为遇到了断点
						// 且进程停止执行。最典型的情况是：
						// - 开发者工具已打开并且正在调试
						// - 窗口是正在被调试的扩展开发主机
						// - 窗口是正在被调试的扩展测试开发主机
						return;
					}

					// 中断V8并收集JavaScript堆栈
					this.jsCallStackCollector.trigger(() => this.startCollectingJScallStacks());
					// 在以下任一条件下，堆栈收集将停止：
					// - 窗口再次变为响应状态
					// - 窗口被销毁，即重新打开或关闭
					// - 采样周期完成，默认为15秒
					this.jsCallStackCollectorStopScheduler.schedule();

					// 显示对话框
					const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
						type: 'warning',
						buttons: [
							localize({ key: 'reopen', comment: ['&& denotes a mnemonic'] }, "&&重新打开"),
							localize({ key: 'close', comment: ['&& denotes a mnemonic'] }, "&&关闭"),
							localize({ key: 'wait', comment: ['&& denotes a mnemonic'] }, "&&继续等待")
						],
						message: localize('appStalled', "窗口没有响应"),
						detail: localize('appStalledDetail', "您可以重新打开或关闭窗口，或继续等待。"),
						checkboxLabel: this._config?.workspace ? localize('doNotRestoreEditors', "不要恢复编辑器") : undefined
					}, this._win);

					// 处理选择
					if (response !== 2 /* 继续等待 */) {
						const reopen = response === 0;
						this.stopCollectingJScallStacks();
						await this.destroyWindow(reopen, checkboxChecked);
					}
				}

				// 进程已终止
				else if (type === WindowError.PROCESS_GONE) {
					let message: string;
					if (!details) {
						message = localize('appGone', "窗口意外终止");
					} else {
						message = localize('appGoneDetails', "窗口意外终止 (原因: '{0}', 代码: '{1}')", details.reason, details.exitCode ?? '<未知>');
					}

					// 显示对话框
					const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
						type: 'warning',
						buttons: [
							this._config?.workspace ? localize({ key: 'reopen', comment: ['&& denotes a mnemonic'] }, "&&重新打开") : localize({ key: 'newWindow', comment: ['&& denotes a mnemonic'] }, "&&新窗口"),
							localize({ key: 'close', comment: ['&& denotes a mnemonic'] }, "&&关闭")
						],
						message,
						detail: this._config?.workspace ?
							localize('appGoneDetailWorkspace', "我们对造成的不便表示歉意。您可以重新打开窗口以继续您离开时的工作。") :
							localize('appGoneDetailEmptyWindow', "我们对造成的不便表示歉意。您可以打开一个新的空窗口重新开始。"),
						checkboxLabel: this._config?.workspace ? localize('doNotRestoreEditors', "不要恢复编辑器") : undefined
					}, this._win);

					// 处理选择
					const reopen = response === 0;
					await this.destroyWindow(reopen, checkboxChecked);
				}
				break;
			case WindowError.RESPONSIVE:
				this.stopCollectingJScallStacks();
				break;
		}
	}

	/**
	 * 销毁窗口
	 * @param reopen 是否重新打开窗口
	 * @param skipRestoreEditors 是否跳过恢复编辑器状态
	 */
	private async destroyWindow(reopen: boolean, skipRestoreEditors: boolean): Promise<void> {
		const workspace = this._config?.workspace;

		// 首先检查是否丢弃编辑器状态
		if (skipRestoreEditors && workspace) {
			try {
				const workspaceStorage = this.storageMainService.workspaceStorage(workspace);
				await workspaceStorage.init();
				workspaceStorage.delete('memento/workbench.parts.editor');
				await workspaceStorage.close();
			} catch (error) {
				this.logService.error(error);
			}
		}

		// 在destroy()上不会触发'close'事件，因此通过显式事件发出崩溃信号
		this._onDidDestroy.fire();

		try {
			// 如果指定了，请求窗口服务打开一个新的窗口
			if (reopen && this._config) {

				// 我们必须从当前工作区重建可打开项
				let uriToOpen: IWorkspaceToOpen | IFolderToOpen | undefined = undefined;
				let forceEmpty = undefined;
				if (isSingleFolderWorkspaceIdentifier(workspace)) {
					uriToOpen = { folderUri: workspace.uri };
				} else if (isWorkspaceIdentifier(workspace)) {
					uriToOpen = { workspaceUri: workspace.configPath };
				} else {
					forceEmpty = true;
				}

				// 委托给窗口服务
				const window = (await this.windowsMainService.open({
					context: OpenContext.API,
					userEnv: this._config.userEnv,
					cli: {
						...this.environmentMainService.args,
						_: [] // 我们通过`urisToOpen`显式传递要打开的工作区
					},
					urisToOpen: uriToOpen ? [uriToOpen] : undefined,
					forceEmpty,
					forceNewWindow: true,
					remoteAuthority: this.remoteAuthority
				})).at(0);
				window?.focus();
			}
		} finally {
			// 确保销毁窗口，因为其渲染进程已终止。在重新打开窗口的代码之后
			// 执行此操作，以防止当最后一个窗口关闭时整个应用程序退出。
			this._win?.destroy();
		}
	}

	private onDidDeleteUntitledWorkspace(workspace: IWorkspaceIdentifier): void {

		// Make sure to update our workspace config if we detect that it
		// was deleted
		if (this._config?.workspace?.id === workspace.id) {
			this._config.workspace = undefined;
		}
	}

	/**
	 * 处理配置更新
	 */
	private onConfigurationUpdated(e?: IConfigurationChangeEvent): void {

		// 菜单栏
		if (!e || e.affectsConfiguration('window.menuBarVisibility')) {
			const newMenuBarVisibility = this.getMenuBarVisibility();
			if (newMenuBarVisibility !== this.currentMenuBarVisibility) {
				this.currentMenuBarVisibility = newMenuBarVisibility;
				this.setMenuBarVisibility(newMenuBarVisibility);
			}
		}

		// 代理
		if (!e || e.affectsConfiguration('http.proxy') || e.affectsConfiguration('http.noProxy')) {
			const inspect = this.configurationService.inspect<string>('http.proxy');
			let newHttpProxy = (inspect.userLocalValue || '').trim()
				|| (process.env['https_proxy'] || process.env['HTTPS_PROXY'] || process.env['http_proxy'] || process.env['HTTP_PROXY'] || '').trim() // 非标准化
				|| undefined;

			if (newHttpProxy?.indexOf('@') !== -1) {
				const uri = URI.parse(newHttpProxy!);
				const i = uri.authority.indexOf('@');
				if (i !== -1) {
					newHttpProxy = uri.with({ authority: uri.authority.substring(i + 1) })
						.toString();
				}
			}
			if (newHttpProxy?.endsWith('/')) {
				newHttpProxy = newHttpProxy.substr(0, newHttpProxy.length - 1);
			}

			const newNoProxy = (this.configurationService.getValue<string[]>('http.noProxy') || []).map((item) => item.trim()).join(',')
				|| (process.env['no_proxy'] || process.env['NO_PROXY'] || '').trim() || undefined; // 非标准化
			if ((newHttpProxy || '').indexOf('@') === -1 && (newHttpProxy !== this.currentHttpProxy || newNoProxy !== this.currentNoProxy)) {
				this.currentHttpProxy = newHttpProxy;
				this.currentNoProxy = newNoProxy;

				const proxyRules = newHttpProxy || '';
				const proxyBypassRules = newNoProxy ? `${newNoProxy},<local>` : '<local>';
				this.logService.trace(`设置代理为 '${proxyRules}'，绕过 '${proxyBypassRules}'`);
				this._win.webContents.session.setProxy({ proxyRules, proxyBypassRules, pacScript: '' });
				electron.app.setProxy({ proxyRules, proxyBypassRules, pacScript: '' });
			}
		}
	}

	/**
	 * 获取菜单栏可见性设置
	 */
	private getMenuBarVisibility(): MenuBarVisibility {
		let menuBarVisibility = getMenuBarVisibility(this.configurationService);
		if (['visible', 'toggle', 'hidden'].indexOf(menuBarVisibility) < 0) {
			menuBarVisibility = 'classic';
		}

		return menuBarVisibility;
	}

	/**
	 * 设置菜单栏可见性
	 * @param visibility 可见性设置
	 * @param notify 是否通知用户
	 */
	private setMenuBarVisibility(visibility: MenuBarVisibility, notify: boolean = true): void {
		if (isMacintosh) {
			return; // 忽略macOS平台
		}

		if (visibility === 'toggle') {
			if (notify) {
				this.send('vscode:showInfoMessage', localize('hiddenMenuBar', "您仍然可以通过按Alt键访问菜单栏。"));
			}
		}

		if (visibility === 'hidden') {
			// 由于某些我无法解释的奇怪原因，直接调用
			// 这个方法而不使用超时不会隐藏菜单栏（参见 https://github.com/microsoft/vscode/issues/19777）。
			// 似乎我们首次打开窗口和创建菜单栏之间存在时序问题。
			// 不知何故，我们想通过Alt键隐藏菜单而不能恢复它的事实使Electron
			// 仍然显示了菜单。无法从简单的Hello World应用程序中复现这个问题...
			setTimeout(() => {
				this.doSetMenuBarVisibility(visibility);
			});
		} else {
			this.doSetMenuBarVisibility(visibility);
		}
	}

	/**
	 * 实际执行菜单栏可见性设置
	 */
	private doSetMenuBarVisibility(visibility: MenuBarVisibility): void {
		const isFullscreen = this.isFullScreen;

		switch (visibility) {
			case ('classic'):
				this._win.setMenuBarVisibility(!isFullscreen);
				this._win.autoHideMenuBar = isFullscreen;
				break;

			case ('visible'):
				this._win.setMenuBarVisibility(true);
				this._win.autoHideMenuBar = false;
				break;

			case ('toggle'):
				this._win.setMenuBarVisibility(false);
				this._win.autoHideMenuBar = true;
				break;

			case ('hidden'):
				this._win.setMenuBarVisibility(false);
				this._win.autoHideMenuBar = false;
				break;
		}
	}

	addTabbedWindow(window: ICodeWindow): void {
		if (isMacintosh && window.win) {
			this._win.addTabbedWindow(window.win);
		}
	}

	/**
	 * 加载窗口配置
	 */
	load(configuration: INativeWindowConfiguration, options: ILoadOptions = Object.create(null)): void {
		this.logService.trace(`window#load: 尝试加载窗口 (id: ${this._id})`);

		// 如果需要，清除文档已编辑状态
		if (this.isDocumentEdited()) {
			if (!options.isReload || !this.backupMainService.isHotExitEnabled()) {
				this.setDocumentEdited(false);
			}
		}

		// 如果需要，清除标题和文件名
		if (!options.isReload) {
			if (this.getRepresentedFilename()) {
				this.setRepresentedFilename('');
			}

			this._win.setTitle(this.productService.nameLong);
		}

		// 根据窗口上下文更新配置值
		// 并将其设置到配置对象URL中以供使用
		this.updateConfiguration(configuration, options);

		// 如果这是窗口首次加载，我们直接将路径
		// 与窗口关联，因为我们假设加载会正常工作
		if (this.readyState === ReadyState.NONE) {
			this._config = configuration;
		}

		// 否则，窗口当前正在显示一个文件夹，如果有一个
		// 防止加载的卸载处理程序，我们不能直接关联路径，
		// 因为加载可能会被否决。相反，我们在窗口加载事件
		// 触发后再关联它。
		else {
			this.pendingLoadConfig = configuration;
		}

		// 指示我们现在正在导航
		this.readyState = ReadyState.NAVIGATING;

		/**
		 * 加载URL, 是整个 VSCode 编辑器的基础框架页面，它包含了：
		 * 	编辑器布局
		 * 	菜单
		 * 	侧边栏
		 * 	面板
		 * 	状态栏
		 */
		this._win.loadURL(FileAccess.asBrowserUri(`vs/code/electron-sandbox/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true));

		// 记住我们已经加载
		const wasLoaded = this.wasLoaded;
		this.wasLoaded = true;

		// 如果窗口在N秒内没有打开，则使其可见，因为这表明有错误
		// 仅在从源代码运行而不是运行测试时执行此操作
		if (!this.environmentMainService.isBuilt && !this.environmentMainService.extensionTestsLocationURI) {
			this._register(new RunOnceScheduler(() => {
				if (this._win && !this._win.isVisible() && !this._win.isMinimized()) {
					this._win.show();
					this.focus({ force: true });
					this._win.webContents.openDevTools();
				}
			}, 10000)).schedule();
		}

		// 触发事件
		this._onWillLoad.fire({ workspace: configuration.workspace, reason: options.isReload ? LoadReason.RELOAD : wasLoaded ? LoadReason.LOAD : LoadReason.INITIAL });
	}

	/**
	 * 更新窗口配置
	 */
	private updateConfiguration(configuration: INativeWindowConfiguration, options: ILoadOptions): void {

		// 如果此窗口之前是从命令行加载的
		// （如VSCODE_CLI环境所示），请确保
		// 在后续加载中保留该用户环境，
		// 除非新的配置上下文也是CLI
		// （用于 https://github.com/microsoft/vscode/issues/108571）
		// 另外，如果我们正在从设置了环境的扩展开发主机加载，
		// 也保留环境
		// （用于 https://github.com/microsoft/vscode/issues/123508）
		const currentUserEnv = (this._config ?? this.pendingLoadConfig)?.userEnv;
		if (currentUserEnv) {
			const shouldPreserveLaunchCliEnvironment = isLaunchedFromCli(currentUserEnv) && !isLaunchedFromCli(configuration.userEnv);
			const shouldPreserveDebugEnvironmnet = this.isExtensionDevelopmentHost;
			if (shouldPreserveLaunchCliEnvironment || shouldPreserveDebugEnvironmnet) {
				configuration.userEnv = { ...currentUserEnv, ...configuration.userEnv }; // 仍然允许覆盖传入的某些环境
			}
		}

		// 如果为crashpad_handler进程实例化了命名管道，为连接到原始应用实例的
		// 新应用实例重用相同的管道。
		// 参考: https://github.com/microsoft/vscode/issues/115874
		if (process.env['CHROME_CRASHPAD_PIPE_NAME']) {
			Object.assign(configuration.userEnv, {
				CHROME_CRASHPAD_PIPE_NAME: process.env['CHROME_CRASHPAD_PIPE_NAME']
			});
		}

		// 将disable-extensions添加到配置中，但不在currentConfig或
		// pendingLoadConfig上保留它，以便它仅在此次加载时应用
		if (options.disableExtensions !== undefined) {
			configuration['disable-extensions'] = options.disableExtensions;
		}

		// 更新窗口相关属性
		try {
			configuration.handle = VSBuffer.wrap(this._win.getNativeWindowHandle());
		} catch (error) {
			this.logService.error(`获取原生窗口句柄时出错: ${error}`);
		}
		configuration.fullscreen = this.isFullScreen;
		configuration.maximized = this._win.isMaximized();
		configuration.partsSplash = this.themeMainService.getWindowSplash(configuration.workspace);
		configuration.zoomLevel = this.getZoomLevel();
		configuration.isCustomZoomLevel = typeof this.customZoomLevel === 'number';
		if (configuration.isCustomZoomLevel && configuration.partsSplash) {
			configuration.partsSplash.zoomLevel = configuration.zoomLevel;
		}

		// 使用最新的性能标记更新
		mark('code/willOpenNewWindow');
		configuration.perfMarks = getMarks();

		// 在配置对象URL中更新以供渲染器使用
		this.configObjectUrl.update(configuration);
	}

	/**
	 * 重新加载窗口
	 */
	async reload(cli?: NativeParsedArgs): Promise<void> {

		// 复制当前配置以重用
		const configuration = Object.assign({}, this._config);

		// 验证工作区
		configuration.workspace = await this.validateWorkspaceBeforeReload(configuration);

		// 删除我们不希望在重新加载期间存在的一些属性
		delete configuration.filesToOpenOrCreate;
		delete configuration.filesToDiff;
		delete configuration.filesToMerge;
		delete configuration.filesToWait;

		// 如果窗口正在重新加载，并且我们处于扩展开发模式，
		// 一些配置项会被继承。这些选项都与开发相关。
		if (this.isExtensionDevelopmentHost && cli) {
			configuration.verbose = cli.verbose;
			configuration.debugId = cli.debugId;
			configuration.extensionEnvironment = cli.extensionEnvironment;
			configuration['inspect-extensions'] = cli['inspect-extensions'];
			configuration['inspect-brk-extensions'] = cli['inspect-brk-extensions'];
			configuration['extensions-dir'] = cli['extensions-dir'];
		}

		configuration.accessibilitySupport = electron.app.isAccessibilitySupportEnabled();
		configuration.isInitialStartup = false; // 因为这是重新加载
		configuration.policiesData = this.policyService.serialize(); // 再次设置策略数据
		configuration.continueOn = this.environmentMainService.continueOn;
		configuration.profiles = {
			all: this.userDataProfilesService.profiles,
			profile: this.profile || this.userDataProfilesService.defaultProfile,
			home: this.userDataProfilesService.profilesHome
		};
		configuration.logLevel = this.loggerMainService.getLogLevel();
		configuration.loggers = this.loggerMainService.getGlobalLoggers();

		// 加载配置
		this.load(configuration, { isReload: true, disableExtensions: cli?.['disable-extensions'] });
	}

	/**
	 * 在重新加载前验证工作区
	 */
	private async validateWorkspaceBeforeReload(configuration: INativeWindowConfiguration): Promise<IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined> {

		// 多文件夹工作区
		if (isWorkspaceIdentifier(configuration.workspace)) {
			const configPath = configuration.workspace.configPath;
			if (configPath.scheme === Schemas.file) {
				const workspaceExists = await this.fileService.exists(configPath);
				if (!workspaceExists) {
					return undefined;
				}
			}
		}

		// 单文件夹工作区
		else if (isSingleFolderWorkspaceIdentifier(configuration.workspace)) {
			const uri = configuration.workspace.uri;
			if (uri.scheme === Schemas.file) {
				const folderExists = await this.fileService.exists(uri);
				if (!folderExists) {
					return undefined;
				}
			}
		}

		// 工作区有效
		return configuration.workspace;
	}

	/**
	 * 序列化窗口状态，将当前窗口的位置、大小和模式保存为可恢复的状态对象
	 */
	serializeWindowState(): IWindowState {
		if (!this._win) {
			return defaultWindowState();
		}

		// 全屏状态需要特殊处理
		if (this.isFullScreen) {
			let display: electron.Display | undefined;
			try {
				display = electron.screen.getDisplayMatching(this.getBounds());
			} catch (error) {
				// Electron在某些条件下会抛出错误
				// 例如 https://github.com/microsoft/vscode/issues/100334
				// 当传入大数值时
			}

			const defaultState = defaultWindowState();

			return {
				mode: WindowMode.Fullscreen,
				display: display ? display.id : undefined,

				// 即使在全屏状态下，仍然保留之前会话的窗口尺寸
				// 如果我们能在全屏状态下计算它。
				// 在某些情况下似乎不可能，例如在Linux上
				// (https://github.com/microsoft/vscode/issues/58218)
				// 所以在这种情况下我们退回到默认值。
				width: this.windowState.width || defaultState.width,
				height: this.windowState.height || defaultState.height,
				x: this.windowState.x || 0,
				y: this.windowState.y || 0,
				zoomLevel: this.customZoomLevel
			};
		}

		const state: IWindowState = Object.create(null);
		let mode: WindowMode;

		// 获取窗口模式
		if (!isMacintosh && this._win.isMaximized()) {
			mode = WindowMode.Maximized;
		} else {
			mode = WindowMode.Normal;
		}

		// 我们不想保存最小化状态，只保存最大化或正常状态
		if (mode === WindowMode.Maximized) {
			state.mode = WindowMode.Maximized;
		} else {
			state.mode = WindowMode.Normal;
		}

		// 只考虑非最小化的窗口状态
		if (mode === WindowMode.Normal || mode === WindowMode.Maximized) {
			let bounds: electron.Rectangle;
			if (mode === WindowMode.Normal) {
				bounds = this.getBounds();
			} else {
				bounds = this._win.getNormalBounds(); // 确保在最大化时保存正常边界，以便能够恢复它们
			}

			state.x = bounds.x;
			state.y = bounds.y;
			state.width = bounds.width;
			state.height = bounds.height;
		}

		state.zoomLevel = this.customZoomLevel;

		return state;
	}

	/**
	 * 恢复窗口状态，根据保存的状态对象设置窗口位置、大小和模式
	 */
	private restoreWindowState(state?: IWindowState): [IWindowState, boolean? /* 是否有多个显示器 */] {
		mark('code/willRestoreCodeWindowState');

		let hasMultipleDisplays = false;
		if (state) {

			// 窗口缩放
			this.customZoomLevel = state.zoomLevel;

			// 窗口尺寸
			try {
				const displays = electron.screen.getAllDisplays();
				hasMultipleDisplays = displays.length > 1;

				state = WindowStateValidator.validateWindowState(this.logService, state, displays);
			} catch (err) {
				this.logService.warn(`验证窗口状态时发生意外错误: ${err}\n${err.stack}`); // 由于某些原因显示API对要验证的状态可能很挑剔
			}
		}

		mark('code/didRestoreCodeWindowState');

		return [state || defaultWindowState(), hasMultipleDisplays];
	}

	getBounds(): electron.Rectangle {
		const [x, y] = this._win.getPosition();
		const [width, height] = this._win.getSize();

		return { x, y, width, height };
	}

	protected override setFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		super.setFullScreen(fullscreen, fromRestore);

		// Events
		this.sendWhenReady(fullscreen ? 'vscode:enterFullScreen' : 'vscode:leaveFullScreen', CancellationToken.None);

		// Respect configured menu bar visibility or default to toggle if not set
		if (this.currentMenuBarVisibility) {
			this.setMenuBarVisibility(this.currentMenuBarVisibility, false);
		}
	}

	notifyZoomLevel(zoomLevel: number | undefined): void {
		this.customZoomLevel = zoomLevel;
	}

	private getZoomLevel(): number | undefined {
		if (typeof this.customZoomLevel === 'number') {
			return this.customZoomLevel;
		}

		const windowSettings = this.configurationService.getValue<IWindowSettings | undefined>('window');
		return windowSettings?.zoomLevel;
	}

	close(): void {
		this._win?.close();
	}

	sendWhenReady(channel: string, token: CancellationToken, ...args: any[]): void {
		if (this.isReady) {
			this.send(channel, ...args);
		} else {
			this.ready().then(() => {
				if (!token.isCancellationRequested) {
					this.send(channel, ...args);
				}
			});
		}
	}

	send(channel: string, ...args: any[]): void {
		if (this._win) {
			if (this._win.isDestroyed() || this._win.webContents.isDestroyed()) {
				this.logService.warn(`Sending IPC message to channel '${channel}' for window that is destroyed`);
				return;
			}

			try {
				this._win.webContents.send(channel, ...args);
			} catch (error) {
				this.logService.warn(`Error sending IPC message to channel '${channel}' of window ${this._id}: ${toErrorMessage(error)}`);
			}
		}
	}

	/**
	 * 更新触控栏分组
	 * @param groups 命令动作组
	 */
	updateTouchBar(groups: ISerializableCommandAction[][]): void {
		if (!isMacintosh) {
			return; // 仅在macOS上支持
		}

		// 更新所有组的分段。直接设置分段属性
		// 可以防止难看的闪烁发生
		this.touchBarGroups.forEach((touchBarGroup, index) => {
			const commands = groups[index];
			touchBarGroup.segments = this.createTouchBarGroupSegments(commands);
		});
	}

	/**
	 * 创建触控栏
	 */
	private createTouchBar(): void {
		if (!isMacintosh) {
			return; // 仅在macOS上支持
		}

		// 为了避免闪烁，我们尝试尽可能多地重用触控栏组
		// 方法是创建大量组以供后续重用。
		for (let i = 0; i < 10; i++) {
			const groupTouchBar = this.createTouchBarGroup();
			this.touchBarGroups.push(groupTouchBar);
		}

		this._win.setTouchBar(new electron.TouchBar({ items: this.touchBarGroups }));
	}

	/**
	 * 创建触控栏组
	 * @param items 命令动作项
	 */
	private createTouchBarGroup(items: ISerializableCommandAction[] = []): electron.TouchBarSegmentedControl {

		// 组段
		const segments = this.createTouchBarGroupSegments(items);

		// 组控件
		const control = new electron.TouchBar.TouchBarSegmentedControl({
			segments,
			mode: 'buttons',
			segmentStyle: 'automatic',
			change: (selectedIndex) => {
				this.sendWhenReady('vscode:runAction', CancellationToken.None, { id: (control.segments[selectedIndex] as ITouchBarSegment).id, from: 'touchbar' });
			}
		});

		return control;
	}

	/**
	 * 创建触控栏组段
	 * @param items 命令动作项
	 */
	private createTouchBarGroupSegments(items: ISerializableCommandAction[] = []): ITouchBarSegment[] {
		const segments: ITouchBarSegment[] = items.map(item => {
			let icon: electron.NativeImage | undefined;
			if (item.icon && !ThemeIcon.isThemeIcon(item.icon) && item.icon?.dark?.scheme === Schemas.file) {
				icon = electron.nativeImage.createFromPath(URI.revive(item.icon.dark).fsPath);
				if (icon.isEmpty()) {
					icon = undefined;
				}
			}

			let title: string;
			if (typeof item.title === 'string') {
				title = item.title;
			} else {
				title = item.title.value;
			}

			return {
				id: item.id,
				label: !icon ? title : undefined,
				icon
			};
		});

		return segments;
	}

	/**
	 * 开始收集JS调用栈，用于诊断无响应情况
	 */
	private async startCollectingJScallStacks(): Promise<void> {
		if (!this.jsCallStackCollector.isTriggered()) {
			const stack = await this._win.webContents.mainFrame.collectJavaScriptCallStack();

			// 增加此堆栈跟踪的计数
			if (stack) {
				const count = this.jsCallStackMap.get(stack) || 0;
				this.jsCallStackMap.set(stack, count + 1);
			}

			this.jsCallStackCollector.trigger(() => this.startCollectingJScallStacks());
		}
	}

	/**
	 * 停止收集JS调用栈，并分析收集的数据
	 */
	private stopCollectingJScallStacks(): void {
		this.jsCallStackCollectorStopScheduler.cancel();
		this.jsCallStackCollector.cancel();

		if (this.jsCallStackMap.size) {
			let logMessage = `CodeWindow无响应采样:\n`;
			let samples = 0;

			const sortedEntries = Array.from(this.jsCallStackMap.entries())
				.sort((a, b) => b[1] - a[1]);

			for (const [stack, count] of sortedEntries) {
				samples += count;
				// 如果堆栈出现超过样本总数的20%，则将其记录到
				// 错误遥测中，作为UnresponsiveSampleError
				if (Math.round((count * 100) / this.jsCallStackEffectiveSampleCount) > 20) {
					const fakeError = new UnresponsiveError(stack, this.id, this.win?.webContents.getOSProcessId());
					errorHandler.onUnexpectedError(fakeError);
				}
				logMessage += `<${count}> ${stack}\n`;
			}

			logMessage += `总样本: ${samples}\n`;
			logMessage += '要获取无响应期间的完整概览，请通过 https://aka.ms/vscode-tracing-cpu-profile 捕获CPU配置文件';
			this.logService.error(logMessage);
		}

		this.jsCallStackMap.clear();
	}

	matches(webContents: electron.WebContents): boolean {
		return this._win?.webContents.id === webContents.id;
	}

	override dispose(): void {
		super.dispose();

		// Deregister the loggers for this window
		this.loggerMainService.deregisterLoggers(this.id);
	}
}

/**
 * 无响应错误类，用于报告窗口无响应的情况
 */
class UnresponsiveError extends Error {

	constructor(sample: string, windowId: number, pid: number = 0) {
		// 由于样本中已经包含堆栈，
		// 我们可以避免在构造错误时收集它们。
		const stackTraceLimit = Error.stackTraceLimit;
		Error.stackTraceLimit = 0;
		super(`UnresponsiveSampleError: 来自ID为${windowId}的窗口，归属于进程ID ${pid}`);
		Error.stackTraceLimit = stackTraceLimit;
		this.name = 'UnresponsiveSampleError';
		this.stack = sample;
	}
}
