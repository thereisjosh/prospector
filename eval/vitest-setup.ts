// The mocked suite must never reach Langfuse: src/config.ts loads .env, and dotenv does
// not override variables that already exist, so blanking the keys here keeps tracing off
// (trace.enabled() needs both). Tests that exercise tracing set them explicitly.
process.env.LANGFUSE_PUBLIC_KEY = "";
process.env.LANGFUSE_SECRET_KEY = "";
process.env.LANGFUSE_TRACING_ENVIRONMENT = "ci";
// Prompt management: tests that turn the keys on for tracing must still never fetch
// prompts over the network; eval/prompt-store.test.ts exercises it with a mocked client.
process.env.LANGFUSE_PROMPTS = "off";
