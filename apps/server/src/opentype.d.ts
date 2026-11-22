// The part of opentype.js the server uses to read its fonts (the package has no types).
declare module 'opentype.js' {
  export interface PathCommandData {
    readonly type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    readonly x?: number;
    readonly y?: number;
    readonly x1?: number;
    readonly y1?: number;
    readonly x2?: number;
    readonly y2?: number;
  }
  export interface Glyph {
    readonly index: number;
    readonly advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): { readonly commands: PathCommandData[] };
  }
  export interface Font {
    readonly unitsPerEm: number;
    readonly ascender: number;
    readonly descender: number;
    charToGlyph(char: string): Glyph;
    charToGlyphIndex(char: string): number;
    getKerningValue(left: number, right: number): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
