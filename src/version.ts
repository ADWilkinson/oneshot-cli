import { readFileSync } from "fs";
import { join } from "path";
import { PKG_ROOT } from "./paths";

const PACKAGE_JSON_PATH = join(PKG_ROOT, "package.json");

const loadVersion = (): string => {
  try {
    const raw = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

export const VERSION = loadVersion();
