import { jest } from '@jest/globals';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn((axiosConfig) => axiosConfig),
    configureTLSSidecar: jest.fn((axiosConfig) => axiosConfig),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

describe('Kiro request conversion', () => {
    test('does not invent a placeholder tool when the caller provides no tools', async () => {
        const service = new KiroApiService({});

        const request = await service.buildCodewhispererRequest(
            [{ role: 'user', content: 'Say ok.' }],
            'claude-opus-4-7'
        );

        const userInputMessage = request.conversationState.currentMessage.userInputMessage;
        expect(userInputMessage.modelId).toBe('claude-opus-4.7');
        expect(userInputMessage.userInputMessageContext).toBeUndefined();
    });
});
