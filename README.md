# devilmcp

`devilmcp` is a lightweight Node.js MCP server that exposes controlled access to a local Devilbox setup.

It currently provides three MCP tools:

- `list_projects`
- `exec_in_php_container`
- `query_mariadb`
- `query_postgres`

This tool runs a shell command via `docker compose exec` inside the Devilbox `php` container. It is intended for MCP clients, editors, or agent runtimes that need to execute common PHP project commands such as:

- `php -v`
- `composer install`
- `php artisan about`
- `vendor/bin/phpunit`

The server uses `spawn` instead of `exec`, which makes it more reliable for longer-running commands and commands with a lot of output, such as `npm run build`.

## What This MCP Does

The server:

- listens locally on `http://127.0.0.1:8787`
- uses JSON-RPC 2.0 over HTTP
- returns `application/json` for normal POST requests
- can also return SSE when the client sends `Accept: text/event-stream`
- supports tool discovery via `initialize` and `tools/list`
- executes tool calls inside the Devilbox `php` container
- executes read-only SQL queries inside the Devilbox MariaDB and PostgreSQL containers
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
For database access, it also reads `DEVILBOX_DIR/.env` and uses those values as defaults.
Local MCP-specific `.env` values still take precedence and act as explicit overrides.

Relevant variables:

- `PORT`: MCP server HTTP port
- `MCP_BIND_HOST`: bind host, default `127.0.0.1`
- `DEVILBOX_DIR`: host path to the Devilbox installation
- `DEVILBOX_PROJECTS_DIR`: base project path inside the `php` container, default `/shared/httpd`
- `DEVILBOX_EXEC_TIMEOUT_MS`: command timeout in milliseconds, default `600000` (10 minutes), set to `0` to disable
- `DEVILBOX_MARIADB_SERVICE`: optional explicit MariaDB/MySQL compose service name, defaults to `mysql` or the local override
- `DEVILBOX_MARIADB_SERVICE_CANDIDATES`: candidate service names used for fallback detection, default `mysql,mariadb`
- `DEVILBOX_MARIADB_USER`: optional MariaDB user override, default `root`
- `DEVILBOX_MARIADB_PASSWORD`: optional MariaDB password override; otherwise `MYSQL_ROOT_PASSWORD` from `DEVILBOX_DIR/.env` is used
- `DEVILBOX_MARIADB_DATABASE`: optional default MariaDB database
- `DEVILBOX_POSTGRES_SERVICE`: optional explicit PostgreSQL compose service name, defaults to `pgsql`
- `DEVILBOX_POSTGRES_SERVICE_CANDIDATES`: candidate service names used for auto-detection, default `pgsql,postgres,postgresql`
- `DEVILBOX_POSTGRES_USER`: optional PostgreSQL user override; otherwise `PGSQL_ROOT_USER` from `DEVILBOX_DIR/.env` is used
- `DEVILBOX_POSTGRES_PASSWORD`: optional PostgreSQL password override; otherwise `PGSQL_ROOT_PASSWORD` from `DEVILBOX_DIR/.env` is used
- `DEVILBOX_POSTGRES_DATABASE`: default PostgreSQL database override; otherwise `PGSQL_DATABASE` from `DEVILBOX_DIR/.env` or `postgres` is used
- `MCP_AUTH_TOKEN`: bearer token required for `tools/list` and `tools/call`

Example:

```env
PORT=8787
MCP_BIND_HOST=127.0.0.1
DEVILBOX_DIR=../devilbox_community
DEVILBOX_PROJECTS_DIR=/shared/httpd
DEVILBOX_EXEC_TIMEOUT_MS=600000
MCP_AUTH_TOKEN=replace_with_a_secure_token
```

With a standard Devilbox setup you usually only need `DEVILBOX_DIR`, `DEVILBOX_PROJECTS_DIR`, and `MCP_AUTH_TOKEN`.
The MCP will derive the MariaDB/PostgreSQL service names and root credentials from `DEVILBOX_DIR/.env`.

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

## IDE Example

Example MCP configuration for IDEs or clients that support streamable HTTP MCP with custom headers:

```json
{
  "mcpServers": {
    "devilbox": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer replace_with_a_secure_token"
      }
    }
  }
}
```

Important:

- the `Authorization` header must include the `Bearer ` prefix
- using only the raw token value without `Bearer ` will fail authentication
- the MCP endpoint is `http://127.0.0.1:8787/mcp`

## Available Tools

### `exec_in_php_container`

Runs a shell command inside the Devilbox `php` container.

Parameters:

- `cmd` required: shell command executed via `bash -lc`
- `project` required: project name under `DEVILBOX_PROJECTS_DIR`, for example `forms_deluxe`, or an absolute container path under that configured base directory

`project` behavior:

- with `project: "forms_deluxe"`, the command runs in `<DEVILBOX_PROJECTS_DIR>/forms_deluxe`
- if `project` already starts with the configured base directory, that path is used directly
- without `project`, the request is rejected
- if the resolved project directory does not exist in the `php` container, the tool returns a clear MCP error result and suggests using `list_projects`

### `list_projects`

Lists the direct child directories below `DEVILBOX_PROJECTS_DIR` inside the Devilbox `php` container.

Parameters:

- none

Response details:

- `structuredContent.projects` contains the parsed project names as an array
- `stdout` contains the same list as newline-separated text

### `query_mariadb`

Runs a single read-only SQL query inside the Devilbox MariaDB container.

Parameters:

- `query` required: one read-only SQL statement
- `database` optional: target database; if omitted, `DEVILBOX_MARIADB_DATABASE` is used when set

Allowed statement prefixes:

- `SELECT`
- `SHOW`
- `DESCRIBE`
- `DESC`
- `EXPLAIN`
- `WITH`

Guard rails:

- only a single statement is allowed
- semicolon-chained queries are rejected
- write-capable or session-changing statements such as `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `MERGE`, `CALL`, `BEGIN`, `COMMIT`, and `ROLLBACK` are rejected

### `query_postgres`

Runs a single read-only SQL query inside the Devilbox PostgreSQL container.

Parameters:

- `query` required: one read-only SQL statement
- `database` optional: target database; defaults to `DEVILBOX_POSTGRES_DATABASE`

The same read-only restrictions and single-statement guard rails as `query_mariadb` apply.

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

Example for MariaDB:

```http
POST /mcp
Authorization: Bearer replace_with_a_secure_token
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "query_mariadb",
    "arguments": {
      "database": "forms_deluxe",
      "query": "SHOW TABLES"
    }
  }
}
```

Example for listing projects:

```http
POST /mcp
Authorization: Bearer replace_with_a_secure_token
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "list_projects",
    "arguments": {}
  }
}
```

Example for PostgreSQL:

```http
POST /mcp
Authorization: Bearer replace_with_a_secure_token
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "query_postgres",
    "arguments": {
      "database": "app_db",
      "query": "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    }
  }
}
```

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
- database tools also include `service`, `database_type`, and `database`
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
      "service": "php",
      "stdout": "PHP 8.x ...",
      "stderr": "",
      "exit_code": 0
    },
    "isError": false
  }
}
```

## Current Limitations

- the server binds to localhost by default
- shell commands run inside the `php` container, not on the host
- database queries run inside the configured MariaDB/PostgreSQL containers
- tool calls use the timeout configured in `DEVILBOX_EXEC_TIMEOUT_MS`
- commands are passed through `bash -lc`, so `cmd` should be treated as trusted input only
- SQL access is intentionally limited to read-only single statements
- `resources/list` and `resources/templates/list` currently return empty lists

## Typical Use Cases

- run Composer commands inside a Devilbox project
- run Laravel or Symfony CLI commands in the correct container
- execute tests inside Devilbox
- discover available Devilbox projects before selecting one for command execution
- inspect the PHP version, extensions, or container environment
- inspect MariaDB schemas, tables, and data via read-only SQL
- inspect PostgreSQL schemas, tables, and data via read-only SQL

## Relevant Files

- `server.js`: MCP server implementation
- `package.json`: Node.js package metadata and start script
- `.env.example`: example configuration
- `.mcp_call3.json`: sample `tools/call` payload
