// Journal du daemon : événements et erreurs uniquement, sur stderr (journald en service).
// Jamais de prompt, de réponse, de sortie d'outil ni de clé : les champs sont des
// identifiants, des codes ou des compteurs.

type Field = string | number | boolean;

export function log(event: string, fields: Record<string, Field> = {}): void {
  const parts = [event];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  process.stderr.write(parts.join(" ") + "\n");
}

/** Nom de l'erreur et son code système éventuel, sans le message (qui peut contenir des données). */
export function errorFields(err: unknown): Record<string, Field> {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === undefined ? { error: err.name } : { error: err.name, code };
  }
  return { error: typeof err };
}
