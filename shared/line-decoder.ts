// Découpage d'un flux d'octets en lignes NDJSON, avec une taille maximale par ligne.
// Uniquement des API standard (Uint8Array, TextDecoder) : utilisé par Node et par GJS.

export class LineTooLongError extends Error {
  override name = "LineTooLongError";
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class LineDecoder {
  private readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private pending = 0;
  // fatal : un octet UTF-8 invalide lève une erreur au lieu d'être remplacé.
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /**
   * Ajoute un fragment et renvoie les lignes complètes qu'il termine.
   * Lève LineTooLongError dès qu'une ligne dépasse la limite, sans attendre sa fin,
   * et TypeError si une ligne n'est pas de l'UTF-8 valide.
   */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(0x0a, start);
    while (nl !== -1) {
      const part = chunk.subarray(start, nl);
      const length = this.pending + part.length;
      if (length > this.maxBytes) {
        throw new LineTooLongError();
      }
      this.chunks.push(part);
      lines.push(this.utf8.decode(concat(this.chunks, length)));
      this.chunks = [];
      this.pending = 0;
      start = nl + 1;
      nl = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    if (this.pending + rest.length > this.maxBytes) {
      throw new LineTooLongError();
    }
    if (rest.length > 0) {
      // Copie : l'appelant peut réutiliser son tampon.
      this.chunks.push(rest.slice());
      this.pending += rest.length;
    }
    return lines;
  }
}
