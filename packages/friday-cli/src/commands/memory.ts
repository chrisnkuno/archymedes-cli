/**
 * The terminal half of memory: parsing `/memory` commands and drawing the result.
 *
 * The storage, recall and prompt-block half moved to agent-core, because the desktop app and any
 * background job need exactly the same facts and had no way to reach them here. What stays is what
 * is genuinely terminal — command syntax and ANSI rendering — and everything else is re-exported so
 * existing callers keep importing memory from one place.
 */

export * from "@archymedes/core/cli/memory";
