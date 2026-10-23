/**
 * 1fichier Tools Module
 * Exposes a 1fichier account over its JSON API
 *
 * - onefichier_ls: a folder, its sub folders and its files with their links,
 *   the FTP folder of config.json by default
 * - onefichier_info: details of one link
 * - onefichier_account: plan, storage and FTP settings of the account
 * - onefichier_mv, onefichier_rename, onefichier_rm, onefichier_mkdir: move,
 *   rename and delete files, create folders
 *
 * The API key stays in config.json and never reaches the model. A deleted
 * file goes to the 1fichier trash, restorable for 30 days. A move or a delete
 * can fail half way, the result then lists the links it did handle
 *
 * The API rate limits each folder listing to one per 30 seconds and the
 * account details to one per 5 minutes, and bans for a while after repeated
 * errors: links are checked locally before any call and nothing retries
 */

const { link, request } = require('./api');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').onefichier;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

const ACCOUNT_FIELDS = [
	'offer',
	'subscription_end',
	'ftp_did',
	'ftp_mode',
	'ftp_report',
	'hot_storage',
	'cold_storage',
	'allowed_cold_storage',
	'available_cold_storage',
	'overquota',
	'upload_forbidden',
	'stats_date'
];
const INFO_FIELDS = [
	'filename',
	'size',
	'date',
	'folder_id',
	'path',
	'content_type',
	'description',
	'checksum',
	'pass',
	'acl',
	'cdn'
];

/**
 * Turn a handler into a tool, a thrown error becoming an error result and the
 * text keeping its head when it exceeds the output limit
 * @param {function(object): Promise<string>} handler
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			let text = await handler(args);
			const bytes = Buffer.byteLength(text);
			if (bytes > config.outputLimitBytes) {
				text =
					Buffer.from(text).subarray(0, config.outputLimitBytes).toString() +
					`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes]`;
			}
			return textResult(text);
		} catch (error) {
			return textResult(error.message, true);
		}
	};
}

/**
 * Call the API, a failure throwing with its status and body
 * @param {string} route
 * @param {object} [body]
 * @returns {Promise<object>} The response body
 */
async function call(route, body) {
	const res = await request(route, body);
	if (!res.ok) {
		const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
		throw new Error(`HTTP ${res.status} ${text}`);
	}
	return res.data;
}

/**
 * Selected fields of an object, one "name: value" line each
 * @param {object} data
 * @param {string[]} fields
 * @returns {string}
 */
function fieldLines(data, fields) {
	return fields
		.filter((name) => data[name] !== undefined && data[name] !== '')
		.map(
			(name) =>
				`${name}: ${typeof data[name] === 'object' ? JSON.stringify(data[name]) : data[name]}`
		)
		.join('\n');
}

/**
 * A non empty list of distinct links, each checked
 * @param {*} value
 * @returns {string[]}
 */
function links(value) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('Urls argument is not a non empty list');
	}
	return [...new Set(value.map(link))];
}

/**
 * A folder id, 0 being the root
 * @param {*} value
 * @returns {number}
 */
function folderId(value) {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 0) {
		throw new Error(`Invalid folder_id "${value}", 0 for the root or a folder id`);
	}
	return id;
}

/**
 * Run a move or a delete, reporting the links handled even when the API
 * answers KO half way
 * @param {string} route
 * @param {object} body
 * @param {string} done Count field of the response, like moved or removed
 * @param {number} total
 * @returns {Promise<string>}
 */
async function bulk(route, body, done, total) {
	const res = await request(route, body);
	const handled = (res.data && res.data.urls) || [];
	const text = [`${done} ${res.data?.[done] ?? handled.length} of ${total}`, ...handled].join('\n');
	if (!res.ok) {
		const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
		throw new Error(`HTTP ${res.status} ${raw}\n${text}`);
	}
	return text;
}

/**
 * A folder with its sub folders and its files, newest file first
 * @param {{folder_id?: number}} args
 */
async function ls({ folder_id = config.ftpFolderId }) {
	const id = folderId(folder_id);
	const data = await call('/folder/ls.cgi', { folder_id: id, files: 1 });
	const lines = [
		`folder ${data.folder_id} ${data.name} | ${data.files} files | ${data.size} bytes`
	];
	for (const sub of data.sub_folders || []) {
		lines.push(`dir ${sub.id} ${sub.name}`);
	}
	const files = (data.items || []).slice().sort((a, b) => b.date.localeCompare(a.date));
	for (const f of files) {
		lines.push(`${f.date} ${f.size} ${f.url} ${f.filename}`);
	}
	return lines.join('\n');
}

/**
 * Details of one link
 * @param {{url: string}} args
 */
async function info({ url }) {
	const data = await call('/file/info.cgi', { url: link(url) });
	return `url: ${data.url}\n` + fieldLines(data, INFO_FIELDS);
}

/**
 * Plan, storage and FTP settings of the account
 */
async function account() {
	return fieldLines(await call('/user/info.cgi'), ACCOUNT_FIELDS);
}

/**
 * Move files to a folder, renaming the file when only one is moved
 * @param {{urls: string[], folder_id: number, rename?: string}} args
 */
function mv({ urls, folder_id, rename }) {
	const list = links(urls);
	if (rename != null && list.length !== 1) {
		throw new Error('Rename argument only applies to a single file');
	}
	const body = { urls: list, destination_folder_id: folderId(folder_id) };
	if (rename != null) {
		body.rename = rename;
	}
	return bulk('/file/mv.cgi', body, 'moved', list.length);
}

/**
 * Rename one file
 * @param {{url: string, filename: string}} args
 */
async function rename({ url, filename }) {
	const data = await call('/file/rename.cgi', { urls: [{ url: link(url), filename }] });
	const r = (data.urls || [])[0] || {};
	return `${r.url || url} ${r.old_filename} -> ${r.new_filename || filename}`;
}

/**
 * Delete files, which go to the trash for 30 days
 * @param {{urls: string[]}} args
 */
function rm({ urls }) {
	const list = links(urls);
	return bulk('/file/rm.cgi', { files: list.map((url) => ({ url })) }, 'removed', list.length);
}

/**
 * Create a folder
 * @param {{name: string, folder_id?: number}} args
 */
async function mkdir({ name, folder_id = 0 }) {
	const data = await call('/folder/mkdir.cgi', { name, folder_id: folderId(folder_id) });
	return `folder ${data.folder_id} ${data.name} created`;
}

const TOOLS_MAPPING = {
	onefichier_ls: tool(ls),
	onefichier_info: tool(info),
	onefichier_account: tool(account),
	onefichier_mv: tool(mv),
	onefichier_rename: tool(rename),
	onefichier_rm: tool(rm),
	onefichier_mkdir: tool(mkdir)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
