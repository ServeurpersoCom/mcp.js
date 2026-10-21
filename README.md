# mcp.js

The Model Context Protocol server I run every day, published as it is. It
serves a Podman sandbox, a persistent memory, an agent account on Moltbook
and a read only mailbox to any MCP client, behind one endpoint. Built on the
official TypeScript SDK v2
([@modelcontextprotocol/server](https://github.com/modelcontextprotocol/typescript-sdk)),
it speaks the 2026-07-28 revision of the protocol and the 2025 ones on the
same endpoint, each client getting the newest revision it knows.

- llama.cpp Svelte WebUI (native MCP client)
- OpenAI ChatGPT (web, custom MCP server)
- Anthropic Claude (web, custom MCP server)
- any OpenAI compatible chat UI without an MCP client, through the bridge

Four servers, the two transports of the specification (stdio, Streamable
HTTP), every server aggregated behind one endpoint, zero framework.

## Warning

The sandbox server gives the connected LLM a root shell in a container.
Everything the container can reach, the LLM reaches: its volumes, its
network, its GPU. Keep the container rootless under a dedicated user, mount
only what the LLM should touch, and treat what it writes as untrusted.

Never expose the HTTP transport on a port reachable from the public internet
without all three of:

- `auth.mode` set to something other than `none` in `config.json`
- HTTPS in front (reverse proxy)
- an IP allowlist at the firewall level

Without these, assume you handed the container over, and with the email
server, your mailbox to read.

## Install

Requires Node.js 20+, and Podman for the sandbox.

```bash
git clone https://github.com/ServeurpersoCom/mcp.js
cd mcp.js
npm install
```

## Layout

```
config.json        transport, credentials, and the identity served
core/              protocol, auth, and the three transports
core/transports/   stdio, Streamable HTTP
servers/sandbox/   bash_tool, view, create_file, str_replace in a Podman container
servers/memory/    a persistent memory in plain files
servers/moltbook/  an agent account on Moltbook
servers/email/     a read only mailbox over IMAPS
mcp-bridge/        an OpenAI compatible proxy that runs the tools for MCP-less UIs
main.js            binds every server to one transport
```

Every server under `servers/` is loaded at startup and their tools and
prompts are served together, so a client connects once and sees them all.
Adding a server means adding a directory under `servers/`, never touching
`core/`. Removing one means deleting its directory.

Two servers exposing the same tool or prompt name is a naming mistake, and
startup fails saying which name and which two servers. A tool declared in a
`tools.json` without its handler fails startup the same way.

## Run

```bash
node main.js stdio              # local MCP clients
node main.js streamable-http    # HTTP, port 8083
```

`main.js` takes a transport name, defaulting to `stdio`, and serves every
server under `servers/`. The HTTP transport binds `127.0.0.1`: put a reverse
proxy in front to reach it from elsewhere.

Both transports build a fresh server for each exchange: one per HTTP
request, one per stdio connection. The opening exchange selects the revision,
2026-07-28 for a client that probes with `server/discover`, a 2025 one for a
client that sends `initialize`.

## Config

Settings come from two files with disjoint roles. The root `config.json`
holds the transport, the credentials and the identity the aggregate answers
with. A `servers/<name>/config.json` holds that server's prompts and its own
settings block, nothing else.

The published files hold every setting I run with, secrets aside: the
authentication secrets are empty, so the server refuses to start until you
set them, and the service credentials read `changeme`. `example.com` stands
for my domain.

Root:

```json
{
	"auth": {
		"mode": "oauth+static",
		"clientId": "",
		"clientSecret": "",
		"password": "",
		"staticToken": "",
		"storeDir": "data/oauth"
	},
	"streamable_http": { "host": "127.0.0.1", "port": 8083 },
	"mcp": {
		"serverName": "mcp-sandbox",
		"serverVersion": "1.0.0",
		"serverIcons": [
			{
				"src": "https://www.example.com/favicon-light.png",
				"mimeType": "image/png",
				"theme": "light"
			},
			{
				"src": "https://www.example.com/favicon-dark.png",
				"mimeType": "image/png",
				"theme": "dark"
			}
		]
	}
}
```

One endpoint serves them all, so ports and identity belong to the root and a
server never carries them. `prompts` holds the templates a server publishes
over `prompts/list` and `prompts/get`, gathered from every server.
`serverIcons` is optional: it rides into the `initialize` response on a 2025
connection and into the `_meta` of every response on a 2026 one.

### Auth

`auth.mode` selects the scheme for the HTTP transport. Stdio is never
authenticated, it speaks over local pipes only.

| Mode           | What is accepted                               |
| -------------- | ---------------------------------------------- |
| `none`         | No authentication, anyone who reaches the port |
| `static`       | A long lived bearer token                      |
| `oauth`        | The OAuth 2.1 flow only                        |
| `oauth+static` | Either of the two                              |

`static` suits clients that cannot run an interactive flow. Every request
carries `Authorization: Bearer <staticToken>`, matched in constant time.

`oauth` implements the smallest surface an MCP connector needs: dynamic
client registration, a consent form gated by `password`, and token exchange
with PKCE S256. `clientId`, `clientSecret`, `password` and `storeDir` must
all be set. Issued tokens are stored under `storeDir`, one file per token,
so connectors stay authorized across restarts; `rm -rf data/oauth` revokes
them all.

The server aborts at startup on an unknown mode, on `static` with an empty
`staticToken`, or on an OAuth mode missing one of its settings.

Generate solid secrets:

```bash
openssl rand -hex 32
```

Discovery follows RFC 9728: a request without a valid token gets a 401
carrying a `WWW-Authenticate` header that points at
`/.well-known/oauth-protected-resource` on the host the request came in on.
Serve that document, and the matching
`/.well-known/oauth-authorization-server`, from your reverse proxy.

## Servers

### sandbox

A Debian container, built from `Containerfile` and declared in `pod.yaml`,
run rootless by `podman.hostUser`. Every command enters it through
`podman exec`, the script on stdin, under a timeout.

| Name          | Action                                                                               |
| ------------- | ------------------------------------------------------------------------------------ |
| `bash_tool`   | Run a bash command: exit code, duration, a kill at the timeout named                 |
| `view`        | Read a file with line numbers and an optional range, list a directory, show an image |
| `create_file` | Create a file, its directories made, empty or not                                    |
| `str_replace` | Replace a unique string in a file, its other bytes untouched                         |

All four take a mandatory `description` argument so the LLM states its
intent on every call, and every call is checked against its schema first:
an unknown argument, a missing one or an empty string is refused by name.

The results read like the tools of the KiSS backend: the output then
`Exit code 0 (12 ms)` or `Killed after 300 s`, numbered lines then
`120 lines`, a listing then `14 entries, 3 hidden`, an image after
`Image image/png 800x600, 51234 bytes`, `Created x, 3 lines, 52 bytes`,
`Replaced at line 42 of x, 10 -> 14 bytes`. Long output keeps its head and
its tail with the hidden bytes counted. Files travel as base64 both ways, so
a file in any encoding keeps its bytes, and a binary one is refused rather
than mangled.

`sandbox-manager.js` drives the pod: `build`, `destroy`, `start`, `stop`,
`reset` (a fresh container from the existing image), `status`, `logs`,
`shell`. `paths` names the host directories mounted as `/mnt/inputs`,
`/mnt/workspace` and `/mnt/outputs`.

### memory

A memory that outlives conversations: one Markdown file per entry under
`data/<group>/<slug>.md`, an index of one line per entry. `memory_open`
reads the index or the named entries, `memory_write` creates or edits an
entry anchored on a unique string, `memory_drop` removes one. Every write
goes to a temporary file then a rename.

### moltbook

An agent account on [Moltbook](https://www.moltbook.com), the social network
for AI agents: home, feed, posts, comments, search, profiles, communities,
votes, follows, and the verification challenge of each new post. The API key
stays in `config.json` and never reaches the model.

### email

A read only mailbox: `email_folders`, `email_list` (one line per message,
filtered on the server, paged by uid) and `email_read` (the headers a client
shows, or the raw block for provenance questions). Every folder opens with
`EXAMINE`, so nothing changes and reading leaves a message unseen.

```json
{
	"host": "192.168.0.2",
	"port": 993,
	"servername": "mail.example.com",
	"ca": "mail.example.com.pem",
	"user": "pascal",
	"password": "changeme"
}
```

IMAPS only, the certificate always checked. `servername` is the name the
certificate carries when `host` is an address. `ca` pins the certificate of
a server that signs its own, Dovecot out of the box: copy its public half
next to `config.json` under that name. Leave `ca` empty for a server whose
certificate a public authority signed.

## Bridge

`mcp-bridge/` serves `/v1/chat/completions` in front of an OpenAI compatible
endpoint (`proxy.apiUrl`, llama-server for me) and runs the tool calls of the
model itself, through the servers of this repository over stdio (or any MCP
server over Streamable HTTP, given its `url` and `headers`), until the model
answers. A chat UI without an MCP client gets the tools that way, each
call and its result shown in the conversation.

```bash
node mcp-bridge/main.js
```

## Client setup

### llama.cpp Svelte WebUI (Streamable HTTP)

In the MCP settings panel, add the server:

- URL: `https://your-host/your-path`
- Header: `Authorization: Bearer <staticToken>`

### OpenAI ChatGPT / Anthropic Claude web (Streamable HTTP)

Declare the server as a custom connector with its URL; the OAuth flow asks
for `password` once.

### Claude Desktop (stdio)

```json
{
	"mcpServers": {
		"mcp": {
			"command": "node",
			"args": ["/path/to/mcp.js/main.js", "stdio"]
		}
	}
}
```

## Status

Personal Swiss army knife. Evolves with my needs and what friends and users
ask for. Issues and PRs welcome.

## License

MIT.
