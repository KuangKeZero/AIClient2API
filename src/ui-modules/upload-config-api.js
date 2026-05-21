import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { broadcastEvent } from './event-broadcast.js';
import { scanConfigFiles } from './config-scanner.js';
import { cleanupUnboundConfigFileEntries } from './credential-cleanup.js';

/**
 * 获取上传配置文件列表
 */
export async function handleGetUploadConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configFiles));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to scan config files:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to scan config files: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 查看特定配置文件
 */
export async function handleViewConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only view files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath, 'utf-8');
        const stats = await fs.stat(fullPath);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            path: relativePath,
            content: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            name: path.basename(fullPath)
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to view config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to view config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载特定配置文件
 */
export async function handleDownloadConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only download files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath);
        const fileName = path.basename(fullPath);
        
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': content.length
        });
        res.end(content);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 删除特定配置文件
 */
export async function handleDeleteConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only delete files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        
        await fs.unlink(fullPath);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: relativePath,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'File deleted successfully',
            filePath: relativePath
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载所有配置为 zip
 */
export async function handleDownloadAllConfigs(req, res) {
    try {
        const configsPath = path.join(process.cwd(), 'configs');
        if (!existsSync(configsPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
            return true;
        }

        const zip = new AdmZip();
        
        // 递归添加目录函数
        const addDirectoryToZip = async (dirPath, zipPath = '') => {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
                
                if (item.isFile()) {
                    const content = await fs.readFile(fullPath);
                    zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
                } else if (item.isDirectory()) {
                    await addDirectoryToZip(fullPath, itemZipPath);
                }
            }
        };

        await addDirectoryToZip(configsPath);
        
        const zipBuffer = zip.toBuffer();
        const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);
        
        logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download all configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download zip: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 批量删除未绑定的配置文件
 * 只删除 configs/xxx/ 子目录下的未绑定配置文件
 */
export async function handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        // 首先获取所有配置文件及其绑定状态
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        
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
        
        // 广播更新事件
        if (deletedFiles.length > 0) {
            broadcastEvent('config_update', {
                action: 'batch_delete',
                deletedFiles: deletedFiles,
                skippedFiles: skippedFiles,
                timestamp: new Date().toISOString()
            });
        }
        
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
    } catch (error) {
        logger.error('[UI API] Failed to delete unbound configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete unbound configs: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 强制触发凭据关联节点的令牌刷新
 */
export async function handleForceExpireConfig(req, res, filePath, currentConfig, providerPoolManager) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only access files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }

        // 触发即时刷新逻辑
        let refreshCount = 0;
        if (providerPoolManager) {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            const targetFile = configFiles.find(f => f.path === relativePath || f.path === filePath);
            
            if (targetFile && targetFile.usageInfo && targetFile.usageInfo.isUsed && Array.isArray(targetFile.usageInfo.usageDetails)) {
                for (const usage of targetFile.usageInfo.usageDetails) {
                    if (usage.uuid && usage.providerType) {
                        // 强制触发刷新
                        const success = await providerPoolManager.refreshNode(usage.providerType, usage.uuid, true);
                        if (success) refreshCount++;
                    }
                }
            }
        }
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'force_refresh',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0,
            refreshCount: refreshCount,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: refreshCount > 0 ? `Triggered refresh for ${refreshCount} node(s)` : 'No active nodes found for this credential',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to force refresh config:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to force refresh config: ' + error.message
            }
        }));
        return true;
    }
}
