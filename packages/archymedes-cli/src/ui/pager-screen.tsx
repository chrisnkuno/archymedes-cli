/** @jsxImportSource @termuijs/jsx */
import { useInput, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import { applyPagerAction, composePagerFrame, initialPagerState, keyToPagerAction, type PagerState } from "./text-pager";

/**
 * The built-in pager, as a screen. `text-pager.ts` decides everything; this paints its rows and
 * reports when the reader leaves — the same split as the editor and the guide.
 */

type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

/** Title above, key bar below. */
const CHROME_ROWS = 2;

export type PagerScreenProps = { columns: number; rows: number; text: string; title?: string; onExit: () => void };

export function PagerScreen({ columns, rows, text, title, onExit }: PagerScreenProps) {
  const [state, setState] = useState<PagerState>(() => initialPagerState(text, rows - CHROME_ROWS));
  useInput((input: string, key: TermUIKey) => {
    const action = keyToPagerAction({ name: key?.key, ctrl: key?.ctrl }, input, state);
    const step = applyPagerAction(state, action);
    if (step.exit) { onExit(); return; }
    setState(step.state);
  });
  const frame = composePagerFrame(state, columns, title);
  return (
    <Panel flexDirection="column" width={columns} height={rows}>
      {frame.map((row, index) => (
        <Line key={`row-${index}`} bold={row.bold} dimColor={row.dim}>
          {row.text}
        </Line>
      ))}
    </Panel>
  );
}

/** Opens the pager and resolves when the reader leaves. TermUI is loaded only when it is used. */
export async function runPagerScreen(options: { columns: number; rows: number; text: string; title?: string }): Promise<void> {
  const { renderApp } = await import("@termuijs/jsx");
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    void renderApp(PagerScreen as never, { ...options, onExit: finish, fullscreen: true } as never).catch(finish);
  });
}
