import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = join(__dirname, "..");
export const PROMPTS_DIR = join(PKG_ROOT, "prompts");
