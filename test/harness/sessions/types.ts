// Shapes shared by the clients, the conversations and the runner.

export interface ToolUse { name: string; status: string; input: Record<string, unknown>; output: string }

/** What a client reports for one turn. Token counts: input includes cached input. */
export interface ClientTurn {
  reply: string;
  tools: ToolUse[];
  ms: number;
  errors: string[];
  /** The client stayed in the same conversation (OpenCode session, Open WebUI chat). */
  sameConversation: boolean;
  tokens: { steps: number; input: number; cached: number; output: number };
  /** Compactions the client did so far in this conversation (OpenCode only). */
  compacted?: number;
}

export interface Client {
  name: 'opencode' | 'openwebui';
  conversationId: string | undefined;
  turn(prompt: string): Promise<ClientTurn>;
  close(): Promise<void>;
}
