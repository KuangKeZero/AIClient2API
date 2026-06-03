import { jest } from '@jest/globals';

const mockPoolManager = {
    applyKiroRealUsage: jest.fn()
};

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => mockPoolManager)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn((axiosConfig) => axiosConfig),
    configureTLSSidecar: jest.fn((axiosConfig) => axiosConfig),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

describe('Kiro request conversion', () => {
    beforeEach(() => {
        mockPoolManager.applyKiroRealUsage.mockReset();
    });

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

    test('parses Kiro native thinking stream events', () => {
        const service = new KiroApiService({});

        const { events } = service.parseAwsEventStreamBuffer(
            '\u0000{"text":"inspect state"}\u0000{"signature":"sig-123"}\u0000{"content":"done","modelId":"claude-opus-4.7"}'
        );

        expect(events).toEqual([
            { type: 'thinking', data: 'inspect state' },
            { type: 'thinkingSignature', data: 'sig-123' },
            { type: 'content', data: 'done' }
        ]);
    });

    test('preserves split Kiro tool input JSON across stream chunks', () => {
        const service = new KiroApiService({});

        const first = service.parseAwsEventStreamBuffer(
            '\u0000{"name":"Bash","toolUseId":"tool_1"}\u0000{"input":"{\\"command\\":\\"echo'
        );

        expect(first.events).toEqual([
            {
                type: 'toolUse',
                data: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '',
                    stop: false
                }
            }
        ]);
        expect(first.remaining).toBe('{"input":"{\\"command\\":\\"echo');

        const second = service.parseAwsEventStreamBuffer(
            `${first.remaining} ok\\"}","toolUseId":"tool_1","stop":true}\u0000{"contextUsagePercentage":1.5}`
        );

        expect(second.events).toEqual([
            {
                type: 'toolUseInput',
                data: {
                    toolUseId: 'tool_1',
                    input: '{"command":"echo ok"}'
                }
            },
            {
                type: 'toolUseStop',
                data: {
                    toolUseId: 'tool_1',
                    stop: true
                }
            },
            {
                type: 'contextUsage',
                data: {
                    contextUsagePercentage: 1.5
                }
            }
        ]);
        expect(second.remaining).toBe('');
    });

    test('treats Kiro empty tool input objects as placeholders', () => {
        const service = new KiroApiService({});

        const { events } = service.parseAwsEventStreamBuffer(
            '\u0000{"name":"Bash","toolUseId":"tool_1","input":{}}\u0000{"input":"{\\"command\\":\\"echo ok\\"}","toolUseId":"tool_1","stop":true}'
        );

        expect(events).toEqual([
            {
                type: 'toolUse',
                data: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '',
                    stop: false
                }
            },
            {
                type: 'toolUseInput',
                data: {
                    toolUseId: 'tool_1',
                    input: '{"command":"echo ok"}'
                }
            },
            {
                type: 'toolUseStop',
                data: {
                    toolUseId: 'tool_1',
                    stop: true
                }
            }
        ]);
    });

    test('buffers tool input until the tool name arrives', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield { type: 'toolUseInput', toolUseId: 'tool_1', input: '{"command":"echo ok"}' };
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_1',
                    input: '',
                    stop: false
                }
            };
            yield { type: 'toolUseStop', toolUseId: 'tool_1', stop: true };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            thinking: { type: 'enabled', budget_tokens: 1024 }
        })) {
            events.push(event);
        }

        const startIndex = events.findIndex(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
        const deltaIndex = events.findIndex(event => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta');
        const stopIndex = events.findIndex(event => event.type === 'content_block_stop');

        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(deltaIndex).toBeGreaterThan(startIndex);
        expect(stopIndex).toBeGreaterThan(deltaIndex);
        expect(events[startIndex].content_block).toEqual(expect.objectContaining({
            type: 'tool_use',
            name: 'Bash',
            input: {}
        }));
        expect(events[deltaIndex].delta).toEqual(expect.objectContaining({
            type: 'input_json_delta',
            partial_json: '{"command":"echo ok"}'
        }));
    });

    test('waits for late tool input after stop before finalizing Bash', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_2',
                    input: '',
                    stop: false
                }
            };
            yield { type: 'toolUseStop', toolUseId: 'tool_2', stop: true };
            yield { type: 'toolUseInput', toolUseId: 'tool_2', input: '{"command":"echo late"}' };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            thinking: { type: 'enabled', budget_tokens: 1024 }
        })) {
            events.push(event);
        }

        const startEvents = events.filter(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
        const deltaIndex = events.findIndex(event => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta');
        const stopIndex = events.findIndex(event => event.type === 'content_block_stop');

        expect(startEvents).toHaveLength(1);
        expect(deltaIndex).toBeGreaterThanOrEqual(0);
        expect(stopIndex).toBeGreaterThan(deltaIndex);
        expect(startEvents[0].content_block).toEqual(expect.objectContaining({
            type: 'tool_use',
            name: 'Bash',
            input: {}
        }));
        expect(events[deltaIndex].delta.partial_json).toBe('{"command":"echo late"}');
    });

    test('does not stream Kiro placeholder input before required tool input arrives', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_3',
                    input: {},
                    stop: false
                }
            };
            yield { type: 'toolUseInput', toolUseId: 'tool_3', input: '{"command":"echo ok"}' };
            yield { type: 'toolUseStop', toolUseId: 'tool_3', stop: true };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            tools: [{
                name: 'Bash',
                input_schema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }]
        })) {
            events.push(event);
        }

        const inputDeltas = events.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta');
        const toolStarts = events.filter(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');

        expect(toolStarts).toHaveLength(1);
        expect(inputDeltas.map(event => event.delta.partial_json)).toEqual(['{"command":"echo ok"}']);
    });

    test('attaches early tool input that arrives before a tool id', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield { type: 'toolUseInput', input: '{"command":"echo orphan"}' };
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_5',
                    input: {},
                    stop: false
                }
            };
            yield { type: 'toolUseStop', toolUseId: 'tool_5', stop: true };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            tools: [{
                name: 'Bash',
                input_schema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }]
        })) {
            events.push(event);
        }

        const inputDeltas = events.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta');
        expect(inputDeltas.map(event => event.delta.partial_json)).toEqual(['{"command":"echo orphan"}']);
    });

    test('turns invalid tool-only responses into an end_turn notice', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_4',
                    input: {},
                    stop: true
                }
            };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            tools: [{
                name: 'Bash',
                input_schema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }]
        })) {
            events.push(event);
        }

        expect(events.some(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')).toBe(false);
        expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('end_turn');
        const textDelta = events
            .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
            .map(event => event.delta.text)
            .join('');
        expect(textDelta).toContain('Tool call was omitted because required parameters were incomplete. Please retry.');
    });

    test('keeps visible text and ends the turn when the following tool call is invalid', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'content',
                content: '探针已部署到 win11-game。下面在 win11-game 上启动驱动并验证它在 KVM 上不冻结:'
            };
            yield {
                type: 'toolUse',
                toolUse: {
                    name: 'Bash',
                    toolUseId: 'tool_6',
                    input: {},
                    stop: true
                }
            };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }],
            tools: [{
                name: 'Bash',
                input_schema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }]
        })) {
            events.push(event);
        }

        const textDelta = events
            .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
            .map(event => event.delta.text)
            .join('');

        expect(textDelta).toContain('探针已部署到 win11-game。下面在 win11-game 上启动驱动并验证它在 KVM 上不冻结:');
        expect(events.some(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')).toBe(false);
        expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('end_turn');
    });

    test('continues when final visible text looks truncated', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'content',
                content: [
                    '全流程跑通。结果总结:',
                    '',
                    '| 阶段 | 结果 |',
                    '|------|------|',
                    '| **驱动启动(KVM 上)** | **ST'
                ].join('\n')
            };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }]
        })) {
            events.push(event);
        }

        const textDelta = events
            .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
            .map(event => event.delta.text)
            .join('');

        expect(textDelta).toContain('| **驱动启动(KVM 上)** | **ST');
        expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('max_tokens');
    });

    test('does not continue complete visible text just because usage is missing', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield {
                type: 'content',
                content: [
                    '全流程跑通。结果总结:',
                    '',
                    '| 阶段 | 结果 |',
                    '|------|------|',
                    '| **驱动启动(KVM 上)** | **STOPPED** |'
                ].join('\n')
            };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '继续' }]
        })) {
            events.push(event);
        }

        expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('end_turn');
    });

    test('streams native thinking-only responses instead of returning an empty turn', async () => {
        const service = new KiroApiService({});
        service.isInitialized = true;
        service.streamApiReal = async function* () {
            yield { type: 'thinking', thinking: 'inspect state' };
            yield { type: 'thinkingSignature', signature: 'sig-123' };
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-7', {
            messages: [{ role: 'user', content: '开始实现' }],
            thinking: { type: 'enabled', budget_tokens: 1024 }
        })) {
            events.push(event);
        }

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' }
            }),
            expect.objectContaining({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'inspect state' }
            }),
            expect.objectContaining({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig-123' }
            })
        ]));
        expect(events).toEqual(expect.arrayContaining([
            { type: 'content_block_stop', index: 0 }
        ]));
        expect(events.some(event => event.type === 'content_block_delta')).toBe(true);
        expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('end_turn');
        expect(events.find(event => event.type === 'message_delta')?.usage?.output_tokens).toBeGreaterThan(0);
        expect(events.some(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')).toBe(false);
    });

    test('applies raw Kiro usage details to the pool before disabling on 402', async () => {
        const service = new KiroApiService({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            uuid: 'kiro-402'
        });
        const quotaError = Object.assign(new Error('Payment Required'), {
            response: { status: 402 }
        });
        const rawUsage = {
            usageBreakdownList: [
                {
                    resourceType: 'AGENTIC_REQUEST',
                    displayName: 'Agentic requests',
                    currentUsage: 100,
                    usageLimit: 100,
                    nextDateReset: 1893456000000
                }
            ],
            subscriptionInfo: {
                subscriptionTitle: 'KIRO FREE'
            }
        };
        service.getUsageLimits = jest.fn().mockResolvedValue(rawUsage);
        mockPoolManager.applyKiroRealUsage.mockReturnValue({ disabled: true });

        await expect(service._handle402Error(quotaError, 'test')).rejects.toBe(quotaError);

        expect(mockPoolManager.applyKiroRealUsage).toHaveBeenCalledWith(
            'claude-kiro-oauth',
            'kiro-402',
            expect.objectContaining({
                raw: rawUsage,
                summary: expect.objectContaining({
                    usedPercent: 100,
                    totalUsed: 100,
                    totalLimit: 100
                })
            })
        );
        expect(quotaError).toMatchObject({
            shouldSwitchCredential: true,
            skipErrorCount: true,
            credentialMarkedUnhealthy: true
        });
    });
});
