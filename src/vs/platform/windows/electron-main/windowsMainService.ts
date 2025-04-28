/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { app, BrowserWindow, WebContents, shell } from 'electron';
import { addUNCHostToAllowlist } from '../../../base/node/unc.js';
import { hostname, release, arch } from 'os';
import { coalesce, distinct } from '../../../base/common/arrays.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CharCode } from '../../../base/common/charCode.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { isWindowsDriveLetter, parseLineAndColumnAware, sanitizeFilePath, toSlashes } from '../../../base/common/extpath.js';
import { getPathLabel } from '../../../base/common/labels.js';
import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { basename, join, normalize, posix } from '../../../base/common/path.js';
import { getMarks, mark } from '../../../base/common/performance.js';
import { IProcessEnvironment, isMacintosh, isWindows, OS } from '../../../base/common/platform.js';
import { cwd } from '../../../base/common/process.js';
import { extUriBiasedIgnorePathCase, isEqualAuthority, normalizePath, originalFSPath, removeTrailingPathSeparator } from '../../../base/common/resources.js';
import { assertIsDefined } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { getNLSLanguage, getNLSMessages, localize } from '../../../nls.js';
import { IBackupMainService } from '../../backup/electron-main/backup.js';
import { IEmptyWindowBackupInfo } from '../../backup/node/backup.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { FileType, IFileService } from '../../files/common/files.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import product from '../../product/common/product.js';
import { IProtocolMainService } from '../../protocol/electron-main/protocol.js';
import { getRemoteAuthority } from '../../remote/common/remoteHosts.js';
import { IStateService } from '../../state/node/state.js';
import { IAddRemoveFoldersRequest, INativeOpenFileRequest, INativeWindowConfiguration, IOpenEmptyWindowOptions, IPath, IPathsToWaitFor, isFileToOpen, isFolderToOpen, isWorkspaceToOpen, IWindowOpenable, IWindowSettings } from '../../window/common/window.js';
import { CodeWindow } from './windowImpl.js';
import { IOpenConfiguration, IOpenEmptyConfiguration, IWindowsCountChangedEvent, IWindowsMainService, OpenContext, getLastFocused } from './windows.js';
import { findWindowOnExtensionDevelopmentPath, findWindowOnFile, findWindowOnWorkspaceOrFolder } from './windowsFinder.js';
import { IWindowState, WindowsStateHandler } from './windowsStateHandler.js';
import { IRecent } from '../../workspaces/common/workspaces.js';
import { hasWorkspaceFileExtension, IAnyWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier, toWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { createEmptyWorkspaceIdentifier, getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../../workspaces/node/workspaces.js';
import { IWorkspacesHistoryMainService } from '../../workspaces/electron-main/workspacesHistoryMainService.js';
import { IWorkspacesManagementMainService } from '../../workspaces/electron-main/workspacesManagementMainService.js';
import { ICodeWindow, UnloadReason } from '../../window/electron-main/window.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { IEditorOptions, ITextEditorOptions } from '../../editor/common/editor.js';
import { IUserDataProfile } from '../../userDataProfile/common/userDataProfile.js';
import { IPolicyService } from '../../policy/common/policy.js';
import { IUserDataProfilesMainService } from '../../userDataProfile/electron-main/userDataProfile.js';
import { ILoggerMainService } from '../../log/electron-main/loggerService.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { ICSSDevelopmentService } from '../../cssDev/node/cssDevService.js';
import { ResourceSet } from '../../../base/common/map.js';

//#region Helper Interfaces

type RestoreWindowsSetting = 'preserve' | 'all' | 'folders' | 'one' | 'none';

interface IOpenBrowserWindowOptions {
	readonly userEnv?: IProcessEnvironment;
	readonly cli?: NativeParsedArgs;

	readonly workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier;

	readonly remoteAuthority?: string;

	readonly initialStartup?: boolean;

	readonly filesToOpen?: IFilesToOpen;

	readonly forceNewWindow?: boolean;
	readonly forceNewTabbedWindow?: boolean;
	readonly windowToUse?: ICodeWindow;

	readonly emptyWindowBackupInfo?: IEmptyWindowBackupInfo;
	readonly forceProfile?: string;
	readonly forceTempProfile?: boolean;
}

interface IPathResolveOptions {

	/**
	 * 默认情况下，解析路径时会检查
	 * 路径是否存在。可以使用此标志
	 * 禁用该检查。
	 */
	readonly ignoreFileNotFound?: boolean;

	/**
	 * 如果路径指向一个临时工作区
	 * （由工作区文件中的 `transient: true`
	 * 属性指示），则会拒绝该路径。
	 */
	readonly rejectTransientWorkspaces?: boolean;

	/**
	 * 如果启用，将解析路径时会识别行/列信息
	 * 并从结果文件路径中正确移除此信息。
	 */
	readonly gotoLineMode?: boolean;

	/**
	 * 强制将提供的路径解析为工作区
	 * 文件而不是将其作为文件打开。
	 */
	readonly forceOpenWorkspaceAsFile?: boolean;

	/**
	 * 如果要打开的 URL 既不是 `file` 也不是
	 * `vscode-remote`，则使用此 remoteAuthority。
	 */
	readonly remoteAuthority?: string;
}

interface IFilesToOpen {
	readonly remoteAuthority?: string;

	filesToOpenOrCreate: IPath[];
	filesToDiff: IPath[];
	filesToMerge: IPath[];

	filesToWait?: IPathsToWaitFor;
}

interface IPathToOpen<T = IEditorOptions> extends IPath<T> {

	/**
	 * 要打开的工作区
	 */
	readonly workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier;

	/**
	 * 路径是否被视为临时路径
	 * 例如，临时工作区不应添加到
	 * 工作区历史记录中，并且永远不应还原。
	 */
	readonly transient?: boolean;

	/**
	 * 要使用的备份路径
	 */
	readonly backupPath?: string;

	/**
	 * 要打开的 Code 实例的远程授权。未定义表示非远程。
	 */
	readonly remoteAuthority?: string;

	/**
	 * 最近历史记录的可选标签
	 */
	label?: string;
}

const EMPTY_WINDOW: IPathToOpen = Object.create(null);

interface IWorkspacePathToOpen extends IPathToOpen {
	readonly workspace: IWorkspaceIdentifier;
}

interface ISingleFolderWorkspacePathToOpen extends IPathToOpen {
	readonly workspace: ISingleFolderWorkspaceIdentifier;
}

function isWorkspacePathToOpen(path: IPathToOpen | undefined): path is IWorkspacePathToOpen {
	return isWorkspaceIdentifier(path?.workspace);
}

/**
 * 判断路径是否为单文件夹工作区路径。
 * @param path 路径
 * @returns 是否为单文件夹工作区路径
 */
function isSingleFolderWorkspacePathToOpen(path: IPathToOpen | undefined): path is ISingleFolderWorkspacePathToOpen {
	return isSingleFolderWorkspaceIdentifier(path?.workspace);
}

//#endregion

/*
 * VS Code 主进程窗口管理核心服务
 *
 * 负责所有主窗口的创建、打开、聚焦、关闭、状态恢复、命令行/协议/API 路径解析、窗口间通信等。
 * 该服务是 VS Code 桌面端窗口生命周期的总控枢纽。
 * 每个窗口都是一个渲染器进程
 */
export class WindowsMainService extends Disposable implements IWindowsMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidOpenWindow = this._register(new Emitter<ICodeWindow>());
	readonly onDidOpenWindow = this._onDidOpenWindow.event;

	private readonly _onDidSignalReadyWindow = this._register(new Emitter<ICodeWindow>());
	readonly onDidSignalReadyWindow = this._onDidSignalReadyWindow.event;

	private readonly _onDidDestroyWindow = this._register(new Emitter<ICodeWindow>());
	readonly onDidDestroyWindow = this._onDidDestroyWindow.event;

	private readonly _onDidChangeWindowsCount = this._register(new Emitter<IWindowsCountChangedEvent>());
	readonly onDidChangeWindowsCount = this._onDidChangeWindowsCount.event;

	private readonly _onDidMaximizeWindow = this._register(new Emitter<ICodeWindow>());
	readonly onDidMaximizeWindow = this._onDidMaximizeWindow.event;

	private readonly _onDidUnmaximizeWindow = this._register(new Emitter<ICodeWindow>());
	readonly onDidUnmaximizeWindow = this._onDidUnmaximizeWindow.event;

	private readonly _onDidChangeFullScreen = this._register(new Emitter<{ window: ICodeWindow; fullscreen: boolean }>());
	readonly onDidChangeFullScreen = this._onDidChangeFullScreen.event;

	private readonly _onDidTriggerSystemContextMenu = this._register(new Emitter<{ window: ICodeWindow; x: number; y: number }>());
	readonly onDidTriggerSystemContextMenu = this._onDidTriggerSystemContextMenu.event;

	private readonly windows = new Map<number, ICodeWindow>();

	private readonly windowsStateHandler: WindowsStateHandler;

	constructor(
		private readonly machineId: string,
		private readonly sqmId: string,
		private readonly devDeviceId: string,
		private readonly initialUserEnv: IProcessEnvironment,
		@ILogService private readonly logService: ILogService,
		@ILoggerMainService private readonly loggerService: ILoggerMainService,
		@IStateService stateService: IStateService,
		@IPolicyService private readonly policyService: IPolicyService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IUserDataProfilesMainService private readonly userDataProfilesMainService: IUserDataProfilesMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IBackupMainService private readonly backupMainService: IBackupMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspacesHistoryMainService private readonly workspacesHistoryMainService: IWorkspacesHistoryMainService,
		@IWorkspacesManagementMainService private readonly workspacesManagementMainService: IWorkspacesManagementMainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@IFileService private readonly fileService: IFileService,
		@IProtocolMainService private readonly protocolMainService: IProtocolMainService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@ICSSDevelopmentService private readonly cssDevelopmentService: ICSSDevelopmentService
	) {
		super();

		this.windowsStateHandler = this._register(new WindowsStateHandler(this, stateService, this.lifecycleMainService, this.logService, this.configurationService));

		this.registerListeners();
	}

	/**
	 * 注册事件监听器。
	 * 监听工作区进入事件，处理窗口准备就绪信号，更新扩展开发路径，处理窗口关闭事件。
	 */
	private registerListeners(): void {

		// 在进入工作区后，发出窗口准备就绪的信号
		this._register(this.workspacesManagementMainService.onDidEnterWorkspace(event => this._onDidSignalReadyWindow.fire(event.window)));

		// 为扩展开发窗口更新协议服务中的有效根目录
		this._register(this.onDidSignalReadyWindow(window => {
			if (window.config?.extensionDevelopmentPath || window.config?.extensionTestsPath) {
				const disposables = new DisposableStore();
				disposables.add(Event.any(window.onDidClose, window.onDidDestroy)(() => disposables.dispose()));

				// 允许访问扩展开发路径
				if (window.config.extensionDevelopmentPath) {
					for (const extensionDevelopmentPath of window.config.extensionDevelopmentPath) {
						disposables.add(this.protocolMainService.addValidFileRoot(extensionDevelopmentPath));
					}
				}

				// 允许访问扩展测试路径
				if (window.config.extensionTestsPath) {
					disposables.add(this.protocolMainService.addValidFileRoot(window.config.extensionTestsPath));
				}
			}
		}));
	}

	/**
	 * 打开一个空窗口（无文件/文件夹/工作区）。
	 * @param openConfig 打开配置
	 * @param options 额外选项
	 * @returns 打开的窗口数组
	 */
	openEmptyWindow(openConfig: IOpenEmptyConfiguration, options?: IOpenEmptyWindowOptions): Promise<ICodeWindow[]> {
		const cli = this.environmentMainService.args;
		const remoteAuthority = options?.remoteAuthority || undefined;
		const forceEmpty = true;
		const forceReuseWindow = options?.forceReuseWindow;
		const forceNewWindow = !forceReuseWindow;

		return this.open({ ...openConfig, cli, forceEmpty, forceNewWindow, forceReuseWindow, remoteAuthority, forceTempProfile: options?.forceTempProfile, forceProfile: options?.forceProfile });
	}

	/**
	 * 将指定窗口置于前台，并处理 --wait 参数。
	 * @param window 目标窗口
	 * @param openConfig 打开配置
	 */
	openExistingWindow(window: ICodeWindow, openConfig: IOpenConfiguration): void {

		// 将窗口置于前台
		window.focus();

		// 处理 --wait
		this.handleWaitMarkerFile(openConfig, [window]);
	}

	/**
	 * 主入口，处理所有"打开窗口"请求。
	 * 解析要打开的路径，决定新开窗口还是复用已有窗口，处理 diff/merge/wait 等特殊模式，恢复上次会话窗口。
	 * @param openConfig 打开配置
	 * @returns 打开的窗口数组
	 */
	async open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {
		this.logService.trace('windowsManager#open'); // 跟踪打开窗口

		// 确保 addMode/removeMode 仅在我们有活动窗口时启用
		// 如果初始启动或没有活动窗口，则禁用
		if ((openConfig.addMode || openConfig.removeMode) && (openConfig.initialStartup || !this.getLastActiveWindow())) {
			openConfig.addMode = false;
			openConfig.removeMode = false;
		}

		// 要添加的文件夹
		const foldersToAdd: ISingleFolderWorkspacePathToOpen[] = [];
		// 要移除的文件夹
		const foldersToRemove: ISingleFolderWorkspacePathToOpen[] = [];
		// 要打开的文件夹
		const foldersToOpen: ISingleFolderWorkspacePathToOpen[] = [];
		// 要打开的工作区
		const workspacesToOpen: IWorkspacePathToOpen[] = [];
		// 要恢复的无标题工作区
		const untitledWorkspacesToRestore: IWorkspacePathToOpen[] = [];
		// 要恢复的空窗口备份
		const emptyWindowsWithBackupsToRestore: IEmptyWindowBackupInfo[] = [];
		// 要打开的文件
		let filesToOpen: IFilesToOpen | undefined;
		// 是否可能打开空窗口
		let maybeOpenEmptyWindow = false;

		// 从打开配置中识别要打开的内容
		const pathsToOpen = await this.getPathsToOpen(openConfig);
		this.logService.trace('windowsManager#open pathsToOpen', pathsToOpen);
		for (const path of pathsToOpen) {
			if (isSingleFolderWorkspacePathToOpen(path)) {
				if (openConfig.addMode) {
					// 当使用 --add 运行时，将要打开的文件夹视为
					// 应添加到当前活动窗口的文件夹。
					foldersToAdd.push(path);
				} else if (openConfig.removeMode) {
					// 当使用 --remove 运行时，将要打开的文件夹视为
					// 应从当前活动窗口中移除的文件夹。
					foldersToRemove.push(path);
				} else {
					foldersToOpen.push(path);
				}
			} else if (isWorkspacePathToOpen(path)) {
				workspacesToOpen.push(path);
			} else if (path.fileUri) {
				if (!filesToOpen) {
					filesToOpen = { filesToOpenOrCreate: [], filesToDiff: [], filesToMerge: [], remoteAuthority: path.remoteAuthority };
				}
				filesToOpen.filesToOpenOrCreate.push(path);
			} else if (path.backupPath) {
				emptyWindowsWithBackupsToRestore.push({ backupFolder: basename(path.backupPath), remoteAuthority: path.remoteAuthority });
			} else {
				maybeOpenEmptyWindow = true; // 取决于其他参数，如 `forceEmpty` 以及已经打开了多少窗口
			}
		}

		// 当使用 --diff 运行时，将前 2 个要打开的文件作为要比较的文件
		if (openConfig.diffMode && filesToOpen && filesToOpen.filesToOpenOrCreate.length >= 2) {
			filesToOpen.filesToDiff = filesToOpen.filesToOpenOrCreate.slice(0, 2);
			filesToOpen.filesToOpenOrCreate = [];
		}

		// 当使用 --merge 运行时，将前 4 个要打开的文件作为要合并的文件
		if (openConfig.mergeMode && filesToOpen && filesToOpen.filesToOpenOrCreate.length === 4) {
			filesToOpen.filesToMerge = filesToOpen.filesToOpenOrCreate.slice(0, 4);
			filesToOpen.filesToOpenOrCreate = [];
			filesToOpen.filesToDiff = [];
		}

		// 使用 --wait 运行时，确保我们保留要等待的路径
		if (filesToOpen && openConfig.waitMarkerFileURI) {
			filesToOpen.filesToWait = { paths: coalesce([...filesToOpen.filesToDiff, filesToOpen.filesToMerge[3] /* [3] 是最终的合并文件 */, ...filesToOpen.filesToOpenOrCreate]), waitMarkerFileUri: openConfig.waitMarkerFileURI };
		}

		// 这些是因为热退出或从上一个会话恢复的窗口（仅在启动时执行一次！）
		if (openConfig.initialStartup) {

			// 未命名的工作区始终会被恢复
			untitledWorkspacesToRestore.push(...this.workspacesManagementMainService.getUntitledWorkspaces());
			workspacesToOpen.push(...untitledWorkspacesToRestore);

			// 带有备份的空窗口始终会被恢复
			emptyWindowsWithBackupsToRestore.push(...this.backupMainService.getEmptyWindowBackups());
		} else {
			emptyWindowsWithBackupsToRestore.length = 0;
		}

		// 根据配置打开
		const { windows: usedWindows, filesOpenedInWindow } = await this.doOpen(openConfig, workspacesToOpen, foldersToOpen, emptyWindowsWithBackupsToRestore, maybeOpenEmptyWindow, filesToOpen, foldersToAdd, foldersToRemove);

		this.logService.trace(`windowsManager#open used window count ${usedWindows.length} (workspacesToOpen: ${workspacesToOpen.length}, foldersToOpen: ${foldersToOpen.length}, emptyToRestore: ${emptyWindowsWithBackupsToRestore.length}, maybeOpenEmptyWindow: ${maybeOpenEmptyWindow})`);

		// 如果我们打开多个窗口，确保将焦点传递给最相关的窗口
		if (usedWindows.length > 1) {

			// 1.) 始终优先聚焦我们在其中打开文件的窗口
			if (filesOpenedInWindow) {
				filesOpenedInWindow.focus();
			}

			// 否则，根据打开参数找到一个合适的窗口
			else {
				const focusLastActive = this.windowsStateHandler.state.lastActiveWindow && !openConfig.forceEmpty && !openConfig.cli._.length && !openConfig.cli['file-uri'] && !openConfig.cli['folder-uri'] && !(openConfig.urisToOpen && openConfig.urisToOpen.length);
				let focusLastOpened = true;
				let focusLastWindow = true;

				// 2.) 如果我们没有被指示打开任何路径，则聚焦上次活动的窗口
				if (focusLastActive) {
					const lastActiveWindow = usedWindows.filter(window => this.windowsStateHandler.state.lastActiveWindow && window.backupPath === this.windowsStateHandler.state.lastActiveWindow.backupPath);
					if (lastActiveWindow.length) {
						lastActiveWindow[0].focus();
						focusLastOpened = false;
						focusLastWindow = false;
					}
				}

				// 3.) 如果被指示打开路径，则聚焦最后一个非恢复的窗口
				if (focusLastOpened) {
					for (let i = usedWindows.length - 1; i >= 0; i--) {
						const usedWindow = usedWindows[i];
						if (
							(usedWindow.openedWorkspace && untitledWorkspacesToRestore.some(workspace => usedWindow.openedWorkspace && workspace.workspace.id === usedWindow.openedWorkspace.id)) ||	// 跳过已恢复的工作区
							(usedWindow.backupPath && emptyWindowsWithBackupsToRestore.some(empty => usedWindow.backupPath && empty.backupFolder === basename(usedWindow.backupPath)))							// 跳过已恢复的空窗口
						) {
							continue;
						}

						usedWindow.focus();
						focusLastWindow = false;
						break;
					}
				}

				// 4.) 最后，始终确保至少聚焦最后使用的窗口
				if (focusLastWindow) {
					usedWindows[usedWindows.length - 1].focus();
				}
			}
		}

		// 记住在最近文档列表中（除非这是为扩展开发而打开的）
		// 当文件是为了比较或合并而打开时，也不添加路径，只有单独打开时才添加
		const isDiff = filesToOpen && filesToOpen.filesToDiff.length > 0;
		const isMerge = filesToOpen && filesToOpen.filesToMerge.length > 0;
		if (!usedWindows.some(window => window.isExtensionDevelopmentHost) && !isDiff && !isMerge && !openConfig.noRecentEntry) {
			const recents: IRecent[] = [];
			for (const pathToOpen of pathsToOpen) {
				if (isWorkspacePathToOpen(pathToOpen) && !pathToOpen.transient /* 永远不要将临时工作区添加到历史记录中 */) {
					recents.push({ label: pathToOpen.label, workspace: pathToOpen.workspace, remoteAuthority: pathToOpen.remoteAuthority });
				} else if (isSingleFolderWorkspacePathToOpen(pathToOpen)) {
					recents.push({ label: pathToOpen.label, folderUri: pathToOpen.workspace.uri, remoteAuthority: pathToOpen.remoteAuthority });
				} else if (pathToOpen.fileUri) {
					recents.push({ label: pathToOpen.label, fileUri: pathToOpen.fileUri, remoteAuthority: pathToOpen.remoteAuthority });
				}
			}

			this.workspacesHistoryMainService.addRecentlyOpened(recents);
		}

		// 处理 --wait
		this.handleWaitMarkerFile(openConfig, usedWindows);

		return usedWindows;
	}

	/**
	 * 处理 --wait 模式下的等待文件逻辑。
	 * 窗口关闭或加载新内容后，删除等待标记文件。
	 * @param openConfig 打开配置
	 * @param usedWindows 已打开的窗口
	 */
	private handleWaitMarkerFile(openConfig: IOpenConfiguration, usedWindows: ICodeWindow[]): void {

		// 如果我们从 CLI 启动时带有 --wait 参数，我们需要向外部发送信号，当用于
		// 编辑操作的窗口被关闭或加载到不同的文件夹时，等待的
		// 进程可以继续。我们通过删除 waitMarkerFilePath 来实现这一点。
		const waitMarkerFileURI = openConfig.waitMarkerFileURI;
		if (openConfig.context === OpenContext.CLI && waitMarkerFileURI && usedWindows.length === 1 && usedWindows[0]) {
			(async () => {
				await usedWindows[0].whenClosedOrLoaded;

				try {
					await this.fileService.del(waitMarkerFileURI);
				} catch (error) {
					// 忽略 - 可能已经从窗口中删除了
				}
			})();
		}
	}

	/**
	 * 根据解析后的路径和参数，实际打开窗口。
	 * 支持文件夹添加/移除、优先复用已有窗口、恢复空窗口/工作区等。
	 * @param openConfig 打开配置
	 * @param workspacesToOpen 要打开的工作区
	 * @param foldersToOpen 要打开的文件夹
	 * @param emptyToRestore 要恢复的空窗口
	 * @param maybeOpenEmptyWindow 是否可能打开空窗口
	 * @param filesToOpen 要打开的文件
	 * @param foldersToAdd 要添加的文件夹
	 * @param foldersToRemove 要移除的文件夹
	 * @returns 打开的窗口及文件打开窗口
	 */
	private async doOpen(
		openConfig: IOpenConfiguration,
		workspacesToOpen: IWorkspacePathToOpen[],
		foldersToOpen: ISingleFolderWorkspacePathToOpen[],
		emptyToRestore: IEmptyWindowBackupInfo[],
		maybeOpenEmptyWindow: boolean,
		filesToOpen: IFilesToOpen | undefined,
		foldersToAdd: ISingleFolderWorkspacePathToOpen[],
		foldersToRemove: ISingleFolderWorkspacePathToOpen[]
	): Promise<{ windows: ICodeWindow[]; filesOpenedInWindow: ICodeWindow | undefined }> {

		// 跟踪已使用的窗口并记住，是否在其中一个窗口中打开了文件
		// 用于存储已打开的窗口
		const usedWindows: ICodeWindow[] = [];
		// 用于存储已打开的文件
		let filesOpenedInWindow: ICodeWindow | undefined = undefined;
		function addUsedWindow(window: ICodeWindow, openedFiles?: boolean): void {
			usedWindows.push(window);

			if (openedFiles) {
				filesOpenedInWindow = window;
				filesToOpen = undefined; // 重置 `filesToOpen` 因为文件已经打开
			}
		}

		// 设置决定是否在新的窗口中打开文件/文件夹
		let { openFolderInNewWindow, openFilesInNewWindow } = this.shouldOpenNewWindow(openConfig);

		// 处理要添加/删除的文件夹，通过查找最后一个活动的 workspace（不在初始启动时）
		if (!openConfig.initialStartup && (foldersToAdd.length > 0 || foldersToRemove.length > 0)) {
			const authority = foldersToAdd.at(0)?.remoteAuthority ?? foldersToRemove.at(0)?.remoteAuthority;
			const lastActiveWindow = this.getLastActiveWindowForAuthority(authority);
			if (lastActiveWindow) {
				addUsedWindow(this.doAddRemoveFoldersInExistingWindow(lastActiveWindow, foldersToAdd.map(folderToAdd => folderToAdd.workspace.uri), foldersToRemove.map(folderToRemove => folderToRemove.workspace.uri)));
			}
		}

		// 处理要打开/比较/合并的文件或创建文件，当不打开文件夹并且不恢复任何
		// 文件夹/无标题，通过尝试在最适合的窗口中打开它们
		const potentialNewWindowsCount = foldersToOpen.length + workspacesToOpen.length + emptyToRestore.length;
		if (filesToOpen && potentialNewWindowsCount === 0) {

			// 查找合适的窗口或文件夹路径来打开文件
			const fileToCheck: IPath<IEditorOptions> | undefined = filesToOpen.filesToOpenOrCreate[0] || filesToOpen.filesToDiff[0] || filesToOpen.filesToMerge[3] /* [3] 是最终的合并文件 */;

			// 只查看具有正确授权的窗口
			const windows = this.getWindows().filter(window => filesToOpen && isEqualAuthority(window.remoteAuthority, filesToOpen.remoteAuthority));

			// 找出一个好的窗口来打开文件，如果任何窗口
			// 具有 fallback 到最后一个活动的窗口。
			//
			// 如果强制 `openFilesInNewWindow`，我们跳过
			// 这一步。
			let windowToUseForFiles: ICodeWindow | undefined = undefined;
			if (fileToCheck?.fileUri && !openFilesInNewWindow) {
				if (openConfig.context === OpenContext.DESKTOP || openConfig.context === OpenContext.CLI || openConfig.context === OpenContext.DOCK || openConfig.context === OpenContext.LINK) {
					windowToUseForFiles = await findWindowOnFile(windows, fileToCheck.fileUri, async workspace => workspace.configPath.scheme === Schemas.file ? this.workspacesManagementMainService.resolveLocalWorkspace(workspace.configPath) : undefined);
				}

				if (!windowToUseForFiles) {
					windowToUseForFiles = this.doGetLastActiveWindow(windows);
				}
			}

			// 我们找到了一个窗口来打开文件
			if (windowToUseForFiles) {

				// 窗口是 workspace
				if (isWorkspaceIdentifier(windowToUseForFiles.openedWorkspace)) {
					workspacesToOpen.push({ workspace: windowToUseForFiles.openedWorkspace, remoteAuthority: windowToUseForFiles.remoteAuthority });
				}

				// 窗口是单个文件夹
				else if (isSingleFolderWorkspaceIdentifier(windowToUseForFiles.openedWorkspace)) {
					foldersToOpen.push({ workspace: windowToUseForFiles.openedWorkspace, remoteAuthority: windowToUseForFiles.remoteAuthority });
				}

				// 窗口是空的
				else {
					addUsedWindow(this.doOpenFilesInExistingWindow(openConfig, windowToUseForFiles, filesToOpen), true);
				}
			}

			// 最后，如果没有窗口或文件夹，只需在空窗口中打开文件
			else {
				addUsedWindow(await this.openInBrowserWindow({
					userEnv: openConfig.userEnv,
					cli: openConfig.cli,
					initialStartup: openConfig.initialStartup,
					filesToOpen,
					forceNewWindow: true,
					remoteAuthority: filesToOpen.remoteAuthority,
					forceNewTabbedWindow: openConfig.forceNewTabbedWindow,
					forceProfile: openConfig.forceProfile,
					forceTempProfile: openConfig.forceTempProfile
				}), true);
			}
		}

		// 处理要打开的工作区（指示和恢复）
		const allWorkspacesToOpen = distinct(workspacesToOpen, workspace => workspace.workspace.id); // prevent duplicates
		if (allWorkspacesToOpen.length > 0) {

			// 检查是否存在实例
			const windowsOnWorkspace = coalesce(allWorkspacesToOpen.map(workspaceToOpen => findWindowOnWorkspaceOrFolder(this.getWindows(), workspaceToOpen.workspace.configPath)));
			if (windowsOnWorkspace.length > 0) {
				const windowOnWorkspace = windowsOnWorkspace[0];
				const filesToOpenInWindow = isEqualAuthority(filesToOpen?.remoteAuthority, windowOnWorkspace.remoteAuthority) ? filesToOpen : undefined;

				// 打开文件
				addUsedWindow(this.doOpenFilesInExistingWindow(openConfig, windowOnWorkspace, filesToOpenInWindow), !!filesToOpenInWindow);

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}

			// 打开剩余的
			for (const workspaceToOpen of allWorkspacesToOpen) {
				if (windowsOnWorkspace.some(window => window.openedWorkspace && window.openedWorkspace.id === workspaceToOpen.workspace.id)) {
					continue; // ignore folders that are already open
				}

				const remoteAuthority = workspaceToOpen.remoteAuthority;
				const filesToOpenInWindow = isEqualAuthority(filesToOpen?.remoteAuthority, remoteAuthority) ? filesToOpen : undefined;

				// Do open folder
				addUsedWindow(await this.doOpenFolderOrWorkspace(openConfig, workspaceToOpen, openFolderInNewWindow, filesToOpenInWindow), !!filesToOpenInWindow);

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}
		}

		// 处理要打开的文件夹（指示和恢复）
		const allFoldersToOpen = distinct(foldersToOpen, folder => extUriBiasedIgnorePathCase.getComparisonKey(folder.workspace.uri)); // prevent duplicates
		if (allFoldersToOpen.length > 0) {

			// 检查是否存在实例
			const windowsOnFolderPath = coalesce(allFoldersToOpen.map(folderToOpen => findWindowOnWorkspaceOrFolder(this.getWindows(), folderToOpen.workspace.uri)));
			if (windowsOnFolderPath.length > 0) {
				const windowOnFolderPath = windowsOnFolderPath[0];
				const filesToOpenInWindow = isEqualAuthority(filesToOpen?.remoteAuthority, windowOnFolderPath.remoteAuthority) ? filesToOpen : undefined;

				// 打开文件
				addUsedWindow(this.doOpenFilesInExistingWindow(openConfig, windowOnFolderPath, filesToOpenInWindow), !!filesToOpenInWindow);

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}

			// 打开剩余的
			for (const folderToOpen of allFoldersToOpen) {
				if (windowsOnFolderPath.some(window => isSingleFolderWorkspaceIdentifier(window.openedWorkspace) && extUriBiasedIgnorePathCase.isEqual(window.openedWorkspace.uri, folderToOpen.workspace.uri))) {
					continue; // ignore folders that are already open
				}

				const remoteAuthority = folderToOpen.remoteAuthority;
				const filesToOpenInWindow = isEqualAuthority(filesToOpen?.remoteAuthority, remoteAuthority) ? filesToOpen : undefined;

				// Do open folder
				addUsedWindow(await this.doOpenFolderOrWorkspace(openConfig, folderToOpen, openFolderInNewWindow, filesToOpenInWindow), !!filesToOpenInWindow);

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}
		}

		// 处理要恢复的空窗口
		const allEmptyToRestore = distinct(emptyToRestore, info => info.backupFolder); // prevent duplicates
		if (allEmptyToRestore.length > 0) {
			for (const emptyWindowBackupInfo of allEmptyToRestore) {
				const remoteAuthority = emptyWindowBackupInfo.remoteAuthority;
				const filesToOpenInWindow = isEqualAuthority(filesToOpen?.remoteAuthority, remoteAuthority) ? filesToOpen : undefined;

				addUsedWindow(await this.doOpenEmpty(openConfig, true, remoteAuthority, filesToOpenInWindow, emptyWindowBackupInfo), !!filesToOpenInWindow);

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}
		}

		// Finally, open an empty window if
		// - we still have files to open
		// - user forces an empty window (e.g. via command line)
		// - no window has opened yet
		if (filesToOpen || (maybeOpenEmptyWindow && (openConfig.forceEmpty || usedWindows.length === 0))) {
			const remoteAuthority = filesToOpen ? filesToOpen.remoteAuthority : openConfig.remoteAuthority;

			addUsedWindow(await this.doOpenEmpty(openConfig, openFolderInNewWindow, remoteAuthority, filesToOpen), !!filesToOpen);
		}

		return { windows: distinct(usedWindows), filesOpenedInWindow };
	}

	/**
	 * 在已有窗口中打开文件。
	 * @param configuration 打开配置
	 * @param window 目标窗口
	 * @param filesToOpen 要打开的文件
	 * @returns 目标窗口
	 */
	private doOpenFilesInExistingWindow(configuration: IOpenConfiguration, window: ICodeWindow, filesToOpen?: IFilesToOpen): ICodeWindow {
		this.logService.trace('windowsManager#doOpenFilesInExistingWindow', { filesToOpen });

		this.focusMainOrChildWindow(window); // make sure window or any of the children has focus

		const params: INativeOpenFileRequest = {
			filesToOpenOrCreate: filesToOpen?.filesToOpenOrCreate,
			filesToDiff: filesToOpen?.filesToDiff,
			filesToMerge: filesToOpen?.filesToMerge,
			filesToWait: filesToOpen?.filesToWait,
			termProgram: configuration?.userEnv?.['TERM_PROGRAM']
		};
		window.sendWhenReady('vscode:openFiles', CancellationToken.None, params);

		return window;
	}

	/**
	 * 聚焦主窗口或其子窗口。
	 * @param mainWindow 主窗口
	 */
	private focusMainOrChildWindow(mainWindow: ICodeWindow): void {
		let windowToFocus: ICodeWindow | IAuxiliaryWindow = mainWindow;

		const focusedWindow = BrowserWindow.getFocusedWindow();
		if (focusedWindow && focusedWindow.id !== mainWindow.id) {
			const auxiliaryWindowCandidate = this.auxiliaryWindowsMainService.getWindowByWebContents(focusedWindow.webContents);
			if (auxiliaryWindowCandidate && auxiliaryWindowCandidate.parentId === mainWindow.id) {
				windowToFocus = auxiliaryWindowCandidate;
			}
		}

		windowToFocus.focus();
	}

	/**
	 * 在已有窗口中添加/移除文件夹。
	 * @param window 目标窗口
	 * @param foldersToAdd 要添加的文件夹 URI 数组
	 * @param foldersToRemove 要移除的文件夹 URI 数组
	 * @returns 目标窗口
	 */
	private doAddRemoveFoldersInExistingWindow(window: ICodeWindow, foldersToAdd: URI[], foldersToRemove: URI[]): ICodeWindow {
		this.logService.trace('windowsManager#doAddRemoveFoldersToExistingWindow', { foldersToAdd, foldersToRemove });

		window.focus(); // make sure window has focus

		const request: IAddRemoveFoldersRequest = { foldersToAdd, foldersToRemove };
		window.sendWhenReady('vscode:addRemoveFolders', CancellationToken.None, request);

		return window;
	}

	/**
	 * 打开空窗口，支持复用已有窗口或新建。
	 * @param openConfig 打开配置
	 * @param forceNewWindow 是否强制新建窗口
	 * @param remoteAuthority 远程授权
	 * @param filesToOpen 要打开的文件
	 * @param emptyWindowBackupInfo 空窗口备份信息
	 * @returns 新建或复用的窗口
	 */
	private doOpenEmpty(openConfig: IOpenConfiguration, forceNewWindow: boolean, remoteAuthority: string | undefined, filesToOpen: IFilesToOpen | undefined, emptyWindowBackupInfo?: IEmptyWindowBackupInfo): Promise<ICodeWindow> {
		this.logService.trace('windowsManager#doOpenEmpty', { restore: !!emptyWindowBackupInfo, remoteAuthority, filesToOpen, forceNewWindow });

		let windowToUse: ICodeWindow | undefined;
		if (!forceNewWindow && typeof openConfig.contextWindowId === 'number') {
			windowToUse = this.getWindowById(openConfig.contextWindowId); // fix for https://github.com/microsoft/vscode/issues/97172
		}

		return this.openInBrowserWindow({
			userEnv: openConfig.userEnv,
			cli: openConfig.cli,
			initialStartup: openConfig.initialStartup,
			remoteAuthority,
			forceNewWindow,
			forceNewTabbedWindow: openConfig.forceNewTabbedWindow,
			filesToOpen,
			windowToUse,
			emptyWindowBackupInfo,
			forceProfile: openConfig.forceProfile,
			forceTempProfile: openConfig.forceTempProfile
		});
	}

	/**
	 * 打开文件夹或工作区。
	 * @param openConfig 打开配置
	 * @param folderOrWorkspace 文件夹或工作区
	 * @param forceNewWindow 是否强制新建窗口
	 * @param filesToOpen 要打开的文件
	 * @param windowToUse 指定复用窗口
	 * @returns 新建或复用的窗口
	 */
	private doOpenFolderOrWorkspace(openConfig: IOpenConfiguration, folderOrWorkspace: IWorkspacePathToOpen | ISingleFolderWorkspacePathToOpen, forceNewWindow: boolean, filesToOpen: IFilesToOpen | undefined, windowToUse?: ICodeWindow): Promise<ICodeWindow> {
		this.logService.trace('windowsManager#doOpenFolderOrWorkspace', { folderOrWorkspace, filesToOpen });

		if (!forceNewWindow && !windowToUse && typeof openConfig.contextWindowId === 'number') {
			windowToUse = this.getWindowById(openConfig.contextWindowId); // fix for https://github.com/microsoft/vscode/issues/49587
		}

		return this.openInBrowserWindow({
			workspace: folderOrWorkspace.workspace,
			userEnv: openConfig.userEnv,
			cli: openConfig.cli,
			initialStartup: openConfig.initialStartup,
			remoteAuthority: folderOrWorkspace.remoteAuthority,
			forceNewWindow,
			forceNewTabbedWindow: openConfig.forceNewTabbedWindow,
			filesToOpen,
			windowToUse,
			forceProfile: openConfig.forceProfile,
			forceTempProfile: openConfig.forceTempProfile
		});
	}

	/**
	 * 解析出本次要打开的所有路径（文件/文件夹/工作区/空窗口）。
	 * 支持 API、CLI、上次会话等多种来源。
	 * @param openConfig 打开配置
	 * @returns 要打开的路径数组
	 */
	private async getPathsToOpen(openConfig: IOpenConfiguration): Promise<IPathToOpen[]> {
		let pathsToOpen: IPathToOpen[];
		let isCommandLineOrAPICall = false;
		let isRestoringPaths = false;

		// Extract paths: from API 从 API 提取路径
		if (openConfig.urisToOpen && openConfig.urisToOpen.length > 0) {
			pathsToOpen = await this.doExtractPathsFromAPI(openConfig);
			isCommandLineOrAPICall = true;
		}

		// Check for force empty 检查是否强制空窗口
		else if (openConfig.forceEmpty) {
			pathsToOpen = [EMPTY_WINDOW];
		}

		// Extract paths: from CLI 从 CLI 提取路径
		else if (openConfig.cli._.length || openConfig.cli['folder-uri'] || openConfig.cli['file-uri']) {
			pathsToOpen = await this.doExtractPathsFromCLI(openConfig.cli);
			if (pathsToOpen.length === 0) {
				pathsToOpen.push(EMPTY_WINDOW); // add an empty window if we did not have windows to open from command line
			}

			isCommandLineOrAPICall = true;
		}

		// Extract paths: from previous session 从上一个会话提取路径
		else {
			pathsToOpen = await this.doGetPathsFromLastSession();
			if (pathsToOpen.length === 0) {
				pathsToOpen.push(EMPTY_WINDOW); // add an empty window if we did not have windows to restore
			}

			isRestoringPaths = true;
		}

		// 当我们在 CLI 中打开多个文件夹时，并且我们不在 `--add` 或 `--remove` 模式下，
		// 通过创建一个无标题的工作区来处理这种情况，只有当：
		// - 它们都共享相同的远程授权
		// - 没有现有工作区可以打开这些文件夹
		if (!openConfig.addMode && !openConfig.removeMode && isCommandLineOrAPICall) {
			const foldersToOpen = pathsToOpen.filter(path => isSingleFolderWorkspacePathToOpen(path));
			if (foldersToOpen.length > 1) {
				const remoteAuthority = foldersToOpen[0].remoteAuthority;
				if (foldersToOpen.every(folderToOpen => isEqualAuthority(folderToOpen.remoteAuthority, remoteAuthority))) {
					let workspace: IWorkspaceIdentifier | undefined;

					const lastSessionWorkspaceMatchingFolders = await this.doGetWorkspaceMatchingFoldersFromLastSession(remoteAuthority, foldersToOpen);
					if (lastSessionWorkspaceMatchingFolders) {
						workspace = lastSessionWorkspaceMatchingFolders;
					} else {
						workspace = await this.workspacesManagementMainService.createUntitledWorkspace(foldersToOpen.map(folder => ({ uri: folder.workspace.uri })));
					}

					// Add workspace and remove folders thereby
					pathsToOpen.push({ workspace, remoteAuthority });
					pathsToOpen = pathsToOpen.filter(path => !isSingleFolderWorkspacePathToOpen(path));
				}
			}
		}

		// 检查 `window.restoreWindows` 设置以包含所有窗口
		// 如果这是初始启动并且我们没有恢复窗口，否则不恢复窗口。
		// 使用 `unshift` 确保任何新窗口打开最后，以便正确处理焦点。
		if (openConfig.initialStartup && !isRestoringPaths && this.configurationService.getValue<IWindowSettings | undefined>('window')?.restoreWindows === 'preserve') {
			const lastSessionPaths = await this.doGetPathsFromLastSession();
			pathsToOpen.unshift(...lastSessionPaths.filter(path => isWorkspacePathToOpen(path) || isSingleFolderWorkspacePathToOpen(path) || path.backupPath));
		}

		return pathsToOpen;
	}

	/**
	 * 从 API 参数中解析路径。
	 * @param openConfig 打开配置
	 * @returns 路径数组
	 */
	private async doExtractPathsFromAPI(openConfig: IOpenConfiguration): Promise<IPathToOpen[]> {
		const pathResolveOptions: IPathResolveOptions = {
			gotoLineMode: openConfig.gotoLineMode,
			remoteAuthority: openConfig.remoteAuthority
		};

		const pathsToOpen = await Promise.all(coalesce(openConfig.urisToOpen || []).map(async pathToOpen => {
			const path = await this.resolveOpenable(pathToOpen, pathResolveOptions);

			// Path exists
			if (path) {
				path.label = pathToOpen.label;

				return path;
			}

			// Path does not exist: show a warning box
			const uri = this.resourceFromOpenable(pathToOpen);

			this.dialogMainService.showMessageBox({
				type: 'info',
				buttons: [localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK")],
				message: uri.scheme === Schemas.file ? localize('pathNotExistTitle', "Path does not exist") : localize('uriInvalidTitle', "URI can not be opened"),
				detail: uri.scheme === Schemas.file ?
					localize('pathNotExistDetail', "The path '{0}' does not exist on this computer.", getPathLabel(uri, { os: OS, tildify: this.environmentMainService })) :
					localize('uriInvalidDetail', "The URI '{0}' is not valid and can not be opened.", uri.toString(true))
			}, BrowserWindow.getFocusedWindow() ?? undefined);

			return undefined;
		}));

		return coalesce(pathsToOpen);
	}

	/**
	 * 从 CLI 参数中解析路径。
	 * @param cli 命令行参数
	 * @returns 路径数组
	 */
	private async doExtractPathsFromCLI(cli: NativeParsedArgs): Promise<IPath[]> {
		const pathsToOpen: IPathToOpen[] = [];
		const pathResolveOptions: IPathResolveOptions = {
			ignoreFileNotFound: true,
			gotoLineMode: cli.goto,
			remoteAuthority: cli.remote || undefined,
			forceOpenWorkspaceAsFile:
				// 特殊情况：在差异/合并模式下强制打开
				// 工作区作为文件
				// https://github.com/microsoft/vscode/issues/149731
				cli.diff && cli._.length === 2 ||
				cli.merge && cli._.length === 4
		};

		// folder uris
		const folderUris = cli['folder-uri'];
		if (folderUris) {
			const resolvedFolderUris = await Promise.all(folderUris.map(rawFolderUri => {
				const folderUri = this.cliArgToUri(rawFolderUri);
				if (!folderUri) {
					return undefined;
				}

				return this.resolveOpenable({ folderUri }, pathResolveOptions);
			}));

			pathsToOpen.push(...coalesce(resolvedFolderUris));
		}

		// file uris
		const fileUris = cli['file-uri'];
		if (fileUris) {
			const resolvedFileUris = await Promise.all(fileUris.map(rawFileUri => {
				const fileUri = this.cliArgToUri(rawFileUri);
				if (!fileUri) {
					return undefined;
				}

				return this.resolveOpenable(hasWorkspaceFileExtension(rawFileUri) ? { workspaceUri: fileUri } : { fileUri }, pathResolveOptions);
			}));

			pathsToOpen.push(...coalesce(resolvedFileUris));
		}

		// folder or file paths
		const resolvedCliPaths = await Promise.all(cli._.map(cliPath => {
			return pathResolveOptions.remoteAuthority ? this.doResolveRemotePath(cliPath, pathResolveOptions) : this.doResolveFilePath(cliPath, pathResolveOptions);
		}));

		pathsToOpen.push(...coalesce(resolvedCliPaths));

		return pathsToOpen;
	}

	/**
	 * 将字符串参数转为 URI。
	 * @param arg 字符串参数
	 * @returns URI 或 undefined
	 */
	private cliArgToUri(arg: string): URI | undefined {
		try {
			const uri = URI.parse(arg);
			if (!uri.scheme) {
				this.logService.error(`Invalid URI input string, scheme missing: ${arg}`);

				return undefined;
			}
			if (!uri.path) {
				return uri.with({ path: '/' });
			}

			return uri;
		} catch (e) {
			this.logService.error(`Invalid URI input string: ${arg}, ${e.message}`);
		}

		return undefined;
	}

	/**
	 * 恢复上次会话的窗口路径。
	 * @returns 路径数组
	 */
	private async doGetPathsFromLastSession(): Promise<IPathToOpen[]> {
		const restoreWindowsSetting = this.getRestoreWindowsSetting();

		switch (restoreWindowsSetting) {

			// none: no window to restore
			case 'none':
				return [];

			// one: restore last opened workspace/folder or empty window
			// all: restore all windows
			// folders: restore last opened folders only
			case 'one':
			case 'all':
			case 'preserve':
			case 'folders': {

				// Collect previously opened windows
				const lastSessionWindows: IWindowState[] = [];
				if (restoreWindowsSetting !== 'one') {
					lastSessionWindows.push(...this.windowsStateHandler.state.openedWindows);
				}
				if (this.windowsStateHandler.state.lastActiveWindow) {
					lastSessionWindows.push(this.windowsStateHandler.state.lastActiveWindow);
				}

				const pathsToOpen = await Promise.all(lastSessionWindows.map(async lastSessionWindow => {

					// Workspaces
					if (lastSessionWindow.workspace) {
						const pathToOpen = await this.resolveOpenable({ workspaceUri: lastSessionWindow.workspace.configPath }, { remoteAuthority: lastSessionWindow.remoteAuthority, rejectTransientWorkspaces: true /* https://github.com/microsoft/vscode/issues/119695 */ });
						if (isWorkspacePathToOpen(pathToOpen)) {
							return pathToOpen;
						}
					}

					// Folders
					else if (lastSessionWindow.folderUri) {
						const pathToOpen = await this.resolveOpenable({ folderUri: lastSessionWindow.folderUri }, { remoteAuthority: lastSessionWindow.remoteAuthority });
						if (isSingleFolderWorkspacePathToOpen(pathToOpen)) {
							return pathToOpen;
						}
					}

					// Empty window, potentially editors open to be restored
					else if (restoreWindowsSetting !== 'folders' && lastSessionWindow.backupPath) {
						return { backupPath: lastSessionWindow.backupPath, remoteAuthority: lastSessionWindow.remoteAuthority };
					}

					return undefined;
				}));

				return coalesce(pathsToOpen);
			}
		}
	}

	/**
	 * 获取窗口恢复策略（如 all/one/none）。
	 * @returns 恢复策略
	 */
	private getRestoreWindowsSetting(): RestoreWindowsSetting {
		let restoreWindows: RestoreWindowsSetting;
		if (this.lifecycleMainService.wasRestarted) {
			restoreWindows = 'all'; // always reopen all windows when an update was applied
		} else {
			const windowConfig = this.configurationService.getValue<IWindowSettings | undefined>('window');
			restoreWindows = windowConfig?.restoreWindows || 'all'; // by default restore all windows

			if (!['preserve', 'all', 'folders', 'one', 'none'].includes(restoreWindows)) {
				restoreWindows = 'all'; // by default restore all windows
			}
		}

		return restoreWindows;
	}

	/**
	 * 查找与指定文件夹集合匹配的工作区。
	 * @param remoteAuthority 远程授权
	 * @param folders 文件夹集合
	 * @returns 匹配的工作区标识符或 undefined
	 */
	private async doGetWorkspaceMatchingFoldersFromLastSession(remoteAuthority: string | undefined, folders: ISingleFolderWorkspacePathToOpen[]): Promise<IWorkspaceIdentifier | undefined> {
		const workspaces = (await this.doGetPathsFromLastSession()).filter(path => isWorkspacePathToOpen(path));
		const folderUris = folders.map(folder => folder.workspace.uri);

		for (const { workspace } of workspaces) {
			const resolvedWorkspace = await this.workspacesManagementMainService.resolveLocalWorkspace(workspace.configPath);
			if (
				!resolvedWorkspace ||
				resolvedWorkspace.remoteAuthority !== remoteAuthority ||
				resolvedWorkspace.transient ||
				resolvedWorkspace.folders.length !== folders.length
			) {
				continue;
			}

			const folderSet = new ResourceSet(folderUris, uri => extUriBiasedIgnorePathCase.getComparisonKey(uri));
			if (resolvedWorkspace.folders.every(folder => folderSet.has(folder.uri))) {
				return resolvedWorkspace;
			}
		}

		return undefined;
	}

	/**
	 * 将各种"可打开对象"解析为具体路径，支持本地/远程、文件/文件夹/工作区等。
	 * @param openable 可打开对象
	 * @param options 解析选项
	 * @returns 路径对象或 undefined
	 */
	private async resolveOpenable(openable: IWindowOpenable, options: IPathResolveOptions = Object.create(null)): Promise<IPathToOpen | undefined> {

		// handle file:// openables with some extra validation
		const uri = this.resourceFromOpenable(openable);
		if (uri.scheme === Schemas.file) {
			if (isFileToOpen(openable)) {
				options = { ...options, forceOpenWorkspaceAsFile: true };
			}

			return this.doResolveFilePath(uri.fsPath, options);
		}

		// handle non file:// openables
		return this.doResolveRemoteOpenable(openable, options);
	}

	/**
	 * 解析远程可打开对象。
	 * @param openable 可打开对象
	 * @param options 解析选项
	 * @returns 路径对象
	 */
	private doResolveRemoteOpenable(openable: IWindowOpenable, options: IPathResolveOptions): IPathToOpen<ITextEditorOptions> | undefined {
		let uri = this.resourceFromOpenable(openable);

		// use remote authority from vscode
		const remoteAuthority = getRemoteAuthority(uri) || options.remoteAuthority;

		// normalize URI
		uri = removeTrailingPathSeparator(normalizePath(uri));

		// File
		if (isFileToOpen(openable)) {
			if (options.gotoLineMode) {
				const { path, line, column } = parseLineAndColumnAware(uri.path);

				return {
					fileUri: uri.with({ path }),
					options: {
						selection: line ? { startLineNumber: line, startColumn: column || 1 } : undefined
					},
					remoteAuthority
				};
			}

			return { fileUri: uri, remoteAuthority };
		}

		// Workspace
		else if (isWorkspaceToOpen(openable)) {
			return { workspace: getWorkspaceIdentifier(uri), remoteAuthority };
		}

		// Folder
		return { workspace: getSingleFolderWorkspaceIdentifier(uri), remoteAuthority };
	}

	/**
	 * 从可打开对象获取资源 URI。
	 * @param openable 可打开对象
	 * @returns URI
	 */
	private resourceFromOpenable(openable: IWindowOpenable): URI {
		if (isWorkspaceToOpen(openable)) {
			return openable.workspaceUri;
		}

		if (isFolderToOpen(openable)) {
			return openable.folderUri;
		}

		return openable.fileUri;
	}

	/**
	 * 解析本地文件路径，支持行列号、工作区、文件夹等。
	 * @param path 路径
	 * @param options 解析选项
	 * @param skipHandleUNCError 跳过 UNC 错误处理
	 * @returns 路径对象或 undefined
	 */
	private async doResolveFilePath(path: string, options: IPathResolveOptions, skipHandleUNCError?: boolean): Promise<IPathToOpen<ITextEditorOptions> | undefined> {

		// Extract line/col information from path
		let lineNumber: number | undefined;
		let columnNumber: number | undefined;
		if (options.gotoLineMode) {
			({ path, line: lineNumber, column: columnNumber } = parseLineAndColumnAware(path));
		}

		// Ensure the path is normalized and absolute
		path = sanitizeFilePath(normalize(path), cwd());

		try {
			const pathStat = await fs.promises.stat(path);

			// File
			if (pathStat.isFile()) {

				// Workspace (unless disabled via flag)
				if (!options.forceOpenWorkspaceAsFile) {
					const workspace = await this.workspacesManagementMainService.resolveLocalWorkspace(URI.file(path));
					if (workspace) {

						// If the workspace is transient and we are to ignore
						// transient workspaces, reject it.
						if (workspace.transient && options.rejectTransientWorkspaces) {
							return undefined;
						}

						return {
							workspace: { id: workspace.id, configPath: workspace.configPath },
							type: FileType.File,
							exists: true,
							remoteAuthority: workspace.remoteAuthority,
							transient: workspace.transient
						};
					}
				}

				return {
					fileUri: URI.file(path),
					type: FileType.File,
					exists: true,
					options: {
						selection: lineNumber ? { startLineNumber: lineNumber, startColumn: columnNumber || 1 } : undefined
					}
				};
			}

			// Folder
			else if (pathStat.isDirectory()) {
				return {
					workspace: getSingleFolderWorkspaceIdentifier(URI.file(path), pathStat),
					type: FileType.Directory,
					exists: true
				};
			}

			// Special device: in POSIX environments, we may get /dev/null passed
			// in (for example git uses it to signal one side of a diff does not
			// exist). In that special case, treat it like a file to support this
			// scenario ()
			else if (!isWindows && path === '/dev/null') {
				return {
					fileUri: URI.file(path),
					type: FileType.File,
					exists: true
				};
			}
		} catch (error) {

			if (error.code === 'ERR_UNC_HOST_NOT_ALLOWED' && !skipHandleUNCError) {
				return this.onUNCHostNotAllowed(path, options);
			}

			const fileUri = URI.file(path);

			// since file does not seem to exist anymore, remove from recent
			this.workspacesHistoryMainService.removeRecentlyOpened([fileUri]);

			// assume this is a file that does not yet exist
			if (options.ignoreFileNotFound && error.code === 'ENOENT') {
				return {
					fileUri,
					type: FileType.File,
					exists: false
				};
			}

			this.logService.error(`Invalid path provided: ${path}, ${error.message}`);
		}

		return undefined;
	}

	/**
	 * 处理 UNC 主机未允许时的弹窗与授权。
	 * @param path 路径
	 * @param options 解析选项
	 * @returns 路径对象或 undefined
	 */
	private async onUNCHostNotAllowed(path: string, options: IPathResolveOptions): Promise<IPathToOpen<ITextEditorOptions> | undefined> {
		const uri = URI.file(path);

		const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
			type: 'warning',
			buttons: [
				localize({ key: 'allow', comment: ['&& denotes a mnemonic'] }, "&&Allow"),
				localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&Cancel"),
				localize({ key: 'learnMore', comment: ['&& denotes a mnemonic'] }, "&&Learn More"),
			],
			message: localize('confirmOpenMessage', "The host '{0}' was not found in the list of allowed hosts. Do you want to allow it anyway?", uri.authority),
			detail: localize('confirmOpenDetail', "The path '{0}' uses a host that is not allowed. Unless you trust the host, you should press 'Cancel'", getPathLabel(uri, { os: OS, tildify: this.environmentMainService })),
			checkboxLabel: localize('doNotAskAgain', "Permanently allow host '{0}'", uri.authority),
			cancelId: 1
		});

		if (response === 0) {
			addUNCHostToAllowlist(uri.authority);

			if (checkboxChecked) {
				// Due to https://github.com/microsoft/vscode/issues/195436, we can only
				// update settings from within a window. But we do not know if a window
				// is about to open or can already handle the request, so we have to send
				// to any current window and any newly opening window.
				const request = { channel: 'vscode:configureAllowedUNCHost', args: uri.authority };
				this.sendToFocused(request.channel, request.args);
				this.sendToOpeningWindow(request.channel, request.args);
			}

			return this.doResolveFilePath(path, options, true /* do not handle UNC error again */);
		}

		if (response === 2) {
			shell.openExternal('https://aka.ms/vscode-windows-unc');

			return this.onUNCHostNotAllowed(path, options); // keep showing the dialog until decision (https://github.com/microsoft/vscode/issues/181956)
		}

		return undefined;
	}

	/**
	 * 解析远程路径，支持行列号、工作区、文件夹等。
	 * @param path 路径
	 * @param options 解析选项
	 * @returns 路径对象
	 */
	private doResolveRemotePath(path: string, options: IPathResolveOptions): IPathToOpen<ITextEditorOptions> | undefined {
		const first = path.charCodeAt(0);
		const remoteAuthority = options.remoteAuthority;

		// Extract line/col information from path
		let lineNumber: number | undefined;
		let columnNumber: number | undefined;

		if (options.gotoLineMode) {
			({ path, line: lineNumber, column: columnNumber } = parseLineAndColumnAware(path));
		}

		// make absolute
		if (first !== CharCode.Slash) {
			if (isWindowsDriveLetter(first) && path.charCodeAt(path.charCodeAt(1)) === CharCode.Colon) {
				path = toSlashes(path);
			}

			path = `/${path}`;
		}

		const uri = URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: path });

		// guess the file type:
		// - if it ends with a slash it's a folder
		// - if in goto line mode or if it has a file extension, it's a file or a workspace
		// - by defaults it's a folder
		if (path.charCodeAt(path.length - 1) !== CharCode.Slash) {

			// file name ends with .code-workspace
			if (hasWorkspaceFileExtension(path)) {
				if (options.forceOpenWorkspaceAsFile) {
					return {
						fileUri: uri,
						options: {
							selection: lineNumber ? { startLineNumber: lineNumber, startColumn: columnNumber || 1 } : undefined
						},
						remoteAuthority: options.remoteAuthority
					};
				}

				return { workspace: getWorkspaceIdentifier(uri), remoteAuthority };
			}

			// file name starts with a dot or has an file extension
			else if (options.gotoLineMode || posix.basename(path).indexOf('.') !== -1) {
				return {
					fileUri: uri,
					options: {
						selection: lineNumber ? { startLineNumber: lineNumber, startColumn: columnNumber || 1 } : undefined
					},
					remoteAuthority
				};
			}
		}

		return { workspace: getSingleFolderWorkspaceIdentifier(uri), remoteAuthority };
	}

	/**
	 * 根据配置和参数，判断是否应新开窗口。
	 * @param openConfig 打开配置
	 * @returns 是否新开窗口的布尔值
	 */
	private shouldOpenNewWindow(openConfig: IOpenConfiguration): { openFolderInNewWindow: boolean; openFilesInNewWindow: boolean } {

		// let the user settings override how folders are open in a new window or same window unless we are forced
		const windowConfig = this.configurationService.getValue<IWindowSettings | undefined>('window');
		const openFolderInNewWindowConfig = windowConfig?.openFoldersInNewWindow || 'default' /* default */;
		const openFilesInNewWindowConfig = windowConfig?.openFilesInNewWindow || 'off' /* default */;

		let openFolderInNewWindow = (openConfig.preferNewWindow || openConfig.forceNewWindow) && !openConfig.forceReuseWindow;
		if (!openConfig.forceNewWindow && !openConfig.forceReuseWindow && (openFolderInNewWindowConfig === 'on' || openFolderInNewWindowConfig === 'off')) {
			openFolderInNewWindow = (openFolderInNewWindowConfig === 'on');
		}

		// let the user settings override how files are open in a new window or same window unless we are forced (not for extension development though)
		let openFilesInNewWindow: boolean = false;
		if (openConfig.forceNewWindow || openConfig.forceReuseWindow) {
			openFilesInNewWindow = !!openConfig.forceNewWindow && !openConfig.forceReuseWindow;
		} else {

			// macOS：默认情况下，如果通过 DOCK 上下文触发，我们会在新窗口中打开文件
			if (isMacintosh) {
				if (openConfig.context === OpenContext.DOCK) {
					openFilesInNewWindow = true;
				}
			}

			// Linux/Windows：默认情况下，我们在新窗口中打开文件，除非通过 DIALOG / MENU 上下文触发
			// 或从集成终端触发，我们假定用户更喜欢在当前窗口中打开
			else {
				if (openConfig.context !== OpenContext.DIALOG && openConfig.context !== OpenContext.MENU && !(openConfig.userEnv && openConfig.userEnv['TERM_PROGRAM'] === 'vscode')) {
					openFilesInNewWindow = true;
				}
			}

			// finally check for overrides of default
			if (!openConfig.cli.extensionDevelopmentPath && (openFilesInNewWindowConfig === 'on' || openFilesInNewWindowConfig === 'off')) {
				openFilesInNewWindow = (openFilesInNewWindowConfig === 'on');
			}
		}

		return { openFolderInNewWindow: !!openFolderInNewWindow, openFilesInNewWindow };
	}

	/**
	 * 打开扩展开发主机窗口，避免重复。
	 * @param extensionDevelopmentPaths 扩展开发路径
	 * @param openConfig 打开配置
	 * @returns 打开的窗口数组
	 */
	async openExtensionDevelopmentHostWindow(extensionDevelopmentPaths: string[], openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {

		// Reload an existing extension development host window on the same path
		// We currently do not allow more than one extension development window
		// on the same extension path.
		const existingWindow = findWindowOnExtensionDevelopmentPath(this.getWindows(), extensionDevelopmentPaths);
		if (existingWindow) {
			this.lifecycleMainService.reload(existingWindow, openConfig.cli);
			existingWindow.focus(); // make sure it gets focus and is restored

			return [existingWindow];
		}

		let folderUris = openConfig.cli['folder-uri'] || [];
		let fileUris = openConfig.cli['file-uri'] || [];
		let cliArgs = openConfig.cli._;

		// Fill in previously opened workspace unless an explicit path is provided and we are not unit testing
		if (!cliArgs.length && !folderUris.length && !fileUris.length && !openConfig.cli.extensionTestsPath) {
			const extensionDevelopmentWindowState = this.windowsStateHandler.state.lastPluginDevelopmentHostWindow;
			const workspaceToOpen = extensionDevelopmentWindowState?.workspace ?? extensionDevelopmentWindowState?.folderUri;
			if (workspaceToOpen) {
				if (URI.isUri(workspaceToOpen)) {
					if (workspaceToOpen.scheme === Schemas.file) {
						cliArgs = [workspaceToOpen.fsPath];
					} else {
						folderUris = [workspaceToOpen.toString()];
					}
				} else {
					if (workspaceToOpen.configPath.scheme === Schemas.file) {
						cliArgs = [originalFSPath(workspaceToOpen.configPath)];
					} else {
						fileUris = [workspaceToOpen.configPath.toString()];
					}
				}
			}
		}

		let remoteAuthority = openConfig.remoteAuthority;
		for (const extensionDevelopmentPath of extensionDevelopmentPaths) {
			if (extensionDevelopmentPath.match(/^[a-zA-Z][a-zA-Z0-9\+\-\.]+:/)) {
				const url = URI.parse(extensionDevelopmentPath);
				const extensionDevelopmentPathRemoteAuthority = getRemoteAuthority(url);
				if (extensionDevelopmentPathRemoteAuthority) {
					if (remoteAuthority) {
						if (!isEqualAuthority(extensionDevelopmentPathRemoteAuthority, remoteAuthority)) {
							this.logService.error('more than one extension development path authority');
						}
					} else {
						remoteAuthority = extensionDevelopmentPathRemoteAuthority;
					}
				}
			}
		}

		// Make sure that we do not try to open:
		// - a workspace or folder that is already opened
		// - a workspace or file that has a different authority as the extension development.

		cliArgs = cliArgs.filter(path => {
			const uri = URI.file(path);
			if (!!findWindowOnWorkspaceOrFolder(this.getWindows(), uri)) {
				return false;
			}

			return isEqualAuthority(getRemoteAuthority(uri), remoteAuthority);
		});

		folderUris = folderUris.filter(folderUriStr => {
			const folderUri = this.cliArgToUri(folderUriStr);
			if (folderUri && !!findWindowOnWorkspaceOrFolder(this.getWindows(), folderUri)) {
				return false;
			}

			return folderUri ? isEqualAuthority(getRemoteAuthority(folderUri), remoteAuthority) : false;
		});

		fileUris = fileUris.filter(fileUriStr => {
			const fileUri = this.cliArgToUri(fileUriStr);
			if (fileUri && !!findWindowOnWorkspaceOrFolder(this.getWindows(), fileUri)) {
				return false;
			}

			return fileUri ? isEqualAuthority(getRemoteAuthority(fileUri), remoteAuthority) : false;
		});

		openConfig.cli._ = cliArgs;
		openConfig.cli['folder-uri'] = folderUris;
		openConfig.cli['file-uri'] = fileUris;

		// Open it
		const openArgs: IOpenConfiguration = {
			context: openConfig.context,
			cli: openConfig.cli,
			forceNewWindow: true,
			forceEmpty: !cliArgs.length && !folderUris.length && !fileUris.length,
			userEnv: openConfig.userEnv,
			noRecentEntry: true,
			waitMarkerFileURI: openConfig.waitMarkerFileURI,
			remoteAuthority,
			forceProfile: openConfig.forceProfile,
			forceTempProfile: openConfig.forceTempProfile
		};

		return this.open(openArgs);
	}

	/**
	 * 实际创建或复用 Electron 窗口，并加载配置。
	 * @param options 打开窗口选项
	 * @returns 新建或复用的窗口
	 */
	private async openInBrowserWindow(options: IOpenBrowserWindowOptions): Promise<ICodeWindow> {
		const windowConfig = this.configurationService.getValue<IWindowSettings | undefined>('window');

		const lastActiveWindow = this.getLastActiveWindow();
		const newWindowProfile = windowConfig?.newWindowProfile
			? this.userDataProfilesMainService.profiles.find(profile => profile.name === windowConfig.newWindowProfile) : undefined;
		const defaultProfile = newWindowProfile ?? lastActiveWindow?.profile ?? this.userDataProfilesMainService.defaultProfile;

		let window: ICodeWindow | undefined;
		if (!options.forceNewWindow && !options.forceNewTabbedWindow) {
			window = options.windowToUse || lastActiveWindow;
			if (window) {
				window.focus();
			}
		}

		// 根据提供的选项、配置和环境构建窗口配置
		const configuration: INativeWindowConfiguration = {

			// 从环境和/或此次启动的特定属性
			// 继承 CLI 参数（如果提供）
			...this.environmentMainService.args,
			...options.cli,

			machineId: this.machineId,
			sqmId: this.sqmId,
			devDeviceId: this.devDeviceId,

			windowId: -1,	// Will be filled in by the window once loaded later

			mainPid: process.pid,

			appRoot: this.environmentMainService.appRoot,
			execPath: process.execPath,
			codeCachePath: this.environmentMainService.codeCachePath,
			// 如果我们预先知道备份文件夹（用于还原空窗口），我们可以
			// 直接在这里设置它，这有助于还原与该窗口关联的 UI 状态。
			// 对于所有其他情况，我们首先调用 registerEmptyWindowBackup()
			// 在加载窗口之前设置它。
			backupPath: options.emptyWindowBackupInfo ? join(this.environmentMainService.backupHome, options.emptyWindowBackupInfo.backupFolder) : undefined,

			profiles: {
				home: this.userDataProfilesMainService.profilesHome,
				all: this.userDataProfilesMainService.profiles,
				// 首先设置为默认配置文件，并在工作区备份注册后
				// 才解析和更新配置文件。
				// 因为空窗口的工作区标识符只有在那时才知道。
				profile: defaultProfile
			},

			homeDir: this.environmentMainService.userHome.with({ scheme: Schemas.file }).fsPath,
			tmpDir: this.environmentMainService.tmpDir.with({ scheme: Schemas.file }).fsPath,
			userDataDir: this.environmentMainService.userDataPath,

			remoteAuthority: options.remoteAuthority,
			workspace: options.workspace,
			userEnv: { ...this.initialUserEnv, ...options.userEnv },

			nls: {
				messages: getNLSMessages(),
				language: getNLSLanguage()
			},

			filesToOpenOrCreate: options.filesToOpen?.filesToOpenOrCreate,
			filesToDiff: options.filesToOpen?.filesToDiff,
			filesToMerge: options.filesToOpen?.filesToMerge,
			filesToWait: options.filesToOpen?.filesToWait,

			logLevel: this.loggerService.getLogLevel(),
			loggers: this.loggerService.getGlobalLoggers(),
			logsPath: this.environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath,

			product,
			isInitialStartup: options.initialStartup,
			perfMarks: getMarks(),
			os: { release: release(), hostname: hostname(), arch: arch() },

			autoDetectHighContrast: windowConfig?.autoDetectHighContrast ?? true,
			autoDetectColorScheme: windowConfig?.autoDetectColorScheme ?? false,
			accessibilitySupport: app.accessibilitySupportEnabled,
			colorScheme: this.themeMainService.getColorScheme(),
			policiesData: this.policyService.serialize(),
			continueOn: this.environmentMainService.continueOn,

			cssModules: this.cssDevelopmentService.isEnabled ? await this.cssDevelopmentService.getCssModules() : undefined
		};

		// New window
		if (!window) {
			const state = this.windowsStateHandler.getNewWindowState(configuration);

			// Create the window
			mark('code/willCreateCodeWindow');
			const createdWindow = window = this.instantiationService.createInstance(CodeWindow, {
				state,
				extensionDevelopmentPath: configuration.extensionDevelopmentPath,
				isExtensionTestHost: !!configuration.extensionTestsPath
			});
			mark('code/didCreateCodeWindow');

			// Add as window tab if configured (macOS only)
			if (options.forceNewTabbedWindow) {
				const activeWindow = this.getLastActiveWindow();
				activeWindow?.addTabbedWindow(createdWindow);
			}

			// Add to our list of windows
			this.windows.set(createdWindow.id, createdWindow);

			// Indicate new window via event
			this._onDidOpenWindow.fire(createdWindow);

			// Indicate number change via event
			this._onDidChangeWindowsCount.fire({ oldCount: this.getWindowCount() - 1, newCount: this.getWindowCount() });

			// Window Events
			const disposables = new DisposableStore();
			disposables.add(createdWindow.onDidSignalReady(() => this._onDidSignalReadyWindow.fire(createdWindow)));
			disposables.add(Event.once(createdWindow.onDidClose)(() => this.onWindowClosed(createdWindow, disposables)));
			disposables.add(Event.once(createdWindow.onDidDestroy)(() => this.onWindowDestroyed(createdWindow)));
			disposables.add(createdWindow.onDidMaximize(() => this._onDidMaximizeWindow.fire(createdWindow)));
			disposables.add(createdWindow.onDidUnmaximize(() => this._onDidUnmaximizeWindow.fire(createdWindow)));
			disposables.add(createdWindow.onDidEnterFullScreen(() => this._onDidChangeFullScreen.fire({ window: createdWindow, fullscreen: true })));
			disposables.add(createdWindow.onDidLeaveFullScreen(() => this._onDidChangeFullScreen.fire({ window: createdWindow, fullscreen: false })));
			disposables.add(createdWindow.onDidTriggerSystemContextMenu(({ x, y }) => this._onDidTriggerSystemContextMenu.fire({ window: createdWindow, x, y })));

			const webContents = assertIsDefined(createdWindow.win?.webContents);
			webContents.removeAllListeners('devtools-reload-page'); // 移除内置侦听器，以便我们可以自己处理
			disposables.add(Event.fromNodeEventEmitter(webContents, 'devtools-reload-page')(() => this.lifecycleMainService.reload(createdWindow)));

			// Lifecycle
			this.lifecycleMainService.registerWindow(createdWindow);
		}

		// Existing window
		else {

			// 如果窗口正在被重用，并且我们处于
			// 扩展开发主机模式，一些配置项会被继承。
			// 这些选项都与开发有关。
			const currentWindowConfig = window.config;
			if (!configuration.extensionDevelopmentPath && currentWindowConfig?.extensionDevelopmentPath) {
				configuration.extensionDevelopmentPath = currentWindowConfig.extensionDevelopmentPath;
				configuration.extensionDevelopmentKind = currentWindowConfig.extensionDevelopmentKind;
				configuration['enable-proposed-api'] = currentWindowConfig['enable-proposed-api'];
				configuration.verbose = currentWindowConfig.verbose;
				configuration['inspect-extensions'] = currentWindowConfig['inspect-extensions'];
				configuration['inspect-brk-extensions'] = currentWindowConfig['inspect-brk-extensions'];
				configuration.debugId = currentWindowConfig.debugId;
				configuration.extensionEnvironment = currentWindowConfig.extensionEnvironment;
				configuration['extensions-dir'] = currentWindowConfig['extensions-dir'];
				configuration['disable-extensions'] = currentWindowConfig['disable-extensions'];
				configuration['disable-extension'] = currentWindowConfig['disable-extension'];
			}
			configuration.loggers = configuration.loggers;
		}

		// Update window identifier and session now
		// that we have the window object in hand.
		configuration.windowId = window.id;

		// If the window was already loaded, make sure to unload it
		// first and only load the new configuration if that was
		// not vetoed
		if (window.isReady) {
			this.lifecycleMainService.unload(window, UnloadReason.LOAD).then(async veto => {
				if (!veto) {
					await this.doOpenInBrowserWindow(window, configuration, options, defaultProfile);
				}
			});
		} else {
			await this.doOpenInBrowserWindow(window, configuration, options, defaultProfile);
		}

		return window;
	}

	/**
	 * 加载窗口配置并注册备份、配置文件等。
	 * @param window 目标窗口
	 * @param configuration 窗口配置
	 * @param options 打开窗口选项
	 * @param defaultProfile 默认配置文件
	 */
	private async doOpenInBrowserWindow(window: ICodeWindow, configuration: INativeWindowConfiguration, options: IOpenBrowserWindowOptions, defaultProfile: IUserDataProfile): Promise<void> {

		// 注册窗口备份，除非窗口
		// 用于扩展开发，我们不保留任何备份。

		if (!configuration.extensionDevelopmentPath) {
			if (isWorkspaceIdentifier(configuration.workspace)) {
				configuration.backupPath = this.backupMainService.registerWorkspaceBackup({
					workspace: configuration.workspace,
					remoteAuthority: configuration.remoteAuthority
				});
			} else if (isSingleFolderWorkspaceIdentifier(configuration.workspace)) {
				configuration.backupPath = this.backupMainService.registerFolderBackup({
					folderUri: configuration.workspace.uri,
					remoteAuthority: configuration.remoteAuthority
				});
			} else {

				// 空窗口特殊之处在于它们在配置中
				// 不提供工作区。为了正确地将它们注册到备份
				// 服务中，我们要么使用提供的关联 `backupFolder`
				// （在恢复先前打开的空窗口的情况下），要么必须
				// 生成一个新的空窗口工作区标识符，用作
				// `backupFolder`。

				configuration.backupPath = this.backupMainService.registerEmptyWindowBackup({
					backupFolder: options.emptyWindowBackupInfo?.backupFolder ?? createEmptyWorkspaceIdentifier().id,
					remoteAuthority: configuration.remoteAuthority
				});
			}
		}

		const workspace = configuration.workspace ?? toWorkspaceIdentifier(configuration.backupPath, false);
		const profilePromise = this.resolveProfileForBrowserWindow(options, workspace, defaultProfile);
		const profile = profilePromise instanceof Promise ? await profilePromise : profilePromise;
		configuration.profiles.profile = profile;

		if (!configuration.extensionDevelopmentPath) {
			// 将配置的配置文件关联到工作区
			// 除非窗口用于扩展开发，
			// 此时我们不会保留关联
			await this.userDataProfilesMainService.setProfileForWorkspace(workspace, profile);
		}

		// Load it
		window.load(configuration);
	}

	/**
	 * 根据打开选项和工作区，解析应使用的用户数据配置文件。
	 * @param options 打开窗口选项
	 * @param workspace 工作区标识
	 * @param defaultProfile 默认配置文件
	 * @returns 用户数据配置文件
	 */
	private resolveProfileForBrowserWindow(options: IOpenBrowserWindowOptions, workspace: IAnyWorkspaceIdentifier, defaultProfile: IUserDataProfile): Promise<IUserDataProfile> | IUserDataProfile {
		if (options.forceProfile) {
			return this.userDataProfilesMainService.profiles.find(p => p.name === options.forceProfile) ?? this.userDataProfilesMainService.createNamedProfile(options.forceProfile);
		}

		if (options.forceTempProfile) {
			return this.userDataProfilesMainService.createTransientProfile();
		}

		return this.userDataProfilesMainService.getProfileForWorkspace(workspace) ?? defaultProfile;
	}

	/**
	 * 窗口关闭时的清理和事件。
	 * @param window 关闭的窗口
	 * @param disposables 相关资源
	 */
	private onWindowClosed(window: ICodeWindow, disposables: IDisposable): void {

		// Remove from our list so that Electron can clean it up
		this.windows.delete(window.id);

		// Emit
		this._onDidChangeWindowsCount.fire({ oldCount: this.getWindowCount() + 1, newCount: this.getWindowCount() });

		// Clean up
		disposables.dispose();
	}

	/**
	 * 窗口销毁时的清理和事件。
	 * @param window 销毁的窗口
	 */
	private onWindowDestroyed(window: ICodeWindow): void {

		// Remove from our list so that Electron can clean it up
		this.windows.delete(window.id);

		// Emit
		this._onDidDestroyWindow.fire(window);
	}

	/**
	 * 获取当前聚焦的窗口。
	 * @returns 聚焦窗口或 undefined
	 */
	getFocusedWindow(): ICodeWindow | undefined {
		const window = BrowserWindow.getFocusedWindow();
		if (window) {
			return this.getWindowById(window.id);
		}

		return undefined;
	}

	/**
	 * 获取最后一个活动窗口。
	 * @returns 最后一个活动窗口或 undefined
	 */
	getLastActiveWindow(): ICodeWindow | undefined {
		return this.doGetLastActiveWindow(this.getWindows());
	}

	/**
	 * 获取指定远程授权下的最后一个活动窗口。
	 * @param remoteAuthority 远程授权
	 * @returns 最后一个活动窗口或 undefined
	 */
	private getLastActiveWindowForAuthority(remoteAuthority: string | undefined): ICodeWindow | undefined {
		return this.doGetLastActiveWindow(this.getWindows().filter(window => isEqualAuthority(window.remoteAuthority, remoteAuthority)));
	}

	/**
	 * 获取窗口列表中的最后一个活动窗口。
	 * @param windows 窗口列表
	 * @returns 最后一个活动窗口或 undefined
	 */
	private doGetLastActiveWindow(windows: ICodeWindow[]): ICodeWindow | undefined {
		return getLastFocused(windows);
	}

	/**
	 * 向聚焦窗口发送消息。
	 * @param channel 通道名
	 * @param args 参数
	 */
	sendToFocused(channel: string, ...args: any[]): void {
		const focusedWindow = this.getFocusedWindow() || this.getLastActiveWindow();

		focusedWindow?.sendWhenReady(channel, CancellationToken.None, ...args);
	}

	/**
	 * 向即将打开的窗口发送消息。
	 * @param channel 通道名
	 * @param args 参数
	 */
	sendToOpeningWindow(channel: string, ...args: any[]): void {
		this._register(Event.once(this.onDidSignalReadyWindow)(window => {
			window.sendWhenReady(channel, CancellationToken.None, ...args);
		}));
	}

	/**
	 * 向所有窗口发送消息。
	 * @param channel 通道名
	 * @param payload 负载
	 * @param windowIdsToIgnore 忽略的窗口 ID
	 */
	sendToAll(channel: string, payload?: any, windowIdsToIgnore?: number[]): void {
		for (const window of this.getWindows()) {
			if (windowIdsToIgnore && windowIdsToIgnore.indexOf(window.id) >= 0) {
				continue; // do not send if we are instructed to ignore it
			}

			window.sendWhenReady(channel, CancellationToken.None, payload);
		}
	}

	/**
	 * 获取所有窗口。
	 * @returns 窗口数组
	 */
	getWindows(): ICodeWindow[] {
		return Array.from(this.windows.values());
	}

	/**
	 * 获取窗口数量。
	 * @returns 窗口数量
	 */
	getWindowCount(): number {
		return this.windows.size;
	}

	/**
	 * 通过窗口 ID 获取窗口。
	 * @param windowId 窗口 ID
	 * @returns 窗口或 undefined
	 */
	getWindowById(windowId: number): ICodeWindow | undefined {
		return this.windows.get(windowId);
	}

	/**
	 * 通过 WebContents 获取窗口。
	 * @param webContents WebContents 对象
	 * @returns 窗口或 undefined
	 */
	getWindowByWebContents(webContents: WebContents): ICodeWindow | undefined {
		const browserWindow = BrowserWindow.fromWebContents(webContents);
		if (!browserWindow) {
			return undefined;
		}

		const window = this.getWindowById(browserWindow.id);

		return window?.matches(webContents) ? window : undefined;
	}
}
