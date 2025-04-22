/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. 保留所有权利。
 *  根据 MIT 许可证授权。有关详细信息，请参阅项目根目录中的 License.txt。
 *--------------------------------------------------------------------------------------------*/

import { homedir, tmpdir } from 'os';
import { NativeParsedArgs } from '../common/argv.js';
import { IDebugParams } from '../common/environment.js';
import { AbstractNativeEnvironmentService, parseDebugParams } from '../common/environmentService.js';
import { getUserDataPath } from './userDataPath.js';
import { IProductService } from '../../product/common/productService.js';

/**
 * 原生环境服务类 EnvironmentService，
 *
 * 这个类继承自AbstractNativeEnvironmentService，用于提供VS Code的环境配置服务。
 * 它负责管理应用程序的各种路径和环境设置，如获取当前启动目录，日志目录，操作系统信息，配置文件目录，用户目录等。
 */
export class NativeEnvironmentService extends AbstractNativeEnvironmentService {

	/**
	 * 构造函数
	 *
	 * @param args 命令行参数对象，包含用户启动VS Code时提供的各种选项
	 * @param productService 产品服务，提供关于当前VS Code产品的信息
	 */
	constructor(args: NativeParsedArgs, productService: IProductService) {
		super(args, {
			homeDir: homedir(),  // 获取用户主目录
			tmpDir: tmpdir(),    // 获取系统临时目录
			userDataDir: getUserDataPath(args, productService.nameShort)  // 获取用户数据目录路径
		}, productService);
	}
}

/**
 * 解析PTY主机调试端口
 *
 * 这个函数用于解析命令行参数中与PTY主机调试相关的选项，并返回调试参数。
 * PTY（伪终端）主机是VS Code中处理终端会话的组件。
 *
 * @param args 命令行参数对象
 * @param isBuilt 是否为构建版本
 * @returns 调试参数对象
 */
export function parsePtyHostDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-ptyhost'], args['inspect-brk-ptyhost'], 5877, isBuilt, args.extensionEnvironment);
}

/**
 * 解析共享进程调试端口
 *
 * 这个函数用于解析命令行参数中与共享进程调试相关的选项，并返回调试参数。
 * 共享进程是VS Code中用于运行扩展的进程。
 *
 * @param args 命令行参数对象
 * @param isBuilt 是否为构建版本
 * @returns 调试参数对象
 */
export function parseSharedProcessDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-sharedprocess'], args['inspect-brk-sharedprocess'], 5879, isBuilt, args.extensionEnvironment);
}
