import { homedir } from "os";
import { join, resolve } from "path";

export const expandHome = (path: string, home = process.env.HOME ?? homedir()): string => {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
};

export const isWithinRoot = (path: string, root: string): boolean => {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
};
