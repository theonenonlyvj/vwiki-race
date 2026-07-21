import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WinningPathChain from "./WinningPathChain";

/**
 * Owner feedback (2026-07-20, Challenge Detail screenshot): the old
 * per-surface rendering listed each hop as a "source → destination" pair, so
 * every interim article appeared twice ("Pizza → Latin", "Latin → Roman
 * Empire"). This component takes the already-collapsed chain (see
 * `pathStepsToChain`) and renders one line per article instead.
 */
describe("WinningPathChain", () => {
  it("renders the start article plain, with no arrow prefix", () => {
    render(<WinningPathChain titles={["Pizza", "Latin", "Roman Empire"]} />);

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Pizza");
    expect(items[0]).not.toHaveTextContent("→");
  });

  it("prefixes every step after the start with the arrow, ending on the target", () => {
    render(<WinningPathChain titles={["Pizza", "Latin", "Roman Empire"]} />);

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent("→ Latin");
    expect(items[2]).toHaveTextContent("→ Roman Empire");
  });

  it("renders an interim article exactly once, not once per adjacent hop", () => {
    // Old pair rendering ("Pizza → Latin", "Latin → Roman Empire") printed
    // "Latin" twice, once per hop it touched. The chain lists it once.
    render(<WinningPathChain titles={["Pizza", "Latin", "Roman Empire"]} />);

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    const latinRows = items.filter((item) => item.textContent?.includes("Latin"));
    expect(latinRows).toHaveLength(1);
  });
});
