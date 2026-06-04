import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { CONFIG } from '../src/core/config-manager.js';

const ORIGINAL_CONFIG = { ...CONFIG };

function toDataImageUrl(buffer, mimeType = 'image/png') {
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function resetConfig() {
    for (const key of Object.keys(CONFIG)) {
        delete CONFIG[key];
    }
    Object.assign(CONFIG, ORIGINAL_CONFIG);
}

describe('Codex large image sanitizer', () => {
    let artifactDir;
    let externalArtifactDir;
    let symlinkArtifactDir;

    beforeEach(() => {
        artifactDir = fs.mkdtempSync(path.join(process.cwd(), 'logs', 'codex-image-sanitizer-test-'));
        Object.assign(CONFIG, {
            CODEX_STRIP_HISTORY_DATA_IMAGES: true,
            CODEX_HISTORY_IMAGE_MAX_BYTES: 8,
            CODEX_CURRENT_IMAGE_MAX_BYTES: 64,
            CODEX_LARGE_IMAGE_ARTIFACT_DIR: artifactDir
        });
    });

    afterEach(() => {
        fs.rmSync(artifactDir, { recursive: true, force: true });
        if (symlinkArtifactDir) {
            fs.rmSync(symlinkArtifactDir, { force: true });
        }
        if (externalArtifactDir) {
            fs.rmSync(externalArtifactDir, { recursive: true, force: true });
        }
        symlinkArtifactDir = null;
        externalArtifactDir = null;
        resetConfig();
    });

    test('strips large historical view_image data URLs and saves the original bytes losslessly', () => {
        const imageBuffer = Buffer.alloc(32, 7);
        const imageUrl = toDataImageUrl(imageBuffer);
        const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        const converter = new CodexConverter();

        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'function_call',
                    call_id: 'call_view_image',
                    name: 'view_image',
                    arguments: JSON.stringify({
                        path: '/tmp/win11-base.png',
                        detail: 'original'
                    })
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_view_image',
                    output: [
                        {
                            type: 'input_image',
                            image_url: imageUrl,
                            detail: 'original'
                        }
                    ]
                }
            ]
        });

        const output = request.input.find(item => item.type === 'function_call_output').output;
        expect(output).toHaveLength(1);
        expect(output[0].type).toBe('input_text');
        expect(output[0].text).toContain('Codex large historical image omitted');
        expect(output[0].text).toContain('/tmp/win11-base.png');
        expect(output[0].text).toContain(sha256);
        expect(JSON.stringify(request)).not.toContain(imageUrl);
        expect(fs.readFileSync(path.join(artifactDir, `${sha256}.png`))).toEqual(imageBuffer);
    });

    test('strips embedded large data URLs from stringified historical tool outputs', () => {
        const imageBuffer = Buffer.alloc(24, 11);
        const imageUrl = toDataImageUrl(imageBuffer);
        const converter = new CodexConverter();

        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'function_call_output',
                    call_id: 'call_string_output',
                    output: `tool returned ${imageUrl}`
                }
            ]
        });

        const output = request.input.find(item => item.type === 'function_call_output').output;
        expect(output).toContain('Codex large historical image omitted');
        expect(output).not.toContain(imageUrl);
    });

    test('preserves current user images when they are below the configured lossless limit', () => {
        const imageBuffer = Buffer.alloc(16, 3);
        const imageUrl = toDataImageUrl(imageBuffer);
        const converter = new CodexConverter();

        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'inspect this' },
                        { type: 'input_image', image_url: imageUrl }
                    ]
                }
            ]
        });

        expect(request.input[0].content[1].image_url).toBe(imageUrl);
    });

    test('strips historical message images without rejecting the current text turn', () => {
        const historicalImageBuffer = Buffer.alloc(96, 13);
        const historicalImageUrl = toDataImageUrl(historicalImageBuffer);
        const sha256 = crypto.createHash('sha256').update(historicalImageBuffer).digest('hex');
        const converter = new CodexConverter();

        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_image', image_url: historicalImageUrl }
                    ]
                },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'output_text', text: 'looked at the image' }
                    ]
                },
                {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'continue from there' }
                    ]
                }
            ]
        });

        expect(request.input[0].content[0].type).toBe('input_text');
        expect(request.input[0].content[0].text).toContain('Codex large historical image omitted');
        expect(request.input[2].content[0].text).toBe('continue from there');
        expect(JSON.stringify(request)).not.toContain(historicalImageUrl);
        expect(fs.readFileSync(path.join(artifactDir, `${sha256}.png`))).toEqual(historicalImageBuffer);
    });

    test('rejects oversize current user images without credential switching', () => {
        const imageBuffer = Buffer.alloc(96, 5);
        const imageUrl = toDataImageUrl(imageBuffer);
        const converter = new CodexConverter();

        let caught;
        try {
            converter.toOpenAIResponsesToCodexRequest({
                model: 'codex-test',
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'input_image', image_url: imageUrl }
                        ]
                    }
                ]
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            status: 413,
            statusCode: 413,
            code: 'CODEX_IMAGE_TOO_LARGE',
            skipErrorCount: true,
            shouldSwitchCredential: false
        });
        expect(caught.message).toContain('lossless');
    });

    test('rejects oversize current user images when image_url uses object form', () => {
        const imageBuffer = Buffer.alloc(96, 17);
        const imageUrl = toDataImageUrl(imageBuffer);
        const converter = new CodexConverter();

        expect(() => converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_image', image_url: { url: imageUrl } }
                    ]
                }
            ]
        })).toThrow(expect.objectContaining({
            statusCode: 413,
            code: 'CODEX_IMAGE_TOO_LARGE',
            shouldSwitchCredential: false
        }));
    });

    test('does not write image artifacts through a logs symlink that points outside logs', () => {
        const imageBuffer = Buffer.alloc(32, 19);
        const imageUrl = toDataImageUrl(imageBuffer);
        const sha256 = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        const fallbackArtifactPath = path.join(process.cwd(), 'logs', 'codex-image-artifacts', `${sha256}.png`);
        externalArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-artifact-outside-'));
        symlinkArtifactDir = path.join(process.cwd(), 'logs', `codex-image-artifact-link-${Date.now()}`);
        fs.symlinkSync(externalArtifactDir, symlinkArtifactDir, 'dir');
        CONFIG.CODEX_LARGE_IMAGE_ARTIFACT_DIR = symlinkArtifactDir;

        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'codex-test',
            input: [
                {
                    type: 'function_call_output',
                    call_id: 'call_view_image',
                    output: [
                        { type: 'input_image', image_url: imageUrl }
                    ]
                }
            ]
        });

        expect(fs.readdirSync(externalArtifactDir)).toHaveLength(0);
        expect(fs.readFileSync(fallbackArtifactPath)).toEqual(imageBuffer);
        expect(JSON.stringify(request)).toContain('logs/codex-image-artifacts');
        fs.rmSync(fallbackArtifactPath, { force: true });
    });
});
