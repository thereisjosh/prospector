/**
 * Free preflight: validates the agent's tool schemas and system prompt against
 * the Messages API via count_tokens (no model run, no cost). Run before any
 * live agent run; a strict-schema keyword the API rejects fails here instead
 * of at turn 1 of a paid run.
 *
 *   npx tsx eval/check-tool-schemas.ts
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { agentTools } from "../src/agent/tools";
import { systemPrompt } from "../src/agent/prompts";
import { AGENT_DEFAULT_MODEL } from "../src/agent/config";

async function main() {
  const client = new Anthropic();
  const tools = agentTools();
  try {
    const r = await client.messages.countTokens({
      model: AGENT_DEFAULT_MODEL,
      system: systemPrompt(),
      tools,
      messages: [{ role: "user", content: "ping" }],
    });
    console.log(`OK — ${tools.length} tools accepted; prompt+tools = ${r.input_tokens} input tokens`);
  } catch (error) {
    const e = error as { status?: number; message?: string };
    console.error(`REJECTED (${e.status ?? "?"}): ${e.message ?? String(error)}`);
    process.exit(1);
  }
}

main();
