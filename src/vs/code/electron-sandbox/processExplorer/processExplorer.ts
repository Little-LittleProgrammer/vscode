/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * ProcessExplorer 入口文件
 *
 * ProcessExplorer 是 VSCode 的进程管理工具页面，用于显示和监控 VSCode 相关的所有进程信息。
 * 主要功能：
 * 1. 显示所有 VSCode 相关进程的详细信息（PID、CPU使用率、内存使用情况等）
 * 2. 提供进程管理功能（结束进程、生成内存转储等）
 * 3. 展示进程树结构（主进程、渲染进程、扩展主机进程、语言服务器进程等）
 *
 * 这个文件是 ProcessExplorer 的启动脚本，负责初始化窗口并加载主模块。
 */
(async function () {

	type IBootstrapWindow = import('../../../platform/window/electron-sandbox/window.js').IBootstrapWindow;
	type IProcessExplorerMain = import('./processExplorerMain.js').IProcessExplorerMain;
	type ProcessExplorerWindowConfiguration = import('../../../platform/process/common/process.js').ProcessExplorerWindowConfiguration;

	// 获取引导窗口对象，由 bootstrap-window.ts 定义
	const bootstrapWindow: IBootstrapWindow = (window as any).MonacoBootstrapWindow;

	// 加载 ProcessExplorer 主模块并获取配置
	const { result, configuration } = await bootstrapWindow.load<IProcessExplorerMain, ProcessExplorerWindowConfiguration>('vs/code/electron-sandbox/processExplorer/processExplorerMain', {
		configureDeveloperSettings: function () {
			return {
				// 强制启用开发者快捷键，方便调试
				forceEnableDeveloperKeybindings: true
			};
		},
	});

	// 启动 ProcessExplorer
	result.startup(configuration);
}());
