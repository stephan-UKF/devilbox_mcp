const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const loadDotEnv = (envPath) => {
    if (!fs.existsSync(envPath)) {
        return {};
    }

    return fs.readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .reduce((acc, line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return acc;
            }

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex === -1) {
                return acc;
            }

            const key = trimmed.slice(0, separatorIndex).trim();
            let value = trimmed.slice(separatorIndex + 1).trim();

            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith('\'') && value.endsWith('\''))
            ) {
                value = value.slice(1, -1);
            }

            if (key) {
                acc[key] = value;
            }

            return acc;
        }, {});
};

const dotenvValues = loadDotEnv(path.resolve(process.cwd(), '.env'));
const getConfigValue = (key, fallback) => process.env[key] || dotenvValues[key] || fallback;
const normalizeContainerPath = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');

const app = express();
const PORT = Number(getConfigValue('PORT', 8787));
const HOST = getConfigValue('MCP_BIND_HOST', '127.0.0.1');
const DEVILBOX_DIR = getConfigValue('DEVILBOX_DIR', path.resolve(process.cwd(), '../devilbox_community'));
const devilboxDotenvValues = loadDotEnv(path.resolve(DEVILBOX_DIR, '.env'));
const getMergedConfigValue = (key, fallback) => process.env[key] || dotenvValues[key] || devilboxDotenvValues[key] || fallback;
const PROJECTS_BASE_DIR = normalizeContainerPath(getConfigValue('DEVILBOX_PROJECTS_DIR', '/shared/httpd'));
const EXPECTED_TOKEN = getConfigValue('MCP_AUTH_TOKEN', 'dein_super_geheimer_token_2026_xyz123_abcdef987654321');
const EXEC_TIMEOUT_MS = Number(getConfigValue('DEVILBOX_EXEC_TIMEOUT_MS', 600000));
const DEVILBOX_MARIADB_SERVICE = getMergedConfigValue('DEVILBOX_MARIADB_SERVICE', 'mysql');
const DEVILBOX_POSTGRES_SERVICE = getMergedConfigValue('DEVILBOX_POSTGRES_SERVICE', 'pgsql');
const DEVILBOX_MARIADB_CANDIDATES = (getMergedConfigValue('DEVILBOX_MARIADB_SERVICE_CANDIDATES', 'mysql,mariadb'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const DEVILBOX_POSTGRES_CANDIDATES = (getMergedConfigValue('DEVILBOX_POSTGRES_SERVICE_CANDIDATES', 'pgsql,postgres,postgresql'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const MARIADB_USER = getMergedConfigValue('DEVILBOX_MARIADB_USER', 'root');
const MARIADB_PASSWORD = getMergedConfigValue('DEVILBOX_MARIADB_PASSWORD', getMergedConfigValue('MYSQL_ROOT_PASSWORD', ''));
const MARIADB_DEFAULT_DATABASE = getMergedConfigValue('DEVILBOX_MARIADB_DATABASE', '');
const POSTGRES_USER = getMergedConfigValue('DEVILBOX_POSTGRES_USER', getMergedConfigValue('PGSQL_ROOT_USER', 'postgres'));
const POSTGRES_PASSWORD = getMergedConfigValue('DEVILBOX_POSTGRES_PASSWORD', getMergedConfigValue('PGSQL_ROOT_PASSWORD', ''));
const POSTGRES_DEFAULT_DATABASE = getMergedConfigValue('DEVILBOX_POSTGRES_DATABASE', getMergedConfigValue('PGSQL_DATABASE', 'postgres'));

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Check bearer token for all requests except initialize.
const checkToken = (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (req.method === 'POST' && req.body?.method !== 'initialize' && token !== EXPECTED_TOKEN) {
        return res.status(401).json({
            jsonrpc: '2.0',
            id: req.body.id || null,
            error: { code: -32001, message: 'Unauthorized' }
        });
    }

    next();
};

app.use(checkToken);

const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
};

const clientAcceptsSse = (req) => (req.headers.accept || '').includes('text/event-stream');

const shellEscape = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const stripSqlComments = (value) => value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim();

const assertReadOnlySql = (query) => {
    if (typeof query !== 'string' || !query.trim()) {
        return 'Missing query';
    }

    const normalized = stripSqlComments(query).replace(/;+$/g, '').trim();

    if (!normalized) {
        return 'Missing query';
    }

    if (normalized.includes(';')) {
        return 'Only a single SQL statement is allowed';
    }

    const upper = normalized.toUpperCase();
    const readOnlyPrefixes = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];

    if (!readOnlyPrefixes.some((prefix) => upper.startsWith(prefix))) {
        return 'Only read-only SQL statements are allowed';
    }

    const forbiddenPatterns = [
        /\bINSERT\b/,
        /\bUPDATE\b/,
        /\bDELETE\b/,
        /\bREPLACE\b/,
        /\bALTER\b/,
        /\bDROP\b/,
        /\bCREATE\b/,
        /\bTRUNCATE\b/,
        /\bGRANT\b/,
        /\bREVOKE\b/,
        /\bMERGE\b/,
        /\bUPSERT\b/,
        /\bCOPY\b/,
        /\bCALL\b/,
        /\bDO\b/,
        /\bSET\s+ROLE\b/,
        /\bSET\s+SESSION\s+CHARACTERISTICS\b/,
        /\bBEGIN\b/,
        /\bCOMMIT\b/,
        /\bROLLBACK\b/
    ];

    if (forbiddenPatterns.some((pattern) => pattern.test(upper))) {
        return 'The SQL query contains write-capable or session-changing statements';
    }

    return null;
};

const sendMcpResponse = (req, res, payload, status = 200) => {
    if (clientAcceptsSse(req)) {
        res.writeHead(status, sseHeaders);
        res.flushHeaders?.();
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
        return;
    }

    res.status(status).json(payload);
};

const makeToolResult = ({ command, containerWorkdir, service, stdout = '', stderr = '', exitCode = 0, extraStructuredContent = {} }) => {
    const structuredContent = {
        command,
        container_workdir: containerWorkdir,
        service,
        stdout,
        stderr,
        exit_code: exitCode,
        ...extraStructuredContent
    };

    const contentLines = [
        `Command: ${command}`,
        `Workdir: ${containerWorkdir}`,
        `Service: ${service}`,
        `Exit code: ${exitCode}`
    ];

    if (stdout) {
        contentLines.push('', 'STDOUT:', stdout);
    }

    if (stderr) {
        contentLines.push('', 'STDERR:', stderr);
    }

    return {
        content: [
            {
                type: 'text',
                text: contentLines.join('\n').trim()
            }
        ],
        structuredContent,
        isError: exitCode !== 0
    };
};

const runInContainer = ({ service, cmd, containerWorkdir = '/' }) => new Promise((resolve) => {
    const child = spawn(
        'docker',
        ['compose', 'exec', '-T', '-w', containerWorkdir, service, 'bash', '-lc', cmd],
        {
            cwd: DEVILBOX_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (error) => {
        if (killTimer) {
            clearTimeout(killTimer);
        }

        resolve({
            stdout,
            stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
            exitCode: 1,
            timedOut: false
        });
    });

    if (EXEC_TIMEOUT_MS > 0) {
        killTimer = setTimeout(() => {
            timedOut = true;
            stderr += `${stderr ? '\n' : ''}Command exceeded timeout of ${EXEC_TIMEOUT_MS} ms.`;
            child.kill('SIGTERM');

            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 5000);
        }, EXEC_TIMEOUT_MS);
    }

    child.on('close', (code, signal) => {
        if (killTimer) {
            clearTimeout(killTimer);
        }

        const exitCode = timedOut ? 124 : (code ?? 1);
        const signalSuffix = signal ? `${stderr ? '\n' : ''}Process terminated by signal ${signal}.` : '';

        resolve({
            stdout,
            stderr: `${stderr}${signalSuffix}`,
            exitCode,
            timedOut
        });
    });
});

const runInPhpContainer = ({ cmd, containerWorkdir }) => runInContainer({
    service: 'php',
    cmd,
    containerWorkdir
});

const runDockerComposeCommand = (args) => new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], {
        cwd: DEVILBOX_DIR,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (error) => {
        resolve({
            stdout,
            stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
            exitCode: 1
        });
    });

    child.on('close', (code) => {
        resolve({
            stdout,
            stderr,
            exitCode: code ?? 1
        });
    });
});

let cachedComposeServices = null;

const getComposeServices = async () => {
    if (cachedComposeServices) {
        return cachedComposeServices;
    }

    const { stdout, stderr, exitCode } = await runDockerComposeCommand(['config', '--services']);

    if (exitCode !== 0) {
        throw new Error(stderr.trim() || 'Failed to resolve docker compose services');
    }

    cachedComposeServices = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);

    return cachedComposeServices;
};

const resolveDbService = async ({ explicitService, candidates, label }) => {
    if (explicitService) {
        return explicitService;
    }

    const services = await getComposeServices();
    const match = candidates.find((candidate) => services.includes(candidate));

    if (!match) {
        throw new Error(`No ${label} service found. Checked: ${candidates.join(', ')}`);
    }

    return match;
};

const resolveContainerWorkdir = (project) => {
    const normalizedProject = normalizeContainerPath(project.trim());
    const baseWithSlash = `${PROJECTS_BASE_DIR}/`;

    if (normalizedProject === PROJECTS_BASE_DIR || normalizedProject.startsWith(baseWithSlash)) {
        return normalizedProject;
    }

    const projectName = normalizedProject.split('/').filter(Boolean).pop();
    return `${PROJECTS_BASE_DIR}/${projectName}`;
};

const listProjectsCommand = `find ${shellEscape(PROJECTS_BASE_DIR)} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; | sort`;
const buildProjectExistsCommand = (containerWorkdir) => `[ -d ${shellEscape(containerWorkdir)} ]`;

const buildMariadbCommand = ({ query, database }) => {
    const parts = [
        'MYSQL_PWD=' + shellEscape(MARIADB_PASSWORD),
        'mysql',
        '--batch',
        '--raw',
        '--silent',
        '--default-character-set=utf8mb4',
        '-u',
        shellEscape(MARIADB_USER)
    ];

    if (database) {
        parts.push('-D', shellEscape(database));
    }

    parts.push('-e', shellEscape(query));
    return parts.join(' ');
};

const buildPostgresCommand = ({ query, database }) => {
    const parts = [
        'PGPASSWORD=' + shellEscape(POSTGRES_PASSWORD),
        'psql',
        '-X',
        '--no-psqlrc',
        '-v',
        'ON_ERROR_STOP=1',
        '--csv',
        '-P',
        'pager=off',
        '-U',
        shellEscape(POSTGRES_USER),
        '-d',
        shellEscape(database || POSTGRES_DEFAULT_DATABASE)
    ];

    parts.push('-c', shellEscape(query));
    return parts.join(' ');
};

const getToolDefinitions = () => ([
    {
        name: 'list_projects',
        description: `Listet die Verzeichnisse direkt unter ${PROJECTS_BASE_DIR} im Devilbox-php-Container auf.`,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {}
        }
    },
    {
        name: 'exec_in_php_container',
        description: `Fuehrt einen Shell-Befehl im Devilbox-php-Container eines angegebenen Projekts aus. project ist Pflicht und muss auf ein Verzeichnis unter ${PROJECTS_BASE_DIR} zeigen.`,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                cmd: {
                    type: 'string',
                    minLength: 1,
                    description: 'Shell-Befehl, der im Devilbox-php-Container via bash -lc ausgefuehrt wird, z. B. "php -v", "composer install" oder "vendor/bin/phpunit --filter MyTest".'
                },
                project: {
                    type: 'string',
                    minLength: 1,
                    description: `Pflichtfeld. Arbeitsverzeichnis im Container: entweder der Projektname unter ${PROJECTS_BASE_DIR}, z. B. "forms_deluxe", oder ein absoluter Container-Pfad ab ${PROJECTS_BASE_DIR}/. Ohne project wird der Aufruf abgelehnt.`
                }
            },
            required: ['cmd', 'project']
        }
    },
    {
        name: 'query_mariadb',
        description: 'Fuehrt eine einzelne schreibgeschuetzte SQL-Abfrage im Devilbox-MariaDB-Container aus. Erlaubt sind nur read-only Statements wie SELECT, SHOW, DESCRIBE, DESC, EXPLAIN und WITH.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    description: 'Eine einzelne read-only SQL-Abfrage fuer MariaDB.'
                },
                database: {
                    type: 'string',
                    minLength: 1,
                    description: 'Optionale MariaDB-Datenbank. Wenn leer, wird die Server-Default aus DEVILBOX_MARIADB_DATABASE verwendet.'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'query_postgres',
        description: 'Fuehrt eine einzelne schreibgeschuetzte SQL-Abfrage im Devilbox-Postgres-Container aus. Erlaubt sind nur read-only Statements wie SELECT, SHOW, EXPLAIN und WITH.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    description: 'Eine einzelne read-only SQL-Abfrage fuer PostgreSQL.'
                },
                database: {
                    type: 'string',
                    minLength: 1,
                    description: `Optionale PostgreSQL-Datenbank. Wenn leer, wird ${POSTGRES_DEFAULT_DATABASE} verwendet.`
                }
            },
            required: ['query']
        }
    }
]);

const handleMcpRequest = (req, res) => {
    const { jsonrpc, method, id, params } = req.body || {};

    if (jsonrpc !== '2.0') {
        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id: id || null,
            error: { code: -32600, message: 'Invalid Request' }
        }, 400);
    }

    if (method === 'notifications/initialized') {
        res.status(202).end();
        return;
    }

    if (method === 'initialize') {
        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: params?.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'Node MCP Devilbox', version: '1.1' }
            }
        });
    }

    if (method === 'tools/list' || method === 'mcp/tools') {
        const tools = getToolDefinitions();

        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id,
            result: { tools }
        });
    }

    if (method === 'resources/list') {
        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id,
            result: { resources: [] }
        });
    }

    if (method === 'resources/templates/list' || method === 'resourceTemplates/list') {
        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id,
            result: { resourceTemplates: [] }
        });
    }

    if (method === 'tools/call') {
        const { name, arguments: args = {} } = params || {};

        if (name === 'list_projects') {
            runInContainer({
                service: 'php',
                cmd: listProjectsCommand,
                containerWorkdir: PROJECTS_BASE_DIR
            })
                .then(({ stdout, stderr, exitCode, timedOut }) => {
                    const projects = stdout
                        .split(/\r?\n/)
                        .map((value) => value.trim())
                        .filter(Boolean);

                    sendMcpResponse(req, res, {
                        jsonrpc: '2.0',
                        id,
                        result: makeToolResult({
                            command: listProjectsCommand,
                            containerWorkdir: PROJECTS_BASE_DIR,
                            service: 'php',
                            stdout,
                            stderr: timedOut ? `${stderr}${stderr ? '\n' : ''}The command timed out.` : stderr,
                            exitCode,
                            extraStructuredContent: {
                                projects
                            }
                        })
                    });
                });
            return;
        }

        if (name === 'exec_in_php_container') {
            const cmd = args.cmd;
            const projectDir = args.project;

            if (!cmd) {
                return sendMcpResponse(req, res, {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: 'Missing cmd' }
                });
            }

            if (!projectDir) {
                return sendMcpResponse(req, res, {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: 'Missing project' }
                });
            }

            const containerWorkdir = resolveContainerWorkdir(projectDir);

            console.log(`Executing in devilbox ${DEVILBOX_DIR}, service php, workdir ${containerWorkdir} (host hint: ${projectDir}): ${cmd}`);

            runInContainer({
                service: 'php',
                cmd: buildProjectExistsCommand(containerWorkdir),
                containerWorkdir: PROJECTS_BASE_DIR
            })
                .then(({ exitCode }) => {
                    if (exitCode !== 0) {
                        sendMcpResponse(req, res, {
                            jsonrpc: '2.0',
                            id,
                            result: makeToolResult({
                                command: cmd,
                                containerWorkdir,
                                service: 'php',
                                stdout: '',
                                stderr: `Project directory ${containerWorkdir} does not exist in the php container. Use list_projects to inspect available projects.`,
                                exitCode: 1
                            })
                        });
                        return;
                    }

                    return runInPhpContainer({ cmd, containerWorkdir })
                        .then(({ stdout, stderr, exitCode: commandExitCode, timedOut }) => {
                            sendMcpResponse(req, res, {
                                jsonrpc: '2.0',
                                id,
                                result: makeToolResult({
                                    command: cmd,
                                    containerWorkdir,
                                    service: 'php',
                                    stdout,
                                    stderr: timedOut ? `${stderr}${stderr ? '\n' : ''}The command timed out.` : stderr,
                                    exitCode: commandExitCode
                                })
                            });
                        });
                });
            return;
        }

        if (name === 'query_mariadb' || name === 'query_postgres') {
            const query = args.query;
            const validationError = assertReadOnlySql(query);

            if (validationError) {
                return sendMcpResponse(req, res, {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: validationError }
                });
            }

            const database = typeof args.database === 'string' && args.database.trim()
                ? args.database.trim()
                : (name === 'query_mariadb' ? MARIADB_DEFAULT_DATABASE : POSTGRES_DEFAULT_DATABASE);

            const resolver = name === 'query_mariadb'
                ? resolveDbService({
                    explicitService: DEVILBOX_MARIADB_SERVICE,
                    candidates: DEVILBOX_MARIADB_CANDIDATES,
                    label: 'MariaDB'
                })
                : resolveDbService({
                    explicitService: DEVILBOX_POSTGRES_SERVICE,
                    candidates: DEVILBOX_POSTGRES_CANDIDATES,
                    label: 'Postgres'
                });

            resolver
                .then((service) => {
                    const cmd = name === 'query_mariadb'
                        ? buildMariadbCommand({ query, database })
                        : buildPostgresCommand({ query, database });

                    console.log(`Executing read-only SQL in devilbox ${DEVILBOX_DIR}, service ${service}, database ${database || '<default>'}: ${query}`);

                    return runInContainer({
                        service,
                        cmd,
                        containerWorkdir: '/'
                    }).then(({ stdout, stderr, exitCode, timedOut }) => {
                        sendMcpResponse(req, res, {
                            jsonrpc: '2.0',
                            id,
                            result: makeToolResult({
                                command: query,
                                containerWorkdir: '/',
                                service,
                                stdout,
                                stderr: timedOut ? `${stderr}${stderr ? '\n' : ''}The command timed out.` : stderr,
                                exitCode,
                                extraStructuredContent: {
                                    database_type: name === 'query_mariadb' ? 'mariadb' : 'postgres',
                                    database
                                }
                            })
                        });
                    });
                })
                .catch((error) => {
                    sendMcpResponse(req, res, {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32000, message: error.message }
                    });
                });
            return;
        }

        return sendMcpResponse(req, res, {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'Tool not found' }
        });
    }

    return sendMcpResponse(req, res, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
    });
};

app.listen(PORT, HOST, () => {
    console.log(`MCP Streamable HTTP Server running on http://${HOST}:${PORT}`);
    console.log(`Token: ${EXPECTED_TOKEN}`);
    console.log(`Projects base dir: ${PROJECTS_BASE_DIR}`);
    console.log(`MariaDB service override: ${DEVILBOX_MARIADB_SERVICE || '<auto>'}`);
    console.log(`Postgres service override: ${DEVILBOX_POSTGRES_SERVICE || '<auto>'}`);
    console.log(`Exec timeout: ${EXEC_TIMEOUT_MS > 0 ? `${EXEC_TIMEOUT_MS} ms` : 'disabled'}`);
});

app.post(['/', '/mcp'], handleMcpRequest);

app.get(['/', '/mcp'], (req, res) => {
    if (clientAcceptsSse(req)) {
        res.writeHead(200, sseHeaders);
        res.flushHeaders?.();
        return;
    }

    res.status(200).json({ ok: true, transport: 'streamable-http' });
});
