/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 注册实例化服务
 *
 * 用于描述一个类及其静态参数，并决定是否支持延迟实例化。
 * @param T 类型
 */
export class SyncDescriptor<T> {

	readonly ctor: any;
	readonly staticArguments: any[];
	readonly supportsDelayedInstantiation: boolean;

	constructor(ctor: new (...args: any[]) => T, staticArguments: any[] = [], supportsDelayedInstantiation: boolean = false) {
		this.ctor = ctor;
		this.staticArguments = staticArguments;
		this.supportsDelayedInstantiation = supportsDelayedInstantiation;
	}
}

export interface SyncDescriptor0<T> {
	readonly ctor: new () => T;
}
