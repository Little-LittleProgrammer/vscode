/*---------------------------------------------------------------------------------------------
 *  版权所有 (c) Microsoft Corporation。保留所有权利。
 *  根据 MIT 许可证授权。有关许可证信息，请参见项目根目录中的 License.txt。
 *--------------------------------------------------------------------------------------------*/

// *********************************************************************
// *                                                                   *
// *  我们需要这个文件来重定向到远程文件夹中的 node_modules。          *
// *  这仅在从源代码运行时适用。                                        *
// *                                                                   *
// *********************************************************************

import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises } from 'node:fs';
import { join } from 'node:path';

// 参见 https://nodejs.org/docs/latest/api/module.html#initialize

const _specifierToUrl: Record<string, string> = {};

export async function initialize(injectPath: string): Promise<void> {
	// 填充映射

	const injectPackageJSONPath = fileURLToPath(new URL('../package.json', pathToFileURL(injectPath)));
	const packageJSON = JSON.parse(String(await promises.readFile(injectPackageJSONPath)));

	for (const [name] of Object.entries(packageJSON.dependencies)) {
		try {
			const path = join(injectPackageJSONPath, `../node_modules/${name}/package.json`);
			let { main } = JSON.parse(String(await promises.readFile(path)));

			if (!main) {
				main = 'index.js';
			}
			if (!main.endsWith('.js')) {
				main += '.js';
			}
			const mainPath = join(injectPackageJSONPath, `../node_modules/${name}/${main}`);
			_specifierToUrl[name] = pathToFileURL(mainPath).href;

		} catch (err) {
			console.error(name);
			console.error(err);
		}
	}

	console.log(`[bootstrap-import] 已为以下路径初始化 node_modules 重定向器: ${injectPath}`);
}

export async function resolve(specifier: string | number, context: any, nextResolve: (arg0: any, arg1: any) => any) {

	const newSpecifier = _specifierToUrl[specifier];
	if (newSpecifier !== undefined) {
		return {
			format: 'commonjs',
			shortCircuit: true,
			url: newSpecifier
		};
	}

	// 延迟到链中的下一个钩子，如果这是最后一个用户指定的加载器，那将是 Node.js 默认的解析器。
	return nextResolve(specifier, context);
}
