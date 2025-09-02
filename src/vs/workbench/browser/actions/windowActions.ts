/*---------------------------------------------------------------------------------------------
 *  版权所有 (c) Microsoft Corporation。保留所有权利。
 *  根据 MIT 许可证获得许可。有关详细信息，请参阅项目根目录下的 License.txt。
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { IWindowOpenable } from '../../../platform/window/common/window.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { MenuRegistry, MenuId, Action2, registerAction2, IAction2Options } from '../../../platform/actions/common/actions.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { IsMainWindowFullscreenContext } from '../../common/contextkeys.js';
import { IsMacNativeContext, IsDevelopmentContext, IsWebContext, IsIOSContext } from '../../../platform/contextkey/common/contextkeys.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputButton, IQuickInputService, IQuickPickSeparator, IKeyMods, IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, IWorkspaceIdentifier } from '../../../platform/workspace/common/workspace.js';
import { ILabelService, Verbosity } from '../../../platform/label/common/label.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { IRecent, isRecentFolder, isRecentWorkspace, IWorkspacesService } from '../../../platform/workspaces/common/workspaces.js';
import { URI } from '../../../base/common/uri.js';
import { getIconClasses } from '../../../editor/common/services/getIconClasses.js';
import { FileKind } from '../../../platform/files/common/files.js';
import { splitRecentLabel } from '../../../base/common/labels.js';
import { isMacintosh, isWeb, isWindows } from '../../../base/common/platform.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { inQuickPickContext, getQuickNavigateHandler } from '../quickaccess.js';
import { IHostService } from '../../services/host/browser/host.js';
import { ResourceMap } from '../../../base/common/map.js';
import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { isFolderBackupInfo, isWorkspaceBackupInfo } from '../../../platform/backup/common/backup.js';
import { getActiveElement, getActiveWindow, isHTMLElement } from '../../../base/browser/dom.js';

export const inRecentFilesPickerContextKey = 'inRecentFilesPicker';

interface IRecentlyOpenedPick extends IQuickPickItem {
	resource: URI;
	openable: IWindowOpenable;
	remoteAuthority: string | undefined;
}

abstract class BaseOpenRecentAction extends Action2 {

	private readonly removeFromRecentlyOpened: IQuickInputButton = {
		iconClass: ThemeIcon.asClassName(Codicon.removeClose),
		tooltip: localize('remove', "Remove from Recently Opened")
	};

	private readonly dirtyRecentlyOpenedFolder: IQuickInputButton = {
		iconClass: 'dirty-workspace ' + ThemeIcon.asClassName(Codicon.closeDirty),
		tooltip: localize('dirtyRecentlyOpenedFolder', "Folder With Unsaved Files"),
		alwaysVisible: true
	};

	private readonly dirtyRecentlyOpenedWorkspace: IQuickInputButton = {
		...this.dirtyRecentlyOpenedFolder,
		tooltip: localize('dirtyRecentlyOpenedWorkspace', "Workspace With Unsaved Files"),
	};

	constructor(desc: Readonly<IAction2Options>) {
		super(desc);
	}

	protected abstract isQuickNavigate(): boolean;

	override async run(accessor: ServicesAccessor): Promise<void> {
		const workspacesService = accessor.get(IWorkspacesService);
		const quickInputService = accessor.get(IQuickInputService);
		const contextService = accessor.get(IWorkspaceContextService);
		const labelService = accessor.get(ILabelService);
		const keybindingService = accessor.get(IKeybindingService);
		const modelService = accessor.get(IModelService);
		const languageService = accessor.get(ILanguageService);
		const hostService = accessor.get(IHostService);
		const dialogService = accessor.get(IDialogService);

		const recentlyOpened = await workspacesService.getRecentlyOpened();
		const dirtyWorkspacesAndFolders = await workspacesService.getDirtyWorkspaces();

		let hasWorkspaces = false;

		// 标识所有包含未保存文件的文件夹和工作区
		const dirtyFolders = new ResourceMap<boolean>();
		const dirtyWorkspaces = new ResourceMap<IWorkspaceIdentifier>();
		for (const dirtyWorkspace of dirtyWorkspacesAndFolders) {
			if (isFolderBackupInfo(dirtyWorkspace)) {
				dirtyFolders.set(dirtyWorkspace.folderUri, true);
			} else {
				dirtyWorkspaces.set(dirtyWorkspace.workspace.configPath, dirtyWorkspace.workspace);
				hasWorkspaces = true;
			}
		}

		// 标识所有最近打开的文件夹和工作区
		const recentFolders = new ResourceMap<boolean>();
		const recentWorkspaces = new ResourceMap<IWorkspaceIdentifier>();
		for (const recent of recentlyOpened.workspaces) {
			if (isRecentFolder(recent)) {
				recentFolders.set(recent.folderUri, true);
			} else {
				recentWorkspaces.set(recent.workspace.configPath, recent.workspace);
				hasWorkspaces = true;
			}
		}

		// 填充所有已知的最近打开的工作区
		const workspacePicks: IRecentlyOpenedPick[] = [];
		for (const recent of recentlyOpened.workspaces) {
			const isDirty = isRecentFolder(recent) ? dirtyFolders.has(recent.folderUri) : dirtyWorkspaces.has(recent.workspace.configPath);

			workspacePicks.push(this.toQuickPick(modelService, languageService, labelService, recent, isDirty));
		}

		// 在末尾补充任何尚未显示的备份工作区
		for (const dirtyWorkspaceOrFolder of dirtyWorkspacesAndFolders) {
			if (isFolderBackupInfo(dirtyWorkspaceOrFolder) && !recentFolders.has(dirtyWorkspaceOrFolder.folderUri)) {
				workspacePicks.push(this.toQuickPick(modelService, languageService, labelService, dirtyWorkspaceOrFolder, true));
			} else if (isWorkspaceBackupInfo(dirtyWorkspaceOrFolder) && !recentWorkspaces.has(dirtyWorkspaceOrFolder.workspace.configPath)) {
				workspacePicks.push(this.toQuickPick(modelService, languageService, labelService, dirtyWorkspaceOrFolder, true));
			}
		}

		const filePicks = recentlyOpened.files.map(p => this.toQuickPick(modelService, languageService, labelService, p, false));

		// 如果第一个最近的工作区是当前工作区，则聚焦第二个条目
		const firstEntry = recentlyOpened.workspaces[0];
		const autoFocusSecondEntry: boolean = firstEntry && contextService.isCurrentWorkspace(isRecentWorkspace(firstEntry) ? firstEntry.workspace : firstEntry.folderUri);

		let keyMods: IKeyMods | undefined;

		const workspaceSeparator: IQuickPickSeparator = { type: 'separator', label: hasWorkspaces ? localize('workspacesAndFolders', "folders & workspaces") : localize('folders', "folders") };
		const fileSeparator: IQuickPickSeparator = { type: 'separator', label: localize('files', "files") };
		const picks = [workspaceSeparator, ...workspacePicks, fileSeparator, ...filePicks];

		const pick = await quickInputService.pick(picks, {
			contextKey: inRecentFilesPickerContextKey,
			activeItem: [...workspacePicks, ...filePicks][autoFocusSecondEntry ? 1 : 0],
			placeHolder: isMacintosh ? localize('openRecentPlaceholderMac', "Select to open (hold Cmd-key to force new window or Option-key for same window)") : localize('openRecentPlaceholder', "Select to open (hold Ctrl-key to force new window or Alt-key for same window)"),
			matchOnDescription: true,
			onKeyMods: mods => keyMods = mods,
			quickNavigate: this.isQuickNavigate() ? { keybindings: keybindingService.lookupKeybindings(this.desc.id) } : undefined,
			hideInput: this.isQuickNavigate(),
			onDidTriggerItemButton: async context => {

				// 移除
				if (context.button === this.removeFromRecentlyOpened) {
					await workspacesService.removeRecentlyOpened([context.item.resource]);
					context.removeItem();
				}

				// 脏文件夹/工作区
				else if (context.button === this.dirtyRecentlyOpenedFolder || context.button === this.dirtyRecentlyOpenedWorkspace) {
					const isDirtyWorkspace = context.button === this.dirtyRecentlyOpenedWorkspace;
					const { confirmed } = await dialogService.confirm({
						title: isDirtyWorkspace ? localize('dirtyWorkspace', "Workspace with Unsaved Files") : localize('dirtyFolder', "Folder with Unsaved Files"),
						message: isDirtyWorkspace ? localize('dirtyWorkspaceConfirm', "Do you want to open the workspace to review the unsaved files?") : localize('dirtyFolderConfirm', "Do you want to open the folder to review the unsaved files?"),
						detail: isDirtyWorkspace ? localize('dirtyWorkspaceConfirmDetail', "Workspaces with unsaved files cannot be removed until all unsaved files have been saved or reverted.") : localize('dirtyFolderConfirmDetail', "Folders with unsaved files cannot be removed until all unsaved files have been saved or reverted.")
					});

					if (confirmed) {
						hostService.openWindow(
							[context.item.openable], {
							remoteAuthority: context.item.remoteAuthority || null // 如果 remoteAuthority 未设置或无法从 openable 推断，则为本地窗口
						});
						quickInputService.cancel();
					}
				}
			}
		});

		if (pick) {
			return hostService.openWindow([pick.openable], {
				forceNewWindow: keyMods?.ctrlCmd,
				forceReuseWindow: keyMods?.alt,
				remoteAuthority: pick.remoteAuthority || null // 如果 remoteAuthority 未设置或无法从 openable 推断，则为本地窗口
			});
		}
	}

	private toQuickPick(modelService: IModelService, languageService: ILanguageService, labelService: ILabelService, recent: IRecent, isDirty: boolean): IRecentlyOpenedPick {
		let openable: IWindowOpenable | undefined;
		let iconClasses: string[];
		let fullLabel: string | undefined;
		let resource: URI | undefined;
		let isWorkspace = false;

		// 文件夹
		if (isRecentFolder(recent)) {
			resource = recent.folderUri;
			iconClasses = getIconClasses(modelService, languageService, resource, FileKind.FOLDER);
			openable = { folderUri: resource };
			fullLabel = recent.label || labelService.getWorkspaceLabel(resource, { verbose: Verbosity.LONG });
		}

		// 工作区
		else if (isRecentWorkspace(recent)) {
			resource = recent.workspace.configPath;
			iconClasses = getIconClasses(modelService, languageService, resource, FileKind.ROOT_FOLDER);
			openable = { workspaceUri: resource };
			fullLabel = recent.label || labelService.getWorkspaceLabel(recent.workspace, { verbose: Verbosity.LONG });
			isWorkspace = true;
		}

		// 文件
		else {
			resource = recent.fileUri;
			iconClasses = getIconClasses(modelService, languageService, resource, FileKind.FILE);
			openable = { fileUri: resource };
			fullLabel = recent.label || labelService.getUriLabel(resource, { appendWorkspaceSuffix: true });
		}

		const { name, parentPath } = splitRecentLabel(fullLabel);

		return {
			iconClasses,
			label: name,
			ariaLabel: isDirty ? isWorkspace ? localize('recentDirtyWorkspaceAriaLabel', "{0}, workspace with unsaved changes", name) : localize('recentDirtyFolderAriaLabel', "{0}, folder with unsaved changes", name) : name,
			description: parentPath,
			buttons: isDirty ? [isWorkspace ? this.dirtyRecentlyOpenedWorkspace : this.dirtyRecentlyOpenedFolder] : [this.removeFromRecentlyOpened],
			openable,
			resource,
			remoteAuthority: recent.remoteAuthority
		};
	}
}

export class OpenRecentAction extends BaseOpenRecentAction {

	static ID = 'workbench.action.openRecent';

	constructor() {
		super({
			id: OpenRecentAction.ID,
			title: {
				...localize2('openRecent', "Open Recent..."),
				mnemonicTitle: localize({ key: 'miMore', comment: ['&& denotes a mnemonic'] }, "&&More..."),
			},
			category: Categories.File,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyR,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyR }
			},
			menu: {
				id: MenuId.MenubarRecentMenu,
				group: 'y_more',
				order: 1
			}
		});
	}

	protected isQuickNavigate(): boolean {
		return false;
	}
}

class QuickPickRecentAction extends BaseOpenRecentAction {

	constructor() {
		super({
			id: 'workbench.action.quickOpenRecent',
			title: localize2('quickOpenRecent', 'Quick Open Recent...'),
			category: Categories.File,
			f1: false // 从命令面板隐藏快速选择器，以免与显示输入字段的其他条目混淆
		});
	}

	protected isQuickNavigate(): boolean {
		return true;
	}
}

class ToggleFullScreenAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.toggleFullScreen',
			title: {
				...localize2('toggleFullScreen', "Toggle Full Screen"),
				mnemonicTitle: localize({ key: 'miToggleFullScreen', comment: ['&& denotes a mnemonic'] }, "&&Full Screen"),
			},
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.F11,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyF
				}
			},
			precondition: IsIOSContext.toNegated(),
			toggled: IsMainWindowFullscreenContext,
			menu: [{
				id: MenuId.MenubarAppearanceMenu,
				group: '1_toggle_view',
				order: 1
			}]
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IHostService);

		return hostService.toggleFullScreen(getActiveWindow());
	}
}

export class ReloadWindowAction extends Action2 {

	static readonly ID = 'workbench.action.reloadWindow';

	constructor() {
		super({
			id: ReloadWindowAction.ID,
			title: localize2('reloadWindow', 'Reload Window'),
			category: Categories.Developer,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: IsDevelopmentContext,
				primary: KeyMod.CtrlCmd | KeyCode.KeyR
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IHostService);

		return hostService.reload();
	}
}

class ShowAboutDialogAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.showAboutDialog',
			title: {
				...localize2('about', "About"),
				mnemonicTitle: localize({ key: 'miAbout', comment: ['&& denotes a mnemonic'] }, "&&About"),
			},
			category: Categories.Help,
			f1: true,
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: 'z_about',
				order: 1,
				when: IsMacNativeContext.toNegated()
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);

		return dialogService.about();
	}
}

class NewWindowAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.newWindow',
			title: {
				...localize2('newWindow', "New Window"),
				mnemonicTitle: localize({ key: 'miNewWindow', comment: ['&& denotes a mnemonic'] }, "New &&Window"),
			},
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: isWeb ? (isWindows ? KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Shift | KeyCode.KeyN) : KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyN) : KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
				secondary: isWeb ? [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN] : undefined
			},
			menu: {
				id: MenuId.MenubarFileMenu,
				group: '1_new',
				order: 3
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const hostService = accessor.get(IHostService);

		return hostService.openWindow({ remoteAuthority: null });
	}
}

class BlurAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.blur',
			title: localize2('blur', 'Remove keyboard focus from focused element')
		});
	}

	run(): void {
		const activeElement = getActiveElement();
		if (isHTMLElement(activeElement)) {
			activeElement.blur();
		}
	}
}

// --- Actions Registration
// --- 动作注册

registerAction2(NewWindowAction);
registerAction2(ToggleFullScreenAction);
registerAction2(QuickPickRecentAction);
registerAction2(OpenRecentAction);
registerAction2(ReloadWindowAction);
registerAction2(ShowAboutDialogAction);
registerAction2(BlurAction);

// --- Commands/Keybindings Registration
// --- 命令/快捷键注册

const recentFilesPickerContext = ContextKeyExpr.and(inQuickPickContext, ContextKeyExpr.has(inRecentFilesPickerContextKey));

const quickPickNavigateNextInRecentFilesPickerId = 'workbench.action.quickOpenNavigateNextInRecentFilesPicker';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: quickPickNavigateNextInRecentFilesPickerId,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(quickPickNavigateNextInRecentFilesPickerId, true),
	when: recentFilesPickerContext,
	primary: KeyMod.CtrlCmd | KeyCode.KeyR,
	mac: { primary: KeyMod.WinCtrl | KeyCode.KeyR }
});

const quickPickNavigatePreviousInRecentFilesPicker = 'workbench.action.quickOpenNavigatePreviousInRecentFilesPicker';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: quickPickNavigatePreviousInRecentFilesPicker,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(quickPickNavigatePreviousInRecentFilesPicker, false),
	when: recentFilesPickerContext,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyR }
});

CommandsRegistry.registerCommand('workbench.action.toggleConfirmBeforeClose', accessor => {
	const configurationService = accessor.get(IConfigurationService);
	const setting = configurationService.inspect<'always' | 'keyboardOnly' | 'never'>('window.confirmBeforeClose').userValue;

	return configurationService.updateValue('window.confirmBeforeClose', setting === 'never' ? 'keyboardOnly' : 'never');
});

// --- Menu Registration
// --- 菜单注册

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	group: 'z_ConfirmClose',
	command: {
		id: 'workbench.action.toggleConfirmBeforeClose',
		title: localize('miConfirmClose', "Confirm Before Close"),
		toggled: ContextKeyExpr.notEquals('config.window.confirmBeforeClose', 'never')
	},
	order: 1,
	when: IsWebContext
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	title: localize({ key: 'miOpenRecent', comment: ['&& denotes a mnemonic'] }, "Open &&Recent"),
	submenu: MenuId.MenubarRecentMenu,
	group: '2_open',
	order: 4
});
