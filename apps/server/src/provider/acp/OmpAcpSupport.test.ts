import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { applyOmpAcpModelSelection } from "./OmpAcpSupport.ts";

const thinkingConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "thinking",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "off", name: "Off" },
    { value: "auto", name: "Auto" },
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};

describe("applyOmpAcpModelSelection", () => {
  it("sets the selected OMP thinking level after the model", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];
    const runtime = {
      getConfigOptions: Effect.succeed([thinkingConfigOption]),
      setModel: (value: string): Effect.Effect<void, EffectAcpErrors.AcpError> =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (
        configId: string,
        value: string | boolean,
      ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
          return { configOptions: [thinkingConfigOption] };
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        currentModelId: "opencode-go/deepseek-v4-flash",
        requestedModelId: "opencode-go/deepseek-v4-pro",
        selections: [{ id: "thinking", value: "low" }],
        mapError: ({ cause }) => cause.message,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "opencode-go/deepseek-v4-pro" },
      { type: "config", configId: "thinking", value: "low" },
    ]);
  });
});
