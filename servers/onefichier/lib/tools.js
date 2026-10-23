/**
 * 1fichier Tools Module
 * Exposes a 1fichier account over its JSON API, read only
 *
 * - onefichier_ls: a folder, its sub folders and its files with their links,
 *   the FTP folder of config.json by default
 * - onefichier_info: details of one link
 * - onefichier_account: plan, storage and FTP settings of the account
 *
 * The API key stays in config.json and never reaches the model. No tool
 * deletes, moves, renames or uploads anything
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
 * A folder with its sub folders and its files, newest file first
 * @param {{folder_id?: number}} args
 */
async function ls({ folder_id = config.ftpFolderId }) {
	const id = Number(folder_id);
	if (!Number.isInteger(id) || id < 0) {
		throw new Error(`Invalid folder_id "${folder_id}", 0 for the root or a folder id`);
	}

	const data = await call('/folder/ls.cgi', { folder_id: id, files: 1 });
	const lines = [
		`folder ${data.folder_id} ${data.name} | ${data.files} files | ${data.size} bytes`
	];
	for (const sub of data.sub_folders || []) {
		lines.push(`dir ${sub.id} ${sub.name} | ${sub.files} files | ${sub.size} bytes`);
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

const TOOLS_MAPPING = {
	onefichier_ls: tool(ls),
	onefichier_info: tool(info),
	onefichier_account: tool(account)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
