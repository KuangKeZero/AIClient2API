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
import {
    handleDeleteProvider,
    handleDeleteUnhealthyProviders
} from '../src/ui-modules/provider-api.js';
import { handleDeleteUnboundConfigs } from '../src/ui-modules/upload-config-api.js';

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

    test('keeps provider deletion successful when credential cleanup throws unexpectedly', async () => {
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
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json'
        };
        Object.defineProperty(currentConfig, 'BROKEN_CREDS_FILE_PATH', {
            enumerable: true,
            get() {
                throw new Error('cleanup boom');
            }
        });

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
        const expectedCleanupFailure = {
            deletedFiles: [],
            skippedFiles: [],
            failedFiles: [{ path: 'configs/codex/delete-me.json', error: 'cleanup boom' }]
        };

        expect(res.statusCode).toBe(200);
        expect(body).toEqual(expect.objectContaining({
            success: true,
            credentialCleanup: expectedCleanupFailure
        }));
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
        expect(await fileExists('configs/codex/delete-me.json')).toBe(true);
        expect(await fileExists('configs/codex/keep-me.json')).toBe(true);
        expect(broadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete',
            credentialCleanup: expectedCleanupFailure
        }));
    });

    test('cleans only orphan credentials when deleting unhealthy providers', async () => {
        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'unhealthy-orphan',
                    customName: 'Unhealthy Orphan',
                    isHealthy: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/unhealthy-orphan.json'
                },
                {
                    uuid: 'unhealthy-shared',
                    customName: 'Unhealthy Shared',
                    isHealthy: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                },
                {
                    uuid: 'healthy-shared',
                    customName: 'Healthy Shared',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                }
            ]
        };
        const credentialCleanup = {
            deletedFiles: ['configs/codex/unhealthy-orphan.json'],
            skippedFiles: [{ path: 'configs/codex/shared.json', reason: 'still_referenced' }],
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
        await writeFile(path.join(tempDir, 'configs/codex/unhealthy-orphan.json'), '{}');
        await writeFile(path.join(tempDir, 'configs/codex/shared.json'), '{}');

        await handleDeleteUnhealthyProviders(
            {},
            res,
            currentConfig,
            providerPoolManager,
            'openai-codex-oauth'
        );

        const body = JSON.parse(res.body);
        const savedProviderPools = await readJson('configs/provider_pools.json');

        expect(res.statusCode).toBe(200);
        expect(body).toEqual(expect.objectContaining({
            success: true,
            deletedCount: 2,
            remainingCount: 1,
            credentialCleanup
        }));
        expect(await fileExists('configs/codex/unhealthy-orphan.json')).toBe(false);
        expect(await fileExists('configs/codex/shared.json')).toBe(true);
        expect(savedProviderPools).toEqual({
            'openai-codex-oauth': [
                {
                    uuid: 'healthy-shared',
                    customName: 'Healthy Shared',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                }
            ]
        });
        expect(providerPoolManager.providerPools).toEqual(savedProviderPools);
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalledTimes(1);
        expect(broadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete_unhealthy',
            credentialCleanup
        }));
    });

    test('delete-unbound removes orphan provider credentials but keeps root config files', async () => {
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json',
            providerPools: {}
        };
        const providerPoolManager = {
            providerPools: {}
        };
        const res = createJsonResponseMock();

        await writeFile(path.join(tempDir, 'configs/codex/orphan-upload.json'), '{}');
        await writeFile(path.join(tempDir, 'configs/config.json'), '{}');
        await writeJson('configs/provider_pools.json', {});

        await handleDeleteUnboundConfigs({}, res, currentConfig, providerPoolManager);

        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);
        expect(body).toEqual(expect.objectContaining({
            success: true,
            deletedCount: 1,
            deletedFiles: ['configs/codex/orphan-upload.json'],
            failedFiles: [],
            skippedFiles: expect.arrayContaining([
                { path: 'configs/config.json', reason: 'unsafe_path' }
            ])
        }));
        expect(await fileExists('configs/codex/orphan-upload.json')).toBe(false);
        expect(await fileExists('configs/config.json')).toBe(true);
        expect(await fileExists('configs/provider_pools.json')).toBe(true);
    });
});
