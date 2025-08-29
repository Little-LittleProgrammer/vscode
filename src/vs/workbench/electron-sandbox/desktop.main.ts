/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. 保留所有权利。
 *  使用MIT许可证。有关许可信息，请参阅项目根目录中的License.txt。
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import product from '../../platform/product/common/product.js';
import { INativeWindowConfiguration, IWindowsConfiguration } from '../../platform/window/common/window.js';
import { Workbench } from '../browser/workbench.js';
import { NativeWindow } from './window.js';
import { setFullscreen } from '../../base/browser/browser.js';
import { domContentLoaded } from '../../base/browser/dom.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import { WorkspaceService } from '../services/configuration/browser/configurationService.js';
import { INativeWorkbenchEnvironmentService, NativeWorkbenchEnvironmentService } from '../services/environment/electron-sandbox/environmentService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILoggerService, ILogService, LogLevel } from '../../platform/log/common/log.js';
import { NativeWorkbenchStorageService } from '../services/storage/electron-sandbox/storageService.js';
import { IWorkspaceContextService, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IAnyWorkspaceIdentifier, reviveIdentifier, toWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IWorkbenchConfigurationService } from '../services/configuration/common/configuration.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../platform/ipc/electron-sandbox/services.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { SharedProcessService } from '../services/sharedProcess/electron-sandbox/sharedProcessService.js';
import { RemoteAuthorityResolverService } from '../../platform/remote/electron-sandbox/remoteAuthorityResolverService.js';
import { IRemoteAuthorityResolverService, RemoteConnectionType } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAgentService } from '../services/remote/electron-sandbox/remoteAgentService.js';
import { IRemoteAgentService } from '../services/remote/common/remoteAgentService.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { RemoteFileSystemProviderClient } from '../services/remote/common/remoteFileSystemProviderClient.js';
import { ConfigurationCache } from '../services/configuration/common/configurationCache.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../platform/uriIdentity/common/uriIdentityService.js';
import { INativeKeyboardLayoutService, NativeKeyboardLayoutService } from '../services/keybinding/electron-sandbox/nativeKeyboardLayoutService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-sandbox/mainProcessService.js';
import { LoggerChannelClient } from '../../platform/log/common/logIpc.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { NativeLogService } from '../services/log/electron-sandbox/logService.js';
import { WorkspaceTrustEnablementService, WorkspaceTrustManagementService } from '../services/workspaces/common/workspaceTrust.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { safeStringify } from '../../base/common/objects.js';
import { IUtilityProcessWorkerWorkbenchService, UtilityProcessWorkerWorkbenchService } from '../services/utilityProcess/electron-sandbox/utilityProcessWorkerWorkbenchService.js';
import { isBigSurOrNewer, isCI, isMacintosh } from '../../base/common/platform.js';
import { Schemas } from '../../base/common/network.js';
import { DiskFileSystemProvider } from '../services/files/electron-sandbox/diskFileSystemProvider.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { IUserDataProfilesService, reviveProfile } from '../../platform/userDataProfile/common/userDataProfile.js';
import { UserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfileIpc.js';
import { PolicyChannelClient } from '../../platform/policy/common/policyIpc.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { UserDataProfileService } from '../services/userDataProfile/common/userDataProfileService.js';
import { IUserDataProfileService } from '../services/userDataProfile/common/userDataProfile.js';
import { BrowserSocketFactory } from '../../platform/remote/browser/browserSocketFactory.js';
import { RemoteSocketFactoryService, IRemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { ElectronRemoteResourceLoader } from '../../platform/remote/electron-sandbox/electronRemoteResourceLoader.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { applyZoom } from '../../platform/window/electron-sandbox/window.js';
import { mainWindow } from '../../base/browser/window.js';
import { DefaultAccountService, IDefaultAccountService } from '../services/accounts/common/defaultAccount.js';
import { AccountPolicyService } from '../services/policies/common/accountPolicyService.js';
import { MultiplexPolicyService } from '../services/policies/common/multiplexPolicyService.js';

/**
 * VSCode桌面版的主类，负责初始化和启动整个工作台
 */
export class DesktopMain extends Disposable {

	constructor(
		private readonly configuration: INativeWindowConfiguration
	) {
		super();

		this.init();
	}

	/**
	 * 初始化桌面主实例
	 */
	private init(): void {

		// 处理配置文件URI
		this.reviveUris();

		// 如果配置中指定了全屏模式，则尽早应用
		setFullscreen(!!this.configuration.fullscreen, mainWindow);
	}

	/**
	 * 恢复配置中的URI对象
	 */
	private reviveUris() {

		// 工作区
		const workspace = reviveIdentifier(this.configuration.workspace);
		if (isWorkspaceIdentifier(workspace) || isSingleFolderWorkspaceIdentifier(workspace)) {
			this.configuration.workspace = workspace;
		}

		// 文件
		const filesToWait = this.configuration.filesToWait;
		const filesToWaitPaths = filesToWait?.paths;
		for (const paths of [filesToWaitPaths, this.configuration.filesToOpenOrCreate, this.configuration.filesToDiff, this.configuration.filesToMerge]) {
			if (Array.isArray(paths)) {
				for (const path of paths) {
					if (path.fileUri) {
						path.fileUri = URI.revive(path.fileUri);
					}
				}
			}
		}

		if (filesToWait) {
			filesToWait.waitMarkerFileUri = URI.revive(filesToWait.waitMarkerFileUri);
		}
	}

	/**
	 * 打开工作台
	 */
	async open(): Promise<void> {

		// 并行初始化服务并等待DOM准备就绪
		const [services] = await Promise.all([this.initServices(), domContentLoaded(mainWindow)]);

		// 在创建工作台之前尽早应用缩放级别以防闪烁。
		// 我们还需要考虑缩放级别可以根据工作区进行配置，
		// 因此需要已解析的配置服务。
		// 最后，窗口可能有一个不是从设置派生的自定义缩放级别。
		// (修复 https://github.com/microsoft/vscode/issues/187982)
		this.applyWindowZoomLevel(services.configurationService);

		// 创建工作台
		const workbench = new Workbench(mainWindow.document.body, { extraClasses: this.getExtraClasses() }, services.serviceCollection, services.logService);

		// 注册监听器
		this.registerListeners(workbench, services.storageService);

		// 启动
		const instantiationService = workbench.startup();

		// 窗口
		this._register(instantiationService.createInstance(NativeWindow));
	}

	/**
	 * 应用窗口缩放级别
	 */
	private applyWindowZoomLevel(configurationService: IConfigurationService) {
		let zoomLevel: number | undefined = undefined;
		if (this.configuration.isCustomZoomLevel && typeof this.configuration.zoomLevel === 'number') {
			zoomLevel = this.configuration.zoomLevel;
		} else {
			const windowConfig = configurationService.getValue<IWindowsConfiguration>();
			zoomLevel = typeof windowConfig.window?.zoomLevel === 'number' ? windowConfig.window.zoomLevel : 0;
		}

		applyZoom(zoomLevel, mainWindow);
	}

	/**
	 * 获取额外的CSS类
	 */
	private getExtraClasses(): string[] {
		if (isMacintosh && isBigSurOrNewer(this.configuration.os.release)) {
			return ['macos-bigsur-or-newer'];
		}

		return [];
	}

	/**
	 * 注册监听器
	 */
	private registerListeners(workbench: Workbench, storageService: NativeWorkbenchStorageService): void {

		// 工作台生命周期
		this._register(workbench.onWillShutdown(event => event.join(storageService.close(), { id: 'join.closeStorage', label: localize('join.closeStorage', "正在保存UI状态") })));
		this._register(workbench.onDidShutdown(() => this.dispose()));
	}

	/**
	 * 初始化服务
	 */
	private async initServices(): Promise<{ serviceCollection: ServiceCollection; logService: ILogService; storageService: NativeWorkbenchStorageService; configurationService: IConfigurationService }> {
		const serviceCollection = new ServiceCollection();


		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		//
		// 注意: 请不要在这里注册服务。如果服务在桌面和Web之间共享，
		//      请使用`workbench.common.main.ts`中的`registerSingleton()`；
		//      如果服务仅限桌面使用，请使用`workbench.desktop.main.ts`。
		//
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!


		// 主进程
		const mainProcessService = this._register(new ElectronIPCMainProcessService(this.configuration.windowId));
		serviceCollection.set(IMainProcessService, mainProcessService);

		// 产品
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		serviceCollection.set(IProductService, productService);

		// 环境
		const environmentService = new NativeWorkbenchEnvironmentService(this.configuration, productService);
		serviceCollection.set(INativeWorkbenchEnvironmentService, environmentService);

		// 日志器
		const loggers = this.configuration.loggers.map(loggerResource => ({ ...loggerResource, resource: URI.revive(loggerResource.resource) }));
		const loggerService = new LoggerChannelClient(this.configuration.windowId, this.configuration.logLevel, environmentService.windowLogsPath, loggers, mainProcessService.getChannel('logger'));
		serviceCollection.set(ILoggerService, loggerService);

		// 日志
		const logService = this._register(new NativeLogService(loggerService, environmentService));
		serviceCollection.set(ILogService, logService);
		if (isCI) {
			logService.info('workbench#open()'); // 标记工作台打开有助于诊断不稳定的集成/冒烟测试
		}
		// 在调用 trace 前先判断级别，避免不必要的 safeStringify 序列化开销
		if (logService.getLevel() === LogLevel.Trace) {
			logService.trace('workbench#open(): with configuration', safeStringify({ ...this.configuration, nls: undefined /* 排除大型属性 */ }));
		}

		// 默认账户
		const defaultAccountService = this._register(new DefaultAccountService());
		serviceCollection.set(IDefaultAccountService, defaultAccountService);

		// 策略
		let policyService: IPolicyService;
		const accountPolicy = new AccountPolicyService(logService, defaultAccountService);
		if (this.configuration.policiesData) {
			const policyChannel = new PolicyChannelClient(this.configuration.policiesData, mainProcessService.getChannel('policy'));
			policyService = new MultiplexPolicyService([policyChannel, accountPolicy], logService);
		} else {
			policyService = accountPolicy;
		}
		serviceCollection.set(IPolicyService, policyService);

		// 共享进程
		const sharedProcessService = new SharedProcessService(this.configuration.windowId, logService);
		serviceCollection.set(ISharedProcessService, sharedProcessService);

		// 实用程序进程工作器
		const utilityProcessWorkerWorkbenchService = new UtilityProcessWorkerWorkbenchService(this.configuration.windowId, logService, mainProcessService);
		serviceCollection.set(IUtilityProcessWorkerWorkbenchService, utilityProcessWorkerWorkbenchService);

		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		//
		// 注意: 请不要在这里注册服务。如果服务在桌面和Web之间共享，
		//      请使用`workbench.common.main.ts`中的`registerSingleton()`；
		//      如果服务仅限桌面使用，请使用`workbench.desktop.main.ts`。
		//
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!


		// 签名
		const signService = ProxyChannel.toService<ISignService>(mainProcessService.getChannel('sign'));
		serviceCollection.set(ISignService, signService);

		// 文件
		const fileService = this._register(new FileService(logService));
		serviceCollection.set(IFileService, fileService);

		// 远程
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(productService, new ElectronRemoteResourceLoader(environmentService.window.id, mainProcessService, fileService));
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);

		// 本地文件
		const diskFileSystemProvider = this._register(new DiskFileSystemProvider(mainProcessService, utilityProcessWorkerWorkbenchService, logService, loggerService));
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		// URI标识
		const uriIdentityService = new UriIdentityService(fileService);
		serviceCollection.set(IUriIdentityService, uriIdentityService);

		// 用户数据配置文件
		const userDataProfilesService = new UserDataProfilesService(this.configuration.profiles.all, URI.revive(this.configuration.profiles.home).with({ scheme: environmentService.userRoamingDataHome.scheme }), mainProcessService.getChannel('userDataProfiles'));
		serviceCollection.set(IUserDataProfilesService, userDataProfilesService);
		const userDataProfileService = new UserDataProfileService(reviveProfile(this.configuration.profiles.profile, userDataProfilesService.profilesHome.scheme));
		serviceCollection.set(IUserDataProfileService, userDataProfileService);

		// 为用户数据使用FileUserDataProvider
		// 以启用原子读/写操作。
		fileService.registerProvider(Schemas.vscodeUserData, this._register(new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesService, uriIdentityService, logService)));

		// 远程代理
		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		remoteSocketFactoryService.register(RemoteConnectionType.WebSocket, new BrowserSocketFactory(null));
		serviceCollection.set(IRemoteSocketFactoryService, remoteSocketFactoryService);
		const remoteAgentService = this._register(new RemoteAgentService(remoteSocketFactoryService, userDataProfileService, environmentService, productService, remoteAuthorityResolverService, signService, logService));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		// 远程文件
		this._register(RemoteFileSystemProviderClient.register(remoteAgentService, fileService, logService));

		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		//
		// 注意: 请不要在这里注册服务。如果服务在桌面和Web之间共享，
		//      请使用`workbench.common.main.ts`中的`registerSingleton()`；
		//      如果服务仅限桌面使用，请使用`workbench.desktop.main.ts`。
		//
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

		// 并行创建需要解析的服务
		const workspace = this.resolveWorkspaceIdentifier(environmentService);
		const [configurationService, storageService] = await Promise.all([
			this.createWorkspaceService(workspace, environmentService, userDataProfileService, userDataProfilesService, fileService, remoteAgentService, uriIdentityService, logService, policyService).then(service => {

				// 工作区
				serviceCollection.set(IWorkspaceContextService, service);

				// 配置
				serviceCollection.set(IWorkbenchConfigurationService, service);

				return service;
			}),

			this.createStorageService(workspace, environmentService, userDataProfileService, userDataProfilesService, mainProcessService).then(service => {

				// 存储
				serviceCollection.set(IStorageService, service);

				return service;
			}),

			this.createKeyboardLayoutService(mainProcessService).then(service => {

				// 键盘布局
				serviceCollection.set(INativeKeyboardLayoutService, service);

				return service;
			})
		]);

		// 工作区信任服务
		const workspaceTrustEnablementService = new WorkspaceTrustEnablementService(configurationService, environmentService);
		serviceCollection.set(IWorkspaceTrustEnablementService, workspaceTrustEnablementService);

		const workspaceTrustManagementService = new WorkspaceTrustManagementService(configurationService, remoteAuthorityResolverService, storageService, uriIdentityService, environmentService, configurationService, workspaceTrustEnablementService, fileService);
		serviceCollection.set(IWorkspaceTrustManagementService, workspaceTrustManagementService);

		// 更新工作区信任，以便相应地更新配置
		configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted());
		this._register(workspaceTrustManagementService.onDidChangeTrust(() => configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted())));


		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
		//
		// 注意: 请不要在这里注册服务。如果服务在桌面和Web之间共享，
		//      请使用`workbench.common.main.ts`中的`registerSingleton()`；
		//      如果服务仅限桌面使用，请使用`workbench.desktop.main.ts`。
		//
		// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!


		return { serviceCollection, logService, storageService, configurationService };
	}

	/**
	 * 解析工作区标识符
	 */
	private resolveWorkspaceIdentifier(environmentService: INativeWorkbenchEnvironmentService): IAnyWorkspaceIdentifier {

		// 当打开文件夹或多根目录时提前返回
		if (this.configuration.workspace) {
			return this.configuration.workspace;
		}

		// 否则，工作区为空，所以我们派生一个标识符
		return toWorkspaceIdentifier(this.configuration.backupPath, environmentService.isExtensionDevelopment);
	}

	/**
	 * 创建工作区服务
	 */
	private async createWorkspaceService(
		workspace: IAnyWorkspaceIdentifier,
		environmentService: INativeWorkbenchEnvironmentService,
		userDataProfileService: IUserDataProfileService,
		userDataProfilesService: IUserDataProfilesService,
		fileService: FileService,
		remoteAgentService: IRemoteAgentService,
		uriIdentityService: IUriIdentityService,
		logService: ILogService,
		policyService: IPolicyService
	): Promise<WorkspaceService> {
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData] /* 缓存所有非原生资源 */, environmentService, fileService);
		const workspaceService = new WorkspaceService({ remoteAuthority: environmentService.remoteAuthority, configurationCache }, environmentService, userDataProfileService, userDataProfilesService, fileService, remoteAgentService, uriIdentityService, logService, policyService);

		try {
			await workspaceService.initialize(workspace);

			return workspaceService;
		} catch (error) {
			onUnexpectedError(error);

			return workspaceService;
		}
	}

	/**
	 * 创建存储服务
	 */
	private async createStorageService(workspace: IAnyWorkspaceIdentifier, environmentService: INativeWorkbenchEnvironmentService, userDataProfileService: IUserDataProfileService, userDataProfilesService: IUserDataProfilesService, mainProcessService: IMainProcessService): Promise<NativeWorkbenchStorageService> {
		const storageService = new NativeWorkbenchStorageService(workspace, userDataProfileService, userDataProfilesService, mainProcessService, environmentService);

		try {
			await storageService.initialize();

			return storageService;
		} catch (error) {
			onUnexpectedError(error);

			return storageService;
		}
	}

	/**
	 * 创建键盘布局服务
	 */
	private async createKeyboardLayoutService(mainProcessService: IMainProcessService): Promise<NativeKeyboardLayoutService> {
		const keyboardLayoutService = new NativeKeyboardLayoutService(mainProcessService);

		try {
			await keyboardLayoutService.initialize();

			return keyboardLayoutService;
		} catch (error) {
			onUnexpectedError(error);

			return keyboardLayoutService;
		}
	}
}

/**
 * 桌面主界面接口
 */
export interface IDesktopMain {
	main(configuration: INativeWindowConfiguration): Promise<void>;
}

/**
 * 主函数 - 创建并启动桌面工作台
 */
export function main(configuration: INativeWindowConfiguration): Promise<void> {
	const workbench = new DesktopMain(configuration);

	return workbench.open();
}
