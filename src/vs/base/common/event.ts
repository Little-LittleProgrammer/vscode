/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from './cancellation.js';
import { diffSets } from './collections.js';
import { onUnexpectedError } from './errors.js';
import { createSingleCallFunction } from './functional.js';
import { combinedDisposable, Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from './lifecycle.js';
import { LinkedList } from './linkedList.js';
import { IObservable, IObservableWithChange, IObserver } from './observable.js';
import { StopWatch } from './stopwatch.js';
import { MicrotaskDelay } from './symbols.js';


// -----------------------------------------------------------------------------------------------------------------------
// 取消下一行的注释以在具有监听器的发射器被释放时打印警告。这是代码异味的标志。
// -----------------------------------------------------------------------------------------------------------------------
const _enableDisposeWithListenerWarning = false
	// || Boolean("TRUE") // 引起一个linter警告，以便它不能被推送
	;


// -----------------------------------------------------------------------------------------------------------------------
// 取消下一行的注释以在快照事件被重复使用而没有清理时打印警告。
// 参见 https://github.com/microsoft/vscode/issues/142851
// -----------------------------------------------------------------------------------------------------------------------
const _enableSnapshotPotentialLeakWarning = false
	// || Boolean("TRUE") // 引起一个linter警告，以便它不能被推送
	;

/**
 * 一个可以被订阅的具有零个或一个参数的事件。事件本身是一个函数。
 */
export interface Event<T> {
	(listener: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable;
}

/**
 * 事件系统的核心实现：
 * 	- 定义了Event接口和Emitter类，是VSCode发布-订阅模式的基础设施
 * 	- 允许代码在不同模块间进行松耦合的通信
 * 丰富的事件操作符：
* 	- map: 将一种类型的事件映射为另一种类型
* 	- filter: 根据条件过滤事件
* 	- debounce: 对事件进行去抖动处理
* 	- latch: 防止连续重复触发相同事件
* 	- once: 创建只触发一次的事件
* 	- buffer: 缓存事件直到有监听器
* 	- chain: 支持链式函数式编程风格
* 特殊事件发射器：
* 	- AsyncEmitter: 支持异步事件处理
* 	- PauseableEmitter: 可暂停的事件发射器
* 	- DebounceEmitter: 自带去抖动功能的发射器
* 	- MicrotaskEmitter: 将事件延迟到微任务队列
* 	- EventMultiplexer: 多个事件源的聚合器
* 	- Relay: 可动态切换事件源的转发器
* 内存泄漏防护：
* 	- 提供监听器泄漏检测和警告机制
* 	- 通过阈值控制允许的监听器数量
* 	- 当超过阈值时提供详细的堆栈追踪
* 性能监控：
* 	- 通过EventProfiling实现事件性能分析
* 	- 记录事件触发次数、耗时等指标
* 适配器模式：
* 	- fromNodeEventEmitter: 将Node.js事件转为VSCode事件
* 	- fromDOMEventEmitter: 将DOM事件转为VSCode事件
* 	- fromPromise: 将Promise转为事件
* 	- fromObservable: 将Observable模式转为事件
 */
export namespace Event {
	export const None: Event<any> = () => Disposable.None;

	function _addLeakageTraceLogic(options: EmitterOptions) {
		if (_enableSnapshotPotentialLeakWarning) {
			const { onDidAddListener: origListenerDidAdd } = options;
			const stack = Stacktrace.create();
			let count = 0;
			options.onDidAddListener = () => {
				if (++count === 2) {
					console.warn('快照发射器可能被公开使用，应该使用DisposableStore创建。在此处进行快照');
					stack.print();
				}
				origListenerDidAdd?.();
			};
		}
	}

	/**
	 * 给定一个事件，返回另一个事件，该事件通过共享的`setTimeout`对调用进行去抖动并将监听器延迟到后续任务。
	 * 事件被转换为信号(`Event<void>`)以避免由于合并事件而产生额外的对象创建，并尝试防止使用相关的延迟和
	 * 非延迟事件时可能出现的竞态条件。
	 *
	 * 这对于延迟非关键工作（例如，一般UI更新）非常有用，以确保它不会阻塞关键工作
	 * （例如，按键到渲染文本的延迟）。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param disposable 要将新EventEmitter添加到的一个可释放存储。
	 */
	export function defer(event: Event<unknown>, disposable?: DisposableStore): Event<void> {
		return debounce<unknown, void>(event, () => void 0, 0, undefined, true, undefined, disposable);
	}

	/**
	 * 给定一个事件，返回另一个只触发一次的事件。
	 *
	 * @param event 新事件的事件源。
	 */
	export function once<T>(event: Event<T>): Event<T> {
		return (listener, thisArgs = null, disposables?) => {
			// 我们需要这个，以防事件在监听器调用期间触发
			let didFire = false;
			let result: IDisposable | undefined = undefined;
			result = event(e => {
				if (didFire) {
					return;
				} else if (result) {
					result.dispose();
				} else {
					didFire = true;
				}

				return listener.call(thisArgs, e);
			}, null, disposables);

			if (didFire) {
				result.dispose();
			}

			return result;
		};
	}

	/**
	 * 给定一个事件，返回另一个只触发一次，且仅当满足条件时触发的事件。
	 *
	 * @param event 新事件的事件源。
	 */
	export function onceIf<T>(event: Event<T>, condition: (e: T) => boolean): Event<T> {
		return Event.once(Event.filter(event, condition));
	}

	/**
	 * 使用映射函数将一种类型的事件映射为另一种类型的事件，类似于`Array.prototype.map`的工作方式。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param map 映射函数。
	 * @param disposable 要将新EventEmitter添加到的一个可释放存储。
	 */
	export function map<I, O>(event: Event<I>, map: (i: I) => O, disposable?: DisposableStore): Event<O> {
		return snapshot((listener, thisArgs = null, disposables?) => event(i => listener.call(thisArgs, map(i)), null, disposables), disposable);
	}

	/**
	 * 将事件包装在另一个事件中，该事件在触发前对事件对象执行某些函数。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param each 在事件对象上执行的函数。
	 * @param disposable 要将新EventEmitter添加到的一个可释放存储。
	 */
	export function forEach<I>(event: Event<I>, each: (i: I) => void, disposable?: DisposableStore): Event<I> {
		return snapshot((listener, thisArgs = null, disposables?) => event(i => { each(i); listener.call(thisArgs, i); }, null, disposables), disposable);
	}

	/**
	 * 将事件包装在另一个仅在满足某些条件时触发的事件中。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param filter 定义条件的过滤函数。如果此函数返回true，则事件将为该对象触发。
	 * @param disposable 要将新EventEmitter添加到的一个可释放存储。
	 */
	export function filter<T, U>(event: Event<T | U>, filter: (e: T | U) => e is T, disposable?: DisposableStore): Event<T>;
	export function filter<T>(event: Event<T>, filter: (e: T) => boolean, disposable?: DisposableStore): Event<T>;
	export function filter<T, R>(event: Event<T | R>, filter: (e: T | R) => e is R, disposable?: DisposableStore): Event<R>;
	export function filter<T>(event: Event<T>, filter: (e: T) => boolean, disposable?: DisposableStore): Event<T> {
		return snapshot((listener, thisArgs = null, disposables?) => event(e => filter(e) && listener.call(thisArgs, e), null, disposables), disposable);
	}

	/**
	 * 给定一个事件，返回相同的事件但类型为`Event<void>`。
	 */
	export function signal<T>(event: Event<T>): Event<void> {
		return event as Event<any> as Event<void>;
	}

	/**
	 * 给定一个事件集合，返回一个单一事件，该事件在任何提供的事件发出时发出。
	 */
	export function any<T>(...events: Event<T>[]): Event<T>;
	export function any(...events: Event<any>[]): Event<void>;
	export function any<T>(...events: Event<T>[]): Event<T> {
		return (listener, thisArgs = null, disposables?) => {
			const disposable = combinedDisposable(...events.map(event => event(e => listener.call(thisArgs, e))));
			return addAndReturnDisposable(disposable, disposables);
		};
	}

	/**
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 */
	export function reduce<I, O>(event: Event<I>, merge: (last: O | undefined, event: I) => O, initial?: O, disposable?: DisposableStore): Event<O> {
		let output: O | undefined = initial;

		return map<I, O>(event, e => {
			output = merge(output, e);
			return output;
		}, disposable);
	}

	function snapshot<T>(event: Event<T>, disposable: DisposableStore | undefined): Event<T> {
		let listener: IDisposable | undefined;

		const options: EmitterOptions | undefined = {
			onWillAddFirstListener() {
				listener = event(emitter.fire, emitter);
			},
			onDidRemoveLastListener() {
				listener?.dispose();
			}
		};

		if (!disposable) {
			_addLeakageTraceLogic(options);
		}

		const emitter = new Emitter<T>(options);

		disposable?.add(emitter);

		return emitter.event;
	}

	/**
	 * 如果设置了store，将IDisposable添加到store中，并返回它。
	 * 对Event函数实现有用。
	 */
	function addAndReturnDisposable<T extends IDisposable>(d: T, store: DisposableStore | IDisposable[] | undefined): T {
		if (store instanceof Array) {
			store.push(d);
		} else if (store) {
			store.add(d);
		}
		return d;
	}

	/**
	 * 给定一个事件，创建一个新的发射器事件，它将基于{@link delay}延迟事件，并给出包含所有触发事件的数组事件对象。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 要去抖的原始事件。
	 * @param merge 将所有事件减少为单个事件的函数。
	 * @param delay 去抖的毫秒数。
	 * @param leading 是否在不去抖的情况下触发前导事件。
	 * @param flushOnListenerRemove 移除监听器时是否触发所有去抖的事件。如果未指定，某些事件可能会丢失。
	 * 如果重要的是处理所有事件，即使监听器在去抖事件触发前被释放，也可以使用此选项。
	 * @param leakWarningThreshold 参见{@link EmitterOptions.leakWarningThreshold}。
	 * @param disposable 注册去抖发射器的可释放存储。
	 */
	export function debounce<T>(event: Event<T>, merge: (last: T | undefined, event: T) => T, delay?: number | typeof MicrotaskDelay, leading?: boolean, flushOnListenerRemove?: boolean, leakWarningThreshold?: number, disposable?: DisposableStore): Event<T>;
	export function debounce<I, O>(event: Event<I>, merge: (last: O | undefined, event: I) => O, delay?: number | typeof MicrotaskDelay, leading?: boolean, flushOnListenerRemove?: boolean, leakWarningThreshold?: number, disposable?: DisposableStore): Event<O>;
	export function debounce<I, O>(event: Event<I>, merge: (last: O | undefined, event: I) => O, delay: number | typeof MicrotaskDelay = 100, leading = false, flushOnListenerRemove = false, leakWarningThreshold?: number, disposable?: DisposableStore): Event<O> {
		let subscription: IDisposable;
		let output: O | undefined = undefined;
		let handle: any = undefined;
		let numDebouncedCalls = 0;
		let doFire: (() => void) | undefined;

		const options: EmitterOptions | undefined = {
			leakWarningThreshold,
			onWillAddFirstListener() {
				subscription = event(cur => {
					numDebouncedCalls++;
					output = merge(output, cur);

					if (leading && !handle) {
						emitter.fire(output);
						output = undefined;
					}

					doFire = () => {
						const _output = output;
						output = undefined;
						handle = undefined;
						if (!leading || numDebouncedCalls > 1) {
							emitter.fire(_output!);
						}
						numDebouncedCalls = 0;
					};

					if (typeof delay === 'number') {
						clearTimeout(handle);
						handle = setTimeout(doFire, delay);
					} else {
						if (handle === undefined) {
							handle = 0;
							queueMicrotask(doFire);
						}
					}
				});
			},
			onWillRemoveListener() {
				if (flushOnListenerRemove && numDebouncedCalls > 0) {
					doFire?.();
				}
			},
			onDidRemoveLastListener() {
				doFire = undefined;
				subscription.dispose();
			}
		};

		if (!disposable) {
			_addLeakageTraceLogic(options);
		}

		const emitter = new Emitter<O>(options);

		disposable?.add(emitter);

		return emitter.event;
	}

	/**
	 * 去抖动一个事件，在一段延迟(默认=0)后触发，包含所有原始事件对象的数组。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 */
	export function accumulate<T>(event: Event<T>, delay: number = 0, disposable?: DisposableStore): Event<T[]> {
		return Event.debounce<T, T[]>(event, (last, e) => {
			if (!last) {
				return [e];
			}
			last.push(e);
			return last;
		}, delay, undefined, true, undefined, disposable);
	}

	/**
	 * 过滤一个事件，使某个条件在连续的情况下不会多次满足，有效确保来自不同源的重复事件对象不会触发相同的事件对象。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param equals 相等条件。
	 * @param disposable 要添加新的EventEmitter的可释放存储。
	 *
	 * @example
	 * ```
	 * // 当单个窗口被打开或聚焦时只触发一次
	 * Event.latch(Event.any(onDidOpenWindow, onDidFocusWindow))
	 * ```
	 */
	export function latch<T>(event: Event<T>, equals: (a: T, b: T) => boolean = (a, b) => a === b, disposable?: DisposableStore): Event<T> {
		let firstCall = true;
		let cache: T;

		return filter(event, value => {
			const shouldEmit = firstCall || !equals(value, cache);
			firstCall = false;
			cache = value;
			return shouldEmit;
		}, disposable);
	}

	/**
	 * 将参数为联合类型的事件分割成联合中每种类型的2个单独事件。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @example
	 * ```
	 * const event = new EventEmitter<number | undefined>().event;
	 * const [numberEvent, undefinedEvent] = Event.split(event, isUndefined);
	 * ```
	 *
	 * @param event 新事件的事件源。
	 * @param isT 确定事件是否属于第一种类型的函数。
	 * @param disposable 要添加新的EventEmitter的可释放存储。
	 */
	export function split<T, U>(event: Event<T | U>, isT: (e: T | U) => e is T, disposable?: DisposableStore): [Event<T>, Event<U>] {
		return [
			Event.filter(event, isT, disposable),
			Event.filter(event, e => !isT(e), disposable) as Event<U>,
		];
	}

	/**
	 * 缓冲一个事件，直到它有一个监听器附加。
	 *
	 * *注意*，此函数返回一个`Event`，当返回的事件对"第三方"可访问时（例如，事件是公共属性），
	 * 必须使用`DisposableStore`调用它。否则，返回事件上的泄漏监听器会导致此工具在原始事件上
	 * 泄漏一个监听器。
	 *
	 * @param event 新事件的事件源。
	 * @param flushAfterTimeout 决定是立即在超时后刷新缓冲区，还是在添加第一个事件监听器后进行`setTimeout`。
	 * @param _buffer 内部：用于测试的源事件数组。
	 *
	 * @example
	 * ```
	 * // 开始累积事件，当附加第一个监听器时，在超时后刷新
	 * // 事件，使得超时前附加的多个监听器都能接收到事件
	 * this.onInstallExtension = Event.buffer(service.onInstallExtension, true);
	 * ```
	 */
	export function buffer<T>(event: Event<T>, flushAfterTimeout = false, _buffer: T[] = [], disposable?: DisposableStore): Event<T> {
		let buffer: T[] | null = _buffer.slice();

		let listener: IDisposable | null = event(e => {
			if (buffer) {
				buffer.push(e);
			} else {
				emitter.fire(e);
			}
		});

		if (disposable) {
			disposable.add(listener);
		}

		const flush = () => {
			buffer?.forEach(e => emitter.fire(e));
			buffer = null;
		};

		const emitter = new Emitter<T>({
			onWillAddFirstListener() {
				if (!listener) {
					listener = event(e => emitter.fire(e));
					if (disposable) {
						disposable.add(listener);
					}
				}
			},

			onDidAddFirstListener() {
				if (buffer) {
					if (flushAfterTimeout) {
						setTimeout(flush);
					} else {
						flush();
					}
				}
			},

			onDidRemoveLastListener() {
				if (listener) {
					listener.dispose();
				}
				listener = null;
			}
		});

		if (disposable) {
			disposable.add(emitter);
		}

		return emitter.event;
	}
	/**
	 * 将事件包装在{@link IChainableEvent}中，允许更加函数式的编程风格。
	 *
	 * @example
	 * ```
	 * // 普通方式
	 * const onEnterPressNormal = Event.filter(
	 *   Event.map(onKeyPress.event, e => new StandardKeyboardEvent(e)),
	 *   e.keyCode === KeyCode.Enter
	 * ).event;
	 *
	 * // 使用链式
	 * const onEnterPressChain = Event.chain(onKeyPress.event, $ => $
	 *   .map(e => new StandardKeyboardEvent(e))
	 *   .filter(e => e.keyCode === KeyCode.Enter)
	 * );
	 * ```
	 */
	export function chain<T, R>(event: Event<T>, sythensize: ($: IChainableSythensis<T>) => IChainableSythensis<R>): Event<R> {
		const fn: Event<R> = (listener, thisArgs, disposables) => {
			const cs = sythensize(new ChainableSynthesis()) as ChainableSynthesis;
			return event(function (value) {
				const result = cs.evaluate(value);
				if (result !== HaltChainable) {
					listener.call(thisArgs, result);
				}
			}, undefined, disposables);
		};

		return fn;
	}

	const HaltChainable = Symbol('HaltChainable');

	class ChainableSynthesis implements IChainableSythensis<any> {
		private readonly steps: ((input: any) => unknown)[] = [];

		map<O>(fn: (i: any) => O): this {
			this.steps.push(fn);
			return this;
		}

		forEach(fn: (i: any) => void): this {
			this.steps.push(v => {
				fn(v);
				return v;
			});
			return this;
		}

		filter(fn: (e: any) => boolean): this {
			this.steps.push(v => fn(v) ? v : HaltChainable);
			return this;
		}

		reduce<R>(merge: (last: R | undefined, event: any) => R, initial?: R | undefined): this {
			let last = initial;
			this.steps.push(v => {
				last = merge(last, v);
				return last;
			});
			return this;
		}

		latch(equals: (a: any, b: any) => boolean = (a, b) => a === b): ChainableSynthesis {
			let firstCall = true;
			let cache: any;
			this.steps.push(value => {
				const shouldEmit = firstCall || !equals(value, cache);
				firstCall = false;
				cache = value;
				return shouldEmit ? value : HaltChainable;
			});

			return this;
		}

		public evaluate(value: any) {
			for (const step of this.steps) {
				value = step(value);
				if (value === HaltChainable) {
					break;
				}
			}

			return value;
		}
	}

	export interface IChainableSythensis<T> {
		map<O>(fn: (i: T) => O): IChainableSythensis<O>;
		forEach(fn: (i: T) => void): IChainableSythensis<T>;
		filter<R extends T>(fn: (e: T) => e is R): IChainableSythensis<R>;
		filter(fn: (e: T) => boolean): IChainableSythensis<T>;
		reduce<R>(merge: (last: R, event: T) => R, initial: R): IChainableSythensis<R>;
		reduce<R>(merge: (last: R | undefined, event: T) => R): IChainableSythensis<R>;
		latch(equals?: (a: T, b: T) => boolean): IChainableSythensis<T>;
	}

	export interface NodeEventEmitter {
		on(event: string | symbol, listener: Function): unknown;
		removeListener(event: string | symbol, listener: Function): unknown;
	}

	/**
	 * 从node事件发射器创建一个{@link Event}。
	 */
	export function fromNodeEventEmitter<T>(emitter: NodeEventEmitter, eventName: string, map: (...args: any[]) => T = id => id): Event<T> {
		const fn = (...args: any[]) => result.fire(map(...args));
		const onFirstListenerAdd = () => emitter.on(eventName, fn);
		const onLastListenerRemove = () => emitter.removeListener(eventName, fn);
		const result = new Emitter<T>({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove });

		return result.event;
	}

	export interface DOMEventEmitter {
		addEventListener(event: string | symbol, listener: Function): void;
		removeEventListener(event: string | symbol, listener: Function): void;
	}

	/**
	 * 从DOM事件发射器创建一个{@link Event}。
	 */
	export function fromDOMEventEmitter<T>(emitter: DOMEventEmitter, eventName: string, map: (...args: any[]) => T = id => id): Event<T> {
		const fn = (...args: any[]) => result.fire(map(...args));
		const onFirstListenerAdd = () => emitter.addEventListener(eventName, fn);
		const onLastListenerRemove = () => emitter.removeEventListener(eventName, fn);
		const result = new Emitter<T>({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove });

		return result.event;
	}

	/**
	 * 使用{@link Event.once}帮助器从事件创建一个Promise。
	 */
	export function toPromise<T>(event: Event<T>, disposables?: IDisposable[] | DisposableStore): Promise<T> {
		return new Promise(resolve => once(event)(resolve, null, disposables));
	}

	/**
	 * 从Promise创建一个事件，该事件在Promise解析时使用Promise的结果或`undefined`触发一次。
	 */
	export function fromPromise<T>(promise: Promise<T>): Event<T | undefined> {
		const result = new Emitter<T | undefined>();

		promise.then(res => {
			result.fire(res);
		}, () => {
			result.fire(undefined);
		}).finally(() => {
			result.dispose();
		});

		return result.event;
	}

	/**
	 * 一个方便的函数，用于将事件转发到另一个发射器，提高可读性。
	 *
	 * 这类似于{@link Relay}，但允许在单行上实例化和转发，
	 * 并且还允许多个源事件。
	 * @param from 要转发的事件。
	 * @param to 要将事件转发到的发射器。
	 * @example
	 * Event.forward(event, emitter);
	 * // 等同于
	 * event(e => emitter.fire(e));
	 * // 等同于
	 * event(emitter.fire, emitter);
	 */
	export function forward<T>(from: Event<T>, to: Emitter<T>): IDisposable {
		return from(e => to.fire(e));
	}

	/**
	 * 向事件添加监听器，并立即使用undefined作为事件对象调用监听器。
	 *
	 * @example
	 * ```
	 * // 初始化UI，并在dataChangeEvent触发时更新它
	 * runAndSubscribe(dataChangeEvent, () => this._updateUI());
	 * ```
	 */
	export function runAndSubscribe<T>(event: Event<T>, handler: (e: T) => unknown, initial: T): IDisposable;
	export function runAndSubscribe<T>(event: Event<T>, handler: (e: T | undefined) => unknown): IDisposable;
	export function runAndSubscribe<T>(event: Event<T>, handler: (e: T | undefined) => unknown, initial?: T): IDisposable {
		handler(initial);
		return event(e => handler(e));
	}

	class EmitterObserver<T> implements IObserver {

		readonly emitter: Emitter<T>;

		private _counter = 0;
		private _hasChanged = false;

		constructor(readonly _observable: IObservable<T>, store: DisposableStore | undefined) {
			const options: EmitterOptions = {
				onWillAddFirstListener: () => {
					_observable.addObserver(this);

					// 向可观察对象通知我们收到了其当前值，并希望被通知未来的变化。
					this._observable.reportChanges();
				},
				onDidRemoveLastListener: () => {
					_observable.removeObserver(this);
				}
			};
			if (!store) {
				_addLeakageTraceLogic(options);
			}
			this.emitter = new Emitter<T>(options);
			if (store) {
				store.add(this.emitter);
			}
		}

		beginUpdate<T>(_observable: IObservable<T>): void {
			// assert(_observable === this.obs);
			this._counter++;
		}

		handlePossibleChange<T>(_observable: IObservable<T>): void {
			// assert(_observable === this.obs);
		}

		handleChange<T, TChange>(_observable: IObservableWithChange<T, TChange>, _change: TChange): void {
			// assert(_observable === this.obs);
			this._hasChanged = true;
		}

		endUpdate<T>(_observable: IObservable<T>): void {
			// assert(_observable === this.obs);
			this._counter--;
			if (this._counter === 0) {
				this._observable.reportChanges();
				if (this._hasChanged) {
					this._hasChanged = false;
					this.emitter.fire(this._observable.get());
				}
			}
		}
	}

	/**
	 * 创建一个在可观察对象更改时触发的事件发射器。
	 * 每个监听器都订阅发射器。
	 */
	export function fromObservable<T>(obs: IObservable<T>, store?: DisposableStore): Event<T> {
		const observer = new EmitterObserver(obs, store);
		return observer.emitter.event;
	}

	/**
	 * 每个监听器都直接附加到可观察对象上。
	 */
	export function fromObservableLight(observable: IObservable<unknown>): Event<void> {
		return (listener, thisArgs, disposables) => {
			let count = 0;
			let didChange = false;
			const observer: IObserver = {
				beginUpdate() {
					count++;
				},
				endUpdate() {
					count--;
					if (count === 0) {
						observable.reportChanges();
						if (didChange) {
							didChange = false;
							listener.call(thisArgs);
						}
					}
				},
				handlePossibleChange() {
					// noop
				},
				handleChange() {
					didChange = true;
				}
			};
			observable.addObserver(observer);
			observable.reportChanges();
			const disposable = {
				dispose() {
					observable.removeObserver(observer);
				}
			};

			if (disposables instanceof DisposableStore) {
				disposables.add(disposable);
			} else if (Array.isArray(disposables)) {
				disposables.push(disposable);
			}

			return disposable;
		};
	}
}

export interface EmitterOptions {
	/**
	 * 可选函数，在添加第一个监听器*之前*调用
	 */
	onWillAddFirstListener?: Function;
	/**
	 * 可选函数，在添加第一个监听器*之后*调用
	 */
	onDidAddFirstListener?: Function;
	/**
	 * 可选函数，在添加监听器后调用
	 */
	onDidAddListener?: Function;
	/**
	 * 可选函数，在移除最后一个监听器*之后*调用
	 */
	onDidRemoveLastListener?: Function;
	/**
	 * 可选函数，在移除监听器*之前*调用
	 */
	onWillRemoveListener?: Function;
	/**
	 * 当监听器抛出错误时调用的可选函数。默认为
	 * {@link onUnexpectedError}
	 */
	onListenerError?: (e: any) => void;
	/**
	 * 在假定泄漏之前允许的监听器数量。默认为
	 * 全局配置的值
	 *
	 * @see setGlobalLeakWarningThreshold
	 */
	leakWarningThreshold?: number;
	/**
	 * 传入一个传递队列，这对于确保
	 * 多个发射器之间的事件按顺序传递非常有用。
	 */
	deliveryQueue?: EventDeliveryQueue;

	/** 仅在开发期间启用 */
	_profName?: string;
}


export class EventProfiling {

	static readonly all = new Set<EventProfiling>();

	private static _idPool = 0;

	readonly name: string;
	public listenerCount: number = 0;
	public invocationCount = 0;
	public elapsedOverall = 0;
	public durations: number[] = [];

	private _stopWatch?: StopWatch;

	constructor(name: string) {
		this.name = `${name}_${EventProfiling._idPool++}`;
		EventProfiling.all.add(this);
	}

	start(listenerCount: number): void {
		this._stopWatch = new StopWatch();
		this.listenerCount = listenerCount;
	}

	stop(): void {
		if (this._stopWatch) {
			const elapsed = this._stopWatch.elapsed();
			this.durations.push(elapsed);
			this.elapsedOverall += elapsed;
			this.invocationCount += 1;
			this._stopWatch = undefined;
		}
	}
}

let _globalLeakWarningThreshold = -1;
export function setGlobalLeakWarningThreshold(n: number): IDisposable {
	const oldValue = _globalLeakWarningThreshold;
	_globalLeakWarningThreshold = n;
	return {
		dispose() {
			_globalLeakWarningThreshold = oldValue;
		}
	};
}

class LeakageMonitor {

	private static _idPool = 1;

	private _stacks: Map<string, number> | undefined;
	private _warnCountdown: number = 0;

	constructor(
		private readonly _errorHandler: (err: Error) => void,
		readonly threshold: number,
		readonly name: string = (LeakageMonitor._idPool++).toString(16).padStart(3, '0')
	) { }

	dispose(): void {
		this._stacks?.clear();
	}

	check(stack: Stacktrace, listenerCount: number): undefined | (() => void) {

		const threshold = this.threshold;
		if (threshold <= 0 || listenerCount < threshold) {
			return undefined;
		}

		if (!this._stacks) {
			this._stacks = new Map();
		}
		const count = (this._stacks.get(stack.value) || 0);
		this._stacks.set(stack.value, count + 1);
		this._warnCountdown -= 1;

		if (this._warnCountdown <= 0) {
			// 仅在首次超出和此后每次超出限制的50%时警告
			this._warnCountdown = threshold * 0.5;

			const [topStack, topCount] = this.getMostFrequentStack()!;
			const message = `[${this.name}] 检测到潜在的监听器泄漏，已有${listenerCount}个监听器。最频繁的监听器 (${topCount}):`;
			console.warn(message);
			console.warn(topStack!);

			const error = new ListenerLeakError(message, topStack);
			this._errorHandler(error);
		}

		return () => {
			const count = (this._stacks!.get(stack.value) || 0);
			this._stacks!.set(stack.value, count - 1);
		};
	}

	getMostFrequentStack(): [string, number] | undefined {
		if (!this._stacks) {
			return undefined;
		}
		let topStack: [string, number] | undefined;
		let topCount: number = 0;
		for (const [stack, count] of this._stacks) {
			if (!topStack || topCount < count) {
				topStack = [stack, count];
				topCount = count;
			}
		}
		return topStack;
	}
}

class Stacktrace {

	static create() {
		const err = new Error();
		return new Stacktrace(err.stack ?? '');
	}

	private constructor(readonly value: string) { }

	print() {
		console.warn(this.value.split('\n').slice(2).join('\n'));
	}
}

// 当超过配置的监听器阈值时记录的错误
export class ListenerLeakError extends Error {
	constructor(message: string, stack: string) {
		super(message);
		this.name = 'ListenerLeakError';
		this.stack = stack;
	}
}

// 当远超过配置的监听器阈值，发射器拒绝接受更多监听器时记录的严重错误
export class ListenerRefusalError extends Error {
	constructor(message: string, stack: string) {
		super(message);
		this.name = 'ListenerRefusalError';
		this.stack = stack;
	}
}

let id = 0;
class UniqueContainer<T> {
	stack?: Stacktrace;
	public id = id++;
	constructor(public readonly value: T) { }
}
const compactionThreshold = 2;

type ListenerContainer<T> = UniqueContainer<(data: T) => void>;
type ListenerOrListeners<T> = (ListenerContainer<T> | undefined)[] | ListenerContainer<T>;

const forEachListener = <T>(listeners: ListenerOrListeners<T>, fn: (c: ListenerContainer<T>) => void) => {
	if (listeners instanceof UniqueContainer) {
		fn(listeners);
	} else {
		for (let i = 0; i < listeners.length; i++) {
			const l = listeners[i];
			if (l) {
				fn(l);
			}
		}
	}
};

/**
 * The Emitter can be used to expose an Event to the public
 * to fire it from the insides.
 * Sample:
	class Document {

		private readonly _onDidChange = new Emitter<(value:string)=>any>();

		public onDidChange = this._onDidChange.event;

		// getter-style
		// get onDidChange(): Event<(value:string)=>any> {
		// 	return this._onDidChange.event;
		// }

		private _doIt() {
			//...
			this._onDidChange.fire(value);
		}
	}
 */
export class Emitter<T> {

	private readonly _options?: EmitterOptions;
	private readonly _leakageMon?: LeakageMonitor;
	private readonly _perfMon?: EventProfiling;
	private _disposed?: true;
	private _event?: Event<T>;

	/**
	 * 一个监听器，或监听器列表。单个监听器是事件发射器最常见的情况
	 * （#185789），因此我们优化这种特殊情况，避免将其包装在数组中
	 * （就像Node.js本身一样）。
	 *
	 * 监听器列表在移除监听器时永远不会"降级"回普通函数，原因有两个：
	 *
	 *  1. 这很复杂（尤其是在有deliveryQueue的情况下）
	 *  2. 拥有多个监听器的发射器很可能在某个时刻再次拥有多个监听器，
	 *     在数组和函数之间切换可能[需要引用]会引入不必要的工作和垃圾。
	 *
	 * 数组监听器可以是"稀疏的"，以避免在添加或删除任何监听器时重新分配数组。
	 * 只有当数组中空元素超过`1 / compactionThreshold`比例时，才会调整其大小。
	 */
	protected _listeners?: ListenerOrListeners<T>;

	/**
	 * 事件存储队列，循环派发了所有注册的事件， 事件会存储到一个事件队列，通过fire方法触发事件
	 * 当_listeners是一个数组时，总是需要被定义。它不再是一个真正的队列，而是保存了分发的'状态'。如果在发射器上调用`fire()`，_deliveryQueue中剩余的任何工作都会首先完成。
	 */
	private _deliveryQueue?: EventDeliveryQueuePrivate;
	protected _size = 0;

	constructor(options?: EmitterOptions) {
		this._options = options;
		this._leakageMon = (_globalLeakWarningThreshold > 0 || this._options?.leakWarningThreshold)
			? new LeakageMonitor(options?.onListenerError ?? onUnexpectedError, this._options?.leakWarningThreshold ?? _globalLeakWarningThreshold) :
			undefined;
		this._perfMon = this._options?._profName ? new EventProfiling(this._options._profName) : undefined;
		this._deliveryQueue = this._options?.deliveryQueue as EventDeliveryQueuePrivate | undefined;
	}

	dispose() {
		if (!this._disposed) {
			this._disposed = true;

			// 在释放发射器时仍有监听器是不好的，但更糟糕的是让监听器通过嵌入在其可释放对象中的引用使发射器保持活动状态。
			// 因此，我们遍历所有剩余的监听器并取消设置它们的订阅/可释放对象。遍历并指责剩余的监听器是在下一个时钟周期完成的，
			// 因为以下编程模式非常流行：
			//
			// const someModel = this._disposables.add(new ModelObject()); // (1) 创建并注册模型
			// this._disposables.add(someModel.onDidChange(() => { ... }); // (2) 订阅并注册模型事件监听器
			// ...稍后...
			// this._disposables.dispose(); 释放 (1) 然后 (2)：不要在 (1) 之后警告，而是在"整体释放"完成后警告

			if (this._deliveryQueue?.current === this) {
				this._deliveryQueue.reset();
			}
			if (this._listeners) {
				if (_enableDisposeWithListenerWarning) {
					const listeners = this._listeners;
					queueMicrotask(() => {
						forEachListener(listeners, l => l.stack?.print());
					});
				}

				this._listeners = undefined;
				this._size = 0;
			}
			this._options?.onDidRemoveLastListener?.();
			this._leakageMon?.dispose();
		}
	}

	/**
	 * For the public to allow to subscribe
	 * to events from this Emitter
	 */
	get event(): Event<T> {
		this._event ??= (callback: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) => {
			if (this._leakageMon && this._size > this._leakageMon.threshold ** 2) {
				const message = `[${this._leakageMon.name}] 拒绝接受新的监听器，因为它远远超出了阈值(${this._size} vs ${this._leakageMon.threshold})`;
				console.warn(message);

				const tuple = this._leakageMon.getMostFrequentStack() ?? ['未知堆栈', -1];
				const error = new ListenerRefusalError(`${message}. 提示: 堆栈显示最频繁的监听器 (${tuple[1]}次)`, tuple[0]);
				const errorHandler = this._options?.onListenerError || onUnexpectedError;
				errorHandler(error);

				return Disposable.None;
			}

			if (this._disposed) {
				// 疑问：如果监听器被添加到已释放的发射器，我们是否应该警告？这种情况经常发生
				return Disposable.None;
			}

			if (thisArgs) {
				callback = callback.bind(thisArgs);
			}

			const contained = new UniqueContainer(callback);

			let removeMonitor: Function | undefined;
			let stack: Stacktrace | undefined;
			if (this._leakageMon && this._size >= Math.ceil(this._leakageMon.threshold * 0.2)) {
				// 检查并记录此发射器的潜在泄漏
				contained.stack = Stacktrace.create();
				removeMonitor = this._leakageMon.check(contained.stack, this._size + 1);
			}

			if (_enableDisposeWithListenerWarning) {
				contained.stack = stack ?? Stacktrace.create();
			}

			if (!this._listeners) {
				this._options?.onWillAddFirstListener?.(this);
				this._listeners = contained;
				this._options?.onDidAddFirstListener?.(this);
			} else if (this._listeners instanceof UniqueContainer) {
				this._deliveryQueue ??= new EventDeliveryQueuePrivate();
				this._listeners = [this._listeners, contained];
			} else {
				this._listeners.push(contained);
			}
			this._options?.onDidAddListener?.(this);

			this._size++;


			const result = toDisposable(() => {
				removeMonitor?.();
				this._removeListener(contained);
			});
			if (disposables instanceof DisposableStore) {
				disposables.add(result);
			} else if (Array.isArray(disposables)) {
				disposables.push(result);
			}

			return result;
		};

		return this._event;
	}

	private _removeListener(listener: ListenerContainer<T>) {
		this._options?.onWillRemoveListener?.(this);

		if (!this._listeners) {
			return; // 如果监听器被释放，这是预期的
		}

		if (this._size === 1) {
			this._listeners = undefined;
			this._options?.onDidRemoveLastListener?.(this);
			this._size = 0;
			return;
		}

		// size > 1需要listeners是一个列表:
		const listeners = this._listeners as (ListenerContainer<T> | undefined)[];

		const index = listeners.indexOf(listener);
		if (index === -1) {
			console.log('已释放?', this._disposed);
			console.log('大小?', this._size);
			console.log('数组?', JSON.stringify(this._listeners));
			throw new Error('尝试释放未知的监听器');
		}

		this._size--;
		listeners[index] = undefined;

		const adjustDeliveryQueue = this._deliveryQueue!.current === this;
		if (this._size * compactionThreshold <= listeners.length) {
			let n = 0;
			for (let i = 0; i < listeners.length; i++) {
				if (listeners[i]) {
					listeners[n++] = listeners[i];
				} else if (adjustDeliveryQueue && n < this._deliveryQueue!.end) {
					this._deliveryQueue!.end--;
					if (n < this._deliveryQueue!.i) {
						this._deliveryQueue!.i--;
					}
				}
			}
			listeners.length = n;
		}
	}

	private _deliver(listener: undefined | UniqueContainer<(value: T) => void>, value: T) {
		if (!listener) {
			return;
		}

		const errorHandler = this._options?.onListenerError || onUnexpectedError;
		if (!errorHandler) {
			listener.value(value);
			return;
		}

		try {
			listener.value(value);
		} catch (e) {
			errorHandler(e);
		}
	}

	/** 传递队列中的项目。假设队列已准备好。 */
	private _deliverQueue(dq: EventDeliveryQueuePrivate) {
		const listeners = dq.current!._listeners! as (ListenerContainer<T> | undefined)[];
		while (dq.i < dq.end) {
			// 重要：在调用deliver()之前增加dq.i，因为它可能会重新进入deliverQueue()
			this._deliver(listeners[dq.i++], dq.value as T);
		}
		dq.reset();
	}

	/**
	 * 保持私有以向订阅者触发事件
	 * 从队列中获取事件，并触发事件
	 */
	fire(event: T): void {
		if (this._deliveryQueue?.current) {
			this._deliverQueue(this._deliveryQueue);
			this._perfMon?.stop(); // 最后一次fire()将启动perfmon，在开始下一次分发前停止它
		}

		this._perfMon?.start(this._size);

		if (!this._listeners) {
			// 无操作
		} else if (this._listeners instanceof UniqueContainer) {
			this._deliver(this._listeners, event);
		} else {
			const dq = this._deliveryQueue!;
			dq.enqueue(this, event, this._listeners.length);
			this._deliverQueue(dq);
		}

		this._perfMon?.stop();
	}

	hasListeners(): boolean {
		return this._size > 0;
	}
}

export interface EventDeliveryQueue {
	_isEventDeliveryQueue: true;
}

export const createEventDeliveryQueue = (): EventDeliveryQueue => new EventDeliveryQueuePrivate();

class EventDeliveryQueuePrivate implements EventDeliveryQueue {
	declare _isEventDeliveryQueue: true;

	/**
	 * 当前监听器列表中的索引。
	 */
	public i = -1;

	/**
	 * 监听器列表中要传递的最后一个索引。
	 */
	public end = 0;

	/**
	 * 当前正在分发的发射器。Emitter._listeners始终是一个数组。
	 */
	public current?: Emitter<any>;
	/**
	 * 当前正在发出的值。当'current'定义时定义。
	 */
	public value?: unknown;

	public enqueue<T>(emitter: Emitter<T>, value: T, end: number) {
		this.i = 0;
		this.end = end;
		this.current = emitter;
		this.value = value;
	}

	public reset() {
		this.i = this.end; // 强制任何当前的发射循环停止，主要用于释放期间
		this.current = undefined;
		this.value = undefined;
	}
}

export interface IWaitUntil {
	token: CancellationToken;
	waitUntil(thenable: Promise<unknown>): void;
}

export type IWaitUntilData<T> = Omit<Omit<T, 'waitUntil'>, 'token'>;

export class AsyncEmitter<T extends IWaitUntil> extends Emitter<T> {

	private _asyncDeliveryQueue?: LinkedList<[(ev: T) => void, IWaitUntilData<T>]>;

	async fireAsync(data: IWaitUntilData<T>, token: CancellationToken, promiseJoin?: (p: Promise<unknown>, listener: Function) => Promise<unknown>): Promise<void> {
		if (!this._listeners) {
			return;
		}

		if (!this._asyncDeliveryQueue) {
			this._asyncDeliveryQueue = new LinkedList();
		}

		forEachListener(this._listeners, listener => this._asyncDeliveryQueue!.push([listener.value, data]));

		while (this._asyncDeliveryQueue.size > 0 && !token.isCancellationRequested) {

			const [listener, data] = this._asyncDeliveryQueue.shift()!;
			const thenables: Promise<unknown>[] = [];

			// eslint-disable-next-line local/code-no-dangerous-type-assertions
			const event = <T>{
				...data,
				token,
				waitUntil: (p: Promise<unknown>): void => {
					if (Object.isFrozen(thenables)) {
						throw new Error('waitUntil不能异步调用');
					}
					if (promiseJoin) {
						p = promiseJoin(p, listener);
					}
					thenables.push(p);
				}
			};

			try {
				listener(event);
			} catch (e) {
				onUnexpectedError(e);
				continue;
			}

			// 冻结thenables集合以强制对wait until的同步调用，
			// 然后等待所有thenables解析
			Object.freeze(thenables);

			await Promise.allSettled(thenables).then(values => {
				for (const value of values) {
					if (value.status === 'rejected') {
						onUnexpectedError(value.reason);
					}
				}
			});
		}
	}
}


export class PauseableEmitter<T> extends Emitter<T> {

	private _isPaused = 0;
	protected _eventQueue = new LinkedList<T>();
	private _mergeFn?: (input: T[]) => T;

	public get isPaused(): boolean {
		return this._isPaused !== 0;
	}

	constructor(options?: EmitterOptions & { merge?: (input: T[]) => T }) {
		super(options);
		this._mergeFn = options?.merge;
	}

	pause(): void {
		this._isPaused++;
	}

	resume(): void {
		if (this._isPaused !== 0 && --this._isPaused === 0) {
			if (this._mergeFn) {
				// 使用合并函数创建一个单一的复合事件。
				// 制作一个副本，以防触发暂停此发射器
				if (this._eventQueue.size > 0) {
					const events = Array.from(this._eventQueue);
					this._eventQueue.clear();
					super.fire(this._mergeFn(events));
				}

			} else {
				// 没有合并，单独触发每个事件并测试
				// 这个发射器是否在中途暂停
				while (!this._isPaused && this._eventQueue.size !== 0) {
					super.fire(this._eventQueue.shift()!);
				}
			}
		}
	}

	override fire(event: T): void {
		if (this._size) {
			if (this._isPaused !== 0) {
				this._eventQueue.push(event);
			} else {
				super.fire(event);
			}
		}
	}
}

export class DebounceEmitter<T> extends PauseableEmitter<T> {

	private readonly _delay: number;
	private _handle: any | undefined;

	constructor(options: EmitterOptions & { merge: (input: T[]) => T; delay?: number }) {
		super(options);
		this._delay = options.delay ?? 100;
	}

	override fire(event: T): void {
		if (!this._handle) {
			this.pause();
			this._handle = setTimeout(() => {
				this._handle = undefined;
				this.resume();
			}, this._delay);
		}
		super.fire(event);
	}
}

/**
 * 一个发射器，它将所有事件排队，然后在事件循环结束时处理它们。
 */
export class MicrotaskEmitter<T> extends Emitter<T> {
	private _queuedEvents: T[] = [];
	private _mergeFn?: (input: T[]) => T;

	constructor(options?: EmitterOptions & { merge?: (input: T[]) => T }) {
		super(options);
		this._mergeFn = options?.merge;
	}
	override fire(event: T): void {

		if (!this.hasListeners()) {
			return;
		}

		this._queuedEvents.push(event);
		if (this._queuedEvents.length === 1) {
			queueMicrotask(() => {
				if (this._mergeFn) {
					super.fire(this._mergeFn(this._queuedEvents));
				} else {
					this._queuedEvents.forEach(e => super.fire(e));
				}
				this._queuedEvents = [];
			});
		}
	}
}

/**
 * 一个事件发射器，将多个事件多路复用成一个单一事件。
 *
 * @example 监听所有`Thing`的`onData`事件，根据需要动态添加和移除`Thing`到多路复用器。
 *
 * ```typescript
 * const anythingDataMultiplexer = new EventMultiplexer<{ data: string }>();
 *
 * const thingListeners = DisposableMap<Thing, IDisposable>();
 *
 * thingService.onDidAddThing(thing => {
 *   thingListeners.set(thing, anythingDataMultiplexer.add(thing.onData);
 * });
 * thingService.onDidRemoveThing(thing => {
 *   thingListeners.deleteAndDispose(thing);
 * });
 *
 * anythingDataMultiplexer.event(e => {
 *   console.log('Something fired data ' + e.data)
 * });
 * ```
 */
export class EventMultiplexer<T> implements IDisposable {

	private readonly emitter: Emitter<T>;
	private hasListeners = false;
	private events: { event: Event<T>; listener: IDisposable | null }[] = [];

	constructor() {
		this.emitter = new Emitter<T>({
			onWillAddFirstListener: () => this.onFirstListenerAdd(),
			onDidRemoveLastListener: () => this.onLastListenerRemove()
		});
	}

	get event(): Event<T> {
		return this.emitter.event;
	}

	add(event: Event<T>): IDisposable {
		const e = { event: event, listener: null };
		this.events.push(e);

		if (this.hasListeners) {
			this.hook(e);
		}

		const dispose = () => {
			if (this.hasListeners) {
				this.unhook(e);
			}

			const idx = this.events.indexOf(e);
			this.events.splice(idx, 1);
		};

		return toDisposable(createSingleCallFunction(dispose));
	}

	private onFirstListenerAdd(): void {
		this.hasListeners = true;
		this.events.forEach(e => this.hook(e));
	}

	private onLastListenerRemove(): void {
		this.hasListeners = false;
		this.events.forEach(e => this.unhook(e));
	}

	private hook(e: { event: Event<T>; listener: IDisposable | null }): void {
		e.listener = e.event(r => this.emitter.fire(r));
	}

	private unhook(e: { event: Event<T>; listener: IDisposable | null }): void {
		e.listener?.dispose();
		e.listener = null;
	}

	dispose(): void {
		this.emitter.dispose();

		for (const e of this.events) {
			e.listener?.dispose();
		}
		this.events = [];
	}
}

export interface IDynamicListEventMultiplexer<TEventType> extends IDisposable {
	readonly event: Event<TEventType>;
}
export class DynamicListEventMultiplexer<TItem, TEventType> implements IDynamicListEventMultiplexer<TEventType> {
	private readonly _store = new DisposableStore();

	readonly event: Event<TEventType>;

	constructor(
		items: TItem[],
		onAddItem: Event<TItem>,
		onRemoveItem: Event<TItem>,
		getEvent: (item: TItem) => Event<TEventType>
	) {
		const multiplexer = this._store.add(new EventMultiplexer<TEventType>());
		const itemListeners = this._store.add(new DisposableMap<TItem, IDisposable>());

		function addItem(instance: TItem) {
			itemListeners.set(instance, multiplexer.add(getEvent(instance)));
		}

		// 现有项目
		for (const instance of items) {
			addItem(instance);
		}

		// 添加项目
		this._store.add(onAddItem(instance => {
			addItem(instance);
		}));

		// 移除项目
		this._store.add(onRemoveItem(instance => {
			itemListeners.deleteAndDispose(instance);
		}));

		this.event = multiplexer.event;
	}

	dispose() {
		this._store.dispose();
	}
}

/**
 * EventBufferer在某些代码期间想要延迟触发事件的情况下很有用。
 * 你可以包装那段代码，并确保在那个包装期间不会触发事件。
 *
 * ```
 * const emitter: Emitter;
 * const delayer = new EventDelayer();
 * const delayedEvent = delayer.wrapEvent(emitter.event);
 *
 * delayedEvent(console.log);
 *
 * delayer.bufferEvents(() => {
 *   emitter.fire(); // 事件还不会被触发
 * });
 *
 * // 事件只会在此时触发
 * ```
 */
export class EventBufferer {

	private data: { buffers: Function[] }[] = [];

	wrapEvent<T>(event: Event<T>): Event<T>;
	wrapEvent<T>(event: Event<T>, reduce: (last: T | undefined, event: T) => T): Event<T>;
	wrapEvent<T, O>(event: Event<T>, reduce: (last: O | undefined, event: T) => O, initial: O): Event<O>;
	wrapEvent<T, O>(event: Event<T>, reduce?: (last: T | O | undefined, event: T) => T | O, initial?: O): Event<O | T> {
		return (listener, thisArgs?, disposables?) => {
			return event(i => {
				const data = this.data[this.data.length - 1];

				// 非减少场景
				if (!reduce) {
					// 缓冲情况
					if (data) {
						data.buffers.push(() => listener.call(thisArgs, i));
					} else {
						// 非缓冲情况
						listener.call(thisArgs, i);
					}
					return;
				}

				// 减少场景
				const reduceData = data as typeof data & {
					/**
					 * 将被减少的累积项。
					 */
					items?: T[];
					/**
					 * 缓存的减少结果，与其他监听器共享。
					 */
					reducedResult?: T | O;
				};

				// 非缓冲情况
				if (!reduceData) {
					// TODO: 是否有办法为所有监听器缓存这个reduce调用？
					listener.call(thisArgs, reduce(initial, i));
					return;
				}

				// 缓冲情况
				reduceData.items ??= [];
				reduceData.items.push(i);
				if (reduceData.buffers.length === 0) {
					// 包含一个缓冲函数，当我们完成缓冲事件时将减少所有事件
					data.buffers.push(() => {
						// 缓存减少的结果，以便该值可以在所有监听器之间共享
						reduceData.reducedResult ??= initial
							? reduceData.items!.reduce(reduce as (last: O | undefined, event: T) => O, initial)
							: reduceData.items!.reduce(reduce as (last: T | undefined, event: T) => T);
						listener.call(thisArgs, reduceData.reducedResult);
					});
				}
			}, undefined, disposables);
		};
	}

	bufferEvents<R = void>(fn: () => R): R {
		const data = { buffers: new Array<Function>() };
		this.data.push(data);
		const r = fn();
		this.data.pop();
		data.buffers.forEach(flush => flush());
		return r;
	}
}

/**
 * Relay是一个事件转发器，它作为一个可重新插接的事件管道。
 * 创建后，你可以将输入事件连接到它和它将简单地通过自己的`event`属性
 * 转发来自该输入事件的事件。`input`可以在任何时候更改。
 */
export class Relay<T> implements IDisposable {

	private listening = false;
	private inputEvent: Event<T> = Event.None;
	private inputEventListener: IDisposable = Disposable.None;

	private readonly emitter = new Emitter<T>({
		onDidAddFirstListener: () => {
			this.listening = true;
			this.inputEventListener = this.inputEvent(this.emitter.fire, this.emitter);
		},
		onDidRemoveLastListener: () => {
			this.listening = false;
			this.inputEventListener.dispose();
		}
	});

	readonly event: Event<T> = this.emitter.event;

	set input(event: Event<T>) {
		this.inputEvent = event;

		if (this.listening) {
			this.inputEventListener.dispose();
			this.inputEventListener = event(this.emitter.fire, this.emitter);
		}
	}

	dispose() {
		this.inputEventListener.dispose();
		this.emitter.dispose();
	}
}

export interface IValueWithChangeEvent<T> {
	readonly onDidChange: Event<void>;
	get value(): T;
}

export class ValueWithChangeEvent<T> implements IValueWithChangeEvent<T> {
	public static const<T>(value: T): IValueWithChangeEvent<T> {
		return new ConstValueWithChangeEvent(value);
	}

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(private _value: T) { }

	get value(): T {
		return this._value;
	}

	set value(value: T) {
		if (value !== this._value) {
			this._value = value;
			this._onDidChange.fire(undefined);
		}
	}
}

class ConstValueWithChangeEvent<T> implements IValueWithChangeEvent<T> {
	public readonly onDidChange: Event<void> = Event.None;

	constructor(readonly value: T) { }
}

/**
 * @param handleItem 为集合中的每个项目调用（但仅在第一次在集合中看到该项目时）。
 * 	如果该项目不再在集合中，则释放返回的可释放对象。
 */
export function trackSetChanges<T>(getData: () => ReadonlySet<T>, onDidChangeData: Event<unknown>, handleItem: (d: T) => IDisposable): IDisposable {
	const map = new DisposableMap<T, IDisposable>();
	let oldData = new Set(getData());
	for (const d of oldData) {
		map.set(d, handleItem(d));
	}

	const store = new DisposableStore();
	store.add(onDidChangeData(() => {
		const newData = getData();
		const diff = diffSets(oldData, newData);
		for (const r of diff.removed) {
			map.deleteAndDispose(r);
		}
		for (const a of diff.added) {
			map.set(a, handleItem(a));
		}
		oldData = new Set(newData);
	}));
	store.add(map);
	return store;
}
