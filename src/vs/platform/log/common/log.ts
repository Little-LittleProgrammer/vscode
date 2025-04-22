/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. 保留所有权利。
 *  根据 MIT 许可证授权。有关详细信息，请参阅项目根目录中的 License.txt。
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../nls.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../base/common/map.js';
import { isWindows } from '../../../base/common/platform.js';
import { joinPath } from '../../../base/common/resources.js';
import { Mutable, isNumber, isString } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { ILocalizedString } from '../../action/common/action.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILogService = createDecorator<ILogService>('logService');
export const ILoggerService = createDecorator<ILoggerService>('loggerService');

function now(): string {
	return new Date().toISOString();
}

export function isLogLevel(thing: unknown): thing is LogLevel {
	return isNumber(thing);
}

export enum LogLevel {
	Off,
	Trace,
	Debug,
	Info,
	Warning,
	Error
}

export const DEFAULT_LOG_LEVEL: LogLevel = LogLevel.Info;

export interface ILogger extends IDisposable {
	onDidChangeLogLevel: Event<LogLevel>;
	getLevel(): LogLevel;
	setLevel(level: LogLevel): void;

	trace(message: string, ...args: any[]): void;
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string | Error, ...args: any[]): void;

	/**
	 * 刷新内容的操作。可以是同步的。
	 */
	flush(): void;
}

export function canLog(loggerLevel: LogLevel, messageLevel: LogLevel): boolean {
	return loggerLevel !== LogLevel.Off && loggerLevel <= messageLevel;
}

export function log(logger: ILogger, level: LogLevel, message: string): void {
	switch (level) {
		case LogLevel.Trace: logger.trace(message); break;
		case LogLevel.Debug: logger.debug(message); break;
		case LogLevel.Info: logger.info(message); break;
		case LogLevel.Warning: logger.warn(message); break;
		case LogLevel.Error: logger.error(message); break;
		case LogLevel.Off: /* do nothing */ break;
		default: throw new Error(`Invalid log level ${level}`);
	}
}

function format(args: any, verbose: boolean = false): string {
	let result = '';

	for (let i = 0; i < args.length; i++) {
		let a = args[i];

		if (a instanceof Error) {
			a = toErrorMessage(a, verbose);
		}

		if (typeof a === 'object') {
			try {
				a = JSON.stringify(a);
			} catch (e) { }
		}

		result += (i > 0 ? ' ' : '') + a;
	}

	return result;
}

export type LoggerGroup = {
	readonly id: string;
	readonly name: string;
};

export interface ILogService extends ILogger {
	readonly _serviceBrand: undefined;
}

export interface ILoggerOptions {

	/**
	 * 日志记录器的 ID。
	 */
	id?: string;

	/**
	 * 日志记录器的名称。
	 */
	name?: string;

	/**
	 * 如果超过最大大小，则不创建轮换文件。
	 */
	donotRotate?: boolean;

	/**
	 * 不使用格式化程序。
	 */
	donotUseFormatters?: boolean;

	/**
	 * 何时记录。设置为 `always` 以始终记录。
	 */
	logLevel?: 'always' | LogLevel;

	/**
	 * 日志是否应对用户隐藏。
	 */
	hidden?: boolean;

	/**
	 * 显示此日志记录器必须为 true 的条件
	 */
	when?: string;

	/**
	 * 创建此日志记录器的扩展的 ID。
	 */
	extensionId?: string;

	/**
	 * 日志记录器的组。
	 */
	group?: LoggerGroup;
}

export interface ILoggerResource {
	readonly resource: URI;
	readonly id: string;
	readonly name?: string;
	readonly logLevel?: LogLevel;
	readonly hidden?: boolean;
	readonly when?: string;
	readonly extensionId?: string;
	readonly group?: LoggerGroup;
}

export type DidChangeLoggersEvent = {
	readonly added: Iterable<ILoggerResource>;
	readonly removed: Iterable<ILoggerResource>;
};

export interface ILoggerService {

	readonly _serviceBrand: undefined;

	/**
	 * 为给定资源创建日志记录器，如果已存在则获取一个。
	 *
	 * 这也会将日志记录器注册到日志记录器服务中。
	 */
	createLogger(resource: URI, options?: ILoggerOptions): ILogger;

	/**
	 * 在 logs 文件夹中创建具有给定 ID 的日志记录器，如果已存在则获取一个。
	 *
	 * 这也会将日志记录器注册到日志记录器服务中。
	 */
	createLogger(id: string, options?: Omit<ILoggerOptions, 'id'>): ILogger;

	/**
	 * 获取现有日志记录器（如果存在）。
	 */
	getLogger(resourceOrId: URI | string): ILogger | undefined;

	/**
	 * 当日志记录器的日志级别更改时触发的事件
	 */
	readonly onDidChangeLogLevel: Event<LogLevel | [URI, LogLevel]>;

	/**
	 * 设置默认日志级别。
	 */
	setLogLevel(level: LogLevel): void;

	/**
	 * 设置日志记录器的日志级别。
	 */
	setLogLevel(resource: URI, level: LogLevel): void;

	/**
	 * 获取日志记录器的日志级别或默认日志级别。
	 */
	getLogLevel(resource?: URI): LogLevel;

	/**
	 * 当日志记录器的可见性更改时触发的事件
	 */
	readonly onDidChangeVisibility: Event<[URI, boolean]>;

	/**
	 * 设置日志记录器的可见性。
	 */
	setVisibility(resourceOrId: URI | string, visible: boolean): void;

	/**
	 * 当日志记录器资源更改时触发的事件
	 */
	readonly onDidChangeLoggers: Event<DidChangeLoggersEvent>;

	/**
	 * 向日志记录器服务注册日志记录器。
	 *
	 * 请注意，这不会创建日志记录器，只会注册它。
	 *
	 * 使用 `createLogger` 创建日志记录器并注册它。
	 *
	 * 当您想要注册不是由日志记录器服务创建的日志记录器时使用它。
	 */
	registerLogger(resource: ILoggerResource): void;

	/**
	 * 注销给定资源的日志记录器。
	 */
	deregisterLogger(idOrResource: URI | string): void;

	/**
	 * 获取所有已注册的日志记录器
	 */
	getRegisteredLoggers(): Iterable<ILoggerResource>;

	/**
	 * 获取给定资源的已注册日志记录器。
	 */
	getRegisteredLogger(resource: URI): ILoggerResource | undefined;
}

export abstract class AbstractLogger extends Disposable implements ILogger {

	private level: LogLevel = DEFAULT_LOG_LEVEL;
	private readonly _onDidChangeLogLevel: Emitter<LogLevel> = this._register(new Emitter<LogLevel>());
	readonly onDidChangeLogLevel: Event<LogLevel> = this._onDidChangeLogLevel.event;

	setLevel(level: LogLevel): void {
		if (this.level !== level) {
			this.level = level;
			this._onDidChangeLogLevel.fire(this.level);
		}
	}

	getLevel(): LogLevel {
		return this.level;
	}

	protected checkLogLevel(level: LogLevel): boolean {
		return canLog(this.level, level);
	}

	protected canLog(level: LogLevel): boolean {
		if (this._store.isDisposed) {
			return false;
		}
		return this.checkLogLevel(level);
	}

	abstract trace(message: string, ...args: any[]): void;
	abstract debug(message: string, ...args: any[]): void;
	abstract info(message: string, ...args: any[]): void;
	abstract warn(message: string, ...args: any[]): void;
	abstract error(message: string | Error, ...args: any[]): void;
	abstract flush(): void;
}

export abstract class AbstractMessageLogger extends AbstractLogger implements ILogger {

	constructor(private readonly logAlways?: boolean) {
		super();
	}

	protected override checkLogLevel(level: LogLevel): boolean {
		return this.logAlways || super.checkLogLevel(level);
	}

	trace(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Trace)) {
			this.log(LogLevel.Trace, format([message, ...args], true));
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Debug)) {
			this.log(LogLevel.Debug, format([message, ...args]));
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Info)) {
			this.log(LogLevel.Info, format([message, ...args]));
		}
	}

	warn(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Warning)) {
			this.log(LogLevel.Warning, format([message, ...args]));
		}
	}

	error(message: string | Error, ...args: any[]): void {
		if (this.canLog(LogLevel.Error)) {
			if (message instanceof Error) {
				const array = Array.prototype.slice.call(arguments) as any[];
				array[0] = message.stack;
				this.log(LogLevel.Error, format(array));
			} else {
				this.log(LogLevel.Error, format([message, ...args]));
			}
		}
	}

	flush(): void { }

	protected abstract log(level: LogLevel, message: string): void;
}


export class ConsoleMainLogger extends AbstractLogger implements ILogger {

	private useColors: boolean;

	constructor(logLevel: LogLevel = DEFAULT_LOG_LEVEL) {
		super();
		this.setLevel(logLevel);
		this.useColors = !isWindows;
	}

	trace(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Trace)) {
			if (this.useColors) {
				console.log(`\x1b[90m[main ${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[main ${now()}]`, message, ...args);
			}
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Debug)) {
			if (this.useColors) {
				console.log(`\x1b[90m[main ${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[main ${now()}]`, message, ...args);
			}
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Info)) {
			if (this.useColors) {
				console.log(`\x1b[90m[main ${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[main ${now()}]`, message, ...args);
			}
		}
	}

	warn(message: string | Error, ...args: any[]): void {
		if (this.canLog(LogLevel.Warning)) {
			if (this.useColors) {
				console.warn(`\x1b[93m[main ${now()}]\x1b[0m`, message, ...args);
			} else {
				console.warn(`[main ${now()}]`, message, ...args);
			}
		}
	}

	error(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Error)) {
			if (this.useColors) {
				console.error(`\x1b[91m[main ${now()}]\x1b[0m`, message, ...args);
			} else {
				console.error(`[main ${now()}]`, message, ...args);
			}
		}
	}

	flush(): void {
		// noop
	}

}

export class ConsoleLogger extends AbstractLogger implements ILogger {

	constructor(logLevel: LogLevel = DEFAULT_LOG_LEVEL, private readonly useColors: boolean = true) {
		super();
		this.setLevel(logLevel);
	}

	trace(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Trace)) {
			if (this.useColors) {
				console.log('%cTRACE', 'color: #888', message, ...args);
			} else {
				console.log(message, ...args);
			}
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Debug)) {
			if (this.useColors) {
				console.log('%cDEBUG', 'background: #eee; color: #888', message, ...args);
			} else {
				console.log(message, ...args);
			}
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Info)) {
			if (this.useColors) {
				console.log('%c INFO', 'color: #33f', message, ...args);
			} else {
				console.log(message, ...args);
			}
		}
	}

	warn(message: string | Error, ...args: any[]): void {
		if (this.canLog(LogLevel.Warning)) {
			if (this.useColors) {
				console.warn('%c WARN', 'color: #993', message, ...args);
			} else {
				console.log(message, ...args);
			}
		}
	}

	error(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Error)) {
			if (this.useColors) {
				console.error('%c  ERR', 'color: #f33', message, ...args);
			} else {
				console.error(message, ...args);
			}
		}
	}


	flush(): void {
		// noop
	}
}

export class AdapterLogger extends AbstractLogger implements ILogger {

	constructor(private readonly adapter: { log: (logLevel: LogLevel, args: any[]) => void }, logLevel: LogLevel = DEFAULT_LOG_LEVEL) {
		super();
		this.setLevel(logLevel);
	}

	trace(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Trace)) {
			this.adapter.log(LogLevel.Trace, [this.extractMessage(message), ...args]);
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Debug)) {
			this.adapter.log(LogLevel.Debug, [this.extractMessage(message), ...args]);
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.canLog(LogLevel.Info)) {
			this.adapter.log(LogLevel.Info, [this.extractMessage(message), ...args]);
		}
	}

	warn(message: string | Error, ...args: any[]): void {
		if (this.canLog(LogLevel.Warning)) {
			this.adapter.log(LogLevel.Warning, [this.extractMessage(message), ...args]);
		}
	}

	error(message: string | Error, ...args: any[]): void {
		if (this.canLog(LogLevel.Error)) {
			this.adapter.log(LogLevel.Error, [this.extractMessage(message), ...args]);
		}
	}

	private extractMessage(msg: string | Error): string {
		if (typeof msg === 'string') {
			return msg;
		}

		return toErrorMessage(msg, this.canLog(LogLevel.Trace));
	}

	flush(): void {
		// noop
	}
}

export class MultiplexLogger extends AbstractLogger implements ILogger {

	constructor(private readonly loggers: ReadonlyArray<ILogger>) {
		super();
		if (loggers.length) {
			this.setLevel(loggers[0].getLevel());
		}
	}

	override setLevel(level: LogLevel): void {
		for (const logger of this.loggers) {
			logger.setLevel(level);
		}
		super.setLevel(level);
	}

	trace(message: string, ...args: any[]): void {
		for (const logger of this.loggers) {
			logger.trace(message, ...args);
		}
	}

	debug(message: string, ...args: any[]): void {
		for (const logger of this.loggers) {
			logger.debug(message, ...args);
		}
	}

	info(message: string, ...args: any[]): void {
		for (const logger of this.loggers) {
			logger.info(message, ...args);
		}
	}

	warn(message: string, ...args: any[]): void {
		for (const logger of this.loggers) {
			logger.warn(message, ...args);
		}
	}

	error(message: string | Error, ...args: any[]): void {
		for (const logger of this.loggers) {
			logger.error(message, ...args);
		}
	}

	flush(): void {
		for (const logger of this.loggers) {
			logger.flush();
		}
	}

	override dispose(): void {
		for (const logger of this.loggers) {
			logger.dispose();
		}
		super.dispose();
	}
}

type LoggerEntry = { logger: ILogger | undefined; info: Mutable<ILoggerResource> };

export abstract class AbstractLoggerService extends Disposable implements ILoggerService {

	declare readonly _serviceBrand: undefined;

	private readonly _loggers = new ResourceMap<LoggerEntry>();

	private _onDidChangeLoggers = this._register(new Emitter<{ added: ILoggerResource[]; removed: ILoggerResource[] }>);
	readonly onDidChangeLoggers = this._onDidChangeLoggers.event;

	private _onDidChangeLogLevel = this._register(new Emitter<LogLevel | [URI, LogLevel]>);
	readonly onDidChangeLogLevel = this._onDidChangeLogLevel.event;

	private _onDidChangeVisibility = this._register(new Emitter<[URI, boolean]>);
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	constructor(
		protected logLevel: LogLevel,
		private readonly logsHome: URI,
		loggerResources?: Iterable<ILoggerResource>,
	) {
		super();
		if (loggerResources) {
			for (const loggerResource of loggerResources) {
				this._loggers.set(loggerResource.resource, { logger: undefined, info: loggerResource });
			}
		}
	}

	private getLoggerEntry(resourceOrId: URI | string): LoggerEntry | undefined {
		if (isString(resourceOrId)) {
			return [...this._loggers.values()].find(logger => logger.info.id === resourceOrId);
		}
		return this._loggers.get(resourceOrId);
	}

	getLogger(resourceOrId: URI | string): ILogger | undefined {
		return this.getLoggerEntry(resourceOrId)?.logger;
	}

	createLogger(idOrResource: URI | string, options?: ILoggerOptions): ILogger {
		const resource = this.toResource(idOrResource);
		const id = isString(idOrResource) ? idOrResource : (options?.id ?? hash(resource.toString()).toString(16));
		let logger = this._loggers.get(resource)?.logger;
		const logLevel = options?.logLevel === 'always' ? LogLevel.Trace : options?.logLevel;
		if (!logger) {
			logger = this.doCreateLogger(resource, logLevel ?? this.getLogLevel(resource) ?? this.logLevel, { ...options, id });
		}
		const loggerEntry: LoggerEntry = {
			logger,
			info: {
				resource,
				id,
				logLevel,
				name: options?.name,
				hidden: options?.hidden,
				group: options?.group,
				extensionId: options?.extensionId,
				when: options?.when
			}
		};
		this.registerLogger(loggerEntry.info);
		this._loggers.set(resource, loggerEntry);
		return logger;
	}

	protected toResource(idOrResource: string | URI): URI {
		return isString(idOrResource) ? joinPath(this.logsHome, `${idOrResource}.log`) : idOrResource;
	}

	setLogLevel(logLevel: LogLevel): void;
	setLogLevel(resource: URI, logLevel: LogLevel): void;
	setLogLevel(arg1: any, arg2?: any): void {
		if (URI.isUri(arg1)) {
			const resource = arg1;
			const logLevel = arg2;
			const logger = this._loggers.get(resource);
			if (logger && logLevel !== logger.info.logLevel) {
				logger.info.logLevel = logLevel === this.logLevel ? undefined : logLevel;
				logger.logger?.setLevel(logLevel);
				this._loggers.set(logger.info.resource, logger);
				this._onDidChangeLogLevel.fire([resource, logLevel]);
			}
		} else {
			this.logLevel = arg1;
			for (const [resource, logger] of this._loggers.entries()) {
				if (this._loggers.get(resource)?.info.logLevel === undefined) {
					logger.logger?.setLevel(this.logLevel);
				}
			}
			this._onDidChangeLogLevel.fire(this.logLevel);
		}
	}

	setVisibility(resourceOrId: URI | string, visibility: boolean): void {
		const logger = this.getLoggerEntry(resourceOrId);
		if (logger && visibility !== !logger.info.hidden) {
			logger.info.hidden = !visibility;
			this._loggers.set(logger.info.resource, logger);
			this._onDidChangeVisibility.fire([logger.info.resource, visibility]);
		}
	}

	getLogLevel(resource?: URI): LogLevel {
		let logLevel;
		if (resource) {
			logLevel = this._loggers.get(resource)?.info.logLevel;
		}
		return logLevel ?? this.logLevel;
	}

	registerLogger(resource: ILoggerResource): void {
		const existing = this._loggers.get(resource.resource);
		if (existing) {
			if (existing.info.hidden !== resource.hidden) {
				this.setVisibility(resource.resource, !resource.hidden);
			}
		} else {
			this._loggers.set(resource.resource, { info: resource, logger: undefined });
			this._onDidChangeLoggers.fire({ added: [resource], removed: [] });
		}
	}

	deregisterLogger(idOrResource: URI | string): void {
		const resource = this.toResource(idOrResource);
		const existing = this._loggers.get(resource);
		if (existing) {
			if (existing.logger) {
				existing.logger.dispose();
			}
			this._loggers.delete(resource);
			this._onDidChangeLoggers.fire({ added: [], removed: [existing.info] });
		}
	}

	*getRegisteredLoggers(): Iterable<ILoggerResource> {
		for (const entry of this._loggers.values()) {
			yield entry.info;
		}
	}

	getRegisteredLogger(resource: URI): ILoggerResource | undefined {
		return this._loggers.get(resource)?.info;
	}

	override dispose(): void {
		this._loggers.forEach(logger => logger.logger?.dispose());
		this._loggers.clear();
		super.dispose();
	}

	protected abstract doCreateLogger(resource: URI, logLevel: LogLevel, options?: ILoggerOptions): ILogger;
}

export class NullLogger implements ILogger {
	readonly onDidChangeLogLevel: Event<LogLevel> = new Emitter<LogLevel>().event;
	setLevel(level: LogLevel): void { }
	getLevel(): LogLevel { return LogLevel.Info; }
	trace(message: string, ...args: any[]): void { }
	debug(message: string, ...args: any[]): void { }
	info(message: string, ...args: any[]): void { }
	warn(message: string, ...args: any[]): void { }
	error(message: string | Error, ...args: any[]): void { }
	critical(message: string | Error, ...args: any[]): void { }
	dispose(): void { }
	flush(): void { }
}

export class NullLogService extends NullLogger implements ILogService {
	declare readonly _serviceBrand: undefined;
}

export function getLogLevel(environmentService: IEnvironmentService): LogLevel {
	if (environmentService.verbose) {
		return LogLevel.Trace;
	}
	if (typeof environmentService.logLevel === 'string') {
		const logLevel = parseLogLevel(environmentService.logLevel.toLowerCase());
		if (logLevel !== undefined) {
			return logLevel;
		}
	}
	return DEFAULT_LOG_LEVEL;
}

export function LogLevelToString(logLevel: LogLevel): string {
	switch (logLevel) {
		case LogLevel.Trace: return 'trace';
		case LogLevel.Debug: return 'debug';
		case LogLevel.Info: return 'info';
		case LogLevel.Warning: return 'warn';
		case LogLevel.Error: return 'error';
		case LogLevel.Off: return 'off';
	}
}

export function LogLevelToLocalizedString(logLevel: LogLevel): ILocalizedString {
	switch (logLevel) {
		case LogLevel.Trace: return { original: 'Trace', value: nls.localize('trace', "Trace") };
		case LogLevel.Debug: return { original: 'Debug', value: nls.localize('debug', "Debug") };
		case LogLevel.Info: return { original: 'Info', value: nls.localize('info', "Info") };
		case LogLevel.Warning: return { original: 'Warning', value: nls.localize('warn', "Warning") };
		case LogLevel.Error: return { original: 'Error', value: nls.localize('error', "Error") };
		case LogLevel.Off: return { original: 'Off', value: nls.localize('off', "Off") };
	}
}

export function parseLogLevel(logLevel: string): LogLevel | undefined {
	switch (logLevel) {
		case 'trace':
			return LogLevel.Trace;
		case 'debug':
			return LogLevel.Debug;
		case 'info':
			return LogLevel.Info;
		case 'warn':
			return LogLevel.Warning;
		case 'error':
			return LogLevel.Error;
		case 'critical':
			return LogLevel.Error;
		case 'off':
			return LogLevel.Off;
	}
	return undefined;
}

// Contexts
export const CONTEXT_LOG_LEVEL = new RawContextKey<string>('logLevel', LogLevelToString(LogLevel.Info));
