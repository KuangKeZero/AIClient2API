import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { PROVIDER_MAPPINGS, addToUsedPaths, isPathUsed } from '../utils/provider-utils.js';

const CREDENTIAL_PATH_KEY_PATTERN = /_(?:CREDS|TOKEN)_FILE_PATH$/;
const ALLOWED_CREDENTIAL_EXTENSIONS = new Set(['.json', '.oauth', '.creds', '.key', '.pem', '.txt']);

function buildAllowedProviderDirs() {
    const providerDirs = new Set();

    for (const mapping of PROVIDER_MAPPINGS) {
        if (mapping.dirName) {
            providerDirs.add(mapping.dirName);
        }

        for (const pattern of mapping.patterns || []) {
            const match = pattern.match(/^configs\/([^/]+)\//);
            if (match) {
                providerDirs.add(match[1]);
            }
        }
    }

    return providerDirs;
}

const ALLOWED_PROVIDER_DIRS = buildAllowedProviderDirs();

function toForwardSlash(filePath) {
    return filePath.replace(/\\/g, '/');
}

function stripLeadingDotSlash(filePath) {
    return filePath.replace(/^\.\//, '');
}

function getAbsolutePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return null;
    }

    return path.resolve(process.cwd(), filePath.trim());
}

function getDisplayPath(filePath) {
    const absolutePath = getAbsolutePath(filePath);
    if (!absolutePath) {
        return '';
    }

    const relativePath = path.relative(process.cwd(), absolutePath);
    return stripLeadingDotSlash(toForwardSlash(relativePath));
}

function getCredentialPathEntries(source = {}) {
    if (!source || typeof source !== 'object') {
        return [];
    }

    return Object.entries(source)
        .filter(([key, value]) => CREDENTIAL_PATH_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim())
        .map(([, value]) => value.trim());
}

function getProviderPoolsToScan(currentConfig = {}, providerPools, hasExplicitProviderPools = false) {
    if (hasExplicitProviderPools) {
        return providerPools;
    }

    return currentConfig?.providerPools;
}

function collectProviderPoolReferences(currentConfig = {}, providerPools, hasExplicitProviderPools = false) {
    const references = [];
    const pools = getProviderPoolsToScan(currentConfig, providerPools, hasExplicitProviderPools);

    if (!pools || typeof pools !== 'object') {
        return references;
    }

    for (const providers of Object.values(pools)) {
        if (!Array.isArray(providers)) {
            continue;
        }

        for (const provider of providers) {
            references.push(...extractCredentialPathsFromProvider(provider));
        }
    }

    return references;
}

function normalizeCleanupCandidate(filePath) {
    const absolutePath = getAbsolutePath(filePath);
    const displayPath = absolutePath ? getDisplayPath(filePath) : '';

    return {
        absolutePath,
        displayPath
    };
}

function isPathInside(parentPath, childPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function hasSymlinkInPath(startPath, targetPath) {
    const startStats = await fs.lstat(startPath);
    if (startStats.isSymbolicLink()) {
        return true;
    }

    const relativePath = path.relative(startPath, targetPath);
    const parts = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
    let currentPath = startPath;

    for (const part of parts) {
        currentPath = path.join(currentPath, part);
        const stats = await fs.lstat(currentPath);
        if (stats.isSymbolicLink()) {
            return true;
        }
    }

    return false;
}

async function validateRealFilesystemCleanupTarget(displayPath, absolutePath) {
    const parts = displayPath.split('/');
    const providerDir = parts[1];
    const configsPath = path.resolve(process.cwd(), 'configs');
    const providerBoundaryPath = path.join(configsPath, providerDir);

    try {
        if (await hasSymlinkInPath(configsPath, absolutePath)) {
            return { allowed: false, reason: 'unsafe_path' };
        }

        const realProviderBoundary = await fs.realpath(providerBoundaryPath);
        const realTargetPath = await fs.realpath(absolutePath);

        if (!isPathInside(realProviderBoundary, realTargetPath)) {
            return { allowed: false, reason: 'unsafe_path' };
        }

        return { allowed: true, realTargetPath };
    } catch (error) {
        return { allowed: false, reason: 'unsafe_path', error };
    }
}

export function extractCredentialPathsFromProvider(provider = {}) {
    return getCredentialPathEntries(provider);
}

export function isAllowedCredentialCleanupPath(filePath) {
    const { absolutePath, displayPath } = normalizeCleanupCandidate(filePath);

    if (!absolutePath || !displayPath || displayPath.startsWith('../') || path.isAbsolute(displayPath)) {
        return { allowed: false, reason: 'unsafe_path', path: displayPath || String(filePath || '') };
    }

    const parts = displayPath.split('/');
    if (parts.length < 3 || parts[0] !== 'configs') {
        return { allowed: false, reason: 'unsafe_path', path: displayPath };
    }

    const providerDir = parts[1];
    if (!ALLOWED_PROVIDER_DIRS.has(providerDir)) {
        return { allowed: false, reason: 'unsupported_provider_dir', path: displayPath };
    }

    const extension = path.extname(displayPath).toLowerCase();
    if (!ALLOWED_CREDENTIAL_EXTENSIONS.has(extension)) {
        return { allowed: false, reason: 'unsupported_extension', path: displayPath };
    }

    return { allowed: true, path: displayPath };
}

export function collectCredentialReferences(currentConfig = {}, providerPools = {}) {
    const hasExplicitProviderPools = arguments.length >= 2;

    return [
        ...getCredentialPathEntries(currentConfig),
        ...collectProviderPoolReferences(currentConfig, providerPools, hasExplicitProviderPools)
    ];
}

export function isCredentialPathReferenced(filePath, currentConfig = {}, providerPools = {}) {
    const hasExplicitProviderPools = arguments.length >= 3;
    const usedPaths = new Set();
    const credentialReferences = hasExplicitProviderPools
        ? collectCredentialReferences(currentConfig, providerPools)
        : collectCredentialReferences(currentConfig);

    for (const credentialPath of credentialReferences) {
        addToUsedPaths(usedPaths, credentialPath);
    }

    const displayPath = getDisplayPath(filePath);
    const fileName = path.basename(displayPath);

    return isPathUsed(displayPath, fileName, usedPaths);
}

async function cleanupCredentialFileCandidates(candidatePaths, currentConfig = {}, providerPools, hasExplicitProviderPools = false) {
    const result = {
        deletedFiles: [],
        skippedFiles: [],
        failedFiles: []
    };
    const candidatesByAbsolutePath = new Map();

    for (const candidatePath of candidatePaths) {
        const { absolutePath, displayPath } = normalizeCleanupCandidate(candidatePath);
        if (!absolutePath || candidatesByAbsolutePath.has(absolutePath)) {
            continue;
        }

        candidatesByAbsolutePath.set(absolutePath, {
            originalPath: candidatePath,
            absolutePath,
            displayPath
        });
    }

    for (const candidate of candidatesByAbsolutePath.values()) {
        const allowedPath = isAllowedCredentialCleanupPath(candidate.originalPath);
        const displayPath = allowedPath.path || candidate.displayPath;

        if (!allowedPath.allowed) {
            result.skippedFiles.push({ path: displayPath, reason: allowedPath.reason });
            logger.warn(`[Credential Cleanup] Skipped ${displayPath}: ${allowedPath.reason}`);
            continue;
        }

        const isReferenced = hasExplicitProviderPools
            ? isCredentialPathReferenced(candidate.originalPath, currentConfig, providerPools)
            : isCredentialPathReferenced(candidate.originalPath, currentConfig);

        if (isReferenced) {
            result.skippedFiles.push({ path: displayPath, reason: 'still_referenced' });
            logger.info(`[Credential Cleanup] Skipped ${displayPath}: still referenced`);
            continue;
        }

        if (!existsSync(candidate.absolutePath)) {
            result.skippedFiles.push({ path: displayPath, reason: 'file_not_found' });
            logger.warn(`[Credential Cleanup] Skipped ${displayPath}: file not found`);
            continue;
        }

        const realPathValidation = await validateRealFilesystemCleanupTarget(displayPath, candidate.absolutePath);
        if (!realPathValidation.allowed) {
            result.skippedFiles.push({ path: displayPath, reason: realPathValidation.reason });
            logger.warn(`[Credential Cleanup] Skipped ${displayPath}: ${realPathValidation.reason}`);
            continue;
        }

        try {
            await fs.unlink(realPathValidation.realTargetPath);
            result.deletedFiles.push(displayPath);
            logger.info(`[Credential Cleanup] Deleted orphan credential file: ${displayPath}`);
        } catch (error) {
            result.failedFiles.push({ path: displayPath, error: error.message });
            logger.warn(`[Credential Cleanup] Failed to delete ${displayPath}:`, error.message);
        }
    }

    return result;
}

export async function cleanupCredentialFilesForDeletedProviders(deletedProviders = [], currentConfig = {}, providerPools = {}) {
    const hasExplicitProviderPools = arguments.length >= 3;
    const candidatePaths = [];

    for (const provider of deletedProviders) {
        candidatePaths.push(...extractCredentialPathsFromProvider(provider));
    }

    return cleanupCredentialFileCandidates(candidatePaths, currentConfig, providerPools, hasExplicitProviderPools);
}

export async function cleanupUnboundConfigFileEntries(configFiles = [], currentConfig = {}, providerPools = {}) {
    const hasExplicitProviderPools = arguments.length >= 3;
    const candidatePaths = configFiles
        .filter(configFile => configFile && !configFile.isUsed && configFile.path)
        .map(configFile => configFile.path);

    return cleanupCredentialFileCandidates(candidatePaths, currentConfig, providerPools, hasExplicitProviderPools);
}
