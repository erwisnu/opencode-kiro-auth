declare module "bun:sqlite" {
  export class Database {
    constructor(
      filename: string,
      options?: { create?: boolean; readonly?: boolean },
    );
    exec(sql: string): void;
    query(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe(expected: unknown): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: string): void;
    toHaveLength(expected: number): void;
    not: {
      toContain(expected: string): void;
    };
  };
}

declare const Bun: {
  sleep(ms: number): Promise<void>;
};
