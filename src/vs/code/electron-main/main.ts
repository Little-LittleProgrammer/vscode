/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * electron-main/main 是程序真正启动的入口,进入main process初始化流程
 * 负责启动 VS Code 应用程序的主进程，并初始化所有必要的服务和组件。
 * 主要任务：
 * 1. 初始化服务
 * 2. 启动主实例
 * 3. 处理错误
 * 4. 退出应用程序
 */
import '../../platform/update/common/update.config.contribution.js';

import { app, dialog } from 'electron';
import { unlinkSync, promises } from 'fs';
import { URI } from '../../base/common/uri.js';
import { coalesce, distinct } from '../../base/common/arrays.js';
import { Promises } from '../../base/common/async.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { ExpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { IPathWithLineAndColumn, isValidBasename, parseLineAndColumnAware, sanitizeFilePath } from '../../base/common/extpath.js';
import { Event } from '../../base/common/event.js';
import { getPathLabel } from '../../base/common/labels.js';
import { Schemas } from '../../base/common/network.js';
import { basename, resolve } from '../../base/common/path.js';
import { mark } from '../../base/common/performance.js';
import { IProcessEnvironment, isMacintosh, isWindows, OS } from '../../base/common/platform.js';
import { cwd } from '../../base/common/process.js';
import { rtrim, trim } from '../../base/common/strings.js';
import { Promises as FSPromises } from '../../base/node/pfs.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Client as NodeIPCClient } from '../../base/parts/ipc/common/ipc.net.js';
import { connect as nodeIPCConnect, serve as nodeIPCServe, Server as NodeIPCServer, XDG_RUNTIME_DIR } from '../../base/parts/ipc/node/ipc.net.js';
import { CodeApplication } from './app.js';
import { localize } from '../../nls.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ConfigurationService } from '../../platform/configuration/common/configurationService.js';
import { IDiagnosticsMainService } from '../../platform/diagnostics/electron-main/diagnosticsMainService.js';
import { DiagnosticsService } from '../../platform/diagnostics/node/diagnosticsService.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { EnvironmentMainService, IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { addArg, parseMainProcessArgv } from '../../platform/environment/node/argvHelper.js';
import { createWaitMarkerFileSync } from '../../platform/environment/node/wait.js';
import { IFileService } from '../../platform/files/common/files.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';
import { ILifecycleMainService, LifecycleMainService } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { BufferLogger } from '../../platform/log/common/bufferLog.js';
import { ConsoleMainLogger, getLogLevel, ILoggerService, ILogService } from '../../platform/log/common/log.js';
import product from '../../platform/product/common/product.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { IProtocolMainService } from '../../platform/protocol/electron-main/protocol.js';
import { ProtocolMainService } from '../../platform/protocol/electron-main/protocolMainService.js';
import { ITunnelService } from '../../platform/tunnel/common/tunnel.js';
import { TunnelService } from '../../platform/tunnel/node/tunnelService.js';
import { IRequestService } from '../../platform/request/common/request.js';
import { RequestService } from '../../platform/request/electron-utility/requestService.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { SignService } from '../../platform/sign/node/signService.js';
import { IStateReadService, IStateService } from '../../platform/state/node/state.js';
import { NullTelemetryService } from '../../platform/telemetry/common/telemetryUtils.js';
import { IThemeMainService, ThemeMainService } from '../../platform/theme/electron-main/themeMainService.js';
import { IUserDataProfilesMainService, UserDataProfilesMainService } from '../../platform/userDataProfile/electron-main/userDataProfile.js';
import { IPolicyService, NullPolicyService } from '../../platform/policy/common/policy.js';
import { NativePolicyService } from '../../platform/policy/node/nativePolicyService.js';
import { FilePolicyService } from '../../platform/policy/common/filePolicyService.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../platform/uriIdentity/common/uriIdentityService.js';
import { ILoggerMainService, LoggerMainService } from '../../platform/log/electron-main/loggerService.js';
import { LogService } from '../../platform/log/common/logService.js';
import { massageMessageBoxOptions } from '../../platform/dialogs/common/dialogs.js';
import { SaveStrategy, StateService } from '../../platform/state/node/stateService.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { addUNCHostToAllowlist, getUNCHost } from '../../base/node/unc.js';

/**
 * VS Code 的主入口点。
 *
 * 注意：这个类可以存在多个实例，例如当 VS Code 已经在运行时，
 * 从命令行启动第二个实例。它总是会尝试与现有实例通信，
 * 以防止同时运行两个 VS Code 实例。
 */
class CodeMain {

	main(): void {
		try {
			this.startup();
		} catch (error) {
			console.error(error.message);
			app.exit(1);
		}
	}

	private async startup(): Promise<void> {

		// 尽早设置错误处理程序，这样我们就不会弹出
		// 默认的 electron 错误对话框
		setUnexpectedErrorHandler(err => console.error(err));

		// 创建服务
		/**
		 * 【instantiationService】 实例化服务，负责创建和管理所有服务实例
		 * 【instanceEnvironment】 实例环境，包含当前启动目录，日志目录，操作系统信息，配置文件目录，用户目录等
		 * 【environmentMainService】 环境服务，负责处理命令行参数和环境变量
		 * 【configurationService】 配置服务，负责管理用户配置文件
		 * 【stateMainService】 状态服务，负责管理应用程序状态
		 * 【bufferLogger】 缓冲日志，负责缓冲日志
		 * 【productService】 产品服务，负责提供产品相关的配置信息
		 * 【userDataProfilesMainService】 用户数据配置文件服务，负责管理用户数据配置文件
		 */
		const [instantiationService, instanceEnvironment, environmentMainService, configurationService, stateMainService, bufferLogger, productService, userDataProfilesMainService] = this.createServices();

		try {

			// 初始化服务
			try {
				await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);
			} catch (error) {

				// 对用户可以解决的错误显示一个对话框
				this.handleStartupDataDirError(environmentMainService, productService, error);

				throw error;
			}

			// 启动主实例
			await instantiationService.invokeFunction(async accessor => {
				const logService = accessor.get(ILogService); // 获取日志服务，管理日志系统的基础配置和生命周期
				const lifecycleMainService = accessor.get(ILifecycleMainService); // 获取生命周期服务
				const fileService = accessor.get(IFileService); // 获取文件服务
				const loggerService = accessor.get(ILoggerService); // 获取日志服务，管理和提供特定上下文或用途的日志记录器 (ILogger) 实例

				// 通过尝试成为服务器来创建主 IPC 服务器
				// 如果这引发错误，则意味着我们不是第一个
				// 运行的 VS Code 实例，因此我们将退出。
				const mainProcessNodeIpcServer = await this.claimInstance(logService, environmentMainService, lifecycleMainService, instantiationService, productService, true);

				// 写入一个锁文件以指示实例正在运行
				// (https://github.com/microsoft/vscode/issues/127861#issuecomment-877417451)
				FSPromises.writeFile(environmentMainService.mainLockfile, String(process.pid)).catch(err => {
					logService.warn(`app#startup(): 写入主锁文件时出错: ${err.stack}`);
				});

				// 出于性能原因延迟创建 spdlog (https://github.com/microsoft/vscode/issues/72906)
				bufferLogger.logger = loggerService.createLogger('main', { name: localize('mainLog', "Main") });

				// 生命周期
				Event.once(lifecycleMainService.onWillShutdown)(evt => {
					fileService.dispose();
					configurationService.dispose();
					evt.join('instanceLockfile', promises.unlink(environmentMainService.mainLockfile).catch(() => { /* 忽略 */ }));
				});

				// 创建主实例， 进入 vs/code/electron-main/app.ts 的 startup 方法
				return instantiationService.createInstance(CodeApplication, mainProcessNodeIpcServer, instanceEnvironment).startup();
			});
		} catch (error) {
			instantiationService.invokeFunction(this.quit, error);
		}
	}


	/**
	 * 创建并初始化VS Code主进程所需的核心服务
	 *
	 * 此方法负责创建和配置VS Code电子主进程所需的基础服务，包括：
	 * - 产品服务：提供产品相关的配置信息
	 * - 环境服务：处理命令行参数和环境变量
	 * - 日志服务：提供应用程序日志记录功能
	 * - 文件服务：处理文件系统操作
	 * - 状态服务：管理应用程序状态
	 * - 用户数据配置文件服务：管理用户数据和配置
	 *
	 * @returns 返回一个包含所有创建的核心服务的元组，这些服务将被用于应用程序的后续初始化和运行
	 */
	private createServices(): [IInstantiationService, IProcessEnvironment, IEnvironmentMainService, ConfigurationService, StateService, BufferLogger, IProductService, UserDataProfilesMainService] {
		const services = new ServiceCollection();
		const disposables = new DisposableStore();
		process.once('exit', () => disposables.dispose());

		// 产品
		const productService = { _serviceBrand: undefined, ...product };
		services.set(IProductService, productService);

		// 环境服务：通过这个服务获取当前启动目录，日志目录，操作系统信息，配置文件目录，用户目录等
		const environmentMainService = new EnvironmentMainService(this.resolveArgs(), productService);
		const instanceEnvironment = this.patchEnvironment(environmentMainService); // 使用实例的环境修补 `process.env`
		services.set(IEnvironmentMainService, environmentMainService);

		// 日志记录器 ：默认使用控制台日志ConsoleLogMainService 其中包含性能追踪和释放信息，日志输出级别
		const loggerService = new LoggerMainService(getLogLevel(environmentMainService), environmentMainService.logsHome);
		services.set(ILoggerMainService, loggerService);

		// 日志：我们需要缓冲 spdlog 日志，直到我们确定
		// 我们是唯一运行的实例，否则在 Windows 上会出现并发
		// 日志文件访问（https://github.com/microsoft/vscode/issues/41218）
		const bufferLogger = new BufferLogger(loggerService.getLogLevel());
		const logService = disposables.add(new LogService(bufferLogger, [new ConsoleMainLogger(loggerService.getLogLevel())]));
		services.set(ILogService, logService);

		// 文件
		const fileService = new FileService(logService);
		services.set(IFileService, fileService);
		const diskFileSystemProvider = new DiskFileSystemProvider(logService);
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		// URI 标识
		const uriIdentityService = new UriIdentityService(fileService);
		services.set(IUriIdentityService, uriIdentityService);

		// 状态
		const stateService = new StateService(SaveStrategy.DELAYED, environmentMainService, logService, fileService);
		services.set(IStateReadService, stateService);
		services.set(IStateService, stateService);

		// 用户数据配置文件
		const userDataProfilesMainService = new UserDataProfilesMainService(stateService, uriIdentityService, environmentMainService, fileService, logService);
		services.set(IUserDataProfilesMainService, userDataProfilesMainService);

		// 对用户数据使用 FileUserDataProvider
		// 以启用原子读/写操作。
		fileService.registerProvider(Schemas.vscodeUserData, new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesMainService, uriIdentityService, logService));

		// 策略
		let policyService: IPolicyService | undefined;
		if (isWindows && productService.win32RegValueName) {
			policyService = disposables.add(new NativePolicyService(logService, productService.win32RegValueName));
		} else if (isMacintosh && productService.darwinBundleIdentifier) {
			policyService = disposables.add(new NativePolicyService(logService, productService.darwinBundleIdentifier));
		} else if (environmentMainService.policyFile) {
			policyService = disposables.add(new FilePolicyService(environmentMainService.policyFile, fileService, logService));
		} else {
			policyService = new NullPolicyService();
		}
		services.set(IPolicyService, policyService);

		// 配置
		const configurationService = new ConfigurationService(userDataProfilesMainService.defaultProfile.settingsResource, fileService, policyService, logService);
		services.set(IConfigurationService, configurationService);

		// 生命周期
		services.set(ILifecycleMainService, new SyncDescriptor(LifecycleMainService, undefined, false));

		// 请求
		services.set(IRequestService, new SyncDescriptor(RequestService, undefined, true));

		// 主题
		services.set(IThemeMainService, new SyncDescriptor(ThemeMainService));

		// 签名
		services.set(ISignService, new SyncDescriptor(SignService, undefined, false /* 代理到其他进程 */));

		// 隧道
		services.set(ITunnelService, new SyncDescriptor(TunnelService));

		// 协议（出于安全原因，早期实例化且不使用同步描述符）
		services.set(IProtocolMainService, new ProtocolMainService(environmentMainService, userDataProfilesMainService, logService));

		return [new InstantiationService(services, true), instanceEnvironment, environmentMainService, configurationService, stateService, bufferLogger, productService, userDataProfilesMainService];
	}

	private patchEnvironment(environmentMainService: IEnvironmentMainService): IProcessEnvironment {
		const instanceEnvironment: IProcessEnvironment = {
			VSCODE_IPC_HOOK: environmentMainService.mainIPCHandle
		};

		['VSCODE_NLS_CONFIG', 'VSCODE_PORTABLE'].forEach(key => {
			const value = process.env[key];
			if (typeof value === 'string') {
				instanceEnvironment[key] = value;
			}
		});

		Object.assign(process.env, instanceEnvironment);

		return instanceEnvironment;
	}

	/**
	 * 初始化服务
	 *
	 * 此方法负责初始化 VS Code 主进程所需的核心服务，包括：
	 * - 环境服务：处理命令行参数和环境变量
	 * - 用户数据配置文件服务：管理用户数据和配置
	 * - 配置服务：管理用户配置文件
	 * - 状态服务：管理应用程序状态
	 * - 产品服务：提供产品相关的配置信息
	 *
	 * @param environmentMainService 环境服务
	 * @param userDataProfilesMainService 用户数据配置文件服务
	 * @param configurationService 配置服务
	 * @param stateService 状态服务
	 * @param productService 产品服务
	 */
	private async initServices(environmentMainService: IEnvironmentMainService, userDataProfilesMainService: UserDataProfilesMainService, configurationService: ConfigurationService, stateService: StateService, productService: IProductService): Promise<void> {
		// 使用 Promises.settled 方法并行执行多个异步操作，并等待所有操作完成（无论成功或失败）这比 Promise.all 更安全，因为即使某些操作失败，也会继续执行其他操作
		await Promises.settled<unknown>([

			// 环境服务（路径），
			Promise.all<string | undefined>([
				this.allowWindowsUNCPath(environmentMainService.extensionsPath), // 在 UNC驱动器上启用扩展路径，确保Windows网络路径可访问
				environmentMainService.codeCachePath,                           // 代码缓存路径，用于存储编译后的代码和缓存数据
				environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath, // 日志文件存储目录，用于存储应用程序运行日志
				userDataProfilesMainService.defaultProfile.globalStorageHome.with({ scheme: Schemas.file }).fsPath, // 默认用户配置文件的全局存储目录，存储扩展的全局数据
				environmentMainService.workspaceStorageHome.with({ scheme: Schemas.file }).fsPath, // 工作区存储目录，用于存储特定工作区的数据
				environmentMainService.localHistoryHome.with({ scheme: Schemas.file }).fsPath, // 本地历史记录目录，用于存储文件的本地历史版本
				environmentMainService.backupHome                               // 备份目录，用于存储未保存内容的备份，防止意外关闭导致数据丢失
			].map(path => path ? promises.mkdir(path, { recursive: true }) : undefined)),

			// 状态服务
			stateService.init(),

			// 配置服务
			configurationService.initialize()
		]);

		// 在初始化状态后初始化用户数据配置文件
		userDataProfilesMainService.init();
	}

	private allowWindowsUNCPath(path: string): string {
		if (isWindows) {
			const host = getUNCHost(path);
			if (host) {
				addUNCHostToAllowlist(host);
			}
		}

		return path;
	}

	private async claimInstance(logService: ILogService, environmentMainService: IEnvironmentMainService, lifecycleMainService: ILifecycleMainService, instantiationService: IInstantiationService, productService: IProductService, retry: boolean): Promise<NodeIPCServer> {

		// 尝试设置一个运行服务器。如果成功，则意味着
		// 我们是第一个启动的实例。否则，很可能
		// 另一个实例已经在运行。
		let mainProcessNodeIpcServer: NodeIPCServer; // 进程间通信服务
		try {
			mark('code/willStartMainServer');
			// main.ts在启动应用后就创建了一个主进程 main process，它可以通过electron中的一些模块直接与原生GUI交互。
			mainProcessNodeIpcServer = await nodeIPCServe(environmentMainService.mainIPCHandle); // 创建服务端 ipc 服务（IPC 通常指 Inter-Process Communication，即进程间通信）
			mark('code/didStartMainServer');
			Event.once(lifecycleMainService.onWillShutdown)(() => mainProcessNodeIpcServer.dispose());
		} catch (error) {

			// 处理意外错误（唯一预期的错误是 EADDRINUSE，
			// 表明另一个 VS Code 实例正在运行）
			if (error.code !== 'EADDRINUSE') {

				// 对用户可以解决的错误显示一个对话框
				this.handleStartupDataDirError(environmentMainService, productService, error);

				// 任何其他运行时错误都只打印到控制台
				throw error;
			}

			// 有一个正在运行的实例，让我们连接到它
			let client: NodeIPCClient<string>;
			try {
				client = await nodeIPCConnect(environmentMainService.mainIPCHandle, 'main');
			} catch (error) {

				// 通过向用户显示对话框来处理意外的连接错误
				if (!retry || isWindows || error.code !== 'ECONNREFUSED') {
					if (error.code === 'EPERM') {
						this.showStartupWarningDialog(
							localize('secondInstanceAdmin', "{0} 的另一个实例已作为管理员运行。", productService.nameShort),
							localize('secondInstanceAdminDetail', "请关闭其他实例并重试。"),
							productService
						);
					}

					throw error;
				}

				// 在 Linux 和 OS X 上，可能会留下管道文件
				// 让我们删除它，因为我们无法连接到它，然后
				// 重试整个过程
				try {
					unlinkSync(environmentMainService.mainIPCHandle);
				} catch (error) {
					logService.warn('无法删除过时的实例句柄', error);

					throw error;
				}

				return this.claimInstance(logService, environmentMainService, lifecycleMainService, instantiationService, productService, false);
			}

			// 来自 CLI 的测试要求当前是唯一的实例
			if (environmentMainService.extensionTestsLocationURI && !environmentMainService.debugExtensionHost.break) {
				const msg = `当前仅在没有其他 ${productService.nameShort} 实例运行时才支持从命令行运行扩展测试。`;
				logService.error(msg);
				client.dispose();

				throw new Error(msg);
			}

			// 如果与另一个实例通信花费很长时间，则在超时后显示警告对话框
			// 如果我们使用 --wait 运行，则跳过此步骤，因为在这种情况下，预计会等待一段时间。
			// 在收集诊断信息（--status）时也跳过此步骤，这可能需要更长的时间。
			let startupWarningDialogHandle: NodeJS.Timeout | undefined = undefined;
			if (!environmentMainService.args.wait && !environmentMainService.args.status) {
				startupWarningDialogHandle = setTimeout(() => {
					this.showStartupWarningDialog(
						localize('secondInstanceNoResponse', "{0} 的另一个实例正在运行但没有响应", productService.nameShort),
						localize('secondInstanceNoResponseDetail', "请关闭所有其他实例并重试。"),
						productService
					);
				}, 10000);
			}

			const otherInstanceLaunchMainService = ProxyChannel.toService<ILaunchMainService>(client.getChannel('launch'), { disableMarshalling: true });
			const otherInstanceDiagnosticsMainService = ProxyChannel.toService<IDiagnosticsMainService>(client.getChannel('diagnostics'), { disableMarshalling: true });

			// 进程信息
			if (environmentMainService.args.status) {
				return instantiationService.invokeFunction(async () => {
					const diagnosticsService = new DiagnosticsService(NullTelemetryService, productService);
					const mainDiagnostics = await otherInstanceDiagnosticsMainService.getMainDiagnostics();
					const remoteDiagnostics = await otherInstanceDiagnosticsMainService.getRemoteDiagnostics({ includeProcesses: true, includeWorkspaceMetadata: true });
					const diagnostics = await diagnosticsService.getDiagnostics(mainDiagnostics, remoteDiagnostics);
					console.log(diagnostics);

					throw new ExpectedError();
				});
			}

			// Windows：允许设置前台
			if (isWindows) {
				await this.windowsAllowSetForegroundWindow(otherInstanceLaunchMainService, logService);
			}

			// 发送环境信息...
			logService.trace('将环境发送到正在运行的实例...');
			await otherInstanceLaunchMainService.start(environmentMainService.args, process.env as IProcessEnvironment);

			// 清理
			client.dispose();

			// 既然我们已经启动了，请确保阻止警告对话框
			if (startupWarningDialogHandle) {
				clearTimeout(startupWarningDialogHandle);
			}

			throw new ExpectedError('已将环境发送到正在运行的实例。正在终止...');
		}

		// 打印 --status 使用信息
		if (environmentMainService.args.status) {
			console.log(localize('statusWarning', "警告：--status 参数只能在 {0} 已经在运行时使用。请在 {0} 启动后再次运行它。", productService.nameShort));

			throw new ExpectedError('正在终止...');
		}

		// 当我们确定我们是第一个启动的实例时，在这里设置 VSCODE_PID 变量。
		// 否则，我们会错误地覆盖 PID
		process.env['VSCODE_PID'] = String(process.pid);

		return mainProcessNodeIpcServer;
	}

	private handleStartupDataDirError(environmentMainService: IEnvironmentMainService, productService: IProductService, error: NodeJS.ErrnoException): void {
		if (error.code === 'EACCES' || error.code === 'EPERM') {
			const directories = coalesce([environmentMainService.userDataPath, environmentMainService.extensionsPath, XDG_RUNTIME_DIR]).map(folder => getPathLabel(URI.file(folder), { os: OS, tildify: environmentMainService }));

			this.showStartupWarningDialog(
				localize('startupDataDirError', "Unable to write program user data."),
				localize('startupUserDataAndExtensionsDirErrorDetail', "{0}\n\nPlease make sure the following directories are writeable:\n\n{1}", toErrorMessage(error), directories.join('\n')),
				productService
			);
		}
	}

	private showStartupWarningDialog(message: string, detail: string, productService: IProductService): void {

		// 在这里使用同步变体，因为我们很可能在此方法之后退出
		// 由于启动问题，否则对话框似乎会消失
		// https://github.com/microsoft/vscode/issues/104493

		dialog.showMessageBoxSync(massageMessageBoxOptions({
			type: 'warning',
			buttons: [localize({ key: 'close', comment: ['&& 表示助记符'] }, "&&关闭")],
			message,
			detail
		}, productService).options);
	}

	private async windowsAllowSetForegroundWindow(launchMainService: ILaunchMainService, logService: ILogService): Promise<void> {
		if (isWindows) {
			const processId = await launchMainService.getMainProcessId();

			logService.trace('Sending some foreground love to the running instance:', processId);

			try {
				(await import('windows-foreground-love')).allowSetForegroundWindow(processId);
			} catch (error) {
				logService.error(error);
			}
		}
	}

	private quit(accessor: ServicesAccessor, reason?: ExpectedError | Error): void {
		const logService = accessor.get(ILogService);
		const lifecycleMainService = accessor.get(ILifecycleMainService);

		let exitCode = 0;

		if (reason) {
			if ((reason as ExpectedError).isExpected) {
				if (reason.message) {
					logService.trace(reason.message);
				}
			} else {
				exitCode = 1; // 向外部发出错误信号

				if (reason.stack) {
					logService.error(reason.stack);
				} else {
					logService.error(`启动错误: ${reason.toString()}`);
				}
			}
		}

		lifecycleMainService.kill(exitCode);
	}

	//#region 命令行参数工具

	private resolveArgs(): NativeParsedArgs {

		// 解析参数
		const args = this.validatePaths(parseMainProcessArgv(process.argv));

		// 如果我们使用 --wait 启动，则创建一个随机临时文件
		// 并将其传递给启动实例。我们可以使用此文件
		// 等待它被删除，以监视编辑的文件
		// 是否已关闭，然后退出等待进程。
		//
		// 注意：如果等待标记已经作为参数添加，我们不会这样做。
		// 这可能发生在 VS Code 从 CLI 启动的情况下。

		if (args.wait && !args.waitMarkerFilePath) {
			const waitMarkerFilePath = createWaitMarkerFileSync(args.verbose);
			if (waitMarkerFilePath) {
				addArg(process.argv, '--waitMarkerFilePath', waitMarkerFilePath);
				args.waitMarkerFilePath = waitMarkerFilePath;
			}
		}

		return args;
	}

	private validatePaths(args: NativeParsedArgs): NativeParsedArgs {

		// 如果要使用 URL，则跟踪它们
		if (args['open-url']) {
			args._urls = args._;
			args._ = [];
		}

		// 规范化路径并注意跳转到行模式
		if (!args['remote']) {
			const paths = this.doValidatePaths(args._, args.goto);
			args._ = paths;
		}

		return args;
	}

	private doValidatePaths(args: string[], gotoLineMode?: boolean): string[] {
		const currentWorkingDir = cwd();
		const result = args.map(arg => {
			let pathCandidate = String(arg);

			let parsedPath: IPathWithLineAndColumn | undefined = undefined;
			if (gotoLineMode) {
				parsedPath = parseLineAndColumnAware(pathCandidate);
				pathCandidate = parsedPath.path;
			}

			if (pathCandidate) {
				pathCandidate = this.preparePath(currentWorkingDir, pathCandidate);
			}

			const sanitizedFilePath = sanitizeFilePath(pathCandidate, currentWorkingDir);

			const filePathBasename = basename(sanitizedFilePath);
			if (filePathBasename /* 如果在根目录打开代码，则可能为空 */ && !isValidBasename(filePathBasename)) {
				return null; // 不允许无效的文件名
			}

			if (gotoLineMode && parsedPath) {
				parsedPath.path = sanitizedFilePath;

				return this.toPath(parsedPath);
			}

			return sanitizedFilePath;
		});

		const caseInsensitive = isWindows || isMacintosh;
		const distinctPaths = distinct(result, path => path && caseInsensitive ? path.toLowerCase() : (path || ''));

		return coalesce(distinctPaths);
	}

	private preparePath(cwd: string, path: string): string {

		// 修剪尾随引号
		if (isWindows) {
			path = rtrim(path, '"'); // https://github.com/microsoft/vscode/issues/1498
		}

		// 修剪空白字符
		path = trim(trim(path, ' '), '	');

		if (isWindows) {

			// 如果是相对路径，则根据 cwd 解析路径
			path = resolve(cwd, path);

			// 在 Windows 上修剪尾随的 '.' 字符以防止无效的文件名
			path = rtrim(path, '.');
		}

		return path;
	}

	private toPath(pathWithLineAndCol: IPathWithLineAndColumn): string {
		const segments = [pathWithLineAndCol.path];

		if (typeof pathWithLineAndCol.line === 'number') {
			segments.push(String(pathWithLineAndCol.line));
		}

		if (typeof pathWithLineAndCol.column === 'number') {
			segments.push(String(pathWithLineAndCol.column));
		}

		return segments.join(':');
	}

	//#endregion
}

// 主启动
const code = new CodeMain();
code.main();
