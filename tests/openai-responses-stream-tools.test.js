import { OpenAIConverter } from '../src/converters/strategies/OpenAIConverter.js';

describe('OpenAI chat stream to Responses tool calls', () => {
    test('preserves streamed function calls in the final Responses output', () => {
        const converter = new OpenAIConverter();
        const requestId = 'test_tool_call_stream';

        const startEvents = converter.toOpenAIResponsesStreamChunk({
            choices: [{ delta: { role: 'assistant' } }],
            model: 'gpt-5.5'
        }, 'gpt-5.5', requestId);

        const textEvents = converter.toOpenAIResponsesStreamChunk({
            choices: [{ delta: { content: 'I will inspect the skills.' } }]
        }, 'gpt-5.5', requestId);

        const toolStartEvents = converter.toOpenAIResponsesStreamChunk({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 1,
                        id: 'call_skill_1',
                        type: 'function',
                        function: { name: 'Skill', arguments: '' }
                    }]
                }
            }]
        }, 'gpt-5.5', requestId);

        const toolArgsEvents = converter.toOpenAIResponsesStreamChunk({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 1,
                        function: { arguments: '{"command":"superpowers:using-superpowers"}' }
                    }]
                }
            }]
        }, 'gpt-5.5', requestId);

        const finalEvents = converter.toOpenAIResponsesStreamChunk({
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }, 'gpt-5.5', requestId);

        const events = [
            ...startEvents,
            ...textEvents,
            ...toolStartEvents,
            ...toolArgsEvents,
            ...finalEvents
        ];

        expect(events.map(event => event.type)).toContain('response.function_call_arguments.done');
        expect(events.map(event => event.type)).toContain('response.output_item.done');

        const completed = events.at(-1);
        expect(completed.type).toBe('response.completed');
        expect(completed.response.status).toBe('completed');

        const functionCall = completed.response.output.find(item => item.type === 'function_call');
        expect(functionCall).toMatchObject({
            id: 'fc_call_skill_1',
            call_id: 'call_skill_1',
            name: 'Skill',
            arguments: '{"command":"superpowers:using-superpowers"}',
            status: 'completed'
        });
        expect(completed.response.output.some(item => item.type === 'message')).toBe(true);

        const sequenceNumbers = events.map(event => event.sequence_number);
        expect(sequenceNumbers.every(Number.isInteger)).toBe(true);
        expect(sequenceNumbers).toEqual([...sequenceNumbers].sort((a, b) => a - b));
        expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length);
    });
});
