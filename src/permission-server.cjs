const endpoint = process.env.CLAUDETE_APPROVAL_ENDPOINT;
let inputBuffer = '';

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) return;
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    respond({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claudete-approval', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{
        name: 'approval_prompt',
        description: 'Ask the Claudete user whether a Claude Code action is allowed.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object', additionalProperties: true },
          },
          required: ['tool_name', 'input'],
        },
      }] },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments || {};
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: args.tool_name, input: args.input || {} }),
      });
      if (!response.ok) throw new Error('Approval request failed.');
      const decision = await response.json();
      respond({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    } catch {
      const decision = { behavior: 'deny', message: 'Claudete could not obtain approval; action denied.' };
      respond({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    }
    return;
  }
  if (message.id !== undefined) {
    respond({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf('\n')) >= 0) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
