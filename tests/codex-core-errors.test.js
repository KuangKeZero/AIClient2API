import { jest } from '@jest/globals';
import { Readable } from 'stream';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn((axiosConfig) => axiosConfig),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

import { CodexApiService } from '../src/providers/openai/codex-core.js';

describe('Codex API error handling', () => {
    let service;

    afterEach(() => {
        service?.stopCacheCleanup();
        service = null;
    });

    test('classifies stream context length errors as client input errors', async () => {
        service = new CodexApiService({});
        const payload = {
            type: 'error',
            error: {
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
                message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
                param: 'input'
            }
        };
        const stream = Readable.from([`data: ${JSON.stringify(payload)}\n\n`]);

        let caught;
        try {
            for await (const _chunk of service.parseSSEStream(stream)) {
                // The stream should throw before yielding data.
            }
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            status: 400,
            statusCode: 400,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            apiErrorCode: 'context_length_exceeded',
            param: 'input',
            skipErrorCount: true
        });
        expect(caught.shouldSwitchCredential).toBeUndefined();
    });

    test('keeps quota errors eligible for credential switching', async () => {
        service = new CodexApiService({});
        const payload = {
            type: 'error',
            error: {
                type: 'insufficient_quota',
                code: 'insufficient_quota',
                message: 'You exceeded your current quota.'
            }
        };
        const stream = Readable.from([`data: ${JSON.stringify(payload)}\n\n`]);

        let caught;
        try {
            for await (const _chunk of service.parseSSEStream(stream)) {
                // The stream should throw before yielding data.
            }
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            status: 429,
            statusCode: 429,
            type: 'insufficient_quota',
            code: 'insufficient_quota',
            shouldSwitchCredential: true,
            skipErrorCount: true
        });
    });
});
