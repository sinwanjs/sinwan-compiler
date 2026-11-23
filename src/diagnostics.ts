/**
 * SinwanJS Compiler — Diagnostics
 *
 * Compile-time warnings for JSX that compiles but misbehaves at runtime.
 * Every diagnostic has a stable code (`SW1xx`), a location and a hint. A
 * `sinwan-ignore` comment on the reported line or the line above silences it:
 * `/* sinwan-ignore SW101 *\/` for one code, `/* sinwan-ignore *\/` for all.
 */

export type DiagnosticCode =
  | "SW101"
  | "SW102"
  | "SW103"
  | "SW104"
  | "SW105"
  | "SW106"
  | "SW110"
  | "SW111"
  | "SW112"
  | "SW113";

export interface SinwanDiagnostic {
  code: DiagnosticCode;
  message: string;
  hint: string;
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export type DiagnosticHandler = (diagnostic: SinwanDiagnostic) => void;

/** Reports a diagnostic at a source offset (oxc nodes carry `start`, not `loc`). */
export type Reporter = (
  code: DiagnosticCode,
  offset: number | null | undefined,
  message: string,
  hint: string,
) => void;

/** `[Sinwan] file:line:column SW101: message`, then the hint on its own line. */
export function formatDiagnostic(diagnostic: SinwanDiagnostic): string {
  return (
    `[Sinwan] ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ` +
    `${diagnostic.code}: ${diagnostic.message}\n  ${diagnostic.hint}`
  );
}

/** The default handler: print to the console, as the compiler always did. */
export function warnDiagnostic(diagnostic: SinwanDiagnostic): void {
  console.warn(formatDiagnostic(diagnostic));
}

const IGNORE_PATTERN = /sinwan-ignore\b([^*\n]*)/;

function lineIgnores(text: string | undefined, code: DiagnosticCode): boolean {
  if (text === undefined) return false;
  const match = IGNORE_PATTERN.exec(text);
  if (!match) return false;
  const codes = match[1]!.match(/SW\d{3}/g);
  return codes === null || codes.includes(code);
}

/**
 * Build a reporter for one file. Offsets become 1-based line/column; offsets
 * the parser did not provide report at line 1, column 1.
 */
export function createReporter(
  source: string,
  file: string,
  handler: DiagnosticHandler,
): Reporter {
  const lines = source.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const locate = (position: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= position) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: position - lineStarts[low]! + 1 };
  };

  return (code, position, message, hint) => {
    const { line, column } = locate(position ?? 0);
    if (lineIgnores(lines[line - 1], code) || lineIgnores(lines[line - 2], code)) {
      return;
    }
    handler({ code, message, hint, file, line, column });
  };
}
