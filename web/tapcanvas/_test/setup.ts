import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { installMantineDomMocks } from "../src/portal/testMantineDomMocks";

if (typeof window !== "undefined") {
  installMantineDomMocks();
}

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") installMantineDomMocks();
});
