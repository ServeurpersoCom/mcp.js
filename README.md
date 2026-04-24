# mcp.js

Personal dev tool that exposes a local shell and filesystem to any Model
Context Protocol client. Built on the official TypeScript SDK
([@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk),
v1.29+), with a custom WebSocket server transport added on top since the
SDK only ships stdio and Streamable HTTP on the server side.

Runs anywhere Node.js and bash run: Linux, macOS, and Windows via WSL
or Git Bash.

- llama.cpp Svelte WebUI (native MCP client)
- OpenAI ChatGPT (web, custom MCP server)
- Anthropic Claude (web, custom MCP server)

Four tools (`bash_tool`, `view`, `create_file`, `str_replace`), three
transports (stdio, Streamable HTTP, WebSocket), one config file, zero
framework.

## Warning

This server gives the connected LLM whatever shell privileges the Node
process itself has. Launch it as root, the LLM runs as root. Launch it
under your daily user on your personal desktop, the LLM can read your
SSH keys, browser data and home directory, and wipe it all in one
command. Running it as root on your personal machine is a bad idea
unless you are fully aware of what you are doing.

Recommended deployment targets, from cheapest to most isolated:

- Podman in userland, rootless, with a dedicated UID
- A throwaway VM you can wipe
- A dedicated Raspberry Pi sitting on a spare network segment

Bonus use case: cyber audit. Point a frontier model at this server
inside a container and watch it try to break out. If it escapes, you
learn something useful about both the model and your container
configuration.

Never expose the HTTP or WebSocket transport on a port reachable from
the public internet without all three of:

- a bearer token enabled in `config.json`
- HTTPS in front (reverse proxy)
- an IP allowlist at the firewall level

Without these, assume you handed the host over.

## Install

Requires Node.js 18+ and bash in PATH.

```bash
git clone https://github.com/ServeurpersoCom/mcp.js
cd mcp.js
npm install
```

## Run

```bash
node stdio.js              # local MCP clients
node streamable-http.js    # HTTP, default port 8083
node websocket.js          # WebSocket, default port 8084
```

### Network exposure

Default bind address is `0.0.0.0` so a llama.cpp instance on your
desktop can reach a sandbox running on a Raspberry Pi across the LAN
without any config tweak. If you run everything on a single machine,
set `host` to `127.0.0.1` in `config.json`. Do not expose the ports on
the public internet unless you know exactly what you are doing, and
even then, re-read the Warning section first.

## Config

All settings live in `config.json`.

```json
{
    "bash": {
        "timeout": 300,
        "outputLimitBytes": 4096
    },
    "auth": {
        "enabled": false,
        "token": ""
    },
    "streamable_http": { "host": "0.0.0.0", "port": 8083 },
    "websocket":       { "host": "0.0.0.0", "port": 8084 },
    "mcp": {
        "protocolVersion": "2025-06-18",
        "serverName": "mcp-local-bash",
        "serverVersion": "1.0.0"
    }
}
```

### Auth

Bearer token for the HTTP and WebSocket transports (OAuth 2.0 scheme,
per MCP spec 2025-06-18). When `enabled` is `true`, every request must
carry `Authorization: Bearer <token>`. Stdio is never authenticated
(local pipes only). The server aborts at startup if `enabled` is `true`
and `token` is empty.

Generate a solid token:

```bash
openssl rand -hex 32
```

## Tools

| Name          | Action                                                    |
| ------------- | --------------------------------------------------------- |
| `bash_tool`   | Run a bash command with timeout and output truncation     |
| `view`        | Read a file with line numbers and optional range, or list a directory |
| `create_file` | Create a file with auto mkdir and base64 safe writes      |
| `str_replace` | Replace a unique string in a file, rejects ambiguous cases |

All four take a mandatory `description` argument so the LLM states its
intent on every call. Shows up in logs, useful for audit.

## Client setup

### llama.cpp Svelte WebUI (Streamable HTTP)

In the MCP settings panel, add the server:

- URL: `http://your-host:8083`
- Header: `Authorization: Bearer <token>`

### OpenAI ChatGPT / Anthropic Claude web (Streamable HTTP)

Declare the server in the app's MCP connector configuration with the
same URL and Authorization header.

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "mcp": {
      "command": "node",
      "args": ["/path/to/mcp.js/stdio.js"]
    }
  }
}
```

## Status

Personal Swiss army knife. Evolves with my needs and what friends and
users ask for. Issues and PRs welcome.

## License

MIT.
