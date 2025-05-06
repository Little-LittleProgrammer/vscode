/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IpcMainEvent, MessagePortMain } from 'electron';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { Barrier, DeferredPromise } from '../../../base/common/async.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { ISharedProcessConfiguration } from '../node/sharedProcess.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';
import { IPolicyService } from '../../policy/common/policy.js';
import { ILoggerMainService } from '../../log/electron-main/loggerService.js';
import { UtilityProcess } from '../../utilityProcess/electron-main/utilityProcess.js';
import { NullTelemetryService } from '../../telemetry/common/telemetryUtils.js';
import { parseSharedProcessDebugPort } from '../../environment/node/environmentService.js';
import { assertIsDefined } from '../../../base/common/types.js';
import { SharedProcessChannelConnection, SharedProcessRawConnection, SharedProcessLifecycle } from '../common/sharedProcess.js';
import { Emitter } from '../../../base/common/event.js';

/**
 * 共享进程管理类
 *
 * 原理：共享进程(SharedProcess)是VSCode多进程架构中的重要组成部分，用于托管多个窗口共享的服务，
 * 如搜索、扩展管理等。此类在主进程中运行，负责：
 * 1. 创建和管理共享进程实例(通过UtilityProcess)
 * 	 - 使用 UtilityProcess 类来创建和管理共享进程实例
 * 	 - 不论打开多少 VSCode 窗口，某些服务(如扩展管理、搜索)只需在单个共享进程中运行一次，大大减少了内存占用。
 * 2. 处理渲染进程(窗口)到共享进程的连接请求
 * 3. 建立IPC通信通道，实现渲染进程与共享服务的通信
 * 	 - 使用 Electron 的 MessagePort 进行高性能进程间通信
 * 	 - 通过命名通道(Channel)来区分不同服务的通信
 * 	 - 支持两种连接模式：通道连接和原始连接
 * 4. 管理共享进程的生命周期(启动、就绪、关闭)
 * 	 - 使用 Barrier 和 Promise 机制协调启动过程
 * 	 - 分阶段就绪：IPC就绪和完全就绪
 * 	 - 在应用关闭时负责清理共享进程资源
 *
 * 共享进程的设计目的是减少资源消耗，确保无论打开多少VSCode窗口，
 * 某些服务(如扩展管理、搜索)只需在单个进程中运行一次。
 */
export class SharedProcess extends Disposable {

	private readonly firstWindowConnectionBarrier = new Barrier();

	private utilityProcess: UtilityProcess | undefined = undefined;
	private utilityProcessLogListener: IDisposable | undefined = undefined;

	private readonly _onDidCrash = this._register(new Emitter<void>());
	readonly onDidCrash = this._onDidCrash.event;

	constructor(
		private readonly machineId: string,
		private readonly sqmId: string,
		private readonly devDeviceId: string,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
		@ILoggerMainService private readonly loggerMainService: ILoggerMainService,
		@IPolicyService private readonly policyService: IPolicyService
	) {
		super();

		this.registerListeners();
	}

	/**
	 * 注册监听器，处理窗口连接请求和应用程序关闭事件
	 */
	private registerListeners(): void {

		// 处理来自工作台窗口的共享进程通道连接请求
		validatedIpcMain.on(SharedProcessChannelConnection.request, (e, nonce: string) => this.onWindowConnection(e, nonce, SharedProcessChannelConnection.response));

		// 处理来自工作台窗口的共享进程原始连接请求
		validatedIpcMain.on(SharedProcessRawConnection.request, (e, nonce: string) => this.onWindowConnection(e, nonce, SharedProcessRawConnection.response));

		// 生命周期事件监听
		this._register(this.lifecycleMainService.onWillShutdown(() => this.onWillShutdown()));
	}

	/**
	 * 处理窗口连接请求
	 *
	 * @param e IPC事件对象
	 * @param nonce 用于安全验证的一次性令牌
	 * @param responseChannel 响应通道名称
	 */
	private async onWindowConnection(e: IpcMainEvent, nonce: string, responseChannel: string): Promise<void> {
		this.logService.trace(`[SharedProcess] onWindowConnection for: ${responseChannel}`);

		// 如果这是第一个窗口连接，打开屏障
		if (!this.firstWindowConnectionBarrier.isOpen()) {
			this.firstWindowConnectionBarrier.open();
		}

		// 等待共享进程完全就绪
		// 我们不只是等待IPC就绪，因为工作台窗口
		// 将直接与共享进程通信

		await this.whenReady();

		// 连接到共享进程，传递responseChannel
		// 作为有效载荷，提示连接的用途

		const port = await this.connect(responseChannel);

		// 检查请求窗口是否已关闭
		// 由于共享进程启动时会有延迟，存在
		// 窗口在共享进程准备好连接前关闭的可能

		if (e.sender.isDestroyed()) {
			return port.close();
		}

		// 将端口发送回请求窗口
		e.sender.postMessage(responseChannel, nonce, [port]);
	}

	/**
	 * 处理应用程序关闭事件
	 */
	private onWillShutdown(): void {
		this.logService.trace('[SharedProcess] onWillShutdown');

		this.utilityProcess?.postMessage(SharedProcessLifecycle.exit);
		this.utilityProcess = undefined;
	}

	private _whenReady: Promise<void> | undefined = undefined;
	/**
	 * 返回表示共享进程完全就绪的Promise
	 */
	whenReady(): Promise<void> {
		if (!this._whenReady) {
			this._whenReady = (async () => {

				// 等待共享进程准备好接受连接
				await this.whenIpcReady;

				// 整体信号表明共享进程已加载
				// 且所有服务都已创建完成

				const whenReady = new DeferredPromise<void>();
				this.utilityProcess?.once(SharedProcessLifecycle.initDone, () => whenReady.complete());

				await whenReady.p;
				this.utilityProcessLogListener?.dispose();
				this.logService.trace('[SharedProcess] Overall ready');
			})();
		}

		return this._whenReady;
	}

	private _whenIpcReady: Promise<void> | undefined = undefined;
	/**
	 * 返回表示共享进程IPC就绪的Promise
	 */
	private get whenIpcReady() {
		if (!this._whenIpcReady) {
			this._whenIpcReady = (async () => {
				// 等待第一个窗口请求连接
				await this.firstWindowConnectionBarrier.wait();

				// 启动共享进程
				this.createUtilityProcess();

				// 等待进程准备好接受IPC连接
				const sharedProcessIpcReady = new DeferredPromise<void>();
				this.utilityProcess?.once(SharedProcessLifecycle.ipcReady, () => sharedProcessIpcReady.complete());

				await sharedProcessIpcReady.p;
			})();
		}

		return this._whenIpcReady;
	}

	/**
	 * 创建共享进程的实用程序进程
	 */
	private createUtilityProcess(): void {
		this.utilityProcess = this._register(new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService));

		// 安装日志监听器，用于捕获共享进程的早期警告和错误
		this.utilityProcessLogListener = this.utilityProcess.onMessage((e: any) => {
			if (typeof e.warning === 'string') {
				this.logService.warn(e.warning);
			} else if (typeof e.error === 'string') {
				this.logService.error(e.error);
			}
		});

		// 处理调试参数
		const inspectParams = parseSharedProcessDebugPort(this.environmentMainService.args, this.environmentMainService.isBuilt);
		let execArgv: string[] | undefined = undefined;
		if (inspectParams.port) {
			execArgv = ['--nolazy'];
			if (inspectParams.break) {
				execArgv.push(`--inspect-brk=${inspectParams.port}`);
			} else {
				execArgv.push(`--inspect=${inspectParams.port}`);
			}
		}

		// 启动共享进程
		this.utilityProcess.start({
			type: 'shared-process',
			entryPoint: 'vs/code/electron-utility/sharedProcess/sharedProcessMain',
			payload: this.createSharedProcessConfiguration(),
			respondToAuthRequestsFromMainProcess: true,
			execArgv
		});

		// 监听崩溃事件
		this._register(this.utilityProcess.onCrash(() => this._onDidCrash.fire()));
	}

	/**
	 * 创建共享进程配置
	 */
	private createSharedProcessConfiguration(): ISharedProcessConfiguration {
		return {
			machineId: this.machineId,
			sqmId: this.sqmId,
			devDeviceId: this.devDeviceId,
			codeCachePath: this.environmentMainService.codeCachePath,
			profiles: {
				home: this.userDataProfilesService.profilesHome,
				all: this.userDataProfilesService.profiles,
			},
			args: this.environmentMainService.args,
			logLevel: this.loggerMainService.getLogLevel(),
			loggers: this.loggerMainService.getGlobalLoggers(),
			policiesData: this.policyService.serialize()
		};
	}

	/**
	 * 连接到共享进程并返回消息端口
	 *
	 * @param payload 可选的连接有效载荷
	 * @returns 通信用的消息端口
	 */
	async connect(payload?: unknown): Promise<MessagePortMain> {

		// 等待共享进程准备好接受连接
		await this.whenIpcReady;

		// 连接并返回消息端口
		const utilityProcess = assertIsDefined(this.utilityProcess);
		return utilityProcess.connect(payload);
	}
}
