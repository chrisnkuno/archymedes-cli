import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./archymedes.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The binary runs unchanged; Bun's test-only preload replaces the network, never a production URL override. */
describe("free mode through the real CLI", () => {
  it("runs a streamed tool round trip, persists free access, resumes and emits JSONL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archymedes-free-e2e-")); dirs.push(root);
    await writeFile(path.join(root, "hello.txt"), "hello free mode");
    const preload = path.join(root, "network.ts");
    await writeFile(preload, `
      import { appendFileSync } from "node:fs";
      globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://openrouter.ai/api/v1/models") {
          if (new Headers(init?.headers).has("authorization")) throw new Error("key leaked into catalog");
          return Response.json({data:[{id:"lab/code:free",name:"Code",context_length:65536,top_provider:{max_completion_tokens:4096},
            architecture:{input_modalities:["text"],output_modalities:["text"]},supported_parameters:["tools"],pricing:{prompt:"0",completion:"0"}}]});
        }
        if (url.includes("raw.githubusercontent.com")) return Response.json({models:[]});
        if (url !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("unexpected endpoint: " + url);
        if (new Headers(init?.headers).get("authorization") !== "Bearer test-free-key") throw new Error("wrong credential");
        const body = JSON.parse(init.body);
        appendFileSync(${JSON.stringify(path.join(root, "requests.jsonl"))}, JSON.stringify(body) + "\\n");
        const didRead = body.messages.some(m => m.role === "tool");
        const delta = didRead ? {content:"FREE_TOOL_OK"} : {tool_calls:[{index:0,id:"read-1",type:"function",function:{name:"read_file",arguments:JSON.stringify({path:"hello.txt"})}}]};
        const chunk = {id:"free-turn",model:"lab/code:free",choices:[{index:0,delta,finish_reason:didRead?"stop":"tool_calls"}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0}};
        return new Response("data: " + JSON.stringify(chunk) + "\\n\\ndata: [DONE]\\n\\n", {headers:{"content-type":"text/event-stream"}});
      };
    `);
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("bun", ["--preload", preload, entry, "--currency", "USD", "--json", ...args], {
        cwd: root, env: { ...process.env, OPENROUTER_API_KEY: "test-free-key", OPENAI_API_KEY: "paid-key-that-must-not-be-used",
          ARCHYMEDES_PROVIDER: "openai", ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), ARCHYMEDES_AUTO_UPDATE: "off", ARCHYMEDES_FX_OFFLINE: "true",
          ARCHYMEDES_FALLBACK_MODEL: "openai:gpt-5.6-terra", EXA_API_KEY: "", ARCHYMEDES_SUGGEST_MODEL: "off" },
      });
      let stdout = ""; let stderr = "";
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("free CLI timed out")); }, 25000);
      child.stdout.on("data", (part) => { stdout += part; }); child.stderr.on("data", (part) => { stderr += part; });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    const first = await run(["--free", "Read hello.txt and report its contents"]);
    expect(first.code, first.stderr + first.stdout).toBe(0);
    const records = first.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) => record.provider === "free")).toBe(true);
    expect(first.stdout).toContain("FREE_TOOL_OK");
    expect(first.stdout).not.toContain("test-free-key");
    const sessions = await readdir(path.join(root, ".archymedes", "sessions"));
    const saved = JSON.parse(await readFile(path.join(root, ".archymedes", "sessions", sessions.find((name) => name.endsWith(".json"))!), "utf8"));
    expect(saved.modelSelection).toEqual({ provider: "free", model: "openrouter/free" });
    const resumed = await run(["--resume", saved.id, "Confirm the previous read"]);
    expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const request of requests) expect(request).toMatchObject({ model: "lab/code:free", provider: { max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false } });
    expect(requests.some((request) => request.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("hello free mode")))).toBe(true);
  }, 60000);
});
