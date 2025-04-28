/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 【instantiationService】 实例化服务，负责创建和管理所有服务实例
 */
import { GlobalIdleValue } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { illegalState } from '../../../base/common/errors.js';
import { DisposableStore, dispose, IDisposable, isDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { SyncDescriptor, SyncDescriptor0 } from './descriptors.js';
import { Graph } from './graph.js';
import { GetLeadingNonServiceArgs, IInstantiationService, ServiceIdentifier, ServicesAccessor, _util } from './instantiation.js';
import { ServiceCollection } from './serviceCollection.js';
import { LinkedList } from '../../../base/common/linkedList.js';

// TRACING
const _enableAllTracing = false
	// || "TRUE" // DO NOT CHECK IN!
	;

class CyclicDependencyError extends Error {
	constructor(graph: Graph<any>) {
		super('cyclic dependency between services');
		this.message = graph.findCycleSlow() ?? `UNABLE to detect cycle, dumping graph: \n${graph.toString()}`;
	}
}

/**
 * 实例化服务
 *
 * 主要目的是实现 VSCode 依赖注入（DI）框架的核心实例化服务，负责创建、管理和销毁所有服务实例，并处理服务之间的依赖关系。它是 VSCode 平台中服务注册与实例化的关键基础设施
 */
export class InstantiationService implements IInstantiationService {

	declare readonly _serviceBrand: undefined;

	readonly _globalGraph?: Graph<string>;
	private _globalGraphImplicitDependency?: string;

	private _isDisposed = false;
	private readonly _servicesToMaybeDispose = new Set<any>();
	private readonly _children = new Set<InstantiationService>();

	/**
	 * 构造函数，初始化实例化服务。
	 * @param _services 服务集合，默认为新的空集合。
	 * @param _strict 是否启用严格模式，默认为 false。
	 * @param _parent 父实例化服务，可选。
	 * @param _enableTracing 是否启用跟踪，默认为全局跟踪设置。
	 */
	constructor(
		private readonly _services: ServiceCollection = new ServiceCollection(),
		private readonly _strict: boolean = false,
		private readonly _parent?: InstantiationService,
		private readonly _enableTracing: boolean = _enableAllTracing
	) {

		this._services.set(IInstantiationService, this);
		this._globalGraph = _enableTracing ? _parent?._globalGraph ?? new Graph(e => e) : undefined;
	}

	/**
	 * 销毁此实例化服务实例及其创建的服务和子服务。
	 */
	dispose(): void {
		if (!this._isDisposed) {
			this._isDisposed = true;
			// dispose all child services
			dispose(this._children);
			this._children.clear();

			// dispose all services created by this service
			for (const candidate of this._servicesToMaybeDispose) {
				if (isDisposable(candidate)) {
					candidate.dispose();
				}
			}
			this._servicesToMaybeDispose.clear();
		}
	}

	/**
	 * 如果服务已被销毁，则抛出错误。
	 */
	private _throwIfDisposed(): void {
		if (this._isDisposed) {
			throw new Error('InstantiationService has been disposed');
		}
	}

	/**
	 * 创建一个子实例化服务。
	 * @param services 要添加到子服务的服务集合。
	 * @param store 可选的 DisposableStore 用于管理子服务的生命周期。
	 * @returns 新的子实例化服务实例。
	 */
	createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService {
		this._throwIfDisposed();

		const that = this;
		const result = new class extends InstantiationService {
			override dispose(): void {
				that._children.delete(result);
				super.dispose();
			}
		}(services, this._strict, this, this._enableTracing);
		this._children.add(result);

		store?.add(result);
		return result;
	}

	/**
	 * 使用服务访问器调用一个函数。
	 * @param fn 要调用的函数，第一个参数是服务访问器。
	 * @param args 传递给函数的其他参数。
	 * @returns 函数的返回值。
	 */
	invokeFunction<R, TS extends any[] = []>(fn: (accessor: ServicesAccessor, ...args: TS) => R, ...args: TS): R {
		this._throwIfDisposed();

		const _trace = Trace.traceInvocation(this._enableTracing, fn);
		let _done = false;
		try {
			const accessor: ServicesAccessor = {
				get: <T>(id: ServiceIdentifier<T>) => {

					if (_done) {
						throw illegalState('service accessor is only valid during the invocation of its target method');
					}

					const result = this._getOrCreateServiceInstance(id, _trace);
					if (!result) {
						throw new Error(`[invokeFunction] unknown service '${id}'`);
					}
					return result;
				}
			};
			return fn(accessor, ...args);
		} finally {
			_done = true;
			_trace.stop();
		}
	}

	/**
	 * 同步创建一个由描述符或构造函数指定的实例。
	 * @param ctorOrDescriptor 构造函数或同步描述符。
	 * @param rest 传递给构造函数的静态参数。
	 * @returns 创建的实例。
	 */
	createInstance<T>(descriptor: SyncDescriptor0<T>): T;
	createInstance<Ctor extends new (...args: any[]) => unknown, R extends InstanceType<Ctor>>(ctor: Ctor, ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>): R;
	createInstance(ctorOrDescriptor: any | SyncDescriptor<any>, ...rest: any[]): unknown {
		this._throwIfDisposed();

		let _trace: Trace;
		let result: any;
		if (ctorOrDescriptor instanceof SyncDescriptor) {
			_trace = Trace.traceCreation(this._enableTracing, ctorOrDescriptor.ctor);
			result = this._createInstance(ctorOrDescriptor.ctor, ctorOrDescriptor.staticArguments.concat(rest), _trace);
		} else {
			_trace = Trace.traceCreation(this._enableTracing, ctorOrDescriptor);
			result = this._createInstance(ctorOrDescriptor, rest, _trace);
		}
		_trace.stop();
		return result;
	}

	/**
	 * 内部方法，实际执行实例创建逻辑。
	 * @param ctor 构造函数。
	 * @param args 传递给构造函数的参数（包括静态参数和服务参数）。
	 * @param _trace 跟踪对象。
	 * @returns 创建的实例。
	 */
	private _createInstance<T>(ctor: any, args: any[] = [], _trace: Trace): T {

		// arguments defined by service decorators
		const serviceDependencies = _util.getServiceDependencies(ctor).sort((a, b) => a.index - b.index);
		const serviceArgs: any[] = [];
		for (const dependency of serviceDependencies) {
			const service = this._getOrCreateServiceInstance(dependency.id, _trace);
			if (!service) {
				this._throwIfStrict(`[createInstance] ${ctor.name} depends on UNKNOWN service ${dependency.id}.`, false);
			}
			serviceArgs.push(service);
		}

		const firstServiceArgPos = serviceDependencies.length > 0 ? serviceDependencies[0].index : args.length;

		// check for argument mismatches, adjust static args if needed
		if (args.length !== firstServiceArgPos) {
			console.trace(`[createInstance] First service dependency of ${ctor.name} at position ${firstServiceArgPos + 1} conflicts with ${args.length} static arguments`);

			const delta = firstServiceArgPos - args.length;
			if (delta > 0) {
				args = args.concat(new Array(delta));
			} else {
				args = args.slice(0, firstServiceArgPos);
			}
		}

		// now create the instance
		return Reflect.construct<any, T>(ctor, args.concat(serviceArgs));
	}

	/**
	 * 将已创建的服务实例设置回服务集合中（覆盖描述符）。
	 * @param id 服务标识符。
	 * @param instance 服务实例。
	 */
	private _setCreatedServiceInstance<T>(id: ServiceIdentifier<T>, instance: T): void {
		if (this._services.get(id) instanceof SyncDescriptor) {
			this._services.set(id, instance);
		} else if (this._parent) {
			this._parent._setCreatedServiceInstance(id, instance);
		} else {
			throw new Error('illegalState - setting UNKNOWN service instance');
		}
	}

	/**
	 * 获取服务实例或其描述符。会向上查找父服务。
	 * @param id 服务标识符。
	 * @returns 服务实例或同步描述符。
	 */
	private _getServiceInstanceOrDescriptor<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> {
		const instanceOrDesc = this._services.get(id);
		if (!instanceOrDesc && this._parent) {
			return this._parent._getServiceInstanceOrDescriptor(id);
		} else {
			return instanceOrDesc;
		}
	}

	/**
	 * 获取或创建服务实例。如果服务尚未创建，则创建并缓存它。
	 * @param id 服务标识符。
	 * @param _trace 跟踪对象。
	 * @returns 服务实例。
	 */
	protected _getOrCreateServiceInstance<T>(id: ServiceIdentifier<T>, _trace: Trace): T {
		if (this._globalGraph && this._globalGraphImplicitDependency) {
			this._globalGraph.insertEdge(this._globalGraphImplicitDependency, String(id));
		}
		const thing = this._getServiceInstanceOrDescriptor(id);
		if (thing instanceof SyncDescriptor) {
			return this._safeCreateAndCacheServiceInstance(id, thing, _trace.branch(id, true));
		} else {
			_trace.branch(id, false);
			return thing;
		}
	}

	private readonly _activeInstantiations = new Set<ServiceIdentifier<any>>();


	/**
	 * 安全地创建并缓存服务实例，防止循环依赖期间的递归实例化。
	 * @param id 服务标识符。
	 * @param desc 同步描述符。
	 * @param _trace 跟踪对象。
	 * @returns 创建的服务实例。
	 */
	private _safeCreateAndCacheServiceInstance<T>(id: ServiceIdentifier<T>, desc: SyncDescriptor<T>, _trace: Trace): T {
		if (this._activeInstantiations.has(id)) {
			throw new Error(`illegal state - RECURSIVELY instantiating service '${id}'`);
		}
		this._activeInstantiations.add(id);
		try {
			return this._createAndCacheServiceInstance(id, desc, _trace);
		} finally {
			this._activeInstantiations.delete(id);
		}
	}

	/**
	 * 创建并缓存服务实例，处理依赖关系图和循环依赖检测。
	 * @param id 服务标识符。
	 * @param desc 同步描述符。
	 * @param _trace 跟踪对象。
	 * @returns 创建的服务实例。
	 */
	private _createAndCacheServiceInstance<T>(id: ServiceIdentifier<T>, desc: SyncDescriptor<T>, _trace: Trace): T {

		type Triple = { id: ServiceIdentifier<any>; desc: SyncDescriptor<any>; _trace: Trace };
		const graph = new Graph<Triple>(data => data.id.toString());

		let cycleCount = 0;
		const stack = [{ id, desc, _trace }];
		const seen = new Set<string>();
		while (stack.length) {
			const item = stack.pop()!;

			if (seen.has(String(item.id))) {
				continue;
			}
			seen.add(String(item.id));

			graph.lookupOrInsertNode(item);

			// a weak but working heuristic for cycle checks
			if (cycleCount++ > 1000) {
				throw new CyclicDependencyError(graph);
			}

			// check all dependencies for existence and if they need to be created first
			for (const dependency of _util.getServiceDependencies(item.desc.ctor)) {

				const instanceOrDesc = this._getServiceInstanceOrDescriptor(dependency.id);
				if (!instanceOrDesc) {
					this._throwIfStrict(`[createInstance] ${id} depends on ${dependency.id} which is NOT registered.`, true);
				}

				// take note of all service dependencies
				this._globalGraph?.insertEdge(String(item.id), String(dependency.id));

				if (instanceOrDesc instanceof SyncDescriptor) {
					const d = { id: dependency.id, desc: instanceOrDesc, _trace: item._trace.branch(dependency.id, true) };
					graph.insertEdge(item, d);
					stack.push(d);
				}
			}
		}

		while (true) {
			const roots = graph.roots();

			// if there is no more roots but still
			// nodes in the graph we have a cycle
			if (roots.length === 0) {
				if (!graph.isEmpty()) {
					throw new CyclicDependencyError(graph);
				}
				break;
			}

			for (const { data } of roots) {
				// Repeat the check for this still being a service sync descriptor. That's because
				// instantiating a dependency might have side-effect and recursively trigger instantiation
				// so that some dependencies are now fullfilled already.
				const instanceOrDesc = this._getServiceInstanceOrDescriptor(data.id);
				if (instanceOrDesc instanceof SyncDescriptor) {
					// create instance and overwrite the service collections
					const instance = this._createServiceInstanceWithOwner(data.id, data.desc.ctor, data.desc.staticArguments, data.desc.supportsDelayedInstantiation, data._trace);
					this._setCreatedServiceInstance(data.id, instance);
				}
				graph.removeNode(data);
			}
		}
		return <T>this._getServiceInstanceOrDescriptor(id);
	}

	/**
	 * 创建服务实例，并确定其所有者（即哪个 InstantiationService 负责管理其生命周期）。
	 * @param id 服务标识符。
	 * @param ctor 构造函数。
	 * @param args 静态参数。
	 * @param supportsDelayedInstantiation 是否支持延迟实例化。
	 * @param _trace 跟踪对象。
	 * @returns 创建的服务实例。
	 */
	private _createServiceInstanceWithOwner<T>(id: ServiceIdentifier<T>, ctor: any, args: any[] = [], supportsDelayedInstantiation: boolean, _trace: Trace): T {
		if (this._services.get(id) instanceof SyncDescriptor) {
			return this._createServiceInstance(id, ctor, args, supportsDelayedInstantiation, _trace, this._servicesToMaybeDispose);
		} else if (this._parent) {
			return this._parent._createServiceInstanceWithOwner(id, ctor, args, supportsDelayedInstantiation, _trace);
		} else {
			throw new Error(`illegalState - creating UNKNOWN service instance ${ctor.name}`);
		}
	}

	/**
	 * 内部方法，创建服务实例，支持立即或延迟实例化。
	 * @param id 服务标识符。
	 * @param ctor 构造函数。
	 * @param args 静态参数。
	 * @param supportsDelayedInstantiation 是否支持延迟实例化。
	 * @param _trace 跟踪对象。
	 * @param disposeBucket 用于存储需要销毁的实例的集合。
	 * @returns 创建的服务实例（可能是代理对象）。
	 */
	private _createServiceInstance<T>(id: ServiceIdentifier<T>, ctor: any, args: any[] = [], supportsDelayedInstantiation: boolean, _trace: Trace, disposeBucket: Set<any>): T {
		if (!supportsDelayedInstantiation) {
			// eager instantiation
			const result = this._createInstance<T>(ctor, args, _trace);
			disposeBucket.add(result);
			return result;

		} else {
			const child = new InstantiationService(undefined, this._strict, this, this._enableTracing);
			child._globalGraphImplicitDependency = String(id);

			type EaryListenerData = {
				listener: Parameters<Event<any>>;
				disposable?: IDisposable;
			};

			// Return a proxy object that's backed by an idle value. That
			// strategy is to instantiate services in our idle time or when actually
			// needed but not when injected into a consumer

			// return "empty events" when the service isn't instantiated yet
			const earlyListeners = new Map<string, LinkedList<EaryListenerData>>();

			const idle = new GlobalIdleValue<any>(() => {
				const result = child._createInstance<T>(ctor, args, _trace);

				// early listeners that we kept are now being subscribed to
				// the real service
				for (const [key, values] of earlyListeners) {
					const candidate = <Event<any>>(<any>result)[key];
					if (typeof candidate === 'function') {
						for (const value of values) {
							value.disposable = candidate.apply(result, value.listener);
						}
					}
				}
				earlyListeners.clear();
				disposeBucket.add(result);
				return result;
			});
			return <T>new Proxy(Object.create(null), {
				get(target: any, key: PropertyKey): unknown {

					if (!idle.isInitialized) {
						// looks like an event
						if (typeof key === 'string' && (key.startsWith('onDid') || key.startsWith('onWill'))) {
							let list = earlyListeners.get(key);
							if (!list) {
								list = new LinkedList();
								earlyListeners.set(key, list);
							}
							const event: Event<any> = (callback, thisArg, disposables) => {
								if (idle.isInitialized) {
									return idle.value[key](callback, thisArg, disposables);
								} else {
									const entry: EaryListenerData = { listener: [callback, thisArg, disposables], disposable: undefined };
									const rm = list.push(entry);
									const result = toDisposable(() => {
										rm();
										entry.disposable?.dispose();
									});
									return result;
								}
							};
							return event;
						}
					}

					// value already exists
					if (key in target) {
						return target[key];
					}

					// create value
					const obj = idle.value;
					let prop = obj[key];
					if (typeof prop !== 'function') {
						return prop;
					}
					prop = prop.bind(obj);
					target[key] = prop;
					return prop;
				},
				set(_target: T, p: PropertyKey, value: any): boolean {
					idle.value[p] = value;
					return true;
				},
				getPrototypeOf(_target: T) {
					return ctor.prototype;
				}
			});
		}
	}

	/**
	 * 根据是否处于严格模式决定是抛出错误还是仅打印警告。
	 * @param msg 错误或警告信息。
	 * @param printWarning 是否打印警告。
	 */
	private _throwIfStrict(msg: string, printWarning: boolean): void {
		if (printWarning) {
			console.warn(msg);
		}
		if (this._strict) {
			throw new Error(msg);
		}
	}
}

//#region -- tracing ---

const enum TraceType {
	None = 0,
	Creation = 1,
	Invocation = 2,
	Branch = 3,
}

export class Trace {

	static all = new Set<string>();

	private static readonly _None = new class extends Trace {
		/**
		 * Trace 类的构造函数 (空实现)。
		 */
		constructor() { super(TraceType.None, null); }
		/**
		 * 停止跟踪 (空实现)。
		 */
		override stop() { }
		/**
		 * 创建分支跟踪 (返回自身)。
		 */
		override branch() { return this; }
	};

	/**
	 * 创建一个用于跟踪函数调用的 Trace 实例。
	 * @param _enableTracing 是否启用跟踪。
	 * @param ctor 构造函数或函数。
	 * @returns Trace 实例或 Trace._None。
	 */
	static traceInvocation(_enableTracing: boolean, ctor: any): Trace {
		return !_enableTracing ? Trace._None : new Trace(TraceType.Invocation, ctor.name || new Error().stack!.split('\n').slice(3, 4).join('\n'));
	}

	/**
	 * 创建一个用于跟踪实例创建的 Trace 实例。
	 * @param _enableTracing 是否启用跟踪。
	 * @param ctor 构造函数。
	 * @returns Trace 实例或 Trace._None。
	 */
	static traceCreation(_enableTracing: boolean, ctor: any): Trace {
		return !_enableTracing ? Trace._None : new Trace(TraceType.Creation, ctor.name);
	}

	private static _totals: number = 0;
	private readonly _start: number = Date.now();
	private readonly _dep: [ServiceIdentifier<any>, boolean, Trace?][] = [];

	/**
	 * Trace 类的私有构造函数。
	 * @param type 跟踪类型。
	 * @param name 跟踪名称。
	 */
	private constructor(
		readonly type: TraceType,
		readonly name: string | null
	) { }

	/**
	 * 创建一个分支跟踪。
	 * @param id 服务标识符。
	 * @param first 是否是首次创建。
	 * @returns 新的 Trace 实例（分支）。
	 */
	branch(id: ServiceIdentifier<any>, first: boolean): Trace {
		const child = new Trace(TraceType.Branch, id.toString());
		this._dep.push([id, first, child]);
		return child;
	}

	/**
	 * 停止当前跟踪并记录信息。
	 */
	stop() {
		const dur = Date.now() - this._start;
		Trace._totals += dur;

		let causedCreation = false;

		function printChild(n: number, trace: Trace) {
			const res: string[] = [];
			const prefix = new Array(n + 1).join('\t');
			for (const [id, first, child] of trace._dep) {
				if (first && child) {
					causedCreation = true;
					res.push(`${prefix}CREATES -> ${id}`);
					const nested = printChild(n + 1, child);
					if (nested) {
						res.push(nested);
					}
				} else {
					res.push(`${prefix}uses -> ${id}`);
				}
			}
			return res.join('\n');
		}

		const lines = [
			`${this.type === TraceType.Creation ? 'CREATE' : 'CALL'} ${this.name}`,
			`${printChild(1, this)}`,
			`DONE, took ${dur.toFixed(2)}ms (grand total ${Trace._totals.toFixed(2)}ms)`
		];

		if (dur > 2 || causedCreation) {
			Trace.all.add(lines.join('\n'));
		}
	}
}

//#endregion
