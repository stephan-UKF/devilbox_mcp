# devilmcp

`devilmcp` is a lightweight Node.js MCP server that exposes a controlled way to run commands inside the `php` container of a local Devilbox setup.

It currently provides one MCP tool:

- `exec_in_php_container`

This tool runs a shell command via `docker compose exec` inside the Devilbox `php` container. It is intended for MCP clients, editors, or agent runtimes that need to execute common PHP project commands such as:

- `php -v`
- `composer install`
- `php artisan about`
- `vendor/bin/phpunit`

## What This MCP Does

The server:

- listens locally on `http://127.0.0.1:8787`
- uses JSON-RPC 2.0 over HTTP
- returns `application/json` for normal POST requests
- can also return SSE when the client sends `Accept: text/event-stream`
- supports tool discovery via `initialize` and `tools/list`
- executes tool calls inside the Devilbox `php` container
- requires every tool call to specify a concrete project under the configured project base directory
- returns MCP-compatible tool results with `content`, `structuredContent`, and `isError`

At runtime, a tool call is executed conceptually like this:

```bash
cd "$DEVILBOX_DIR"
docker compose exec -T -w "<project-workdir>" php bash -lc "<cmd>"
```

## Requirements

To use this server, you need:

- Node.js
- a working Devilbox installation with Docker Compose
- a running Devilbox `php` container
- your projects mounted under the container base path configured in `DEVILBOX_PROJECTS_DIR`

By default, the server expects the Devilbox installation here:

```text
../devilbox_community
```

relative to the server working directory.

## Configuration

The server reads its configuration from `.env`.
Use `.env.example` as the template.

Relevant variables:

- `PORT`: MCP server HTTP port
- `MCP_BIND_HOST`: bind host, default `127.0.0.1`
- `DEVILBOX_DIR`: host path to the Devilbox installation
- `DEVILBOX_PROJECTS_DIR`: base project path inside the `php` container, default `/shared/httpd`
- `MCP_AUTH_TOKEN`: bearer token required for `tools/list` and `tools/call`

Example:

```env
PORT=8787
MCP_BIND_HOST=127.0.0.1
DEVILBOX_DIR=../devilbox_community
DEVILBOX_PROJECTS_DIR=/shared/httpd
MCP_AUTH_TOKEN=replace_with_a_secure_token
```

## Installation

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

After startup, the MCP endpoint is available at `http://127.0.0.1:8787/mcp` unless you changed `PORT` or `MCP_BIND_HOST`.

## Authentication

All requests except `initialize` require a bearer token.

That means:

- `initialize` works without authentication
- `tools/list` and `tools/call` require `Authorization: Bearer <token>`

Replace the placeholder token in `.env` with a real secret before using this outside a local test setup.

## Available Tool

### `exec_in_php_container`

Runs a shell command inside the Devilbox `php` container.

Parameters:

- `cmd` required: shell command executed via `bash -lc`
- `project` required: project name under `DEVILBOX_PROJECTS_DIR`, for example `forms_deluxe`, or an absolute container path under that configured base directory

`project` behavior:

- with `project: "forms_deluxe"`, the command runs in `<DEVILBOX_PROJECTS_DIR>/forms_deluxe`
- if `project` already starts with the configured base directory, that path is used directly
- without `project`, the request is rejected

## MCP Flow

### 1. Initialize

```http
POST /mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18"
  }
}
```

### 2. List tools

```http
POST /mcp
Authorization: Bearer replace_with_a_secure_token
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

### 3. Call the tool

Example for a concrete project:

```http
POST /mcp
Authorization: Bearer replace_with_a_secure_token
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "exec_in_php_container",
    "arguments": {
      "project": "forms_deluxe",
      "cmd": "php artisan --version"
    }
  }
}
```

A real sample payload is included in `.mcp_call3.json`.

## Example With `curl`

```bash
curl -X POST http://127.0.0.1:8787/mcp ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer replace_with_a_secure_token" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":23,\"method\":\"tools/call\",\"params\":{\"name\":\"exec_in_php_container\",\"arguments\":{\"project\":\"forms_deluxe\",\"cmd\":\"php artisan about --only=environment\"}}}"
```

## Response Format

On success, `tools/call` returns an MCP-compatible JSON-RPC result with:

- `content`: text output intended for the agent
- `structuredContent`: structured fields such as `stdout`, `stderr`, `exit_code`, `command`, and `container_workdir`
- `isError`: `true` when the command failed

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Command: php -v\nWorkdir: /shared/httpd/forms_deluxe\nExit code: 0\n..."
      }
    ],
    "structuredContent": {
      "command": "php -v",
      "container_workdir": "/shared/httpd/forms_deluxe",
      "stdout": "PHP 8.x ...",
      "stderr": "",
      "exit_code": 0
    },
    "isError": false
  }
}
```

## Current Limitations

- only one tool is currently exposed
- the server binds to localhost by default
- commands run inside the `php` container, not on the host
- tool calls currently use a 60 second timeout
- commands are passed through `bash -lc`, so `cmd` should be treated as trusted input only
- `resources/list` and `resources/templates/list` currently return empty lists

## Typical Use Cases

- run Composer commands inside a Devilbox project
- run Laravel or Symfony CLI commands in the correct container
- execute tests inside Devilbox
- inspect the PHP version, extensions, or container environment

## Relevant Files

- `server.js`: MCP server implementation
- `package.json`: Node.js package metadata and start script
- `.env.example`: example configuration
- `.mcp_call3.json`: sample `tools/call` payload
