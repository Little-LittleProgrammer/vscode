/*---------------------------------------------------------------------------------------------
 * 版权所有 (c) Microsoft Corporation。保留所有权利。
 * 根据 MIT 许可证授权。有关详细信息，请参阅项目根目录中的 License.txt。
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import * as descriptors from './descriptors.js';
import { ServiceCollection } from './serviceCollection.js';

// ------ 内部工具 ------

export namespace _util {

	export const serviceIds = new Map<string, ServiceIdentifier<any>>();

	export const DI_TARGET = '$di$target';
	export const DI_DEPENDENCIES = '$di$dependencies';

	export function getServiceDependencies(ctor: any): { id: ServiceIdentifier<any>; index: number }[] {
		return ctor[DI_DEPENDENCIES] || [];
	}
}

// --- 接口定义 ------

export type BrandedService = { _serviceBrand: undefined };

export interface IConstructorSignature<T, Args extends any[] = []> {
	new <Services extends BrandedService[]>(...args: [...Args, ...Services]): T;
}

export interface ServicesAccessor {
	get<T>(id: ServiceIdentifier<T>): T;
}

export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService');

/**
 * 给定一个元组形式的参数列表，尝试将开头的非服务参数提取到它们自己的元组中。
 */
export type GetLeadingNonServiceArgs<TArgs extends any[]> =
	TArgs extends [] ? []
	: TArgs extends [...infer TFirst, BrandedService] ? GetLeadingNonServiceArgs<TFirst>
	: TArgs;

export interface IInstantiationService {

	readonly _serviceBrand: undefined;

	/**
	 * 同步创建一个由描述符指定的实例。
	 */
	createInstance<T>(descriptor: descriptors.SyncDescriptor0<T>): T;
	/**
	 * 同步创建一个由构造函数指定的实例。
	 * @param ctor 构造函数。
	 * @param args 传递给构造函数的非服务参数。
	 */
	createInstance<Ctor extends new (...args: any[]) => unknown, R extends InstanceType<Ctor>>(ctor: Ctor, ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>): R;

	/**
	 * 使用服务访问器调用一个函数。
	 * @param fn 要调用的函数，第一个参数是服务访问器。
	 * @param args 传递给函数的其他参数。
	 */
	invokeFunction<R, TS extends any[] = []>(fn: (accessor: ServicesAccessor, ...args: TS) => R, ...args: TS): R;

	/**
	 * 创建此服务的一个子服务，该子服务继承所有当前服务，并添加/覆盖给定的服务。
	 *
	 * 注意：返回的子服务是 `disposable` 的，不再使用时应被销毁。
	 * 这也将销毁此服务已创建的所有服务。
	 * @param services 要添加或覆盖的服务集合。
	 * @param store 可选的 DisposableStore 用于管理子服务的生命周期。
	 */
	createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService;

	/**
	 * 销毁此实例化服务。
	 *
	 * - 将销毁此实例化服务已创建的所有服务。
	 * - 将销毁其所有子服务，但不会销毁其父服务。
	 * - 不会销毁创建此服务时传入的服务实例。
	 * - 不会销毁此服务已创建的消费者实例。
	 */
	dispose(): void;
}


/**
 * 标识类型为 `T` 的服务。
 */
export interface ServiceIdentifier<T> {
	(...args: any[]): void;
	type: T;
}

function storeServiceDependency(id: Function, target: Function, index: number): void {
	if ((target as any)[_util.DI_TARGET] === target) {
		(target as any)[_util.DI_DEPENDENCIES].push({ id, index });
	} else {
		(target as any)[_util.DI_DEPENDENCIES] = [{ id, index }];
		(target as any)[_util.DI_TARGET] = target;
	}
}

/**
 * 创建 {{ServiceIdentifier}} 的*唯一*有效方法。
 * @param serviceId 服务的唯一字符串标识符。
 */
export function createDecorator<T>(serviceId: string): ServiceIdentifier<T> {

	if (_util.serviceIds.has(serviceId)) {
		return _util.serviceIds.get(serviceId)!;
	}

	const id = <any>function (target: Function, key: string, index: number) {
		if (arguments.length !== 3) {
			throw new Error('@IServiceName-decorator 只能用于装饰参数');
		}
		storeServiceDependency(id, target, index);
	};

	id.toString = () => serviceId;

	_util.serviceIds.set(serviceId, id);
	return id;
}

export function refineServiceDecorator<T1, T extends T1>(serviceIdentifier: ServiceIdentifier<T1>): ServiceIdentifier<T> {
	return <ServiceIdentifier<T>>serviceIdentifier;
}
