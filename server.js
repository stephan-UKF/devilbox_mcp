const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);

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
const PROJECTS_BASE_DIR = normalizeContainerPath(getConfigValue('DEVILBOX_PROJECTS_DIR', '/shared/httpd'));
const EXPECTED_TOKEN = getConfigValue('MCP_AUTH_TOKEN', 'dein_super_geheimer_token_2026_xyz123_abcdef987654321');

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

const makeToolResult = ({ command, containerWorkdir, stdout = '', stderr = '', exitCode = 0 }) => {
    const structuredContent = {
        command,
        container_workdir: containerWorkdir,
        stdout,
        stderr,
        exit_code: exitCode
    };

    const contentLines = [
        `Command: ${command}`,
        `Workdir: ${containerWorkdir}`,
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

const resolveContainerWorkdir = (project) => {
    const normalizedProject = normalizeContainerPath(project.trim());
    const baseWithSlash = `${PROJECTS_BASE_DIR}/`;

    if (normalizedProject === PROJECTS_BASE_DIR || normalizedProject.startsWith(baseWithSlash)) {
        return normalizedProject;
    }

    const projectName = normalizedProject.split('/').filter(Boolean).pop();
    return `${PROJECTS_BASE_DIR}/${projectName}`;
};

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
        const tools = [
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
            }
        ];

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

        if (name !== 'exec_in_php_container') {
            return sendMcpResponse(req, res, {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: 'Tool not found' }
            });
        }

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

        console.log(`Executing in devilbox ${DEVILBOX_DIR}, workdir ${containerWorkdir} (host hint: ${projectDir}): ${cmd}`);

        execPromise(
            `cd "${DEVILBOX_DIR}" && docker compose exec -T -w "${containerWorkdir}" php bash -lc "${cmd.replace(/"/g, '\\"')}" 2>&1`,
            { timeout: 60000 }
        )
            .then(({ stdout, stderr }) => {
                sendMcpResponse(req, res, {
                    jsonrpc: '2.0',
                    id,
                    result: makeToolResult({
                        command: cmd,
                        containerWorkdir,
                        stdout: stdout + (stderr || ''),
                        stderr: '',
                        exitCode: 0
                    })
                });
            })
            .catch((err) => {
                sendMcpResponse(req, res, {
                    jsonrpc: '2.0',
                    id,
                    result: makeToolResult({
                        command: cmd,
                        containerWorkdir,
                        stdout: err.stdout || '',
                        stderr: err.stderr || err.message || err.toString(),
                        exitCode: err.code || 1
                    })
                });
            });
        return;
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
