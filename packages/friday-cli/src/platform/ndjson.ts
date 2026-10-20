/**
 * Splits a stdio chunk into complete messages, keeping whatever is left over.
 *
 * Pure and separate from the stream because this is where a naive implementation breaks in
 * production and nowhere else: a large `session/prompt` arrives in several chunks, and a reader
 * that assumes one chunk is one message loses the tail of every big paste. Blank lines are skipped
 * rather than treated as empty messages, which is what a client that pretty-prints its framing
 * produces.
 */
export function splitFrames(buffer: string): { messages: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { messages: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}
