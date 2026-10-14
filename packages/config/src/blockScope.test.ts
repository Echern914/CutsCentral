import { describe, expect, it } from "vitest";
import {
  blockAppliesToService,
  blocksAllServices,
  describeBlockScope,
  normalizeBlockServiceIds,
} from "./blockScope.js";

describe("blockAppliesToService", () => {
  it("an all-services block (every existing row) stops every service", () => {
    expect(blockAppliesToService([], "haircut")).toBe(true);
    expect(blockAppliesToService(null, "haircut")).toBe(true);
    expect(blockAppliesToService(undefined, "haircut")).toBe(true);
  });

  it("a scoped block stops only the services it names", () => {
    const scope = ["shapeup", "kids"];
    expect(blockAppliesToService(scope, "shapeup")).toBe(true);
    expect(blockAppliesToService(scope, "kids")).toBe(true);
    expect(blockAppliesToService(scope, "haircut")).toBe(false);
  });

  it("🔴 a question that cannot name its service treats every block as in the way", () => {
    expect(blockAppliesToService(["shapeup"], null)).toBe(true);
    expect(blockAppliesToService(["shapeup"], undefined)).toBe(true);
    expect(blockAppliesToService(["shapeup"], "")).toBe(true);
  });
});

describe("normalizeBlockServiceIds", () => {
  it("trims, de-duplicates and sorts; nothing = all services", () => {
    expect(normalizeBlockServiceIds([" b ", "a", "b", "", 7, null])).toEqual(["a", "b"]);
    expect(normalizeBlockServiceIds(null)).toEqual([]);
    expect(normalizeBlockServiceIds(undefined)).toEqual([]);
  });

  it("blocksAllServices reads an empty list as the whole chair", () => {
    expect(blocksAllServices([])).toBe(true);
    expect(blocksAllServices(["a"])).toBe(false);
  });
});

describe("describeBlockScope", () => {
  const names: Record<string, string> = { s: "Shape-up", k: "Kids' cut", b: "Beard trim" };
  const nameOf = (id: string) => names[id];

  it("names the services, the way the barber picked them", () => {
    expect(describeBlockScope([], nameOf)).toBe("All services");
    expect(describeBlockScope(["s"], nameOf)).toBe("Shape-up only");
    expect(describeBlockScope(["s", "k"], nameOf)).toBe("Shape-up and Kids' cut only");
    expect(describeBlockScope(["s", "k", "b"], nameOf)).toBe("Shape-up, Kids' cut and Beard trim only");
  });

  it("never claims All services for a block whose services were all deleted", () => {
    expect(describeBlockScope(["gone"], nameOf)).toBe("Removed services only");
    expect(describeBlockScope(["gone", "s"], nameOf)).toBe("Shape-up only");
  });
});
