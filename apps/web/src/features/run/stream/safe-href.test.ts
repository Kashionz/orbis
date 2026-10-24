import { describe, expect, it } from "vitest";
import { safeHref } from "./safe-href";

describe("safeHref", () => {
  it("接受 http 與 https", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("http://localhost:4123/")).toBe("http://localhost:4123/");
  });

  it("拒絕其他 scheme 與無法解析的值", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});
