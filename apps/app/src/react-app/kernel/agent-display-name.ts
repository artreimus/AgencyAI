export function agentDisplayName(name: string): string {
  if (name.trim().toLowerCase() === "agencyai") return "Agency Agent";
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
}
