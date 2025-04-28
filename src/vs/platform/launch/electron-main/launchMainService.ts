/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件说明：
 * launchMainService.ts 负责 VSCode 主进程的启动流程管理，处理从命令行或其他实例传递过来的参数，
 * 并根据参数决定如何打开窗口、处理 URL、环境变量等。
 *
 * 主要功能：
 * 1. 作为主进程服务，接收启动参数并决定窗口打开方式。
 * 2. 支持通过 URL 协议（如 vscode://）启动 VSCode 并处理相关逻辑。
 * 3. 处理扩展开发、diff/merge、临时配置文件等特殊启动场景。
 * 4. 提供主进程 PID 查询能力。
 *
 * 主要类与方法：
 * - LaunchMainService：主服务实现，核心方法包括 start、parseOpenUrl、startOpenWindow、getMainProcessId。
 * - start：主入口，处理参数并决定窗口/URL 处理方式。
 * - parseOpenUrl：解析 --open-url 参数，提取协议 URL。
 * - startOpenWindow：根据参数决定如何打开窗口（新建/复用/特殊模式）。
 * - getMainProcessId：返回主进程 PID。
 */

import { app } from 'electron';
import { coalesce } from '../../../base/common/arrays.js';
import { IProcessEnvironment, isMacintosh } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { whenDeleted } from '../../../base/node/pfs.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { isLaunchedFromCli } from '../../environment/node/argvHelper.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IURLService } from '../../url/common/url.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IWindowSettings } from '../../window/common/window.js';
import { IOpenConfiguration, IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { IProtocolUrl } from '../../url/electron-main/url.js';

export const ID = 'launchMainService';
export const ILaunchMainService = createDecorator<ILaunchMainService>(ID);

export interface IStartArguments {
	readonly args: NativeParsedArgs;
	readonly userEnv: IProcessEnvironment;
}

export interface ILaunchMainService {

	readonly _serviceBrand: undefined;

	start(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void>;

	getMainProcessId(): Promise<number>;
}

export class LaunchMainService implements ILaunchMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IURLService private readonly urlService: IURLService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	/**
	 * 启动主服务，处理启动参数。
	 * @param args 启动参数
	 * @param userEnv 用户环境变量
	 */
	async start(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void> {
		this.logService.trace('Received data from other instance: ', args, userEnv);


		// macOS: Electron 7.x 之后，程序化聚焦窗口不会自动将应用置于前台。
		// 只有通过 app.focus({ steal: true }) 才能恢复旧行为。
		// 这里确保在收到其他实例打开新窗口指令时，应用获得焦点。
		if (isMacintosh) {
			app.focus({ steal: true });
		}

		// 优先检查 --open-url 参数，由 URL 服务处理
		const urlsToOpen = this.parseOpenUrl(args);
		if (urlsToOpen.length) {
			let whenWindowReady: Promise<unknown> = Promise.resolve();

			// 如果当前没有窗口，则新建一个空窗口
			if (this.windowsMainService.getWindowCount() === 0) {
				const window = (await this.windowsMainService.openEmptyWindow({ context: OpenContext.DESKTOP })).at(0);
				if (window) {
					whenWindowReady = window.ready();
				}
			}

			// 确保有窗口可接收 URL 事件
			whenWindowReady.then(() => {
				for (const { uri, originalUrl } of urlsToOpen) {
					this.urlService.open(uri, { originalUrl });
				}
			});
		}

		// 否则走常规窗口打开流程
		else {
			return this.startOpenWindow(args, userEnv);
		}
	}

	/**
	 * 解析 --open-url 参数，返回协议 URL 列表。
	 * @param args 启动参数
	 * @returns IProtocolUrl[]
	 */
	private parseOpenUrl(args: NativeParsedArgs): IProtocolUrl[] {
		if (args['open-url'] && args._urls && args._urls.length > 0) {

			// --open-url must contain -- followed by the url(s)
			// process.argv is used over args._ as args._ are resolved to file paths at this point
			// --open-url 必须跟随 URL 参数
			// 此处用 process.argv 而不是 args._，因为 args._ 已被解析为文件路径

			return coalesce(args._urls
				.map(url => {
					try {
						return { uri: URI.parse(url), originalUrl: url };
					} catch (err) {
						return null;
					}
				}));
		}

		return [];
	}

	/**
	 * 根据参数决定如何打开窗口（新建/复用/特殊模式）。
	 * @param args 启动参数
	 * @param userEnv 用户环境变量
	 */
	private async startOpenWindow(args: NativeParsedArgs, userEnv: IProcessEnvironment): Promise<void> {
		const context = isLaunchedFromCli(userEnv) ? OpenContext.CLI : OpenContext.DESKTOP;
		let usedWindows: ICodeWindow[] = [];

		const waitMarkerFileURI = args.wait && args.waitMarkerFilePath ? URI.file(args.waitMarkerFilePath) : undefined;
		const remoteAuthority = args.remote || undefined;

		const baseConfig: IOpenConfiguration = {
			context,
			cli: args,
			/**
			 * When opening a new window from a second instance that sent args and env
			 * over to this instance, we want to preserve the environment only if that second
			 * instance was spawned from the CLI or used the `--preserve-env` flag (example:
			 * when using `open -n "VSCode.app" --args --preserve-env WORKSPACE_FOLDER`).
			 *
			 * This is done to ensure that the second window gets treated exactly the same
			 * as the first window, for example, it gets the same resolved user shell environment.
			 *
			 * https://github.com/microsoft/vscode/issues/194736
			 */
			// 当第二个实例通过 CLI 或 --preserve-env 启动时，保留其环境变量，保证一致性。
			userEnv: (args['preserve-env'] || context === OpenContext.CLI) ? userEnv : undefined,
			waitMarkerFileURI,
			remoteAuthority,
			forceProfile: args.profile,
			forceTempProfile: args['profile-temp']
		};

		// Special case extension development
		// 扩展开发模式特殊处理
		if (!!args.extensionDevelopmentPath) {
			await this.windowsMainService.openExtensionDevelopmentHostWindow(args.extensionDevelopmentPath, baseConfig);
		}

		// Start without file/folder arguments
		// 无文件/文件夹参数时的启动逻辑
		else if (!args._.length && !args['folder-uri'] && !args['file-uri']) {
			let openNewWindow = false;

			// Force new window
			// 强制新建窗口
			if (args['new-window'] || baseConfig.forceProfile || baseConfig.forceTempProfile) {
				openNewWindow = true;
			}

			// Force reuse window
			// 强制复用窗口
			else if (args['reuse-window']) {
				openNewWindow = false;
			}

			// Otherwise check for settings
			// 否则根据设置决定
			else {
				const windowConfig = this.configurationService.getValue<IWindowSettings | undefined>('window');
				const openWithoutArgumentsInNewWindowConfig = windowConfig?.openWithoutArgumentsInNewWindow || 'default' /* default */;
				switch (openWithoutArgumentsInNewWindowConfig) {
					case 'on':
						openNewWindow = true;
						break;
					case 'off':
						openNewWindow = false;
						break;
					default:
						openNewWindow = !isMacintosh; // prefer to restore running instance on macOS
				}
			}

			// Open new Window
			// 新建窗口
			if (openNewWindow) {
				usedWindows = await this.windowsMainService.open({
					...baseConfig,
					forceNewWindow: true,
					forceEmpty: true
				});
			}

			// Focus existing window or open if none opened
			// 聚焦已有窗口，若无则新建
			else {
				const lastActive = this.windowsMainService.getLastActiveWindow();
				if (lastActive) {
					this.windowsMainService.openExistingWindow(lastActive, baseConfig);

					usedWindows = [lastActive];
				} else {
					usedWindows = await this.windowsMainService.open({
						...baseConfig,
						forceEmpty: true
					});
				}
			}
		}

		// Start with file/folder arguments
		// 有文件/文件夹参数时的启动逻辑
		else {
			usedWindows = await this.windowsMainService.open({
				...baseConfig,
				forceNewWindow: args['new-window'],
				preferNewWindow: !args['reuse-window'] && !args.wait,
				forceReuseWindow: args['reuse-window'],
				diffMode: args.diff,
				mergeMode: args.merge,
				addMode: args.add,
				removeMode: args.remove,
				noRecentEntry: !!args['skip-add-to-recently-opened'],
				gotoLineMode: args.goto
			});
		}

		// If the other instance is waiting to be killed, we hook up a window listener if one window
		// is being used and only then resolve the startup promise which will kill this second instance.
		// In addition, we poll for the wait marker file to be deleted to return.
		// 如果另一个实例在等待被关闭，且只打开了一个窗口，则监听窗口关闭或标记文件被删除后再结束当前实例。
		if (waitMarkerFileURI && usedWindows.length === 1 && usedWindows[0]) {
			return Promise.race([
				usedWindows[0].whenClosedOrLoaded,
				whenDeleted(waitMarkerFileURI.fsPath)
			]).then(() => undefined, () => undefined);
		}
	}

	/**
	 * 返回主进程 PID。
	 */
	async getMainProcessId(): Promise<number> {
		this.logService.trace('Received request for process ID from other instance.');

		return process.pid;
	}
}
