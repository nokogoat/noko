// Découpage d'un flux d'octets en lignes NDJSON, avec une taille maximale par ligne.

export class LineTooLongError extends Error {
  override name = "LineTooLongError";
}

export class LineDecoder {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
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
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(0x0a, start);
    while (nl !== -1) {
      const part = chunk.subarray(start, nl);
      if (this.pending + part.length > this.maxBytes) {
        throw new LineTooLongError();
      }
      this.chunks.push(part);
      lines.push(this.utf8.decode(Buffer.concat(this.chunks)));
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
      this.chunks.push(rest);
      this.pending += rest.length;
    }
    return lines;
  }
}
