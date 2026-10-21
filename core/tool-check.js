/**
 * Tool arguments
 * The law every call passes before its handler, the twin of tools_check in
 * the KiSS backend: the arguments form an object, none is unknown to the tool
 * schema, every required one is present, and an argument the schema types as
 * a string is a string never shorter than its minLength
 */

/**
 * The first breach of a tool schema by the arguments of a call, or null
 * @param {object} schema JSON Schema of the tool input
 * @param {*} args
 * @returns {string|null}
 */
function breach(schema, args) {
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return 'Arguments are not an object';
	}
	const properties = schema.properties || {};
	const capital = (name) => name[0].toUpperCase() + name.slice(1);

	const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
	if (unknown.length > 0) {
		return `Unknown argument ${unknown.join(', ')}`;
	}
	for (const name of schema.required || []) {
		if (args[name] === undefined) {
			return `${capital(name)} argument required`;
		}
	}
	for (const [name, value] of Object.entries(args)) {
		if (properties[name].type !== 'string') {
			continue;
		}
		if (typeof value !== 'string') {
			return `${capital(name)} argument is not a string`;
		}
		if (value.length < (properties[name].minLength || 0)) {
			return `${capital(name)} argument required`;
		}
	}
	return null;
}

module.exports = { breach };
