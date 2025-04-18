/*---------------------------------------------------------------------------------------------
 *  版权所有 (c) Microsoft Corporation。保留所有权利。
 *  根据 MIT 许可证授权。详见项目根目录下的 License.txt 文件。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'original-fs';
import * as os from 'os';
import { performance } from 'perf_hooks';
import { configurePortable } from './bootstrap-node.js';
import { bootstrapESM } from './bootstrap-esm.js';
import { fileURLToPath } from 'url';
import { app, protocol, crashReporter, Menu, contentTracing } from 'electron';
import minimist from 'minimist';
import { product } from './bootstrap-meta.js';
import { parse } from './vs/base/common/jsonc.js';
import { getUserDataPath } from './vs/platform/environment/node/userDataPath.js';
import * as perf from './vs/base/common/performance.js';
import { resolveNLSConfiguration } from './vs/base/node/nls.js';
import { getUNCHost, addUNCHostToAllowlist } from './vs/base/node/unc.js';
import { INLSConfiguration } from './vs/nls.js';
import { NativeParsedArgs } from './vs/platform/environment/common/argv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

perf.mark('code/didStartMain');

perf.mark('code/willLoadMainBundle', {
	// 构建时，主包是一个包含所有内联依赖的单一 JS 文件。
	// 因此，我们将 `willLoadMainBundle` 标记为主包加载过程的开始。
	startTime: Math.floor(performance.timeOrigin)
});
perf.mark('code/didLoadMainBundle');

// 启用便携模式支持
const portable = configurePortable(product);

const args = parseCLIArgs();
// 配置静态命令行参数
const argvConfig = configureCommandlineSwitchesSync(args);
// 全局启用沙箱，除非
// 1) 通过命令行使用 `--no-sandbox` 或 `--disable-chromium-sandbox` 参数禁用。
// 2) argv.json 包含 `disable-chromium-sandbox: true`。
if (args['sandbox'] &&
	!args['disable-chromium-sandbox'] &&
	!argvConfig['disable-chromium-sandbox']) {
	app.enableSandbox();
} else if (app.commandLine.hasSwitch('no-sandbox') &&
	!app.commandLine.hasSwitch('disable-gpu-sandbox')) {
	// 当使用 --no-sandbox 时，禁用 GPU 沙箱。
	app.commandLine.appendSwitch('disable-gpu-sandbox');
} else {
	app.commandLine.appendSwitch('no-sandbox');
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 在 app 'ready' 事件之前设置 userData 路径
const userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');
if (process.platform === 'win32') {
	const userDataUNCHost = getUNCHost(userDataPath);
	if (userDataUNCHost) {
		addUNCHostToAllowlist(userDataUNCHost); // 允许在 userDataPath 中使用 UNC 路径
	}
}
app.setPath('userData', userDataPath);

// 解析代码缓存路径
const codeCachePath = getCodeCachePath();

// 禁用默认菜单 (https://github.com/electron/electron/issues/35512)
Menu.setApplicationMenu(null);

// 配置崩溃报告器
perf.mark('code/willStartCrashReporter');
// 如果指定了 crash-reporter-directory，我们将崩溃报告存储在指定目录中，
// 并且不将它们上传到崩溃服务器。
//
// 如果满足以下条件，则启用 Appcenter 崩溃报告：
// * 运行时参数 enable-crash-reporter 设置为 'true'
// * 未设置 --disable-crash-reporter 命令行参数
//
// 在所有其他情况下禁用崩溃报告。
if (args['crash-reporter-directory'] || (argvConfig['enable-crash-reporter'] && !args['disable-crash-reporter'])) {
	configureCrashReporter();
}
perf.mark('code/didStartCrashReporter');

// 如果以便携模式运行，在 app 'ready' 事件之前设置日志路径，
// 以确保不会在便携目录之外的位置创建 'logs' 文件夹
// (https://github.com/microsoft/vscode/issues/56651)
if (portable && portable.isPortable) {
	app.setAppLogsPath(path.join(userDataPath, 'logs'));
}

// 注册具有权限的自定义协议
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'vscode-webview',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, codeCache: true }
	},
	{
		scheme: 'vscode-file',
		privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, codeCache: true }
	}
]);

// 全局应用监听器
registerListeners();

/**
 * 如果 NLS 配置在 argv.json 中定义了，我们可以在 `app.ready` 事件之前提前解析它。
 * 否则，我们只能在 `app.ready` 事件之后解析 NLS，以便解析操作系统区域设置。
 */
let nlsConfigurationPromise: Promise<INLSConfiguration> | undefined = undefined;

// 使用最优选的操作系统语言进行语言推荐。
// 在 Linux 上，该 API 可能返回一个空数组，例如当 'C' 区域设置是用户唯一配置的区域设置时。
// 无论操作系统如何，如果数组为空，则默认回退到 'en'。
const osLocale = processZhLocale((app.getPreferredSystemLanguages()?.[0] ?? 'en').toLowerCase());
const userLocale = getUserDefinedLocale(argvConfig);
if (userLocale) {
	nlsConfigurationPromise = resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: product.commit,
		userDataPath,
		nlsMetadataPath: __dirname
	});
}

// 将区域设置传递给 Electron，以便在 Windows 上正确渲染
// Windows Control Overlay。
// 目前，由于 https://github.com/microsoft/vscode/issues/167543，
// 不在 macOS 上传递区域设置。
// 如果区域设置是 `qps-ploc`，则表示正在使用 Microsoft
// Pseudo Language Language Pack。
// 在这种情况下，使用 `en` 作为 Electron 的区域设置。

if (process.platform === 'win32' || process.platform === 'linux') {
	const electronLocale = (!userLocale || userLocale === 'qps-ploc') ? 'en' : userLocale;
	app.commandLine.appendSwitch('lang	', electronLocale);
}

// 在准备就绪后加载我们的代码
app.once('ready', function () {
	if (args['trace']) {
		let traceOptions: Electron.TraceConfig | Electron.TraceCategoriesAndOptions;
		if (args['trace-memory-infra']) {
			const customCategories = args['trace-category-filter']?.split(',') || [];
			customCategories.push('disabled-by-default-memory-infra', 'disabled-by-default-memory-infra.v8.code_stats');
			traceOptions = {
				included_categories: customCategories,
				excluded_categories: ['*'],
				memory_dump_config: {
					allowed_dump_modes: ['light', 'detailed'],
					triggers: [
						{
							type: 'periodic_interval',
							mode: 'detailed',
							min_time_between_dumps_ms: 10000
						},
						{
							type: 'periodic_interval',
							mode: 'light',
							min_time_between_dumps_ms: 1000
						}
					]
				}
			};
		} else {
			traceOptions = {
				categoryFilter: args['trace-category-filter'] || '*',
				traceOptions: args['trace-options'] || 'record-until-full,enable-sampling'
			};
		}

		contentTracing.startRecording(traceOptions).finally(() => onReady());
	} else {
		onReady();
	}
});

async function onReady() {
	perf.mark('code/mainAppReady');

	try {
		const [, nlsConfig] = await Promise.all([
			mkdirpIgnoreError(codeCachePath),
			resolveNlsConfiguration()
		]);

		await startup(codeCachePath, nlsConfig);
	} catch (error) {
		console.error(error);
	}
}

/**
 * 主启动例程
 */
async function startup(codeCachePath: string | undefined, nlsConfig: INLSConfiguration): Promise<void> {
	process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
	process.env['VSCODE_CODE_CACHE_PATH'] = codeCachePath || '';

	// 引导 ESM
	await bootstrapESM();

	// 加载 Main
	await import('./vs/code/electron-main/main.js');
	perf.mark('code/didRunMainBundle');
}

function configureCommandlineSwitchesSync(cliArgs: NativeParsedArgs) {
	const SUPPORTED_ELECTRON_SWITCHES = [

		// 我们为 --disable-gpu 设置的别名
		'disable-hardware-acceleration',

		// 覆盖要使用的颜色配置文件
		'force-color-profile',

		// 禁用 LCD 字体渲染，一个 Chromium 标志
		'disable-lcd-text',

		// 对给定的分号分隔的主机列表绕过任何指定的代理
		'proxy-bypass-list'
	];

	if (process.platform === 'linux') {

		// 通过此标志在 Linux 上强制启用屏幕阅读器
		SUPPORTED_ELECTRON_SWITCHES.push('force-renderer-accessibility');

		// 覆盖在 Linux 上使用的密码存储
		SUPPORTED_ELECTRON_SWITCHES.push('password-store');
	}

	const SUPPORTED_MAIN_PROCESS_SWITCHES = [

		// 通过 argv.json 持久启用 proposed api: https://github.com/microsoft/vscode/issues/99775
		'enable-proposed-api',

		// 要使用的日志级别。默认为 'info'。允许的值为 'error', 'warn', 'info', 'debug', 'trace', 'off'。
		'log-level',

		// 对机密使用内存存储
		'use-inmemory-secretstorage'
	];

	// 读取 argv 配置
	const argvConfig = readArgvConfigSync();

	Object.keys(argvConfig).forEach(argvKey => {
		const argvValue = argvConfig[argvKey];

		// 将 Electron 标志附加到 Electron
		if (SUPPORTED_ELECTRON_SWITCHES.indexOf(argvKey) !== -1) {
			if (argvValue === true || argvValue === 'true') {
				if (argvKey === 'disable-hardware-acceleration') {
					app.disableHardwareAcceleration(); // 需要显式调用
				} else {
					app.commandLine.appendSwitch(argvKey);
				}
			} else if (typeof argvValue === 'string' && argvValue) {
				if (argvKey === 'password-store') {
					// 密码存储
					// TODO@TylerLeonhardt: 3个月后移除此迁移
					let migratedArgvValue = argvValue;
					if (argvValue === 'gnome' || argvValue === 'gnome-keyring') {
						migratedArgvValue = 'gnome-libsecret';
					}
					app.commandLine.appendSwitch(argvKey, migratedArgvValue);
				} else {
					app.commandLine.appendSwitch(argvKey, argvValue);
				}
			}
		}

		// 将主进程标志附加到 process.argv
		else if (SUPPORTED_MAIN_PROCESS_SWITCHES.indexOf(argvKey) !== -1) {
			switch (argvKey) {
				case 'enable-proposed-api':
					if (Array.isArray(argvValue)) {
						argvValue.forEach(id => id && typeof id === 'string' && process.argv.push('--enable-proposed-api', id));
					} else {
						console.error(`argv.json 中 \`enable-proposed-api\` 的值无效。预期为扩展 ID 数组。`);
					}
					break;

				case 'log-level':
					if (typeof argvValue === 'string') {
						process.argv.push('--log', argvValue);
					} else if (Array.isArray(argvValue)) {
						for (const value of argvValue) {
							process.argv.push('--log', value);
						}
					}
					break;

				case 'use-inmemory-secretstorage':
					if (argvValue) {
						process.argv.push('--use-inmemory-secretstorage');
					}
					break;
			}
		}
	});

	// 从运行时启用以下功能：
	// `DocumentPolicyIncludeJSCallStacksInCrashReports` - https://www.electronjs.org/docs/latest/api/web-frame-main#framecollectjavascriptcallstack-experimental
	// `EarlyEstablishGpuChannel` - 参考 https://issues.chromium.org/issues/40208065
	// `EstablishGpuChannelAsync` - 参考 https://issues.chromium.org/issues/40208065
	const featuresToEnable =
		`DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync,${app.commandLine.getSwitchValue('enable-features')}`;
	app.commandLine.appendSwitch('enable-features', featuresToEnable);

	// 从运行时禁用以下功能：
	// `CalculateNativeWinOcclusion` - 禁用原生窗口遮挡跟踪器 (https://groups.google.com/a/chromium.org/g/embedder-dev/c/ZF3uHHyWLKw/m/VDN2hDXMAAAJ)
	const featuresToDisable =
		`CalculateNativeWinOcclusion,${app.commandLine.getSwitchValue('disable-features')}`;
	app.commandLine.appendSwitch('disable-features', featuresToDisable);

	// Blink 功能配置。
	// `FontMatchingCTMigration` - 将 macOS 上的字体匹配切换到 Appkit (参考 https://github.com/microsoft/vscode/issues/224496#issuecomment-2270418470)。
	// `StandardizedBrowserZoom` - 禁用边界框的缩放调整 (https://github.com/microsoft/vscode/issues/232750#issuecomment-2459495394)
	const blinkFeaturesToDisable =
		`FontMatchingCTMigration,StandardizedBrowserZoom,${app.commandLine.getSwitchValue('disable-blink-features')}`;
	app.commandLine.appendSwitch('disable-blink-features', blinkFeaturesToDisable);

	// 支持 JS 标志
	const jsFlags = getJSFlags(cliArgs);
	if (jsFlags) {
		app.commandLine.appendSwitch('js-flags', jsFlags);
	}

	// 使用支持 current_folder 选项的 portal 版本 4
	// 来解决 https://github.com/microsoft/vscode/issues/213780
	// 运行时将默认版本设置为 3，参考 https://github.com/electron/electron/pull/44426
	app.commandLine.appendSwitch('xdg-portal-required-version', '4');

	return argvConfig;
}

interface IArgvConfig {
	[key: string]: string | string[] | boolean | undefined;
	readonly locale?: string;
	readonly 'disable-lcd-text'?: boolean;
	readonly 'proxy-bypass-list'?: string;
	readonly 'disable-hardware-acceleration'?: boolean;
	readonly 'force-color-profile'?: string;
	readonly 'enable-crash-reporter'?: boolean;
	readonly 'crash-reporter-id'?: string;
	readonly 'enable-proposed-api'?: string[];
	readonly 'log-level'?: string | string[];
	readonly 'disable-chromium-sandbox'?: boolean;
	readonly 'use-inmemory-secretstorage'?: boolean;
}

function readArgvConfigSync(): IArgvConfig {

	// 在 app('ready') 之前同步读取或创建 argv.json 配置文件
	const argvConfigPath = getArgvConfigPath();
	let argvConfig: IArgvConfig | undefined = undefined;
	try {
		argvConfig = parse(fs.readFileSync(argvConfigPath).toString());
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			createDefaultArgvConfigSync(argvConfigPath);
		} else {
			console.warn(`无法读取 ${argvConfigPath} 中的 argv.json 配置文件，将回退到默认设置 (${error})`);
		}
	}

	// 回退到默认设置
	if (!argvConfig) {
		argvConfig = {};
	}

	return argvConfig;
}

function createDefaultArgvConfigSync(argvConfigPath: string): void {
	try {

		// 确保 argv 配置父目录存在
		const argvConfigPathDirname = path.dirname(argvConfigPath);
		if (!fs.existsSync(argvConfigPathDirname)) {
			fs.mkdirSync(argvConfigPathDirname);
		}

		// 默认 argv 内容
		const defaultArgvConfigContent = [
			'// 此配置文件允许您向 VS Code 传递永久命令行参数。',
			'// 目前仅支持部分参数，以减少破坏安装的可能性。',
			'//',
			'// 请在了解影响后再进行更改',
			'//',
			'// 注意：更改此文件需要重新启动 VS Code。',
			'{',
			'	// 使用软件渲染而不是硬件加速渲染。',
			'	// 这在 VS Code 中遇到渲染问题时可能会有所帮助。',
			'	// "disable-hardware-acceleration": true',
			'}'
		];

		// 使用默认内容创建初始 argv.json
		fs.writeFileSync(argvConfigPath, defaultArgvConfigContent.join('\n'));
	} catch (error) {
		console.error(`无法在 ${argvConfigPath} 中创建 argv.json 配置文件，将回退到默认设置 (${error})`);
	}
}

function getArgvConfigPath(): string {
	const vscodePortable = process.env['VSCODE_PORTABLE'];
	if (vscodePortable) {
		return path.join(vscodePortable, 'argv.json');
	}

	let dataFolderName = product.dataFolderName;
	if (process.env['VSCODE_DEV']) {
		dataFolderName = `${dataFolderName}-dev`;
	}

	return path.join(os.homedir(), dataFolderName!, 'argv.json');
}

function configureCrashReporter(): void {
	let crashReporterDirectory = args['crash-reporter-directory'];
	let submitURL = '';
	if (crashReporterDirectory) {
		crashReporterDirectory = path.normalize(crashReporterDirectory);

		if (!path.isAbsolute(crashReporterDirectory)) {
			console.error(`为 --crash-reporter-directory 指定的路径 '${crashReporterDirectory}' 必须是绝对路径。`);
			app.exit(1);
		}

		if (!fs.existsSync(crashReporterDirectory)) {
			try {
				fs.mkdirSync(crashReporterDirectory, { recursive: true });
			} catch (error) {
				console.error(`为 --crash-reporter-directory 指定的路径 '${crashReporterDirectory}' 似乎不存在或无法创建。`);
				app.exit(1);
			}
		}

		// 默认情况下，崩溃存储在 crashDumps 目录中，因此我们
		// 需要将该目录更改为提供的目录
		console.log(`找到 --crash-reporter-directory 参数。将 crashDumps 目录设置为 '${crashReporterDirectory}'`);
		app.setPath('crashDumps', crashReporterDirectory);
	}

	// 否则我们从 product.json 配置崩溃报告器
	else {
		const appCenter = product.appCenter;
		if (appCenter) {
			const isWindows = (process.platform === 'win32');
			const isLinux = (process.platform === 'linux');
			const isDarwin = (process.platform === 'darwin');
			const crashReporterId = argvConfig['crash-reporter-id'];
			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			if (crashReporterId && uuidPattern.test(crashReporterId)) {
				if (isWindows) {
					switch (process.arch) {
						case 'x64':
							submitURL = appCenter['win32-x64'];
							break;
						case 'arm64':
							submitURL = appCenter['win32-arm64'];
							break;
					}
				} else if (isDarwin) {
					if (product.darwinUniversalAssetId) {
						submitURL = appCenter['darwin-universal'];
					} else {
						switch (process.arch) {
							case 'x64':
								submitURL = appCenter['darwin'];
								break;
							case 'arm64':
								submitURL = appCenter['darwin-arm64'];
								break;
						}
					}
				} else if (isLinux) {
					submitURL = appCenter['linux-x64'];
				}
				submitURL = submitURL.concat('&uid=', crashReporterId, '&iid=', crashReporterId, '&sid=', crashReporterId);
				// 发送显式启动崩溃报告器的子节点进程的 ID。
				// 对于 vscode，目前是 ExtensionHost 进程。
				const argv = process.argv;
				const endOfArgsMarkerIndex = argv.indexOf('--');
				if (endOfArgsMarkerIndex === -1) {
					argv.push('--crash-reporter-id', crashReporterId);
				} else {
					// 如果我们有一个参数 "--"（参数结束标记）
					// 我们不能在末尾添加参数。相反，我们在
					// "--" 标记之前添加参数。
					argv.splice(endOfArgsMarkerIndex, 0, '--crash-reporter-id', crashReporterId);
				}
			}
		}
	}

	// 为所有进程启动崩溃报告器
	const productName = (product.crashReporter ? product.crashReporter.productName : undefined) || product.nameShort;
	const companyName = (product.crashReporter ? product.crashReporter.companyName : undefined) || 'Microsoft';
	const uploadToServer = Boolean(!process.env['VSCODE_DEV'] && submitURL && !crashReporterDirectory);
	crashReporter.start({
		companyName,
		productName: process.env['VSCODE_DEV'] ? `${productName} Dev` : productName,
		submitURL,
		uploadToServer,
		compress: true
	});
}

function getJSFlags(cliArgs: NativeParsedArgs): string | null {
	const jsFlags: string[] = [];

	// 添加我们已经从命令行获取的任何现有 JS 标志
	if (cliArgs['js-flags']) {
		jsFlags.push(cliArgs['js-flags']);
	}

	if (process.platform === 'linux') {
		// 修复 Linux 上 16KB 页面大小的 cppgc 崩溃。
		// 参考 https://issues.chromium.org/issues/378017037
		// 来自 https://github.com/electron/electron/commit/6c5b2ef55e08dc0bede02384747549c1eadac0eb 的修复
		// 只影响非渲染器进程。
		// 以下将确保该标志也将应用于
		// 渲染器进程。
		// TODO(deepak1556): 一旦我们更新到
		// Chromium >= 134，就移除此项。
		jsFlags.push('--nodecommit_pooled_pages');
	}

	return jsFlags.length > 0 ? jsFlags.join(' ') : null;
}

function parseCLIArgs(): NativeParsedArgs {
	return minimist(process.argv, {
		string: [
			'user-data-dir',
			'locale',
			'js-flags',
			'crash-reporter-directory'
		],
		boolean: [
			'disable-chromium-sandbox',
		],
		default: {
			'sandbox': true
		},
		alias: {
			'no-sandbox': 'sandbox'
		}
	});
}

function registerListeners(): void {

	/**
	 * macOS: 当有人将文件拖放到尚未运行的 VSCode 时，open-file 事件甚至在
	 * app-ready 事件之前触发。我们很早就监听 open-file 并将其记作启动时要打开的路径。
	 */
	const macOpenFiles: string[] = [];
	(globalThis as any)['macOpenFiles'] = macOpenFiles;
	app.on('open-file', function (event, path) {
		macOpenFiles.push(path);
	});

	/**
	 * macOS: 响应 open-url 请求。
	 */
	const openUrls: string[] = [];
	const onOpenUrl =
		function (event: { preventDefault: () => void }, url: string) {
			event.preventDefault();

			openUrls.push(url);
		};

	app.on('will-finish-launching', function () {
		app.on('open-url', onOpenUrl);
	});

	(globalThis as any)['getOpenUrls'] = function () {
		app.removeListener('open-url', onOpenUrl);

		return openUrls;
	};
}

function getCodeCachePath(): string | undefined {

	// 通过 CLI 参数显式禁用
	if (process.argv.indexOf('--no-cached-data') > 0) {
		return undefined;
	}

	// 从源代码运行
	if (process.env['VSCODE_DEV']) {
		return undefined;
	}

	// 需要 commit id
	const commit = product.commit;
	if (!commit) {
		return undefined;
	}

	return path.join(userDataPath, 'CachedData', commit);
}

async function mkdirpIgnoreError(dir: string | undefined): Promise<string | undefined> {
	if (typeof dir === 'string') {
		try {
			await fs.promises.mkdir(dir, { recursive: true });

			return dir;
		} catch (error) {
			// 忽略
		}
	}

	return undefined;
}

//#region NLS 支持

function processZhLocale(appLocale: string): string {
	if (appLocale.startsWith('zh')) {
		const region = appLocale.split('-')[1];

		// 在 Windows 和 macOS 上，由 app.getPreferredSystemLanguages() 返回的中文语言
		// 以 zh-hans（简体中文）或 zh-hant（繁体中文）开头，
		// 因此我们可以轻松确定是使用简体还是繁体。
		// 然而，在 Linux 上，由同一 API 返回的中文语言
		// 的格式为 zh-XY，其中 XY 是国家/地区代码。
		// 对于中国 (CN)、新加坡 (SG) 和马来西亚 (MY)
		// 的国家/地区代码，假定它们使用简体中文。
		// 对于其他情况，假定它们使用繁体中文。
		if (['hans', 'cn', 'sg', 'my'].includes(region)) {
			return 'zh-cn';
		}

		return 'zh-tw';
	}

	return appLocale;
}

/**
 * 解析 NLS 配置
 */
async function resolveNlsConfiguration(): Promise<INLSConfiguration> {

	// 首先，我们需要测试用户定义的区域设置。
	// 如果失败，我们尝试应用程序区域设置。
	// 如果还是失败，我们回退到英语。

	const nlsConfiguration = nlsConfigurationPromise ? await nlsConfigurationPromise : undefined;
	if (nlsConfiguration) {
		return nlsConfiguration;
	}

	// 尝试使用应用程序区域设置，这仅在
	// app ready 事件触发后有效。

	let userLocale = app.getLocale();
	if (!userLocale) {
		return {
			userLocale: 'en',
			osLocale,
			resolvedLanguage: 'en',
			defaultMessagesFile: path.join(__dirname, 'nls.messages.json'),

			// NLS: 下面 2 项是旧时代的遗留物，仅由 vscode-nls 使用并已弃用
			locale: 'en',
			availableLanguages: {}
		};
	}

	// 请参阅上面关于加载器和大小写敏感性的注释
	userLocale = processZhLocale(userLocale.toLowerCase());

	return resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: product.commit,
		userDataPath,
		nlsMetadataPath: __dirname
	});
}

/**
 * 语言标签不区分大小写，但是 ESM 加载器区分大小写
 * 为了使其在保留大小写和不区分大小写的 FS 上工作，我们执行以下操作：
 * 语言包具有小写语言标签，我们始终将从用户或 OS 收到的区域设置转换为小写。
 */
function getUserDefinedLocale(argvConfig: IArgvConfig): string | undefined {
	const locale = args['locale'];
	if (locale) {
		return locale.toLowerCase(); // 直接提供的 --locale 总是优先
	}

	return typeof argvConfig?.locale === 'string' ? argvConfig.locale.toLowerCase() : undefined;
}

//#endregion
