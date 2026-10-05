// Résumé d'un appel d'outil pour la conversation : nom et argument principal.
// (Les demandes d'autorisation, elles, montrent toujours l'entrée complète.)

const MAIN_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description"];
const MAX_LENGTH = 160;

export function toolSummary(name: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    for (const key of MAIN_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") {
        const firstLine = value.trim().split("\n", 1)[0] ?? "";
        const short = firstLine.length > MAX_LENGTH ? firstLine.slice(0, MAX_LENGTH) + "…" : firstLine;
        const more = value.trim().includes("\n") && !short.endsWith("…") ? " …" : "";
        return `${name} : ${short}${more}`;
      }
    }
  }
  return name;
}
