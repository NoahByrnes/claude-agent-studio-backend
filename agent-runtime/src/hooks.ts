export interface AuditHookOptions {
  backendUrl: string;
  agentId: string;
}

export function createAuditHook(options: AuditHookOptions) {
  return {
    async postToolUse(toolName: string, input: any, output: any) {
      try {
        await fetch(`${options.backendUrl}/api/agents/${options.agentId}/audit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action_type: 'tool_use',
            tool_name: toolName,
            input_data: input,
            output_data: output,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.error('Failed to send audit hook:', error);
      }
    },

    async preTurn(turn: number) {
      try {
        await fetch(`${options.backendUrl}/api/agents/${options.agentId}/audit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action_type: 'turn_start',
            input_data: { turn },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.error('Failed to send audit hook:', error);
      }
    },

    async postTurn(turn: number) {
      try {
        await fetch(`${options.backendUrl}/api/agents/${options.agentId}/audit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action_type: 'turn_end',
            input_data: { turn },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.error('Failed to send audit hook:', error);
      }
    },
  };
}
