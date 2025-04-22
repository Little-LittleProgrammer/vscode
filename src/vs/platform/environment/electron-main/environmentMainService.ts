/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { memoize } from '../../../base/common/decorators.js';
import { join } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { createStaticIPCHandle } from '../../../base/parts/ipc/node/ipc.net.js';
import { IEnvironmentService, INativeEnvironmentService } from '../common/environment.js';
import { NativeEnvironmentService } from '../node/environmentService.js';
import { refineServiceDecorator } from '../../instantiation/common/instantiation.js';

export const IEnvironmentMainService = refineServiceDecorator<IEnvironmentService, IEnvironmentMainService>(IEnvironmentService);

/**
 * A subclass of the `INativeEnvironmentService` to be used only in electron-main
 * environments.
 */
export interface IEnvironmentMainService extends INativeEnvironmentService {

	// --- backup paths
	readonly backupHome: string;

	// --- V8 code caching
	readonly codeCachePath: string | undefined;
	readonly useCodeCache: boolean;

	// --- IPC
	readonly mainIPCHandle: string;
	readonly mainLockfile: string;

	// --- config
	readonly disableUpdates: boolean;

	unsetSnapExportedVariables(): void;
	restoreSnapExportedVariables(): void;
}

export class EnvironmentMainService extends NativeEnvironmentService implements IEnvironmentMainService {

	private _snapEnv: Record<string, string> = {};

	/**
	 * 获取备份主目录路径
	 *
	 * 这个属性使用@memoize装饰器进行缓存，避免重复计算
	 * 返回用户数据路径下的'Backups'目录路径
	 *
	 * @returns {string} 备份主目录路径
	 */
	@memoize
	get backupHome(): string { return join(this.userDataPath, 'Backups'); }

	@memoize
	get mainIPCHandle(): string { return createStaticIPCHandle(this.userDataPath, 'main', this.productService.version); }

	@memoize
	get mainLockfile(): string { return join(this.userDataPath, 'code.lock'); }

	/**
	 * 获取是否禁用更新的标志
	 *
	 * 这个属性使用@memoize装饰器进行缓存，避免重复计算
	 * 当命令行参数中包含'disable-updates'选项时，返回true表示禁用更新
	 * 否则返回false表示允许更新
	 *
	 * @returns {boolean} 如果禁用更新则返回true，否则返回false
	 */
	@memoize
	get disableUpdates(): boolean { return !!this.args['disable-updates']; }

	@memoize
	get crossOriginIsolated(): boolean { return !!this.args['enable-coi']; }

	@memoize
	get codeCachePath(): string | undefined { return process.env['VSCODE_CODE_CACHE_PATH'] || undefined; }

	@memoize
	get useCodeCache(): boolean { return !!this.codeCachePath; }

	unsetSnapExportedVariables() {
		if (!isLinux) {
			return;
		}
		for (const key in process.env) {
			if (key.endsWith('_VSCODE_SNAP_ORIG')) {
				const originalKey = key.slice(0, -17); // Remove the _VSCODE_SNAP_ORIG suffix
				if (this._snapEnv[originalKey]) {
					continue;
				}
				// Preserve the original value in case the snap env is re-entered
				if (process.env[originalKey]) {
					this._snapEnv[originalKey] = process.env[originalKey]!;
				}
				// Copy the original value from before entering the snap env if available,
				// if not delete the env variable.
				if (process.env[key]) {
					process.env[originalKey] = process.env[key];
				} else {
					delete process.env[originalKey];
				}
			}
		}
	}

	restoreSnapExportedVariables() {
		if (!isLinux) {
			return;
		}
		for (const key in this._snapEnv) {
			process.env[key] = this._snapEnv[key];
			delete this._snapEnv[key];
		}
	}
}
