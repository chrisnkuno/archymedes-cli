import { describe, expect, it } from "vitest";
import { parseFreeOpenRouterModels, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { sanitizeChatRequest } from "./policy";

const entry = { id: "lab/code:free", context_length: 65536, top_provider: { max_completion_tokens: 2048 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const models = new Map(parseFreeOpenRouterModels({ data: [entry] }).map((model): [string, FreeModel] => [model.id, model]));
const base = { model: entry.id, messages: [{ role: "user", content: "hi" }] };

describe("gateway reasoning passthrough", () => {
  it("forwards the effort word and nothing else of the reasoning object", () => {
    const result = sanitizeChatRequest({ ...base, reasoning: { effort: "low", max_tokens: 99_999, exclude: true } }, models);
    expect(result).toMatchObject({ body: { reasoning: { effort: "low" } } });
    expect((result as { body: { reasoning: unknown } }).body.reasoning).toEqual({ effort: "low" });
  });

  it("drops an effort outside the fixed list, including none", () => {
    for (const effort of ["none", "ultra", 3]) {
      expect((sanitizeChatRequest({ ...base, reasoning: { effort } }, models) as { body: object }).body).not.toHaveProperty("reasoning");
    }
  });
});
