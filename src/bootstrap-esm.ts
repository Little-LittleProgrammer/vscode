/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire, register } from 'node:module';
import { product, pkg } from './bootstrap-meta.js';
import './bootstrap-node.js';
import * as performance from './vs/base/common/performance.js';
import { INLSConfiguration } from './vs/nls.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 安装一个模块解析钩子，将 'fs' 映射到 'original-fs'
if (process.env['ELECTRON_RUN_AS_NODE'] || process.versions['electron']) {
	const jsCode = `
	export async function resolve(specifier, context, nextResolve) {
		if (specifier === 'fs') {
			return {
				format: 'builtin',
				shortCircuit: true,
				url: 'node:original-fs'
			};
		}

		// 委托给链中的下一个钩子，如果这是最后一个用户指定的加载器，
		// 则将是 Node.js 的默认解析。
		return nextResolve(specifier, context);
	}`;
	register(`data:text/javascript;base64,${Buffer.from(jsCode).toString('base64')}`, import.meta.url);
}

// 准备运行所需的全局变量
globalThis._VSCODE_PRODUCT_JSON = { ...product };
if (process.env['VSCODE_DEV']) {
	try {
		const overrides: unknown = require('../product.overrides.json');
		globalThis._VSCODE_PRODUCT_JSON = Object.assign(globalThis._VSCODE_PRODUCT_JSON, overrides);
	} catch (error) { /* 忽略 */ }
}
globalThis._VSCODE_PACKAGE_JSON = { ...pkg };
globalThis._VSCODE_FILE_ROOT = __dirname;

//#region NLS helpers

let setupNLSResult: Promise<INLSConfiguration | undefined> | undefined = undefined;

function setupNLS(): Promise<INLSConfiguration | undefined> {
	if (!setupNLSResult) {
		setupNLSResult = doSetupNLS();
	}

	return setupNLSResult;
}

async function doSetupNLS(): Promise<INLSConfiguration | undefined> {
	performance.mark('code/willLoadNls');

	let nlsConfig: INLSConfiguration | undefined = undefined;

	let messagesFile: string | undefined;
	if (process.env['VSCODE_NLS_CONFIG']) {
		try {
			nlsConfig = JSON.parse(process.env['VSCODE_NLS_CONFIG']);
			if (nlsConfig?.languagePack?.messagesFile) {
				messagesFile = nlsConfig.languagePack.messagesFile;
			} else if (nlsConfig?.defaultMessagesFile) {
				messagesFile = nlsConfig.defaultMessagesFile;
			}

			globalThis._VSCODE_NLS_LANGUAGE = nlsConfig?.resolvedLanguage;
		} catch (e) {
			console.error(`Error reading VSCODE_NLS_CONFIG from environment: ${e}`);
		}
	}

	if (
		process.env['VSCODE_DEV'] ||	// 开发模式下不支持 NLS
		!messagesFile					// 没有 NLS 消息文件
	) {
		return undefined;
	}

	try {
		globalThis._VSCODE_NLS_MESSAGES = JSON.parse((await fs.promises.readFile(messagesFile)).toString());
	} catch (error) {
		console.error(`Error reading NLS messages file ${messagesFile}: ${error}`);

		// 标记为已损坏：这将在下次启动时重新创建语言包缓存
		if (nlsConfig?.languagePack?.corruptMarkerFile) {
			try {
				await fs.promises.writeFile(nlsConfig.languagePack.corruptMarkerFile, 'corrupted');
			} catch (error) {
				console.error(`Error writing corrupted NLS marker file: ${error}`);
			}
		}

		// 回退到默认消息文件以确保至少有英文翻译
		if (nlsConfig?.defaultMessagesFile && nlsConfig.defaultMessagesFile !== messagesFile) {
			try {
				globalThis._VSCODE_NLS_MESSAGES = JSON.parse((await fs.promises.readFile(nlsConfig.defaultMessagesFile)).toString());
			} catch (error) {
				console.error(`Error reading default NLS messages file ${nlsConfig.defaultMessagesFile}: ${error}`);
			}
		}
	}

	performance.mark('code/didLoadNls');

	return nlsConfig;
}

//#endregion

export async function bootstrapESM(): Promise<void> {

	// NLS
	await setupNLS();
}
