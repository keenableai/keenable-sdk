/**
 * The error-contract fixture is generated from the backend's error catalog, and
 * every SDK tests the same copy of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CATALOG_PATH,
  FIXTURE_PATHS,
  contractFromDisk,
  type CatalogEntry,
} from "../../scripts/error-contract/sync.js";

describe("error contract fixture", () => {
  const want = contractFromDisk();

  it.each(FIXTURE_PATHS)("%s matches the catalog (run npm run errors:sync)", (path) => {
    expect(readFileSync(path, "utf8")).toBe(want);
  });

  it("has one case per catalog code, with the catalog's type and docs_url", () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogEntry[];
    const cases = JSON.parse(want).cases as {
      name: string;
      body: Record<string, unknown>;
    }[];

    for (const entry of catalog) {
      const c = cases.find((x) => x.name === entry.code);
      expect(c?.body, entry.code).toMatchObject({
        type: entry.type,
        code: entry.code,
        docs_url: entry.docs_url,
      });
    }
  });
});
