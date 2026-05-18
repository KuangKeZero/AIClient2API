import { getProtocolPrefix, MODEL_PROTOCOL_PREFIX } from '../src/utils/common.js';
import { convertData } from '../src/convert/convert.js';
import '../src/converters/register-converters.js';

describe('provider protocol routing', () => {
    test('treats suffixed Codex OAuth providers as Codex protocol', () => {
        expect(getProtocolPrefix('openai-codex-oauth')).toBe(MODEL_PROTOCOL_PREFIX.CODEX);
        expect(getProtocolPrefix('openai-codex-oauth-plus')).toBe(MODEL_PROTOCOL_PREFIX.CODEX);
    });

    test('adds required Codex instructions when converting Responses requests', () => {
        const converted = convertData({
            model: 'gpt-5.5',
            input: 'Reply with exactly: ok',
            stream: false
        }, 'request', MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, 'openai-codex-oauth-plus');

        expect(converted.instructions).toBeTruthy();
        expect(converted.input).toEqual([{
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_text',
                text: 'Reply with exactly: ok'
            }]
        }]);
    });
});
