import { jest } from '@jest/globals';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

jest.mock('open', () => jest.fn());

jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {}
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfigForProvider: jest.fn(() => null)
}));

import { autoLinkProviderConfigs } from '../src/services/service-manager.js';
import { batchImportCodexTokensStream } from '../src/auth/codex-oauth.js';

const originalCwd = process.cwd();
let tempDir;

async function writeJson(relativePath, value) {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2));
}

async function readCodexCredentials() {
    const codexDir = path.join(tempDir, 'configs/codex');
    const files = await readdir(codexDir);
    return Promise.all(files.map(async (file) => {
        const fullPath = path.join(codexDir, file);
        return JSON.parse(await readFile(fullPath, 'utf8'));
    }));
}

function fakeJwt(payload = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'test-user', exp: 1781654400, ...payload })).toString('base64url');
    return `${header}.${body}.signature`;
}

function codexToken(overrides = {}) {
    const email = overrides.email || 'user@example.com';

    return {
        account_id: 'shared-account',
        email,
        access_token: fakeJwt({ email }),
        refresh_token: 'refresh-token',
        expired: '2026-06-17T00:00:00.000Z',
        ...overrides
    };
}

beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'codex-batch-import-'));
    process.chdir(tempDir);
    await mkdir('configs/codex', { recursive: true });
});

afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
});

describe('Codex batch token import duplicate detection', () => {
    test('imports distinct refresh tokens even when account_id is shared', async () => {
        const result = await batchImportCodexTokensStream([
            codexToken({ email: 'one@example.com', access_token: fakeJwt({ sub: 'access-one' }), refresh_token: 'refresh-one' }),
            codexToken({ email: 'two@example.com', access_token: fakeJwt({ sub: 'access-two' }), refresh_token: 'refresh-two' }),
            codexToken({ email: 'three@example.com', access_token: fakeJwt({ sub: 'access-three' }), refresh_token: 'refresh-three' })
        ]);

        expect(result).toMatchObject({
            total: 3,
            success: 3,
            failed: 0
        });
        expect(result.details.every(detail => detail.success)).toBe(true);

        const saved = await readCodexCredentials();
        expect(saved).toHaveLength(3);
        expect([...new Set(saved.map(credential => credential.account_id))]).toEqual(['shared-account']);
        expect(saved.map(credential => credential.refresh_token).sort()).toEqual([
            'refresh-one',
            'refresh-three',
            'refresh-two'
        ]);
        expect(autoLinkProviderConfigs).toHaveBeenCalledTimes(3);
    });

    test('flags duplicate only when refresh_token matches an existing credential', async () => {
        await writeJson('configs/codex/existing.json', codexToken({
            email: 'existing@example.com',
            access_token: fakeJwt({ sub: 'access-existing' }),
            refresh_token: 'refresh-existing'
        }));

        const result = await batchImportCodexTokensStream([
            codexToken({ email: 'fresh@example.com', access_token: fakeJwt({ sub: 'access-fresh' }), refresh_token: 'refresh-fresh' }),
            codexToken({ email: 'duplicate@example.com', account_id: 'other-account', access_token: fakeJwt({ sub: 'access-duplicate' }), refresh_token: 'refresh-existing' })
        ]);

        expect(result.success).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.details[0]).toMatchObject({
            success: true,
            email: 'fresh@example.com'
        });
        expect(result.details[1]).toMatchObject({
            success: false,
            error: 'duplicate',
            duplicateField: 'refresh_token',
            existingPath: 'configs/codex/existing.json'
        });

        const saved = await readCodexCredentials();
        expect(saved).toHaveLength(2);
    });

    test('uses access_token exact match for access-token-only duplicates', async () => {
        const existingAccessToken = fakeJwt({ sub: 'access-existing' });

        await writeJson('configs/codex/existing.json', codexToken({
            email: 'existing@example.com',
            access_token: existingAccessToken,
            refresh_token: ''
        }));

        const result = await batchImportCodexTokensStream([
            codexToken({ email: 'fresh@example.com', access_token: fakeJwt({ sub: 'access-fresh' }), refresh_token: '' }),
            codexToken({ email: 'duplicate@example.com', account_id: 'other-account', access_token: existingAccessToken, refresh_token: '' })
        ]);

        expect(result.success).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.details[0]).toMatchObject({
            success: true,
            accessTokenOnly: true
        });
        expect(result.details[1]).toMatchObject({
            success: false,
            error: 'duplicate',
            duplicateField: 'access_token',
            existingPath: 'configs/codex/existing.json'
        });
    });
});
