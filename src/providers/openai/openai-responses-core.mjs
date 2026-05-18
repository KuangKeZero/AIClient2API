import { v4 as uuidv4 } from 'uuid';

// 流式处理状态管理
class StreamState {
  constructor() {
    this.states = new Map(); // 使用Map存储不同请求的状态
  }

  // 获取或创建状态
  getOrCreateState(requestId) {
    if (!this.states.has(requestId)) {
      this.states.set(requestId, {
        id: `resp_${uuidv4().replace(/-/g, '')}`,
        msgId: `msg_${uuidv4().replace(/-/g, '')}`,
        fullText: '',
        sequenceNumber: 0,
        model: null,
        status: 'in_progress',
        startTime: Math.floor(Date.now() / 1000),
        toolCalls: [],
        currentToolCall: null,
        currentToolCalls: new Map()
      });
    }
    return this.states.get(requestId);
  }

  // 更新文本内容
  updateText(requestId, textDelta) {
    const state = this.getOrCreateState(requestId);
    state.fullText += textDelta;
    state.sequenceNumber += 1;
    return state;
  }

  // 设置模型信息
  setModel(requestId, model) {
    const state = this.getOrCreateState(requestId);
    state.model = model;
    return state;
  }

  // 完成请求
  completeRequest(requestId) {
    const state = this.getOrCreateState(requestId);
    state.status = 'completed';
    return state;
  }

  // 清理状态
  cleanup(requestId) {
    this.states.delete(requestId);
  }
}

// 创建全局流式状态管理器
const streamStateManager = new StreamState();

function nextSequenceNumber(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);
  state.sequenceNumber += 1;
  return state.sequenceNumber;
}

function uniqueToolCalls(toolCalls) {
  const seen = new Set();
  const unique = [];
  for (const toolCall of toolCalls || []) {
    if (!toolCall || seen.has(toolCall.id)) continue;
    seen.add(toolCall.id);
    unique.push(toolCall);
  }
  return unique;
}

function resolveToolCall(state, itemId, outputIndex) {
  if (itemId && state.currentToolCalls?.has(itemId)) {
    return state.currentToolCalls.get(itemId);
  }
  if (state.currentToolCalls?.has(outputIndex)) {
    return state.currentToolCalls.get(outputIndex);
  }
  return state.currentToolCall;
}

/**
 * Generates a response.created event
 */
function generateResponseCreated(requestId, model) {
  const state = streamStateManager.getOrCreateState(requestId);
  if (model) {
    state.model = model;
  }

  return {
    type: 'response.created',
    sequence_number: nextSequenceNumber(requestId),
    response: {
      id: state.id,
      object: 'response',
      created_at: state.startTime,
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: '',
      max_output_tokens: null,
      model: state.model || 'claude-sonnet-4-6',
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { },
      store: false,
      temperature: 1,
      text: { format: { type: "text" }},
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {}
    }
  };
}

/**
 * Generates a response.in_progress event
 */
function generateResponseInProgress(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.in_progress',
    sequence_number: nextSequenceNumber(requestId),
    response: {
      id: state.id,
      object: 'response',
      created_at: state.startTime,
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: '',
      max_output_tokens: null,
      model: state.model || 'claude-sonnet-4-6',
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { },
      service_tier: "auto",
      store: false,
      temperature: 1,
      text: { format: { type: "text" }},
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {}
    }
  };
}

/**
 * Generates a response.output_item.added event
 */
function generateOutputItemAdded(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.output_item.added',
    sequence_number: nextSequenceNumber(requestId),
    output_index: 0,
    item: {
      id: state.msgId,
      summary: [],
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: []
    }
  };
}

/**
 * Generates a response.content_part.added event
 */
function generateContentPartAdded(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.content_part.added',
    sequence_number: nextSequenceNumber(requestId),
    item_id: state.msgId,
    output_index: 0,
    content_index: 0,
    part: {
      type: 'output_text',
      text: '',
      annotations: [],
      logprobs: []
    }
  };
}

/**
 * Generates a response.output_text.delta event
 */
function generateOutputTextDelta(requestId, delta) {
  const state = streamStateManager.getOrCreateState(requestId);
  state.fullText += delta;

  return {
    type: 'response.output_text.delta',
    sequence_number: nextSequenceNumber(requestId),
    item_id: state.msgId,
    output_index: 0,
    content_index: 0,
    delta: delta,
    logprobs: [],
    obfuscation: null
  };
}

/**
 * Generates a response.output_text.done event
 */
function generateOutputTextDone(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.output_text.done',
    sequence_number: nextSequenceNumber(requestId),
    item_id: state.msgId,
    output_index: 0,
    content_index: 0,
    text: state.fullText,
    logprobs: []
  };
}

/**
 * Generates a response.content_part.done event
 */
function generateContentPartDone(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.content_part.done',
    sequence_number: nextSequenceNumber(requestId),
    item_id: state.msgId,
    output_index: 0,
    content_index: 0,
    part: {
      type: 'output_text',
      text: state.fullText,
      annotations: [],
      logprobs: []
    }
  };
}

/**
 * Generates a response.output_item.done event
 */
function generateOutputItemDone(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.output_item.done',
    sequence_number: nextSequenceNumber(requestId),
    output_index: 0,
    item: {
      id: state.msgId,
      summary: [],
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: state.fullText,
          annotations: [],
          logprobs: []
        }
      ]
    }
  };
}

/**
 * Generates a response.completed event
 */
function generateResponseCompleted(requestId, usage) {
  const state = streamStateManager.getOrCreateState(requestId);

  return {
    type: 'response.completed',
    sequence_number: nextSequenceNumber(requestId),
    response: {
      background: false,
      created_at: state.startTime,
      error: null,
      id: state.id,
      incomplete_details: null,
      max_output_tokens: null,
      max_tool_calls: null,
      metadata: {},
      model: state.model || 'claude-sonnet-4-6',
      object: 'response',
      output: (() => {
        const items = [];
        if (state.fullText) {
          items.push({
            id: state.msgId, summary: [], type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: state.fullText, annotations: [], logprobs: [] }]
          });
        }
        if (state.toolCalls && state.toolCalls.length > 0) {
          for (const tc of state.toolCalls) {
            items.push({
              id: tc.id, call_id: tc.call_id || tc.id, type: 'function_call',
              name: tc.name, arguments: tc.arguments || '{}', status: 'completed'
            });
          }
        }
        if (items.length === 0) {
          items.push({
            id: state.msgId, summary: [], type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }]
          });
        }
        return items;
      })(),
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: null,
      reasoning: {
      },
      safety_identifier: `user-${uuidv4().replace(/-/g, '')}`, // 随机值
      service_tier: "default",
      status: "completed",
      store: false,
      temperature: 1,
      text: {
        format: { type: "text" }
      },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage: usage || {
        input_tokens: Math.floor(Math.random() * 100) + 20, // 随机值
        input_tokens_details: {
          cached_tokens: Math.floor(Math.random() * 50) // 随机值
        },
        output_tokens: state.fullText.split('').length,
        output_tokens_details: {
          reasoning_tokens: 0
        },
        total_tokens: Math.floor(Math.random() * 100) + 20 + state.fullText.split('').length // 随机值+文本长度
      },
      user: null
    }
  };
}


function startToolCall(requestId, toolCallId, name, outputIndex = 0) {
  const state = streamStateManager.getOrCreateState(requestId);
  const id = toolCallId || `call_${uuidv4().replace(/-/g, '')}`;
  const toolCall = { id, call_id: id, name: name, arguments: '', outputIndex };
  state.currentToolCall = toolCall;
  state.currentToolCalls.set(outputIndex, toolCall);
  state.currentToolCalls.set(id, toolCall);
  return toolCall;
}

function appendToolCallArgs(requestId, delta, itemId = null, outputIndex = 0) {
  const state = streamStateManager.getOrCreateState(requestId);
  const toolCall = resolveToolCall(state, itemId, outputIndex);
  if (toolCall) toolCall.arguments += delta;
  return toolCall;
}

function finishToolCall(requestId, itemId = null, outputIndex = 0) {
  const state = streamStateManager.getOrCreateState(requestId);
  const toolCall = resolveToolCall(state, itemId, outputIndex);
  if (toolCall) {
    if (!state.toolCalls.some(existing => existing.id === toolCall.id)) {
      state.toolCalls.push({...toolCall});
    }
    const finished = {...toolCall};
    state.currentToolCalls.delete(toolCall.id);
    state.currentToolCalls.delete(toolCall.outputIndex);
    if (state.currentToolCall?.id === toolCall.id) {
      state.currentToolCall = null;
    }
    return finished;
  }
  return null;
}

function generateFunctionCallArgsDelta(requestId, itemId, outputIndex, delta) {
  const toolCall = appendToolCallArgs(requestId, delta, itemId, outputIndex);
  return {
    type: 'response.function_call_arguments.delta',
    sequence_number: nextSequenceNumber(requestId),
    item_id: toolCall?.id || itemId,
    output_index: outputIndex,
    delta: delta
  };
}

function generateFunctionCallArgsDone(requestId, itemId, outputIndex) {
  const state = streamStateManager.getOrCreateState(requestId);
  const toolCall = resolveToolCall(state, itemId, outputIndex);
  const args = toolCall ? toolCall.arguments : '{}';
  return {
    type: 'response.function_call_arguments.done',
    sequence_number: nextSequenceNumber(requestId),
    item_id: toolCall?.id || itemId,
    output_index: outputIndex,
    name: toolCall?.name || '',
    arguments: args
  };
}

function generateFunctionCallOutputItemAdded(requestId, toolCall, outputIndex) {
  return {
    type: 'response.output_item.added',
    sequence_number: nextSequenceNumber(requestId),
    output_index: outputIndex,
    item: {
      id: toolCall.id,
      call_id: toolCall.call_id || toolCall.id,
      type: 'function_call',
      name: toolCall.name,
      arguments: '',
      status: 'in_progress'
    }
  };
}

function generateFunctionCallOutputItemDone(requestId, toolCall, outputIndex) {
  return {
    type: 'response.output_item.done',
    sequence_number: nextSequenceNumber(requestId),
    output_index: outputIndex,
    item: { id: toolCall.id, call_id: toolCall.call_id || toolCall.id, type: 'function_call',
      name: toolCall.name, arguments: toolCall.arguments || '{}', status: 'completed' }
  };
}

function getPendingToolCalls(requestId) {
  const state = streamStateManager.getOrCreateState(requestId);
  return uniqueToolCalls(Array.from(state.currentToolCalls?.values() || []));
}

// 导出流式状态管理器以供外部使用
export { streamStateManager, generateResponseCreated, generateResponseInProgress,
  generateOutputItemAdded, generateContentPartAdded, generateOutputTextDelta,
  generateOutputTextDone, generateContentPartDone, generateOutputItemDone,
  generateResponseCompleted, startToolCall, appendToolCallArgs, finishToolCall,
  generateFunctionCallArgsDelta, generateFunctionCallArgsDone, generateFunctionCallOutputItemAdded,
  generateFunctionCallOutputItemDone, getPendingToolCalls, nextSequenceNumber };
