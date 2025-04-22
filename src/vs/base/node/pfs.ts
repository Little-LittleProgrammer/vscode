/*---------------------------------------------------------------------------------------------
 * 版权所有 (c) Microsoft Corporation。保留所有权利。
 * 根据 MIT 许可证授权。有关详细信息，请参阅项目根目录中的 License.txt。
 *--------------------------------------------------------------------------------------------*/

/**
 * 文件系统操作模块
 * 对 Node.js 内置 fs 模块功能的封装和扩展，提供了更健壮、更易用（基于 Promise）且针对特定平台（如 macOS 的 NFC）和场景（如跨磁盘移动、文件写入刷新、符号链接处理）优化的文件系统操作。
 * 提供文件和目录的创建、读取、写入、删除等操作
 */
import * as fs from 'fs'; // 导入 Node.js 文件系统模块
import { tmpdir } from 'os'; // 导入操作系统模块以获取临时目录
import { promisify } from 'util'; // 导入 promisify 工具，将回调风格函数转换为 Promise 风格
import { ResourceQueue, timeout } from '../common/async.js'; // 导入异步工具：资源队列和超时
import { isEqualOrParent, isRootOrDriveLetter, randomPath } from '../common/extpath.js'; // 导入路径扩展工具
import { normalizeNFC } from '../common/normalization.js'; // 导入 Unicode 规范化工具
import { join } from '../common/path.js'; // 导入路径处理工具
import { isLinux, isMacintosh, isWindows } from '../common/platform.js'; // 导入平台判断工具
import { extUriBiasedIgnorePathCase } from '../common/resources.js'; // 导入资源处理工具
import { URI } from '../common/uri.js'; // 导入 URI 处理工具

//#region rimraf (递归删除)

export enum RimRafMode { // 定义递归删除模式枚举

	/**
	 * 慢速版本，逐个取消链接文件和文件夹。
	 */
	UNLINK,

	/**
	 * 快速版本，首先将文件/文件夹移动到临时目录，
	 * 然后在后台删除，无需等待其完成。
	 */
	MOVE
}

/**
 * 允许递归删除提供的路径（文件或文件夹），并提供选项：
 * - `UNLINK`: 直接从磁盘删除。
 * - `MOVE`: 更快的变体，首先将目标移动到临时目录，然后在后台删除，
 *           无需等待其完成。可选的 `moveToPath` 允许覆盖重命名路径
 *           的位置，然后再删除它。
 */
async function rimraf(path: string, mode: RimRafMode.UNLINK): Promise<void>; // 重载：使用 UNLINK 模式
async function rimraf(path: string, mode: RimRafMode.MOVE, moveToPath?: string): Promise<void>; // 重载：使用 MOVE 模式
async function rimraf(path: string, mode?: RimRafMode, moveToPath?: string): Promise<void>; // 重载：可选模式
async function rimraf(path: string, mode = RimRafMode.UNLINK, moveToPath?: string): Promise<void> { // 实现
	if (isRootOrDriveLetter(path)) { // 检查是否为根目录或驱动器号
		throw new Error('rimraf - will refuse to recursively delete root'); // 拒绝删除根目录
	}

	// 删除：通过 rm
	if (mode === RimRafMode.UNLINK) {
		return rimrafUnlink(path); // 调用 unlink 模式的删除函数
	}

	// 删除：通过 move
	return rimrafMove(path, moveToPath); // 调用 move 模式的删除函数
}

// 使用移动方式递归删除
async function rimrafMove(path: string, moveToPath = randomPath(tmpdir())): Promise<void> {
	try {
		try {
			await fs.promises.rename(path, moveToPath); // 尝试将路径重命名到临时位置
		} catch (error: any) {
			if (error.code === 'ENOENT') { // 如果源路径不存在
				return; // 忽略 - 要删除的路径不存在
			}

			return rimrafUnlink(path); // 否则回退到 unlink 模式
		}

		// 在后台删除，不等待 Promise 返回
		rimrafUnlink(moveToPath).catch(error => {/* ignore */ }); // 忽略后台删除可能出现的错误
	} catch (error: any) {
		if (error.code !== 'ENOENT') { // 如果错误不是 "文件不存在"
			throw error; // 抛出其他错误
		}
		// 如果是 ENOENT，则忽略，因为目标路径已不存在
	}
}

// 使用 unlink 方式递归删除
async function rimrafUnlink(path: string): Promise<void> {
	// 使用 fs.promises.rm 进行递归强制删除，并进行最多 3 次重试
	return fs.promises.rm(path, { recursive: true, force: true, maxRetries: 3 });
}

// 同步版本的 rimraf
export function rimrafSync(path: string): void {
	if (isRootOrDriveLetter(path)) { // 检查是否为根目录或驱动器号
		throw new Error('rimraf - will refuse to recursively delete root'); // 拒绝删除根目录
	}

	// 使用 fs.rmSync 进行同步递归强制删除，并进行最多 3 次重试
	fs.rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

//#endregion

//#region readdir with NFC support (macos) (支持 NFC 规范化的 readdir)

export interface IDirent { // 定义目录项接口
	name: string; // 名称

	isFile(): boolean; // 是否是文件
	isDirectory(): boolean; // 是否是目录
	isSymbolicLink(): boolean; // 是否是符号链接
}

/**
 * `fs.readdir` 的替代品，支持将 macOS 的 NFD unicode 形式
 * 转换为 NFC (https://github.com/nodejs/node/issues/2165)
 */
async function readdir(path: string): Promise<string[]>; // 重载：返回字符串数组
async function readdir(path: string, options: { withFileTypes: true }): Promise<IDirent[]>; // 重载：返回 IDirent 数组
async function readdir(path: string, options?: { withFileTypes: true }): Promise<(string | IDirent)[]> { // 实现
	// 调用底层 readdir 函数，并处理子项（进行 NFC 规范化）
	return handleDirectoryChildren(await (options ? safeReaddirWithFileTypes(path) : fs.promises.readdir(path)));
}

// 安全地读取目录并获取文件类型
async function safeReaddirWithFileTypes(path: string): Promise<IDirent[]> {
	try {
		// 尝试使用带有 withFileTypes 选项的 readdir
		return await fs.promises.readdir(path, { withFileTypes: true });
	} catch (error) {
		// 如果出错，记录警告
		console.warn('[node.js fs] readdir with filetypes failed with error: ', error);
	}

	// 如果上面的方法失败，则回退到手动读取并解析每个子项
	// 这种情况可能发生在特殊的文件系统上，例如 #115645 中描述的，
	// 其中 `readdir` 返回的条目之后无法进行 `lstat`。
	const result: IDirent[] = [];
	const children = await readdir(path); // 先获取子项名称列表
	for (const child of children) {
		let isFile = false;
		let isDirectory = false;
		let isSymbolicLink = false;

		try {
			// 对每个子项进行 lstat 以获取信息
			const lstat = await fs.promises.lstat(join(path, child));

			isFile = lstat.isFile();
			isDirectory = lstat.isDirectory();
			isSymbolicLink = lstat.isSymbolicLink();
		} catch (error) {
			// 如果 lstat 出错，记录警告
			console.warn('[node.js fs] unexpected error from lstat after readdir: ', error);
		}

		// 构建 IDirent 对象并添加到结果中
		result.push({
			name: child,
			isFile: () => isFile,
			isDirectory: () => isDirectory,
			isSymbolicLink: () => isSymbolicLink
		});
	}

	return result; // 返回手动构建的结果
}

/**
 * `fs.readdirSync` 的替代品，支持将 macOS 的 NFD unicode 形式
 * 转换为 NFC (https://github.com/nodejs/node/issues/2165)
 */
export function readdirSync(path: string): string[] {
	// 调用底层 readdirSync 并处理子项（进行 NFC 规范化）
	return handleDirectoryChildren(fs.readdirSync(path));
}

// 处理目录子项（进行 NFC 规范化）
function handleDirectoryChildren(children: string[]): string[]; // 重载：处理字符串数组
function handleDirectoryChildren(children: IDirent[]): IDirent[]; // 重载：处理 IDirent 数组
function handleDirectoryChildren(children: (string | IDirent)[]): (string | IDirent)[]; // 重载：处理混合数组
function handleDirectoryChildren(children: (string | IDirent)[]): (string | IDirent)[] { // 实现
	return children.map(child => {

		// Mac: 磁盘上使用 NFD unicode 形式，但我们想要 NFC
		// 参考 https://github.com/nodejs/node/issues/2165

		if (typeof child === 'string') { // 如果是字符串
			return isMacintosh ? normalizeNFC(child) : child; // 在 Mac 上进行 NFC 规范化
		}

		// 如果是 IDirent 对象
		child.name = isMacintosh ? normalizeNFC(child.name) : child.name; // 在 Mac 上规范化名称

		return child; // 返回处理后的子项
	});
}

/**
 * 一个方便的方法，用于读取路径下所有子目录的名称。
 */
async function readDirsInDir(dirPath: string): Promise<string[]> {
	const children = await readdir(dirPath); // 读取所有子项名称
	const directories: string[] = []; // 初始化目录数组

	for (const child of children) {
		// 检查子项是否为目录（支持符号链接）
		if (await SymlinkSupport.existsDirectory(join(dirPath, child))) {
			directories.push(child); // 如果是目录，添加到数组中
		}
	}

	return directories; // 返回目录名称数组
}

//#endregion

//#region whenDeleted() (等待删除)

/**
 * 一个 `Promise`，当提供的 `path` 从磁盘上删除时解析。
 * @param path 要监视的路径。
 * @param intervalMs 检查间隔（毫秒），默认为 1000。
 */
export function whenDeleted(path: string, intervalMs = 1000): Promise<void> {
	return new Promise<void>(resolve => {
		let running = false; // 标记检查是否正在进行
		const interval = setInterval(() => { // 设置定时器
			if (!running) { // 如果没有检查正在进行
				running = true; // 标记开始检查
				fs.access(path, err => { // 检查路径是否存在
					running = false; // 标记检查结束

					if (err) { // 如果访问出错（通常意味着文件不存在）
						clearInterval(interval); // 清除定时器
						resolve(undefined); // 解析 Promise
					}
				});
			}
		}, intervalMs); // 指定检查间隔
	});
}

//#endregion

//#region Methods with symbolic links support (支持符号链接的方法)

export namespace SymlinkSupport { // 定义支持符号链接的命名空间

	export interface IStats { // 定义 Stats 接口

		// 文件的状态信息。如果文件是符号链接，
		// stats 将是目标文件的状态，而不是链接本身。
		// 如果文件是符号链接，指向一个不存在的文件，
		// stat 将是链接本身的状态，并且 `dangling` 标志将指示这一点。
		stat: fs.Stats;

		// 如果资源在磁盘上是符号链接，则会提供此项。
		// 使用 `dangling` 标志来判断它是否指向一个
		// 磁盘上不存在的资源。
		symbolicLink?: { dangling: boolean }; // 可选的符号链接信息
	}

	/**
	 * 解析所提供路径的 `fs.Stats`。如果路径是符号链接，
	 * `fs.Stats` 将来自它指向的目标。如果目标不存在，
	 * `symbolicLink` 值将返回 `dangling: true`。
	 */
	export async function stat(path: string): Promise<IStats> {

		// 首先获取链接本身的状态
		let lstats: fs.Stats | undefined;
		try {
			lstats = await fs.promises.lstat(path); // 尝试获取 lstat

			// 如果根本不是符号链接，则提前返回
			if (!lstats.isSymbolicLink()) {
				return { stat: lstats }; // 返回 lstat 结果
			}
		} catch (error) {
			/* 忽略 - 改用 stat() */
		}

		// 如果是符号链接或获取 lstat 失败，则使用 fs.stat()
		// 对于符号链接，fs.stat() 会获取其指向的目标的状态
		try {
			const stats = await fs.promises.stat(path); // 尝试获取 stat

			// 返回目标的状态，并附带符号链接信息（如果 lstats 存在）
			return { stat: stats, symbolicLink: lstats?.isSymbolicLink() ? { dangling: false } : undefined };
		} catch (error: any) {

			// 如果链接指向不存在的文件，我们仍然希望
			// 将其作为结果返回，同时设置 dangling: true 标志
			if (error.code === 'ENOENT' && lstats) {
				return { stat: lstats, symbolicLink: { dangling: true } }; // 返回链接本身的状态，标记为 dangling
			}

			// Windows: 解决 node.js 不支持重解析点的 bug (https://github.com/nodejs/node/issues/36790)
			if (isWindows && error.code === 'EACCES') {
				try {
					// 尝试读取链接目标并获取其状态
					const stats = await fs.promises.stat(await fs.promises.readlink(path));

					return { stat: stats, symbolicLink: { dangling: false } }; // 返回目标状态
				} catch (innerError: any) {

					// 如果链接指向不存在的文件，我们仍然希望
					// 将其作为结果返回，同时设置 dangling: true 标志
					if (innerError.code === 'ENOENT' && lstats) {
						return { stat: lstats, symbolicLink: { dangling: true } }; // 返回链接本身的状态，标记为 dangling
					}

					throw innerError; // 抛出内部错误
				}
			}

			throw error; // 抛出原始错误
		}
	}

	/**
	 * 判断 `path` 是否存在并且是一个文件（支持符号链接）。
	 *
	 * 注意：对于磁盘上存在但悬空（指向不存在路径）的符号链接，
	 * 此函数将返回 `false`。
	 *
	 * 如果你只关心路径是否存在于磁盘上，而不考虑符号链接，
	 * 请使用 `exists`。
	 */
	export async function existsFile(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path); // 获取状态信息

			// 检查是否是文件且不是悬空链接
			return stat.isFile() && symbolicLink?.dangling !== true;
		} catch (error) {
			// 忽略错误，路径可能不存在
		}

		return false; // 默认返回 false
	}

	/**
	 * 判断 `path` 是否存在并且是一个目录（支持符号链接）。
	 *
	 * 注意：对于磁盘上存在但悬空（指向不存在路径）的符号链接，
	 * 此函数将返回 `false`。
	 *
	 * 如果你只关心路径是否存在于磁盘上，而不考虑符号链接，
	 * 请使用 `exists`。
	 */
	export async function existsDirectory(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path); // 获取状态信息

			// 检查是否是目录且不是悬空链接
			return stat.isDirectory() && symbolicLink?.dangling !== true;
		} catch (error) {
			// 忽略错误，路径可能不存在
		}

		return false; // 默认返回 false
	}
}

//#endregion

//#region Write File (写入文件)

// 根据 node.js 文档 (https://nodejs.org/docs/v14.16.0/api/fs.html#fs_fs_writefile_file_data_options_callback)
// 在未等待回调返回的情况下，多次调用 writeFile() 写入同一路径是不安全的。
// 因此，我们对给定的路径使用队列，以正确地序列化对同一路径的调用。
const writeQueues = new ResourceQueue(); // 创建写入队列

/**
 * 与 `fs.writeFile` 相同，但在写入后额外调用 `fs.fdatasync`
 * 以确保更改刷新到磁盘。
 *
 * 此外，对同一路径的多次写入会被排队。
 */
function writeFile(path: string, data: string, options?: IWriteFileOptions): Promise<void>; // 重载：写入字符串
function writeFile(path: string, data: Buffer, options?: IWriteFileOptions): Promise<void>; // 重载：写入 Buffer
function writeFile(path: string, data: Uint8Array, options?: IWriteFileOptions): Promise<void>; // 重载：写入 Uint8Array
function writeFile(path: string, data: string | Buffer | Uint8Array, options?: IWriteFileOptions): Promise<void>; // 重载：写入多种类型
function writeFile(path: string, data: string | Buffer | Uint8Array, options?: IWriteFileOptions): Promise<void> { // 实现
	return writeQueues.queueFor(URI.file(path), () => { // 为文件路径获取队列
		const ensuredOptions = ensureWriteOptions(options); // 确保写入选项有效

		// 返回一个新的 Promise
		return new Promise((resolve, reject) => doWriteFileAndFlush(path, data, ensuredOptions, error => error ? reject(error) : resolve()));
	}, extUriBiasedIgnorePathCase); // 使用忽略大小写的 URI 比较器
}

// 写入文件选项接口
interface IWriteFileOptions {
	mode?: number; // 文件模式
	flag?: string; // 文件标志
}

// 确保写入文件选项有效的接口
interface IEnsuredWriteFileOptions extends IWriteFileOptions {
	mode: number; // 文件模式（必填）
	flag: string; // 文件标志（必填）
}

let canFlush = true; // 是否启用写入时刷新
// 配置写入时是否刷新
export function configureFlushOnWrite(enabled: boolean): void {
	canFlush = enabled;
}

// 调用 fs.writeFile() 后跟一个 fs.fdatasync() 调用，将更改刷新到磁盘
// 在我们想要确保数据确实在磁盘上而不是在某个缓存中时执行此操作。
//
// 参考 https://github.com/nodejs/node/blob/v5.10.0/lib/fs.js#L1194
function doWriteFileAndFlush(path: string, data: string | Buffer | Uint8Array, options: IEnsuredWriteFileOptions, callback: (error: Error | null) => void): void {
	if (!canFlush) { // 如果禁用刷新
		// 直接调用 fs.writeFile
		return fs.writeFile(path, data, { mode: options.mode, flag: options.flag }, callback);
	}

	// 使用与 fs.writeFile() 相同的标志和模式打开文件
	fs.open(path, options.flag, options.mode, (openError, fd) => {
		if (openError) { // 如果打开文件出错
			return callback(openError); // 调用回调并传递错误
		}

		// 将 fd 句柄传递给 fs.writeFile() 是有效的，并且会保持句柄打开！
		fs.writeFile(fd, data, writeError => {
			if (writeError) { // 如果写入文件出错
				// 出错时仍需要关闭句柄！
				return fs.close(fd, () => callback(writeError));
			}

			// 将文件内容（而非元数据）刷新到磁盘
			// https://github.com/microsoft/vscode/issues/9589
			fs.fdatasync(fd, (syncError: Error | null) => {

				// 在某些特殊设置下，node 可能无法同步
				// 在这种情况下，我们禁用刷新并向控制台发出警告
				if (syncError) {
					console.warn('[node.js fs] fdatasync is now disabled for this session because it failed: ', syncError);
					configureFlushOnWrite(false); // 禁用刷新
				}

				// 关闭文件句柄并调用回调
				return fs.close(fd, closeError => callback(closeError ?? syncError)); // 如果 close 出错，优先返回 close 错误
			});
		});
	});
}


/**
 * 与 `fs.writeFileSync` 相同，但在写入后额外调用 `fs.fdatasyncSync`
 * 以确保更改刷新到磁盘。
 */
export function writeFileSync(path: string, data: string | Buffer, options?: IWriteFileOptions): void {
	const ensuredOptions = ensureWriteOptions(options); // 确保写入选项有效

	if (!canFlush) { // 如果禁用刷新
		// 直接调用 fs.writeFileSync
		return fs.writeFileSync(path, data, { mode: ensuredOptions.mode, flag: ensuredOptions.flag });
	}

	// 使用与 fs.writeFile() 相同的标志和模式打开文件
	const fd = fs.openSync(path, ensuredOptions.flag, ensuredOptions.mode);

	try {

		// 将 fd 句柄传递给 fs.writeFileSync() 是有效的，并且会保持句柄打开！
		fs.writeFileSync(fd, data);

		// 将文件内容（而非元数据）刷新到磁盘
		try {
			fs.fdatasyncSync(fd); // https://github.com/microsoft/vscode/issues/9589
		} catch (syncError) {
			// 如果同步出错，记录警告并禁用刷新
			console.warn('[node.js fs] fdatasyncSync is now disabled for this session because it failed: ', syncError);
			configureFlushOnWrite(false);
		}
	} finally {
		// 确保关闭文件句柄
		fs.closeSync(fd);
	}
}

// 确保写入选项具有默认值
function ensureWriteOptions(options?: IWriteFileOptions): IEnsuredWriteFileOptions {
	if (!options) { // 如果未提供选项
		// 返回默认选项
		return { mode: 0o666 /* node.js 文件的默认模式 */, flag: 'w' };
	}

	// 返回带有默认值的选项
	return {
		mode: typeof options.mode === 'number' ? options.mode : 0o666 /* node.js 文件的默认模式 */,
		flag: typeof options.flag === 'string' ? options.flag : 'w'
	};
}

//#endregion

//#region Move / Copy (移动 / 复制)

/**
 * `fs.rename` 的替代品，具有以下特性：
 * - 允许跨多个磁盘移动
 * - 在 Windows 上尝试对某些错误代码进行重试操作
 * @param source 源路径
 * @param target 目标路径
 * @param windowsRetryTimeout Windows 重试超时时间（毫秒），或 false 禁用重试。默认为 60000。
 */
async function rename(source: string, target: string, windowsRetryTimeout: number | false = 60000): Promise<void> {
	if (source === target) { // 如果源路径和目标路径相同
		return; // 模拟 node.js 行为，不执行任何操作
	}

	try {
		if (isWindows && typeof windowsRetryTimeout === 'number') { // 如果是 Windows 且启用了重试
			// 在 Windows 上，当源或目标被 AV 软件锁定时，重命名可能会失败。
			await renameWithRetry(source, target, Date.now(), windowsRetryTimeout); // 调用带重试的重命名
		} else {
			await fs.promises.rename(source, target); // 否则直接调用 fs.promises.rename
		}
	} catch (error: any) {
		// 在两种情况下，我们回退到经典的复制和删除：
		//
		// 1.) EXDEV 错误表示源和目标位于不同的设备上
		// 在这种情况下，回退到使用 copy() 操作，因为无法在不同设备之间 rename()。
		//
		// 2.) 用户尝试重命名以点结尾的文件/文件夹。这实际上无法移动，
		// 至少在 UNC 设备上是这样。
		if (source.toLowerCase() !== target.toLowerCase() && error.code === 'EXDEV' || source.endsWith('.')) {
			// 复制到另一个设备时不保留符号链接
			await copy(source, target, { preserveSymlinks: false });
			// 使用 MOVE 模式删除源文件/文件夹
			await rimraf(source, RimRafMode.MOVE);
		} else {
			throw error; // 抛出其他错误
		}
	}
}

// 带重试逻辑的重命名函数（主要用于 Windows）
async function renameWithRetry(source: string, target: string, startTime: number, retryTimeout: number, attempt = 0): Promise<void> {
	try {
		// 尝试重命名
		return await fs.promises.rename(source, target);
	} catch (error: any) {
		// 只对我们认为是临时性的错误进行重试
		if (error.code !== 'EACCES' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
			throw error; // 抛出非预期错误
		}

		// 如果超过了配置的超时时间，则放弃
		if (Date.now() - startTime >= retryTimeout) {
			console.error(`[node.js fs] rename failed after ${attempt} retries with error: ${error}`);
			throw error; // 抛出错误
		}

		// 第一次尝试时进行额外检查
		if (attempt === 0) {
			let abortRetry = false;
			try {
				// 检查目标路径状态
				const { stat } = await SymlinkSupport.stat(target);
				if (!stat.isFile()) {
					// 如果目标不是文件，EPERM 错误可能会被引发，我们不应尝试重试
					abortRetry = true;
				}
			} catch (error) {
				// 忽略检查错误
			}

			if (abortRetry) { // 如果需要中止重试
				throw error; // 抛出原始错误
			}
		}

		// 使用增量退避延迟，最多延迟 100 毫秒
		await timeout(Math.min(100, attempt * 10));

		// 再次尝试
		return renameWithRetry(source, target, startTime, retryTimeout, attempt + 1);
	}
}

// 复制操作的载荷接口
interface ICopyPayload {
	readonly root: { source: string; target: string }; // 源和目标的根路径
	readonly options: { preserveSymlinks: boolean }; // 复制选项（是否保留符号链接）
	readonly handledSourcePaths: Set<string>; // 已处理的源路径集合（用于防止循环）
}

/**
 * 将 `source` 的所有内容递归复制到 `target`。
 *
 * 选项 `preserveSymlinks` 配置遇到符号链接时应如何处理。
 * 设置为 `false` 不保留它们，设置为 `true` 则保留。
 */
async function copy(source: string, target: string, options: { preserveSymlinks: boolean }): Promise<void> {
	// 调用内部复制函数，并初始化载荷
	return doCopy(source, target, { root: { source, target }, options, handledSourcePaths: new Set<string>() });
}

// 复制文件或文件夹时，我们希望保留其模式，
// 并在创建时提供它。但是，模式可能超出我们的预期
//（参见下面的链接），因此我们对其进行掩码处理。
// (https://github.com/nodejs/node-v0.x-archive/issues/3045#issuecomment-4862588)
const COPY_MODE_MASK = 0o777; // 复制模式掩码

// 内部递归复制函数
async function doCopy(source: string, target: string, payload: ICopyPayload): Promise<void> {

	// 跟踪已复制的路径，以防止符号链接导致的循环问题
	if (payload.handledSourcePaths.has(source)) { // 如果已处理过
		return; // 直接返回
	} else {
		payload.handledSourcePaths.add(source); // 标记为已处理
	}

	// 获取源路径的状态信息（支持符号链接）
	const { stat, symbolicLink } = await SymlinkSupport.stat(source);

	// 如果是符号链接
	if (symbolicLink) {

		// 尝试重新创建符号链接，除非 `preserveSymlinks: false`
		if (payload.options.preserveSymlinks) {
			try {
				// 调用复制符号链接的函数
				return await doCopySymlink(source, target, payload);
			} catch (error) {
				// 任何错误都回退到通过解引用进行普通复制
			}
		}

		// 如果是悬空符号链接，则跳过（从现在开始）
		if (symbolicLink.dangling) {
			// (https://github.com/microsoft/vscode/issues/111621)
			return;
		}
	}

	// 如果是目录
	if (stat.isDirectory()) {
		// 调用复制目录的函数
		return doCopyDirectory(source, target, stat.mode & COPY_MODE_MASK, payload);
	}

	// 如果是文件或类文件
	else {
		// 调用复制文件的函数
		return doCopyFile(source, target, stat.mode & COPY_MODE_MASK);
	}
}

// 复制目录的内部函数
async function doCopyDirectory(source: string, target: string, mode: number, payload: ICopyPayload): Promise<void> {

	// 创建目标文件夹
	await fs.promises.mkdir(target, { recursive: true, mode });

	// 递归复制每个文件
	const files = await readdir(source); // 读取源目录内容
	for (const file of files) {
		// 对每个子项调用 doCopy
		await doCopy(join(source, file), join(target, file), payload);
	}
}

// 复制文件的内部函数
async function doCopyFile(source: string, target: string, mode: number): Promise<void> {

	// 复制文件
	await fs.promises.copyFile(source, target);

	// 恢复模式 (https://github.com/nodejs/node/issues/1104)
	await fs.promises.chmod(target, mode);
}

// 复制符号链接的内部函数
async function doCopySymlink(source: string, target: string, payload: ICopyPayload): Promise<void> {

	// 获取链接目标
	let linkTarget = await fs.promises.readlink(source);

	// 特殊情况：符号链接指向的目标实际上位于正在复制的路径内。
	// 在这种情况下，我们希望符号链接指向目标路径下的相应位置，而不是源路径。
	if (isEqualOrParent(linkTarget, payload.root.source, !isLinux)) { // 检查链接目标是否在源根路径下
		// 计算目标路径下的相对路径
		linkTarget = join(payload.root.target, linkTarget.substr(payload.root.source.length + 1));
	}

	// 创建符号链接
	await fs.promises.symlink(linkTarget, target);
}

//#endregion

//#region Promise based fs methods (基于 Promise 的 fs 方法)

/**
 * 一些底层 `fs` 方法，以 `Promises` 的形式提供，类似于 `fs.promises`，
 * 但有一些显著差异，要么由我们自己实现，要么恢复了原始的基于回调的行为。
 *
 * 至少 `realpath` 在基于 Promise 的实现中与基于回调的实现方式不同。
 * 基于 Promise 的实现实际上调用了 `fs.realpath.native`。
 * (https://github.com/microsoft/vscode/issues/118562)
 */
export const Promises = new class { // 定义 Promises 对象

	//#region Implemented by node.js (由 node.js 实现)

	get read() { // 获取 read 方法

		// 这里不使用 `promisify` 是有原因的：返回类型不像 TypeScript
		// 指示的那样是一个对象，而只是读取的字节数，所以我们创建自己的包装器。

		return (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
			return new Promise<{ bytesRead: number; buffer: Uint8Array }>((resolve, reject) => {
				// 调用原始的 fs.read
				fs.read(fd, buffer, offset, length, position, (err, bytesRead, buffer) => {
					if (err) {
						return reject(err);
					}

					return resolve({ bytesRead, buffer }); // 返回包含 bytesRead 和 buffer 的对象
				});
			});
		};
	}

	get write() { // 获取 write 方法

		// 这里不使用 `promisify` 是有原因的：返回类型不像 TypeScript
		// 指示的那样是一个对象，而只是写入的字节数，所以我们创建自己的包装器。

		return (fd: number, buffer: Uint8Array, offset: number | undefined | null, length: number | undefined | null, position: number | undefined | null) => {
			return new Promise<{ bytesWritten: number; buffer: Uint8Array }>((resolve, reject) => {
				// 调用原始的 fs.write
				fs.write(fd, buffer, offset, length, position, (err, bytesWritten, buffer) => {
					if (err) {
						return reject(err);
					}

					return resolve({ bytesWritten, buffer }); // 返回包含 bytesWritten 和 buffer 的对象
				});
			});
		};
	}

	get fdatasync() { return promisify(fs.fdatasync); } // 在 20.x 中尚未作为 API 公开

	get open() { return promisify(fs.open); } 			// 在 Promise API 中更改为返回 `FileHandle`
	get close() { return promisify(fs.close); } 		// 由于 `open` 的 `FileHandle` 返回类型而未作为 API 公开

	get realpath() { return promisify(fs.realpath); }	// `fs.promises.realpath` 将使用我们不希望的 `fs.realpath.native`

	get ftruncate() { return promisify(fs.ftruncate); } // 在 20.x 中尚未作为 API 公开

	//#endregion

	//#region Implemented by us (由我们实现)

	// 检查路径是否存在
	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path); // 尝试访问路径

			return true; // 成功则存在
		} catch {
			return false; // 失败则不存在
		}
	}

	get readdir() { return readdir; } // 获取我们实现的 readdir
	get readDirsInDir() { return readDirsInDir; } // 获取我们实现的 readDirsInDir

	get writeFile() { return writeFile; } // 获取我们实现的 writeFile

	get rm() { return rimraf; } // 获取我们实现的 rm (rimraf)

	get rename() { return rename; } // 获取我们实现的 rename
	get copy() { return copy; } // 获取我们实现的 copy

	//#endregion
};

//#endregion
