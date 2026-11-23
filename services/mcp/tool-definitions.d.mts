export declare function date(value: unknown): boolean;
export declare function period(startDate: unknown, endDate: unknown): void;
export declare function exact(value: unknown, allowedKeys: readonly string[]): void;
export declare function monthRange(month: unknown): { startDate: string; endDate: string };
export declare function parse(name: string, args: unknown): unknown;
export declare const MAX_OUTPUT: number;
export declare const MAX_CALLS: number;
