/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { ITelemetryData } from '../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFolder, hasWorkspaceFileExtension } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../services/workspaces/common/workspaceEditing.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ADD_ROOT_FOLDER_COMMAND_ID, ADD_ROOT_FOLDER_LABEL, PICK_WORKSPACE_FOLDER_COMMAND_ID, SET_ROOT_FOLDER_COMMAND_ID } from './workspaceCommands.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { MenuRegistry, MenuId, Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { EmptyWorkspaceSupportContext, EnterMultiRootWorkspaceSupportContext, OpenFolderWorkspaceSupportContext, WorkbenchStateContext, WorkspaceFolderCountContext } from '../../common/contextkeys.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IHostService } from '../../services/host/browser/host.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { IWorkspacesService } from '../../../platform/workspaces/common/workspaces.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsMacNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import { ILocalizedString } from '../../../platform/action/common/action.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';

const workspacesCategory: ILocalizedString = localize2('workspaces', 'Workspaces');

export class OpenFileAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFile';

	constructor() {
		super({
			id: OpenFileAction.ID,
			title: localize2('openFile', 'Open File...'),
			category: Categories.File,
			f1: true,
			keybinding: {
				when: IsMacNativeContext.toNegated(),
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFileAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

export class OpenFolderAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFolder';

	constructor() {
		super({
			id: OpenFolderAction.ID,
			title: localize2('openFolder', 'Open Folder...'),
			category: Categories.File,
			f1: true,
			precondition: OpenFolderWorkspaceSupportContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: undefined,
				linux: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyO)
				},
				win: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyO)
				}
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFolderAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

export class OpenFolderViaWorkspaceAction extends Action2 {

	// This action swaps the folders of a workspace with
	// the selected folder and is a workaround for providing
	// "Open Folder..." in environments that do not support
	// this without having a workspace open (e.g. web serverless)

	static readonly ID = 'workbench.action.files.openFolderViaWorkspace';

	constructor() {
		super({
			id: OpenFolderViaWorkspaceAction.ID,
			title: localize2('openFolder', 'Open Folder...'),
			category: Categories.File,
			f1: true,
			precondition: ContextKeyExpr.and(OpenFolderWorkspaceSupportContext.toNegated(), WorkbenchStateContext.isEqualTo('workspace')),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		return commandService.executeCommand(SET_ROOT_FOLDER_COMMAND_ID);
	}
}

export class OpenFileFolderAction extends Action2 {

	static readonly ID = 'workbench.action.files.openFileFolder';
	static readonly LABEL: ILocalizedString = localize2('openFileFolder', 'Open...');

	constructor() {
		super({
			id: OpenFileFolderAction.ID,
			title: OpenFileFolderAction.LABEL,
			category: Categories.File,
			f1: true,
			precondition: ContextKeyExpr.and(IsMacNativeContext, OpenFolderWorkspaceSupportContext),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO
			}
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickFileFolderAndOpen({ forceNewWindow: false, telemetryExtraData: data });
	}
}

class OpenWorkspaceAction extends Action2 {

	static readonly ID = 'workbench.action.openWorkspace';

	constructor() {
		super({
			id: OpenWorkspaceAction.ID,
			title: localize2('openWorkspaceAction', 'Open Workspace from File...'),
			category: Categories.File,
			f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext
		});
	}

	override async run(accessor: ServicesAccessor, data?: ITelemetryData): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);

		return fileDialogService.pickWorkspaceAndOpen({ telemetryExtraData: data });
	}
}

class CloseWorkspaceAction extends Action2 {

	static readonly ID = 'workbench.action.closeFolder';

	constructor() {
		super({
			id: CloseWorkspaceAction.ID,
			title: localize2('closeWorkspace', 'Close Workspace'),
			category: workspacesCategory,
			f1: true,
			precondition: ContextKeyExpr.and(WorkbenchStateContext.notEqualsTo('empty'), EmptyWorkspaceSupportContext),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyF)
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IHostService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);

		return hostService.openWindow({ forceReuseWindow: true, remoteAuthority: environmentService.remoteAuthority });
	}
}

class OpenWorkspaceConfigFileAction extends Action2 {

	static readonly ID = 'workbench.action.openWorkspaceConfigFile';

	constructor() {
		super({
			id: OpenWorkspaceConfigFileAction.ID,
			title: localize2('openWorkspaceConfigFile', 'Open Workspace Configuration File'),
			category: workspacesCategory,
			f1: true,
			precondition: WorkbenchStateContext.isEqualTo('workspace')
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const contextService = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);

		const configuration = contextService.getWorkspace().configuration;
		if (configuration) {
			await editorService.openEditor({ resource: configuration, options: { pinned: true } });
		}
	}
}

export class AddRootFolderAction extends Action2 {

	static readonly ID = 'workbench.action.addRootFolder';

	constructor() {
		super({
			id: AddRootFolderAction.ID,
			title: ADD_ROOT_FOLDER_LABEL,
			category: workspacesCategory,
			f1: true,
			precondition: ContextKeyExpr.or(EnterMultiRootWorkspaceSupportContext, WorkbenchStateContext.isEqualTo('workspace'))
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		return commandService.executeCommand(ADD_ROOT_FOLDER_COMMAND_ID);
	}
}

export class RemoveRootFolderAction extends Action2 {

	static readonly ID = 'workbench.action.removeRootFolder';

	constructor() {
		super({
			id: RemoveRootFolderAction.ID,
			title: localize2('globalRemoveFolderFromWorkspace', 'Remove Folder from Workspace...'),
			category: workspacesCategory,
			f1: true,
			precondition: ContextKeyExpr.and(WorkspaceFolderCountContext.notEqualsTo('0'), ContextKeyExpr.or(EnterMultiRootWorkspaceSupportContext, WorkbenchStateContext.isEqualTo('workspace')))
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);

		const folder = await commandService.executeCommand<IWorkspaceFolder>(PICK_WORKSPACE_FOLDER_COMMAND_ID);
		if (folder) {
			await workspaceEditingService.removeFolders([folder.uri]);
		}
	}
}

class SaveWorkspaceAsAction extends Action2 {

	static readonly ID = 'workbench.action.saveWorkspaceAs';

	constructor() {
		super({
			id: SaveWorkspaceAsAction.ID,
			title: localize2('saveWorkspaceAsAction', 'Save Workspace As...'),
			category: workspacesCategory,
			f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);
		const contextService = accessor.get(IWorkspaceContextService);

		const configPathUri = await workspaceEditingService.pickNewWorkspacePath();
		if (configPathUri && hasWorkspaceFileExtension(configPathUri)) {
			switch (contextService.getWorkbenchState()) {
				case WorkbenchState.EMPTY:
				case WorkbenchState.FOLDER: {
					const folders = contextService.getWorkspace().folders.map(folder => ({ uri: folder.uri }));
					return workspaceEditingService.createAndEnterWorkspace(folders, configPathUri);
				}
				case WorkbenchState.WORKSPACE:
					return workspaceEditingService.saveAndEnterWorkspace(configPathUri);
			}
		}
	}
}

class DuplicateWorkspaceInNewWindowAction extends Action2 {

	static readonly ID = 'workbench.action.duplicateWorkspaceInNewWindow';

	constructor() {
		super({
			id: DuplicateWorkspaceInNewWindowAction.ID,
			title: localize2('duplicateWorkspaceInNewWindow', 'Duplicate As Workspace in New Window'),
			category: workspacesCategory,
			f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);
		const hostService = accessor.get(IHostService);
		const workspacesService = accessor.get(IWorkspacesService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);

		const folders = workspaceContextService.getWorkspace().folders;
		const remoteAuthority = environmentService.remoteAuthority;

		const newWorkspace = await workspacesService.createUntitledWorkspace(folders, remoteAuthority);
		await workspaceEditingService.copyWorkspaceSettings(newWorkspace);

		return hostService.openWindow([{ workspaceUri: newWorkspace.configPath }], { forceNewWindow: true, remoteAuthority });
	}
}

// --- Actions Registration

/**
 * 工作区操作注册
 *
 * VSCode 的工作区系统是其核心功能之一，它允许用户：
 * 1. 组织相关项目：将多个相关项目文件夹组合到一个工作区中
 * 2. 工作区特定设置：为特定项目组合定义专用设置，不影响全局设置
 * 3. 工作区任务：定义特定于工作区的任务，如构建、测试等
 * 4. 扩展推荐：为特定工作区推荐相关扩展
 * 5. 项目共享：通过共享 .code-workspace 文件，团队成员可以使用相同的工作环境
 */

// 允许用户向当前工作区添加一个新的根文件夹
// 对应命令面板中的"添加文件夹到工作区..."选项
registerAction2(AddRootFolderAction);

// 允许用户从当前工作区中移除一个根文件夹
// 不会删除磁盘上的文件夹，只是从当前工作区中移除
registerAction2(RemoveRootFolderAction);

// 打开文件选择对话框，允许用户选择并打开一个文件
// 通常对应"文件 > 打开文件..."菜单项
registerAction2(OpenFileAction);

// 打开文件夹选择对话框，允许用户选择并打开一个文件夹
// 通常对应"文件 > 打开文件夹..."菜单项
// 打开的文件夹会替换当前窗口中的内容
registerAction2(OpenFolderAction);

// 类似于 OpenFolderAction，但有特定的工作区相关处理
registerAction2(OpenFolderViaWorkspaceAction);

// 在某些平台上（如 macOS）合并了打开文件和打开文件夹的功能
// 允许用户在同一对话框中选择打开文件或文件夹
registerAction2(OpenFileFolderAction);

// 打开工作区文件选择对话框，允许用户选择并打开一个 .code-workspace 文件
// 通常对应"文件 > 打开工作区..."菜单项
registerAction2(OpenWorkspaceAction);

// 打开当前工作区的配置文件（.code-workspace）进行编辑
// 允许用户直接修改工作区设置、启动任务、推荐扩展等
registerAction2(OpenWorkspaceConfigFileAction);

// 关闭当前工作区，回到空窗口状态
// 通常对应"文件 > 关闭工作区"菜单项
registerAction2(CloseWorkspaceAction);

// 允许用户将当前工作区保存为 .code-workspace 文件
// 对于多根工作区特别有用，可以保存当前的文件夹组合
registerAction2(SaveWorkspaceAsAction);

// 在新窗口中打开当前工作区的副本
// 允许用户在不同窗口中处理相同的工作区内容
registerAction2(DuplicateWorkspaceInNewWindowAction);

// --- Menu Registration

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFileAction.ID,
		title: localize({ key: 'miOpenFile', comment: ['&& denotes a mnemonic'] }, "&&Open File...")
	},
	order: 1,
	when: IsMacNativeContext.toNegated()
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFolderAction.ID,
		title: localize({ key: 'miOpenFolder', comment: ['&& denotes a mnemonic'] }, "Open &&Folder...")
	},
	order: 2,
	when: OpenFolderWorkspaceSupportContext
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFolderViaWorkspaceAction.ID,
		title: localize({ key: 'miOpenFolder', comment: ['&& denotes a mnemonic'] }, "Open &&Folder...")
	},
	order: 2,
	when: ContextKeyExpr.and(OpenFolderWorkspaceSupportContext.toNegated(), WorkbenchStateContext.isEqualTo('workspace'))
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenFileFolderAction.ID,
		title: localize({ key: 'miOpen', comment: ['&& denotes a mnemonic'] }, "&&Open...")
	},
	order: 1,
	when: ContextKeyExpr.and(IsMacNativeContext, OpenFolderWorkspaceSupportContext)
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '2_open',
	command: {
		id: OpenWorkspaceAction.ID,
		title: localize({ key: 'miOpenWorkspace', comment: ['&& denotes a mnemonic'] }, "Open Wor&&kspace from File...")
	},
	order: 3,
	when: EnterMultiRootWorkspaceSupportContext
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '3_workspace',
	command: {
		id: ADD_ROOT_FOLDER_COMMAND_ID,
		title: localize({ key: 'miAddFolderToWorkspace', comment: ['&& denotes a mnemonic'] }, "A&&dd Folder to Workspace...")
	},
	when: ContextKeyExpr.or(EnterMultiRootWorkspaceSupportContext, WorkbenchStateContext.isEqualTo('workspace')),
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '3_workspace',
	command: {
		id: SaveWorkspaceAsAction.ID,
		title: localize('miSaveWorkspaceAs', "Save Workspace As...")
	},
	order: 2,
	when: EnterMultiRootWorkspaceSupportContext
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '3_workspace',
	command: {
		id: DuplicateWorkspaceInNewWindowAction.ID,
		title: localize('duplicateWorkspace', "Duplicate Workspace")
	},
	order: 3,
	when: EnterMultiRootWorkspaceSupportContext
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '6_close',
	command: {
		id: CloseWorkspaceAction.ID,
		title: localize({ key: 'miCloseFolder', comment: ['&& denotes a mnemonic'] }, "Close &&Folder")
	},
	order: 3,
	when: ContextKeyExpr.and(WorkbenchStateContext.isEqualTo('folder'), EmptyWorkspaceSupportContext)
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: '6_close',
	command: {
		id: CloseWorkspaceAction.ID,
		title: localize({ key: 'miCloseWorkspace', comment: ['&& denotes a mnemonic'] }, "Close &&Workspace")
	},
	order: 3,
	when: ContextKeyExpr.and(WorkbenchStateContext.isEqualTo('workspace'), EmptyWorkspaceSupportContext)
});
