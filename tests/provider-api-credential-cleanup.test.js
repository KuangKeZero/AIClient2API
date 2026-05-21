import { jest } from '@jest/globals';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getRegisteredProviders: jest.fn(() => []),
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

import { invalidateServiceAdapter } from '../src/providers/adapter.js';
import { broadcastEvent } from '../src/ui-modules/event-broadcast.js';
import { handleDeleteProvider } from '../src/ui-modules/provider-api.js';

const originalCwd = process.cwd();
let tempDir;

function createJsonResponseMock() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead: jest.fn(function writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        }),
        end: jest.fn(function end(chunk = '') {
            this.body += chunk;
        })
    };
}

async function readJson(relativePath) {
    return JSON.parse(await readFile(path.join(tempDir, relativePath), 'utf-8'));
}

async function writeJson(relativePath, value) {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2));
}

async function fileExists(relativePath) {
    try {
        await access(path.join(tempDir, relativePath));
        return true;
    } catch {
        return false;
    }
}

beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'provider-api-credential-cleanup-'));
    process.chdir(tempDir);
    await mkdir('configs/codex', { recursive: true });
});

afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
});

describe('provider API credential cleanup', () => {
    test('deletes orphan credential file when deleting a provider-pool account', async () => {
        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'delete-me',
                    customName: 'Delete Me',
                    CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/delete-me.json'
                },
                {
                    uuid: 'keep-me',
                    customName: 'Keep Me',
                    CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/keep-me.json'
                }
            ]
        };
        const credentialCleanup = {
            deletedFiles: ['configs/codex/delete-me.json'],
            skippedFiles: [],
            failedFiles: []
        };
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json',
            providerPools
        };
        const providerPoolManager = {
            providerPools: {},
            initializeProviderStatus: jest.fn()
        };
        const res = createJsonResponseMock();

        await writeJson('configs/provider_pools.json', providerPools);
        await writeFile(path.join(tempDir, 'configs/codex/delete-me.json'), '{}');
        await writeFile(path.join(tempDir, 'configs/codex/keep-me.json'), '{}');

        await handleDeleteProvider(
            {},
            res,
            currentConfig,
            providerPoolManager,
            'openai-codex-oauth',
            'delete-me'
        );

        const body = JSON.parse(res.body);
        const savedProviderPools = await readJson('configs/provider_pools.json');

        expect(res.statusCode).toBe(200);
        expect(body).toEqual(expect.objectContaining({
            success: true,
            message: 'Provider deleted successfully',
            credentialCleanup
        }));
        expect(await fileExists('configs/codex/delete-me.json')).toBe(false);
        expect(await fileExists('configs/codex/keep-me.json')).toBe(true);
        expect(savedProviderPools).toEqual({
            'openai-codex-oauth': [
                {
                    uuid: 'keep-me',
                    customName: 'Keep Me',
                    CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/keep-me.json'
                }
            ]
        });
        expect(providerPoolManager.providerPools).toEqual(savedProviderPools);
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalledTimes(1);
        expect(invalidateServiceAdapter).toHaveBeenCalledWith('openai-codex-oauth', 'delete-me');
        expect(broadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete',
            credentialCleanup
        }));
    });
});
