import type { ServedModel } from "./server.ts";
import { DEFAULT_PORT } from "./server.ts";

export const RESPONSE_TOKENS = 32768;

export function providerName(port: number) {
  return port === DEFAULT_PORT ? "splash" : `splash-${port}`;
}

export function providerConfig(port: number, served: ServedModel, env = process.env) {
  const input = served.inputModalities.includes("image") ? ["text", "image"] : ["text"];
  return {
    name: `Splash (local, port ${port})`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: env.SPLASH_API_KEY ? "$SPLASH_API_KEY" : "local",
    models: [
      {
        id: served.id,
        name: served.id,
        reasoning: true,
        thinkingLevelMap: { off: "none" },
        input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: served.context,
        maxTokens: RESPONSE_TOKENS,
        ...(served.laterSystem ? { compat: { supportsMidConvoSystemMessages: true } } : {}),
      },
    ],
  };
}
