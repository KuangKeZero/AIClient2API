# Credential Orphan Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically delete orphaned credential files when provider-pool accounts are deleted, while preserving shared, referenced, root-level, and external files.

**Architecture:** Add one focused cleanup module that owns credential path extraction, safety checks, reference checks, and file deletion. Wire provider deletion, unhealthy-provider batch deletion, and upload-config unbound cleanup into that module so every deletion path uses the same rules.

**Tech Stack:** Node.js ESM, Jest, existing `provider-utils.js` path helpers, existing UI API modules, existing file-lock and atomic write flow.

---

## File Structure

- Create `src/ui-modules/credential-cleanup.js`: shared credential cleanup helper used by provider and upload-config APIs.
- Create `tests/credential-cleanup.test.js`: focused unit tests for safe deletion, reference checks, and deduplication.
- Create `tests/provider-api-credential-cleanup.test.js`: integration-style UI API tests for provider deletion, unhealthy deletion, and unbound config cleanup.
- Modify `src/ui-modules/provider-api.js`: call the cleanup helper after deleting providers and include cleanup details in responses/events.
- Modify `src/ui-modules/upload-config-api.js`: replace local unlink logic in `handleDeleteUnboundConfigs` with the shared cleanup helper.

## Task 1: Shared Credential Cleanup Utility

**Files:**
- Create: `tests/credential-cleanup.test.js`
- Create: `src/ui-modules/credential-cleanup.js`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/credential-cleanup.test.js` with this full content:

```javascript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    cleanupCredentialFilesForDeletedProviders,
    isAllowedCredentialCleanupPath
} from '../src/ui-modules/credential-cleanup.js';

describe('credential orphan cleanup', () => {
    const originalCwd = process.cwd();
    let tempDir;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'credential-cleanup-'));
        mkdirSync(join(tempDir, 'configs', 'codex'), { recursive: true });
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('deletes a credential file that is no longer referenced', async () => {
        const credentialPath = join(tempDir, 'configs', 'codex', 'orphan.json');
        writeFileSync(credentialPath, JSON.stringify({ access_token: 'token' }));

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ uuid: 'deleted-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/orphan.json' }],
            {},
            { 'openai-codex-oauth': [] }
        );

        expect(result).toEqual({
            deletedFiles: ['configs/codex/orphan.json'],
            skippedFiles: [],
            failedFiles: []
        });
        expect(existsSync(credentialPath)).toBe(false);
    });

    test('skips a credential file that another provider still references', async () => {
        const credentialPath = join(tempDir, 'configs', 'codex', 'shared.json');
        writeFileSync(credentialPath, JSON.stringify({ access_token: 'token' }));

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ uuid: 'deleted-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json' }],
            {},
            {
                'openai-codex-oauth': [
                    { uuid: 'kept-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json' }
                ]
            }
        );

        expect(result.deletedFiles).toEqual([]);
        expect(result.skippedFiles).toEqual([
            { path: 'configs/codex/shared.json', reason: 'still_referenced' }
        ]);
        expect(result.failedFiles).toEqual([]);
        expect(existsSync(credentialPath)).toBe(true);
    });

    test('skips a credential file that main config still references', async () => {
        const credentialPath = join(tempDir, 'configs', 'codex', 'main.json');
        writeFileSync(credentialPath, JSON.stringify({ access_token: 'token' }));

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ uuid: 'deleted-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/main.json' }],
            { CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/main.json' },
            { 'openai-codex-oauth': [] }
        );

        expect(result.deletedFiles).toEqual([]);
        expect(result.skippedFiles).toEqual([
            { path: 'configs/codex/main.json', reason: 'still_referenced' }
        ]);
        expect(result.failedFiles).toEqual([]);
        expect(existsSync(credentialPath)).toBe(true);
    });

    test('rejects root-level config files as unsafe cleanup targets', async () => {
        mkdirSync(join(tempDir, 'configs'), { recursive: true });
        const rootConfigPath = join(tempDir, 'configs', 'root.json');
        writeFileSync(rootConfigPath, JSON.stringify({ access_token: 'token' }));

        expect(isAllowedCredentialCleanupPath('./configs/root.json')).toMatchObject({
            allowed: false,
            reason: 'unsafe_path',
            path: 'configs/root.json'
        });

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ uuid: 'deleted-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/root.json' }],
            {},
            {}
        );

        expect(result.deletedFiles).toEqual([]);
        expect(result.skippedFiles).toEqual([
            { path: 'configs/root.json', reason: 'unsafe_path' }
        ]);
        expect(result.failedFiles).toEqual([]);
        expect(existsSync(rootConfigPath)).toBe(true);
    });

    test('deduplicates repeated credential paths before deleting', async () => {
        const credentialPath = join(tempDir, 'configs', 'codex', 'duplicate.json');
        writeFileSync(credentialPath, JSON.stringify({ access_token: 'token' }));

        const result = await cleanupCredentialFilesForDeletedProviders(
            [
                { uuid: 'deleted-1', CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/duplicate.json' },
                { uuid: 'deleted-2', CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/duplicate.json' }
            ],
            {},
            { 'openai-codex-oauth': [] }
        );

        expect(result.deletedFiles).toEqual(['configs/codex/duplicate.json']);
        expect(result.skippedFiles).toEqual([]);
        expect(result.failedFiles).toEqual([]);
        expect(existsSync(credentialPath)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm test -- tests/credential-cleanup.test.js --runInBand
```

Expected: FAIL because `../src/ui-modules/credential-cleanup.js` does not exist.

- [ ] **Step 3: Implement the shared cleanup utility**

Create `src/ui-modules/credential-cleanup.js` with this full content:

```javascript
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import {
    PROVIDER_MAPPINGS,
    addToUsedPaths,
    isPathUsed
} from '../utils/provider-utils.js';

const CREDENTIAL_PATH_KEY_PATTERN = /_(?:CREDS|TOKEN)_FILE_PATH$/;
const CREDENTIAL_FILE_EXTENSIONS = new Set(['.json', '.oauth', '.creds', '.key', '.pem', '.txt']);

function buildAllowedCredentialDirs() {
    const dirs = new Set();
    for (const mapping of PROVIDER_MAPPINGS) {
        if (mapping.dirName) {
            dirs.add(mapping.dirName);
        }
        for (const pattern of mapping.patterns || []) {
            const match = pattern.match(/^configs\/([^/]+)\//);
            if (match) {
                dirs.add(match[1]);
            }
        }
    }
    return dirs;
}

const ALLOWED_CREDENTIAL_DIRS = buildAllowedCredentialDirs();

function normalizeDisplayPath(filePath, absolutePath = null) {
    const sourcePath = absolutePath || filePath;
    if (!sourcePath) return '';

    const resolvedPath = path.isAbsolute(sourcePath)
        ? path.normalize(sourcePath)
        : path.resolve(process.cwd(), sourcePath);
    const relativePath = path.relative(process.cwd(), resolvedPath);

    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
    }

    return relativePath.replace(/\\/g, '/');
}

function emptyCleanupResult() {
    return {
        deletedFiles: [],
        skippedFiles: [],
        failedFiles: []
    };
}

export function extractCredentialPathsFromProvider(provider = {}) {
    if (!provider || typeof provider !== 'object') {
        return [];
    }

    return Object.entries(provider)
        .filter(([key, value]) => CREDENTIAL_PATH_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim())
        .map(([, value]) => value.trim());
}

export function isAllowedCredentialCleanupPath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return {
            allowed: false,
            reason: 'empty_path',
            path: ''
        };
    }

    const absolutePath = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(process.cwd(), filePath);
    const configsDir = path.resolve(process.cwd(), 'configs');
    const relativeToConfigs = path.relative(configsDir, absolutePath);
    const displayPath = normalizeDisplayPath(filePath, absolutePath);

    if (!relativeToConfigs || relativeToConfigs.startsWith('..') || path.isAbsolute(relativeToConfigs)) {
        return {
            allowed: false,
            reason: 'unsafe_path',
            path: displayPath,
            absolutePath
        };
    }

    const parts = displayPath.split('/');
    if (parts.length < 3 || parts[0] !== 'configs') {
        return {
            allowed: false,
            reason: 'unsafe_path',
            path: displayPath,
            absolutePath
        };
    }

    const providerDir = parts[1];
    if (!ALLOWED_CREDENTIAL_DIRS.has(providerDir)) {
        return {
            allowed: false,
            reason: 'unsupported_provider_dir',
            path: displayPath,
            absolutePath
        };
    }

    const extension = path.extname(displayPath).toLowerCase();
    if (!CREDENTIAL_FILE_EXTENSIONS.has(extension)) {
        return {
            allowed: false,
            reason: 'unsupported_extension',
            path: displayPath,
            absolutePath
        };
    }

    return {
        allowed: true,
        path: displayPath,
        absolutePath,
        providerDir
    };
}

export function collectCredentialReferences(currentConfig = {}, providerPools = {}) {
    const references = [];

    if (currentConfig && typeof currentConfig === 'object') {
        for (const [key, value] of Object.entries(currentConfig)) {
            if (CREDENTIAL_PATH_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim()) {
                references.push(value.trim());
            }
        }
    }

    if (providerPools && typeof providerPools === 'object') {
        for (const providers of Object.values(providerPools)) {
            if (!Array.isArray(providers)) continue;
            for (const provider of providers) {
                references.push(...extractCredentialPathsFromProvider(provider));
            }
        }
    }

    return references;
}

export function isCredentialPathReferenced(filePath, currentConfig = {}, providerPools = {}) {
    const validation = isAllowedCredentialCleanupPath(filePath);
    const displayPath = validation.path || normalizeDisplayPath(filePath, validation.absolutePath);
    const fileName = path.basename(displayPath);
    const usedPaths = new Set();

    for (const reference of collectCredentialReferences(currentConfig, providerPools)) {
        addToUsedPaths(usedPaths, reference);
    }

    return isPathUsed(displayPath, fileName, usedPaths);
}

function addCandidate(candidateMap, filePath) {
    const validation = isAllowedCredentialCleanupPath(filePath);
    const dedupeKey = validation.absolutePath || path.resolve(process.cwd(), filePath);

    if (!candidateMap.has(dedupeKey)) {
        candidateMap.set(dedupeKey, {
            originalPath: filePath,
            validation
        });
    }
}

async function cleanupCredentialPathCandidates(candidateMap, currentConfig = {}, providerPools = {}) {
    const result = emptyCleanupResult();

    for (const { originalPath, validation } of candidateMap.values()) {
        const resultPath = validation.path || normalizeDisplayPath(originalPath, validation.absolutePath);

        if (!validation.allowed) {
            result.skippedFiles.push({
                path: resultPath,
                reason: validation.reason
            });
            continue;
        }

        if (isCredentialPathReferenced(resultPath, currentConfig, providerPools)) {
            result.skippedFiles.push({
                path: resultPath,
                reason: 'still_referenced'
            });
            continue;
        }

        if (!existsSync(validation.absolutePath)) {
            result.skippedFiles.push({
                path: resultPath,
                reason: 'file_not_found'
            });
            continue;
        }

        try {
            await fs.unlink(validation.absolutePath);
            result.deletedFiles.push(resultPath);
            logger.info(`[Credential Cleanup] Deleted orphan credential: ${resultPath}`);
        } catch (error) {
            result.failedFiles.push({
                path: resultPath,
                error: error.message
            });
            logger.warn(`[Credential Cleanup] Failed to delete ${resultPath}: ${error.message}`);
        }
    }

    return result;
}

export async function cleanupCredentialFilesForDeletedProviders(deletedProviders = [], currentConfig = {}, providerPools = {}) {
    const candidateMap = new Map();

    for (const provider of deletedProviders) {
        for (const credentialPath of extractCredentialPathsFromProvider(provider)) {
            addCandidate(candidateMap, credentialPath);
        }
    }

    return cleanupCredentialPathCandidates(candidateMap, currentConfig, providerPools);
}

export async function cleanupUnboundConfigFileEntries(configFiles = [], currentConfig = {}, providerPools = {}) {
    const candidateMap = new Map();

    for (const configFile of configFiles) {
        if (!configFile || configFile.isUsed || !configFile.path) {
            continue;
        }
        addCandidate(candidateMap, configFile.path);
    }

    return cleanupCredentialPathCandidates(candidateMap, currentConfig, providerPools);
}
```

- [ ] **Step 4: Run the utility tests to verify they pass**

Run:

```bash
npm test -- tests/credential-cleanup.test.js --runInBand
```

Expected: PASS for all 5 tests in `credential orphan cleanup`.

- [ ] **Step 5: Commit the shared utility**

Run:

```bash
git add src/ui-modules/credential-cleanup.js tests/credential-cleanup.test.js
git commit -m "feat: add credential orphan cleanup helper"
```

Expected: commit succeeds.

## Task 2: Single Provider Delete Cleanup

**Files:**
- Create: `tests/provider-api-credential-cleanup.test.js`
- Modify: `src/ui-modules/provider-api.js`

- [ ] **Step 1: Write the failing provider delete integration test**

Create `tests/provider-api-credential-cleanup.test.js` with this full content:

```javascript
import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

function writeJson(filePath, data) {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

describe('provider API credential cleanup', () => {
    const originalCwd = process.cwd();
    let tempDir;
    let poolsPath;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'provider-api-cleanup-'));
        mkdirSync(join(tempDir, 'configs', 'codex'), { recursive: true });
        process.chdir(tempDir);
        poolsPath = join(tempDir, 'configs', 'provider_pools.json');
        broadcastEvent.mockClear();
        invalidateServiceAdapter.mockClear();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('deletes the orphan credential after deleting a provider account', async () => {
        const deletedCredentialPath = join(tempDir, 'configs', 'codex', 'delete-me.json');
        const keptCredentialPath = join(tempDir, 'configs', 'codex', 'keep-me.json');
        writeJson(deletedCredentialPath, { access_token: 'deleted-token' });
        writeJson(keptCredentialPath, { access_token: 'kept-token' });

        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'delete-me',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/delete-me.json'
                },
                {
                    uuid: 'keep-me',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/keep-me.json'
                }
            ]
        };
        writeJson(poolsPath, providerPools);

        const providerPoolManager = {
            providerPools,
            initializeProviderStatus: jest.fn()
        };
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json'
        };
        const res = createJsonResponseMock();

        await handleDeleteProvider({}, res, currentConfig, providerPoolManager, 'openai-codex-oauth', 'delete-me');

        const body = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(body.success).toBe(true);
        expect(body.credentialCleanup).toEqual({
            deletedFiles: ['configs/codex/delete-me.json'],
            skippedFiles: [],
            failedFiles: []
        });
        expect(existsSync(deletedCredentialPath)).toBe(false);
        expect(existsSync(keptCredentialPath)).toBe(true);
        expect(readJson(poolsPath)).toEqual({
            'openai-codex-oauth': [
                {
                    uuid: 'keep-me',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/keep-me.json'
                }
            ]
        });
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
        expect(invalidateServiceAdapter).toHaveBeenCalledWith('openai-codex-oauth', 'delete-me');
        expect(broadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete',
            credentialCleanup: {
                deletedFiles: ['configs/codex/delete-me.json'],
                skippedFiles: [],
                failedFiles: []
            }
        }));
    });
});
```

- [ ] **Step 2: Run the provider API test to verify it fails**

Run:

```bash
npm test -- tests/provider-api-credential-cleanup.test.js --runInBand
```

Expected: FAIL because `body.credentialCleanup` is missing from `handleDeleteProvider`.

- [ ] **Step 3: Import the cleanup helper in provider API**

In `src/ui-modules/provider-api.js`, add this import near the existing local UI module imports:

```javascript
import { cleanupCredentialFilesForDeletedProviders } from './credential-cleanup.js';
```

The import section should include both existing imports and the new helper:

```javascript
import { broadcastEvent } from './event-broadcast.js';
import { getRegisteredProviders, getServiceAdapter, invalidateServiceAdapter, serviceInstances } from '../providers/adapter.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.js';
import { cleanupCredentialFilesForDeletedProviders } from './credential-cleanup.js';
```

- [ ] **Step 4: Add credential cleanup to single provider deletion**

In `_handleDeleteProvider` inside `src/ui-modules/provider-api.js`, after the provider pool manager refresh block and before the `broadcastEvent('config_update', ...)` call, insert:

```javascript
        const credentialCleanup = await cleanupCredentialFilesForDeletedProviders(
            [deletedProvider],
            currentConfig,
            providerPools
        );
```

Then update the existing `broadcastEvent('config_update', ...)` payload so it includes `credentialCleanup`:

```javascript
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(deletedProvider),
            credentialCleanup,
            timestamp: new Date().toISOString()
        });
```

Finally update the `res.end(JSON.stringify(...))` body in the same function so it includes `credentialCleanup`:

```javascript
        res.end(JSON.stringify({
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider: sanitizeProviderData(deletedProvider),
            credentialCleanup
        }));
```

- [ ] **Step 5: Run the provider API test to verify it passes**

Run:

```bash
npm test -- tests/provider-api-credential-cleanup.test.js --runInBand
```

Expected: PASS for `deletes the orphan credential after deleting a provider account`.

- [ ] **Step 6: Run the utility tests again**

Run:

```bash
npm test -- tests/credential-cleanup.test.js --runInBand
```

Expected: PASS for all cleanup utility tests.

- [ ] **Step 7: Commit single-delete cleanup**

Run:

```bash
git add src/ui-modules/provider-api.js tests/provider-api-credential-cleanup.test.js
git commit -m "feat: clean orphan credentials on provider delete"
```

Expected: commit succeeds.

## Task 3: Batch Delete And Unbound Cleanup

**Files:**
- Modify: `tests/provider-api-credential-cleanup.test.js`
- Modify: `src/ui-modules/provider-api.js`
- Modify: `src/ui-modules/upload-config-api.js`

- [ ] **Step 1: Extend the provider API cleanup tests**

In `tests/provider-api-credential-cleanup.test.js`, update the provider API import:

```javascript
import {
    handleDeleteProvider,
    handleDeleteUnhealthyProviders
} from '../src/ui-modules/provider-api.js';
import { handleDeleteUnboundConfigs } from '../src/ui-modules/upload-config-api.js';
```

Then append these tests inside the existing `describe('provider API credential cleanup', () => { ... })` block:

```javascript
    test('cleans only orphan credentials when deleting unhealthy providers', async () => {
        const orphanPath = join(tempDir, 'configs', 'codex', 'unhealthy-orphan.json');
        const sharedPath = join(tempDir, 'configs', 'codex', 'shared.json');
        writeJson(orphanPath, { access_token: 'orphan-token' });
        writeJson(sharedPath, { access_token: 'shared-token' });

        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'unhealthy-orphan',
                    isHealthy: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/unhealthy-orphan.json'
                },
                {
                    uuid: 'unhealthy-shared',
                    isHealthy: false,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                },
                {
                    uuid: 'healthy-shared',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                }
            ]
        };
        writeJson(poolsPath, providerPools);

        const providerPoolManager = {
            providerPools,
            initializeProviderStatus: jest.fn()
        };
        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json'
        };
        const res = createJsonResponseMock();

        await handleDeleteUnhealthyProviders({}, res, currentConfig, providerPoolManager, 'openai-codex-oauth');

        const body = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(body.deletedCount).toBe(2);
        expect(body.remainingCount).toBe(1);
        expect(body.credentialCleanup).toEqual({
            deletedFiles: ['configs/codex/unhealthy-orphan.json'],
            skippedFiles: [
                { path: 'configs/codex/shared.json', reason: 'still_referenced' }
            ],
            failedFiles: []
        });
        expect(existsSync(orphanPath)).toBe(false);
        expect(existsSync(sharedPath)).toBe(true);
        expect(readJson(poolsPath)).toEqual({
            'openai-codex-oauth': [
                {
                    uuid: 'healthy-shared',
                    isHealthy: true,
                    CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/shared.json'
                }
            ]
        });
        expect(broadcastEvent).toHaveBeenCalledWith('config_update', expect.objectContaining({
            action: 'delete_unhealthy',
            credentialCleanup: {
                deletedFiles: ['configs/codex/unhealthy-orphan.json'],
                skippedFiles: [
                    { path: 'configs/codex/shared.json', reason: 'still_referenced' }
                ],
                failedFiles: []
            }
        }));
    });

    test('delete-unbound removes orphan provider credentials but keeps root config files', async () => {
        const orphanPath = join(tempDir, 'configs', 'codex', 'orphan-upload.json');
        const rootConfigPath = join(tempDir, 'configs', 'config.json');
        writeJson(orphanPath, { access_token: 'orphan-token' });
        writeJson(rootConfigPath, { MODEL_PROVIDER: 'openai-codex-oauth' });
        writeJson(poolsPath, {});

        const currentConfig = {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json',
            providerPools: {}
        };
        const providerPoolManager = {
            providerPools: {}
        };
        const res = createJsonResponseMock();

        await handleDeleteUnboundConfigs({}, res, currentConfig, providerPoolManager);

        const body = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(body.deletedFiles).toEqual(['configs/codex/orphan-upload.json']);
        expect(body.deletedCount).toBe(1);
        expect(body.failedFiles).toEqual([]);
        expect(body.skippedFiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'configs/config.json', reason: 'unsafe_path' })
        ]));
        expect(existsSync(orphanPath)).toBe(false);
        expect(existsSync(rootConfigPath)).toBe(true);
        expect(existsSync(poolsPath)).toBe(true);
    });
```

- [ ] **Step 2: Run the extended provider API tests to verify they fail**

Run:

```bash
npm test -- tests/provider-api-credential-cleanup.test.js --runInBand
```

Expected: FAIL because `handleDeleteUnhealthyProviders` does not return `credentialCleanup`, and `handleDeleteUnboundConfigs` does not return `skippedFiles` from the shared cleanup helper.

- [ ] **Step 3: Add credential cleanup to unhealthy provider deletion**

In `_handleDeleteUnhealthyProviders` inside `src/ui-modules/provider-api.js`, after the provider pool manager refresh block and before the `broadcastEvent('config_update', ...)` call, insert:

```javascript
        const credentialCleanup = await cleanupCredentialFilesForDeletedProviders(
            unhealthyProviders,
            currentConfig,
            providerPools
        );
```

Then update the existing `broadcastEvent('config_update', ...)` payload so it includes `credentialCleanup`:

```javascript
        broadcastEvent('config_update', {
            action: 'delete_unhealthy',
            filePath: filePath,
            providerType,
            deletedCount: unhealthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => sanitizeProviderData({ uuid: p.uuid, customName: p.customName })),
            credentialCleanup,
            timestamp: new Date().toISOString()
        });
```

Finally update the `res.end(JSON.stringify(...))` body in the same function so it includes `credentialCleanup`:

```javascript
        res.end(JSON.stringify({
            success: true,
            message: `Successfully deleted ${unhealthyProviders.length} unhealthy providers`,
            deletedCount: unhealthyProviders.length,
            remainingCount: healthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => ({ uuid: p.uuid, customName: p.customName })),
            credentialCleanup
        }));
```

- [ ] **Step 4: Import the unbound cleanup helper**

In `src/ui-modules/upload-config-api.js`, add this import next to the existing `scanConfigFiles` import:

```javascript
import { cleanupUnboundConfigFileEntries } from './credential-cleanup.js';
```

The import section should include:

```javascript
import { broadcastEvent } from './event-broadcast.js';
import { scanConfigFiles } from './config-scanner.js';
import { cleanupUnboundConfigFileEntries } from './credential-cleanup.js';
```

- [ ] **Step 5: Replace manual unbound deletion logic with shared cleanup**

In `handleDeleteUnboundConfigs` inside `src/ui-modules/upload-config-api.js`, replace the current `unboundConfigs` filtering and manual `for ... fs.unlink` block with this code:

```javascript
        const unboundConfigs = configFiles.filter(config => !config.isUsed);
        const providerPools = providerPoolManager?.providerPools || currentConfig.providerPools || {};
        const credentialCleanup = await cleanupUnboundConfigFileEntries(
            unboundConfigs,
            currentConfig,
            providerPools
        );

        const deletedFiles = credentialCleanup.deletedFiles;
        const failedFiles = credentialCleanup.failedFiles;
        const skippedFiles = credentialCleanup.skippedFiles;
```

Keep the existing broadcast section, but update it so the event includes skipped files:

```javascript
        if (deletedFiles.length > 0) {
            broadcastEvent('config_update', {
                action: 'batch_delete',
                deletedFiles: deletedFiles,
                skippedFiles: skippedFiles,
                timestamp: new Date().toISOString()
            });
        }
```

Update the final response body so it returns skipped details:

```javascript
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Deleted ${deletedFiles.length} unbound config files`,
            deletedCount: deletedFiles.length,
            deletedFiles: deletedFiles,
            failedCount: failedFiles.length,
            failedFiles: failedFiles,
            skippedCount: skippedFiles.length,
            skippedFiles: skippedFiles
        }));
        return true;
```

Remove the old early return that only checked `unboundConfigs.length === 0`; the shared cleanup result now drives the zero-deletion response and preserves skipped-file details for root-level config files.

- [ ] **Step 6: Run the extended provider API tests to verify they pass**

Run:

```bash
npm test -- tests/provider-api-credential-cleanup.test.js --runInBand
```

Expected: PASS for all tests in `provider API credential cleanup`.

- [ ] **Step 7: Run the utility tests again**

Run:

```bash
npm test -- tests/credential-cleanup.test.js --runInBand
```

Expected: PASS for all cleanup utility tests.

- [ ] **Step 8: Commit batch and unbound cleanup**

Run:

```bash
git add src/ui-modules/provider-api.js src/ui-modules/upload-config-api.js tests/provider-api-credential-cleanup.test.js
git commit -m "feat: clean orphan credentials in batch cleanup"
```

Expected: commit succeeds.

## Task 4: Final Verification

**Files:**
- Verify: `src/ui-modules/credential-cleanup.js`
- Verify: `src/ui-modules/provider-api.js`
- Verify: `src/ui-modules/upload-config-api.js`
- Verify: `tests/credential-cleanup.test.js`
- Verify: `tests/provider-api-credential-cleanup.test.js`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- tests/credential-cleanup.test.js tests/provider-api-credential-cleanup.test.js --runInBand
```

Expected: PASS for both targeted test files.

- [ ] **Step 2: Run the existing quota-ledger regression tests**

Run:

```bash
npm test -- tests/account-quota-ledger.test.js --runInBand
```

Expected: PASS. This confirms provider-pool data shape changes did not break existing account pool and usage synchronization tests.

- [ ] **Step 3: Restart the local service**

Run:

```bash
./aiclient2api.sh restart
```

Expected: the service restarts successfully on the project port `3001`.

- [ ] **Step 4: Verify the service responds on port 3001**

Run:

```bash
curl -sS -o /tmp/aiclient2api-upload-configs.json -w "%{http_code}\n" http://localhost:3001/api/upload-configs
```

Expected: prints `200`. The response body is saved to `/tmp/aiclient2api-upload-configs.json` for inspection if the status is not 200.

- [ ] **Step 5: Check the final diff**

Run:

```bash
git status --short -- src/ui-modules/credential-cleanup.js src/ui-modules/provider-api.js src/ui-modules/upload-config-api.js tests/credential-cleanup.test.js tests/provider-api-credential-cleanup.test.js
git diff --check
```

Expected: `git diff --check` prints no whitespace errors. The scoped `git status --short` command prints no output because Tasks 1-3 committed the implementation and tests.

- [ ] **Step 6: Confirm recent implementation commits**

Run:

```bash
git log --oneline -3
```

Expected: output includes the three task commits:

```text
feat: clean orphan credentials in batch cleanup
feat: clean orphan credentials on provider delete
feat: add credential orphan cleanup helper
```
