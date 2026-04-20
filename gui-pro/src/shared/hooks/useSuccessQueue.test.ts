import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSuccessQueue } from "./useSuccessQueue";

describe("useSuccessQueue", () => {
  it("starts with an empty queue", () => {
    const { result } = renderHook(() => useSuccessQueue());
    expect(result.current.successQueue).toEqual([]);
  });

  it("pushSuccess adds a message to the queue", () => {
    const { result } = renderHook(() => useSuccessQueue());

    act(() => {
      result.current.pushSuccess("Operation completed");
    });

    expect(result.current.successQueue).toEqual([
      { text: "Operation completed", type: "success" },
    ]);
  });

  it("pushSuccess supports error type", () => {
    const { result } = renderHook(() => useSuccessQueue());

    act(() => {
      result.current.pushSuccess("Something failed", "error");
    });

    expect(result.current.successQueue).toEqual([
      { text: "Something failed", type: "error" },
    ]);
  });

  it("shiftSuccess removes the first item from the queue", () => {
    const { result } = renderHook(() => useSuccessQueue());

    act(() => {
      result.current.pushSuccess("First");
      result.current.pushSuccess("Second");
    });

    act(() => {
      result.current.shiftSuccess();
    });

    expect(result.current.successQueue).toEqual([
      { text: "Second", type: "success" },
    ]);
  });

  it("multiple pushes stack correctly", () => {
    const { result } = renderHook(() => useSuccessQueue());

    act(() => {
      result.current.pushSuccess("A");
      result.current.pushSuccess("B");
      result.current.pushSuccess("C");
    });

    expect(result.current.successQueue).toHaveLength(3);
    expect(result.current.successQueue[0].text).toBe("A");
    expect(result.current.successQueue[1].text).toBe("B");
    expect(result.current.successQueue[2].text).toBe("C");
  });
});
