import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOmpDiscoveredModelsFromSessionSetup,
  buildOmpModelCapabilitiesFromSessionSetup,
} from "./OmpProvider.ts";

describe("buildOmpModelCapabilitiesFromSessionSetup", () => {
  it("exposes OMP thought-level choices as a model option descriptor", () => {
    const sessionSetup = {
      sessionId: "omp-session",
      configOptions: [
        {
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
        },
      ],
    } as EffectAcpSchema.NewSessionResponse;

    expect(buildOmpModelCapabilitiesFromSessionSetup(sessionSetup)).toEqual({
      optionDescriptors: [
        {
          id: "thinking",
          label: "Thinking",
          type: "select",
          currentValue: "high",
          options: [
            { id: "off", label: "Off" },
            { id: "auto", label: "Auto" },
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ],
    });
  });
});

describe("buildOmpDiscoveredModelsFromSessionSetup", () => {
  it("labels known OpenCode slugs with a human name", () => {
    const sessionSetup = {
      sessionId: "omp-session",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opencode-zen/x-preview-f-free",
          options: [
            { value: "opencode-zen/x-preview-f-free", name: "opencode-zen/x-preview-f-free" },
            { value: "opencode-go/ox-alpha-free", name: "opencode-go/ox-alpha-free" },
            { value: "opencode-go/deepseek-v4-flash", name: "opencode-go/deepseek-v4-flash" },
            { value: "opencode-go/deepseek-v4.1-flash", name: "opencode-go/deepseek-v4.1-flash" },
          ],
        },
      ],
    } as EffectAcpSchema.NewSessionResponse;

    expect(
      buildOmpDiscoveredModelsFromSessionSetup(sessionSetup).map((model) => ({
        slug: model.slug,
        name: model.name,
      })),
    ).toEqual([
      { slug: "opencode-zen/x-preview-f-free", name: "Ox Alpha Free" },
      { slug: "opencode-go/ox-alpha-free", name: "Ox Alpha Free" },
      { slug: "opencode-go/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { slug: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    ]);
  });
});
