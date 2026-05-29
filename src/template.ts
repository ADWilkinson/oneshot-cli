/**
 * Fill `{{key}}` placeholders in a prompt template.
 *
 * Uses a function replacement so `$`-sequences in the value (e.g. `$$`, `$&`,
 * `$'`, `` $` ``) are inserted literally instead of being interpreted as
 * regex-style replacement patterns. Task descriptions, CLAUDE.md content, and
 * plan output routinely contain these (shell `$$`, bash `$'...'`, prices), and
 * a naive `String.replace(string, value)` would silently corrupt the prompt.
 * Every occurrence of each placeholder is replaced, not just the first.
 */
export const fillTemplate = (template: string, vars: Record<string, string>): string => {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, () => value);
  }
  return result;
};
