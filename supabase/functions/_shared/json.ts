/**
 * Strict JSON reader. Same grammar as JSON.parse, but duplicate object keys are an error and
 * every member is defined as an own data property (so "__proto__" cannot change a prototype).
 */
export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

export const MAX_JSON_DEPTH = 64;

export function parseJsonStrict(text: string): JsonResult {
  const reader = new Reader(text);
  try {
    reader.skipSpace();
    const value = reader.value(0);
    reader.skipSpace();
    if (!reader.done()) return { ok: false, error: `unexpected text after JSON at offset ${reader.offset}` };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

/** One whole JSON object, optionally wrapped in one surrounding ``` or ```json fence. Nothing else. */
export function parseWholeJsonOutput(text: string): JsonResult {
  let body = text.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fence) body = (fence[1] ?? "").trim();
  else if (body.startsWith("```")) return { ok: false, error: "code fence is not closed or has extra text" };
  if (!body.startsWith("{")) return { ok: false, error: "output must be one JSON object with no other text" };
  return parseJsonStrict(body);
}

class Reader {
  offset = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  done(): boolean {
    return this.offset >= this.text.length;
  }

  skipSpace(): void {
    while (this.offset < this.text.length) {
      const char = this.text[this.offset];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") this.offset += 1;
      else break;
    }
  }

  value(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON nests too deeply");
    const char = this.text[this.offset];
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === "\"") return this.string();
    if (char === "t") return this.literal("true", true);
    if (char === "f") return this.literal("false", false);
    if (char === "n") return this.literal("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.number();
    throw new Error(`unexpected character at offset ${this.offset}`);
  }

  private object(depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.offset += 1;
    this.skipSpace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.offset] !== "\"") throw new Error(`expected a key at offset ${this.offset}`);
      const key = this.string();
      if (seen.has(key)) throw new Error(`duplicate key "${key.slice(0, 64)}"`);
      seen.add(key);
      this.skipSpace();
      if (this.text[this.offset] !== ":") throw new Error(`expected ":" at offset ${this.offset}`);
      this.offset += 1;
      this.skipSpace();
      const member = this.value(depth + 1);
      Object.defineProperty(result, key, { value: member, enumerable: true, writable: true, configurable: true });
      this.skipSpace();
      const next = this.text[this.offset];
      this.offset += 1;
      if (next === "}") return result;
      if (next !== ",") throw new Error(`expected "," or "}" at offset ${this.offset - 1}`);
    }
  }

  private array(depth: number): unknown[] {
    const result: unknown[] = [];
    this.offset += 1;
    this.skipSpace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      this.skipSpace();
      result.push(this.value(depth + 1));
      this.skipSpace();
      const next = this.text[this.offset];
      this.offset += 1;
      if (next === "]") return result;
      if (next !== ",") throw new Error(`expected "," or "]" at offset ${this.offset - 1}`);
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    for (;;) {
      const char = this.text[this.offset];
      if (char === undefined) throw new Error(`unterminated string at offset ${start}`);
      if (char === "\"") {
        this.offset += 1;
        break;
      }
      if (char === "\\") {
        this.offset += 2;
        continue;
      }
      if (char < " ") throw new Error(`control character in string at offset ${this.offset}`);
      this.offset += 1;
    }
    return JSON.parse(this.text.slice(start, this.offset)) as string;
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset, this.offset + 400));
    if (!match) throw new Error(`invalid number at offset ${this.offset}`);
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("number is out of range");
    return value;
  }

  private literal(word: string, value: boolean | null): boolean | null {
    if (this.text.slice(this.offset, this.offset + word.length) !== word) {
      throw new Error(`unexpected token at offset ${this.offset}`);
    }
    this.offset += word.length;
    return value;
  }
}
