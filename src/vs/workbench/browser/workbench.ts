/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. 保留所有权利。
 *  使用MIT许可证。详见项目根目录中的License.txt获取许可信息。
 *--------------------------------------------------------------------------------------------*/
import './style.js';
import { runWhenWindowIdle } from '../../base/browser/dom.js';
import { Event, Emitter, setGlobalLeakWarningThreshold } from '../../base/common/event.js';
import { RunOnceScheduler, timeout } from '../../base/common/async.js';
import { isFirefox, isSafari, isChrome } from '../../base/browser/browser.js';
import { mark } from '../../base/common/performance.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { isWindows, isLinux, isWeb, isNative, isMacintosh } from '../../base/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../common/contributions.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../common/editor.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { Position, Parts, IWorkbenchLayoutService, positionToString } from '../services/layout/browser/layoutService.js';
import { IStorageService, WillSaveStateReason, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { LifecyclePhase, ILifecycleService, WillShutdownEvent } from '../services/lifecycle/common/lifecycle.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { NotificationService } from '../services/notification/common/notificationService.js';
import { NotificationsCenter } from './parts/notifications/notificationsCenter.js';
import { NotificationsAlerts } from './parts/notifications/notificationsAlerts.js';
import { NotificationsStatus } from './parts/notifications/notificationsStatus.js';
import { registerNotificationCommands } from './parts/notifications/notificationsCommands.js';
import { NotificationsToasts } from './parts/notifications/notificationsToasts.js';
import { setARIAContainer } from '../../base/browser/ui/aria/aria.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { BareFontInfo } from '../../editor/common/config/fontInfo.js';
import { ILogService } from '../../platform/log/common/log.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { WorkbenchContextKeysHandler } from './contextkeys.js';
import { coalesce } from '../../base/common/arrays.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { Layout } from './layout.js';
import { IHostService } from '../services/host/browser/host.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { mainWindow } from '../../base/browser/window.js';
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../platform/hover/browser/hover.js';
import { setHoverDelegateFactory } from '../../base/browser/ui/hover/hoverDelegateFactory.js';
import { setBaseLayerHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate2.js';
import { AccessibilityProgressSignalScheduler } from '../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { setProgressAcccessibilitySignalScheduler } from '../../base/browser/ui/progressbar/progressAccessibilitySignal.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { NotificationAccessibleView } from './parts/notifications/notificationAccessibleView.js';

export interface IWorkbenchOptions {

	/**
	 * 添加到工作台容器的额外CSS类。
	 */
	extraClasses?: string[];
}

/**
 * 此文件是VSCode编辑器启动过程的核心入口点，负责初始化和加载工作台界面。
 * 它实现了Workbench类，该类处理工作台的创建、初始化服务、注册监听器、
 * 渲染各个部分、处理生命周期事件以及恢复工作台状态等关键功能。
 */
export class Workbench extends Layout {

	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	readonly onWillShutdown = this._onWillShutdown.event;

	private readonly _onDidShutdown = this._register(new Emitter<void>());
	readonly onDidShutdown = this._onDidShutdown.event;

	constructor(
		parent: HTMLElement,
		private readonly options: IWorkbenchOptions | undefined,
		private readonly serviceCollection: ServiceCollection,
		logService: ILogService
	) {
		super(parent);

		// 性能：测量工作台启动时间
		mark('code/willStartWorkbench');

		this.registerErrorHandler(logService);
	}

	private registerErrorHandler(logService: ILogService): void {

		// 监听未处理的拒绝事件
		// 注意：有意不注册为可处置的，以处理
		//       在关闭阶段可能发生的错误。
		mainWindow.addEventListener('unhandledrejection', (event) => {

			// 参见 https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
			onUnexpectedError(event.reason);

			// 防止将此事件打印到控制台
			event.preventDefault();
		});

		// 安装意外错误处理程序
		setUnexpectedErrorHandler(error => this.handleUnexpectedError(error, logService));
	}

	private previousUnexpectedError: { message: string | undefined; time: number } = { message: undefined, time: 0 };
	private handleUnexpectedError(error: unknown, logService: ILogService): void {
		const message = toErrorMessage(error, true);
		if (!message) {
			return;
		}

		const now = Date.now();
		if (message === this.previousUnexpectedError.message && now - this.previousUnexpectedError.time <= 1000) {
			return; // 如果错误消息与前一个相同且间隔少于1秒，则返回
		}

		this.previousUnexpectedError.time = now;
		this.previousUnexpectedError.message = message;

		// 记录它
		logService.error(message);
	}

	startup(): IInstantiationService {
		try {

			// 配置发射器泄漏警告阈值
			this._register(setGlobalLeakWarningThreshold(175));

			// 服务
			const instantiationService = this.initServices(this.serviceCollection);

			// 使用服务访问器调用一个函数。
			// 在服务访问器中，可以获取并使用已注册的服务。
			instantiationService.invokeFunction(accessor => {
				const lifecycleService = accessor.get(ILifecycleService);
				const storageService = accessor.get(IStorageService);
				const configurationService = accessor.get(IConfigurationService);
				const hostService = accessor.get(IHostService);
				const hoverService = accessor.get(IHoverService);
				const dialogService = accessor.get(IDialogService);
				const notificationService = accessor.get(INotificationService) as NotificationService;

				// 默认悬停委托必须在创建任何工作台/布局组件之前注册
				// 因为这些可能会使用默认悬停委托
				setHoverDelegateFactory((placement, enableInstantHover) => instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover: enableInstantHover }, {}));
				setBaseLayerHoverDelegate(hoverService);

				// 布局
				this.initLayout(accessor);

				// 注册表
				Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).start(accessor);
				Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor);

				// 上下文键
				this._register(instantiationService.createInstance(WorkbenchContextKeysHandler));

				// 注册监听器
				this.registerListeners(lifecycleService, storageService, configurationService, hostService, dialogService);

				// 渲染工作台
				this.renderWorkbench(instantiationService, notificationService, storageService, configurationService);

				// 工作台布局
				this.createWorkbenchLayout();

				// 布局
				this.layout();

				// 恢复
				this.restore(lifecycleService);
			});

			return instantiationService;
		} catch (error) {
			onUnexpectedError(error);

			throw error; // 重新抛出，因为这是一个我们无法在此处正确处理的关键问题
		}
	}

	private initServices(serviceCollection: ServiceCollection): IInstantiationService {

		// 布局服务
		serviceCollection.set(IWorkbenchLayoutService, this);

		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		//
		// 注意: 请不要在此处注册服务。使用`registerSingleton()`
		//       来自`workbench.common.main.ts`如果服务在桌面和Web之间共享，
		//       或者来自`workbench.desktop.main.ts`如果服务仅限桌面使用。
		//
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

		// 所有贡献的服务
		const contributedServices = getSingletonServiceDescriptors();
		for (const [id, descriptor] of contributedServices) {
			serviceCollection.set(id, descriptor);
		}

		const instantiationService = new InstantiationService(serviceCollection, true);

		// 总结
		instantiationService.invokeFunction(accessor => {
			const lifecycleService = accessor.get(ILifecycleService);

			// TODO@Sandeep 围绕循环依赖的技术债务
			const configurationService = accessor.get(IConfigurationService) as any;
			if (typeof configurationService.acquireInstantiationService === 'function') {
				configurationService.acquireInstantiationService(instantiationService);
			}

			// 向生命周期发出服务已设置的信号
			lifecycleService.phase = LifecyclePhase.Ready;
		});

		return instantiationService;
	}

	private registerListeners(lifecycleService: ILifecycleService, storageService: IStorageService, configurationService: IConfigurationService, hostService: IHostService, dialogService: IDialogService): void {

		// 配置更改
		this._register(configurationService.onDidChangeConfiguration(e => this.updateFontAliasing(e, configurationService)));

		// 字体信息
		if (isNative) {
			this._register(storageService.onWillSaveState(e => {
				if (e.reason === WillSaveStateReason.SHUTDOWN) {
					this.storeFontInfo(storageService);
				}
			}));
		} else {
			this._register(lifecycleService.onWillShutdown(() => this.storeFontInfo(storageService)));
		}

		// 生命周期
		this._register(lifecycleService.onWillShutdown(event => this._onWillShutdown.fire(event)));
		this._register(lifecycleService.onDidShutdown(() => {
			this._onDidShutdown.fire();
			this.dispose();
		}));

		// 在某些环境中，我们没有足够的时间在关闭时保存状态。
		// 在其他情况下，VSCode可能会崩溃，所以我们定期保存状态以减少
		// 丢失任何状态的可能性。
		// 窗口失去焦点是用户已停止在该窗口中工作的一个好迹象，
		// 所以我们选择这个时间来收集状态。
		this._register(hostService.onDidChangeFocus(focus => {
			if (!focus) {
				storageService.flush();
			}
		}));

		// 对话框显示/隐藏
		this._register(dialogService.onWillShowDialog(() => this.mainContainer.classList.add('modal-dialog-visible')));
		this._register(dialogService.onDidShowDialog(() => this.mainContainer.classList.remove('modal-dialog-visible')));
	}

	private fontAliasing: 'default' | 'antialiased' | 'none' | 'auto' | undefined;
	private updateFontAliasing(e: IConfigurationChangeEvent | undefined, configurationService: IConfigurationService) {
		if (!isMacintosh) {
			return; // 仅限macOS
		}

		if (e && !e.affectsConfiguration('workbench.fontAliasing')) {
			return;
		}

		const aliasing = configurationService.getValue<'default' | 'antialiased' | 'none' | 'auto'>('workbench.fontAliasing');
		if (this.fontAliasing === aliasing) {
			return;
		}

		this.fontAliasing = aliasing;

		// 移除所有
		const fontAliasingValues: (typeof aliasing)[] = ['antialiased', 'none', 'auto'];
		this.mainContainer.classList.remove(...fontAliasingValues.map(value => `monaco-font-aliasing-${value}`));

		// 添加特定
		if (fontAliasingValues.some(option => option === aliasing)) {
			this.mainContainer.classList.add(`monaco-font-aliasing-${aliasing}`);
		}
	}

	private restoreFontInfo(storageService: IStorageService, configurationService: IConfigurationService): void {
		const storedFontInfoRaw = storageService.get('editorFontInfo', StorageScope.APPLICATION);
		if (storedFontInfoRaw) {
			try {
				const storedFontInfo = JSON.parse(storedFontInfoRaw);
				if (Array.isArray(storedFontInfo)) {
					FontMeasurements.restoreFontInfo(mainWindow, storedFontInfo);
				}
			} catch (err) {
				/* 忽略 */
			}
		}

		FontMeasurements.readFontInfo(mainWindow, BareFontInfo.createFromRawSettings(configurationService.getValue('editor'), PixelRatio.getInstance(mainWindow).value));
	}

	private storeFontInfo(storageService: IStorageService): void {
		const serializedFontInfo = FontMeasurements.serializeFontInfo(mainWindow);
		if (serializedFontInfo) {
			storageService.store('editorFontInfo', JSON.stringify(serializedFontInfo), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	private renderWorkbench(instantiationService: IInstantiationService, notificationService: NotificationService, storageService: IStorageService, configurationService: IConfigurationService): void {

		// ARIA和信号
		setARIAContainer(this.mainContainer);
		setProgressAcccessibilitySignalScheduler((msDelayTime: number, msLoopTime?: number) => instantiationService.createInstance(AccessibilityProgressSignalScheduler, msDelayTime, msLoopTime));

		// 状态特定类
		const platformClass = isWindows ? 'windows' : isLinux ? 'linux' : 'mac';
		const workbenchClasses = coalesce([
			'monaco-workbench',
			platformClass,
			isWeb ? 'web' : undefined,
			isChrome ? 'chromium' : isFirefox ? 'firefox' : isSafari ? 'safari' : undefined,
			...this.getLayoutClasses(),
			...(this.options?.extraClasses ? this.options.extraClasses : [])
		]);

		this.mainContainer.classList.add(...workbenchClasses);

		// 应用字体抗锯齿
		this.updateFontAliasing(undefined, configurationService);

		// 在构建太多DOM元素之前预热字体缓存信息
		this.restoreFontInfo(storageService, configurationService);

		// 创建部件
		for (const { id, role, classes, options } of [
			{ id: Parts.TITLEBAR_PART, role: 'none', classes: ['titlebar'] },
			{ id: Parts.BANNER_PART, role: 'banner', classes: ['banner'] },
			{ id: Parts.ACTIVITYBAR_PART, role: 'none', classes: ['activitybar', this.getSideBarPosition() === Position.LEFT ? 'left' : 'right'] }, // 对某些部件使用角色'none'使屏幕阅读器不那么唠叨 #114892
			{ id: Parts.SIDEBAR_PART, role: 'none', classes: ['sidebar', this.getSideBarPosition() === Position.LEFT ? 'left' : 'right'] },
			{ id: Parts.EDITOR_PART, role: 'main', classes: ['editor'], options: { restorePreviousState: this.willRestoreEditors() } },
			{ id: Parts.PANEL_PART, role: 'none', classes: ['panel', 'basepanel', positionToString(this.getPanelPosition())] },
			{ id: Parts.AUXILIARYBAR_PART, role: 'none', classes: ['auxiliarybar', 'basepanel', this.getSideBarPosition() === Position.LEFT ? 'right' : 'left'] },
			{ id: Parts.STATUSBAR_PART, role: 'status', classes: ['statusbar'] }
		]) {
			const partContainer = this.createPart(id, role, classes);

			mark(`code/willCreatePart/${id}`);
			this.getPart(id).create(partContainer, options);
			mark(`code/didCreatePart/${id}`);
		}

		// 通知处理程序
		this.createNotificationsHandlers(instantiationService, notificationService);

		// 将工作台添加到DOM
		this.parent.appendChild(this.mainContainer);
	}

	private createPart(id: string, role: string, classes: string[]): HTMLElement {
		const part = document.createElement(role === 'status' ? 'footer' /* 对状态栏使用footer元素 #98376 */ : 'div');
		part.classList.add('part', ...classes);
		part.id = id;
		part.setAttribute('role', role);
		if (role === 'status') {
			part.setAttribute('aria-live', 'off');
		}

		return part;
	}

	private createNotificationsHandlers(instantiationService: IInstantiationService, notificationService: NotificationService): void {

		// 实例化通知组件
		const notificationsCenter = this._register(instantiationService.createInstance(NotificationsCenter, this.mainContainer, notificationService.model));
		const notificationsToasts = this._register(instantiationService.createInstance(NotificationsToasts, this.mainContainer, notificationService.model));
		this._register(instantiationService.createInstance(NotificationsAlerts, notificationService.model));
		const notificationsStatus = instantiationService.createInstance(NotificationsStatus, notificationService.model);

		// 可见性
		this._register(notificationsCenter.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
			notificationsToasts.update(notificationsCenter.isVisible);
		}));

		this._register(notificationsToasts.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
		}));

		// 注册命令
		registerNotificationCommands(notificationsCenter, notificationsToasts, notificationService.model);

		// 注册通知可访问视图
		AccessibleViewRegistry.register(new NotificationAccessibleView());

		// 向布局注册
		this.registerNotifications({
			onDidChangeNotificationsVisibility: Event.map(Event.any(notificationsToasts.onDidChangeVisibility, notificationsCenter.onDidChangeVisibility), () => notificationsToasts.isVisible || notificationsCenter.isVisible)
		});
	}

	private restore(lifecycleService: ILifecycleService): void {

		// 要求每个部分恢复
		try {
			this.restoreParts();
		} catch (error) {
			onUnexpectedError(error);
		}

		// 在布局恢复后过渡到恢复阶段
		// 但不要在这上面无限期等待，以应对慢速
		// 编辑器的恢复。由于工作台功能齐全
		// 即使可见编辑器尚未解析，我们仍然
		// 希望`Restored`阶段的贡献在之前工作
		// 慢编辑器已解析。但我们也不想让快速
		// 编辑器因太多贡献而变慢，所以我们通过
		// `Promise.race`找到中间解决方案
		this.whenReady.finally(() =>
			Promise.race([
				this.whenRestored,
				timeout(2000)
			]).finally(() => {

				// 仅当布局完全恢复时更新性能标记。
				// 我们希望包括恢复
				// 编辑器所需的时间在这些数字中

				function markDidStartWorkbench() {
					mark('code/didStartWorkbench');
					performance.measure('perf: workbench create & restore', 'code/didLoadWorkbenchMain', 'code/didStartWorkbench');
				}

				if (this.isRestored()) {
					markDidStartWorkbench();
				} else {
					this.whenRestored.finally(() => markDidStartWorkbench());
				}

				// 将生命周期阶段设置为`Restored`
				lifecycleService.phase = LifecyclePhase.Restored;

				// 短暂延迟后将生命周期阶段设置为`Eventually`，并在空闲时（最少2.5秒，最多5秒）
				const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
					this._register(runWhenWindowIdle(mainWindow, () => lifecycleService.phase = LifecyclePhase.Eventually, 2500));
				}, 2500));
				eventuallyPhaseScheduler.schedule();
			})
		);
	}
}
