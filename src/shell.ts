export const shellEscape = (value: string): string => {
  return `'${value.replace(/'/g, "'\\''")}'`;
};
