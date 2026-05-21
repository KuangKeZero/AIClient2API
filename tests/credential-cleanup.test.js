import { mkdtemp, mkdir, rm, writeFile, access, symlink, readFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import {
    collectCredentialReferences,
    cleanupCredentialFilesForDeletedProviders,
    cleanupUnboundConfigFileEntries,
    isAllowedCredentialCleanupPath
} from '../src/ui-modules/credential-cleanup.js';

const originalCwd = process.cwd();
let tempDir;

async function createCredentialFile(relativePath, content = '{}') {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return fullPath;
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
    tempDir = await mkdtemp(path.join(tmpdir(), 'credential-cleanup-'));
    process.chdir(tempDir);
});

afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
});

describe('credential cleanup helper', () => {
    test('collects raw credential path references without expanding matcher variants', () => {
        const references = collectCredentialReferences(
            {
                CODEX_OAUTH_CREDS_FILE_PATH: '  ./configs/codex/main.json  ',
                GROK_COOKIE_TOKEN: 'not-a-file-path-token'
            },
            {
                'openai-codex-oauth': [
                    { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/provider.json' }
                ],
                'grok-web': [
                    { GROK_COOKIE_TOKEN: 'still-not-a-file-path-token' }
                ]
            }
        );

        expect(references).toEqual([
            './configs/codex/main.json',
            'configs/codex/provider.json'
        ]);
    });

    test('uses explicit provider pools instead of stale current config provider pools', async () => {
        await createCredentialFile('configs/codex/stale.json');

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/stale.json' }],
            {
                providerPools: {
                    'openai-codex-oauth': [
                        { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/stale.json' }
                    ]
                }
            },
            {}
        );

        expect(result).toEqual({
            deletedFiles: ['configs/codex/stale.json'],
            skippedFiles: [],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/stale.json')).toBe(false);
    });

    test('deletes a credential file that is no longer referenced', async () => {
        await createCredentialFile('configs/codex/orphan.json');

        const result = await cleanupCredentialFilesForDeletedProviders([
            { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/orphan.json' }
        ]);

        expect(result).toEqual({
            deletedFiles: ['configs/codex/orphan.json'],
            skippedFiles: [],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/orphan.json')).toBe(false);
    });

    test('skips a credential file that another provider still references', async () => {
        await createCredentialFile('configs/codex/shared.json');

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/shared.json' }],
            {},
            {
                'openai-codex-oauth': [
                    { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/shared.json' }
                ]
            }
        );

        expect(result).toEqual({
            deletedFiles: [],
            skippedFiles: [{ path: 'configs/codex/shared.json', reason: 'still_referenced' }],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/shared.json')).toBe(true);
    });

    test('skips a credential file that main config still references', async () => {
        await createCredentialFile('configs/codex/main.json');

        const result = await cleanupCredentialFilesForDeletedProviders(
            [{ CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/main.json' }],
            { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/main.json' }
        );

        expect(result).toEqual({
            deletedFiles: [],
            skippedFiles: [{ path: 'configs/codex/main.json', reason: 'still_referenced' }],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/main.json')).toBe(true);
    });

    test('rejects root-level config files as unsafe cleanup targets', async () => {
        await createCredentialFile('configs/root.json');

        expect(isAllowedCredentialCleanupPath('configs/root.json')).toEqual({
            allowed: false,
            reason: 'unsafe_path',
            path: 'configs/root.json'
        });

        const result = await cleanupCredentialFilesForDeletedProviders([
            { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/root.json' }
        ]);

        expect(result).toEqual({
            deletedFiles: [],
            skippedFiles: [{ path: 'configs/root.json', reason: 'unsafe_path' }],
            failedFiles: []
        });
        expect(await fileExists('configs/root.json')).toBe(true);
    });

    test('deduplicates repeated credential paths before deleting', async () => {
        await createCredentialFile('configs/codex/repeated.json');

        const result = await cleanupCredentialFilesForDeletedProviders([
            { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/repeated.json' },
            { CODEX_OAUTH_CREDS_FILE_PATH: './configs/codex/repeated.json' }
        ]);

        expect(result).toEqual({
            deletedFiles: ['configs/codex/repeated.json'],
            skippedFiles: [],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/repeated.json')).toBe(false);
    });

    test('does not delete through a symlinked provider directory', async () => {
        const externalDir = await mkdtemp(path.join(tmpdir(), 'credential-cleanup-external-'));

        try {
            await writeFile(path.join(externalDir, 'secret.json'), '{"secret":true}');
            await mkdir(path.join(tempDir, 'configs'), { recursive: true });

            try {
                await symlink(externalDir, path.join(tempDir, 'configs', 'codex'), 'dir');
            } catch (error) {
                if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) {
                    return;
                }
                throw error;
            }

            const result = await cleanupCredentialFilesForDeletedProviders([
                { CODEX_OAUTH_CREDS_FILE_PATH: 'configs/codex/secret.json' }
            ]);

            expect(result).toEqual({
                deletedFiles: [],
                skippedFiles: [{ path: 'configs/codex/secret.json', reason: 'unsafe_path' }],
                failedFiles: []
            });
            expect(await readFile(path.join(externalDir, 'secret.json'), 'utf8')).toBe('{"secret":true}');
        } finally {
            await rm(externalDir, { recursive: true, force: true });
        }
    });

    test('cleans up unbound scanner config file entries conservatively', async () => {
        await createCredentialFile('configs/codex/unused.json');
        await createCredentialFile('configs/codex/used.json');
        await createCredentialFile('configs/root.json');

        const result = await cleanupUnboundConfigFileEntries([
            { path: 'configs/codex/unused.json', isUsed: false },
            { path: 'configs/codex/used.json', isUsed: true },
            { path: 'configs/root.json', isUsed: false }
        ]);

        expect(result).toEqual({
            deletedFiles: ['configs/codex/unused.json'],
            skippedFiles: [{ path: 'configs/root.json', reason: 'unsafe_path' }],
            failedFiles: []
        });
        expect(await fileExists('configs/codex/unused.json')).toBe(false);
        expect(await fileExists('configs/codex/used.json')).toBe(true);
        expect(await fileExists('configs/root.json')).toBe(true);
    });
});
