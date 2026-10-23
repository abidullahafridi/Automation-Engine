import { randomBytes } from "node:crypto";

export type TraceContext = Readonly<{
  traceId: string;
  spanId: string;
  sampled: boolean;
}>;

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const isAllZero = (value: string): boolean => /^0+$/.test(value);

/** Returns undefined for anything that is not a valid W3C traceparent (version 00). */
export const parseTraceparent = (value: string | undefined): TraceContext | undefined => {
  if (value === undefined) return undefined;
  const match = traceparentPattern.exec(value);
  if (match === null) return undefined;
  const traceId = match[1];
  const spanId = match[2];
  const flags = match[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  if (isAllZero(traceId) || isAllZero(spanId)) return undefined;
  return Object.freeze({
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1
  });
};

export const formatTraceparent = (context: TraceContext): string =>
  `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;

export type TraceFactory = Readonly<{
  /** Starts a new trace (for example at event emission). */
  root: () => TraceContext;
  /** Same trace, new span. An invalid or missing parent starts a new trace. */
  child: (parentTraceparent: string | undefined) => TraceContext;
}>;

const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

export const createTraceFactory = (
  randomHex: (bytes: number) => string = defaultRandomHex
): TraceFactory => {
  const id = (bytes: number): string => {
    const value = randomHex(bytes);
    if (value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) {
      throw new Error("Trace id source must return lowercase hex of the requested length.");
    }
    return isAllZero(value) ? `${value.slice(0, -1)}1` : value;
  };

  const root = (): TraceContext =>
    Object.freeze({ traceId: id(16), spanId: id(8), sampled: true });

  return Object.freeze({
    root,
    child: (parentTraceparent: string | undefined): TraceContext => {
      const parent = parseTraceparent(parentTraceparent);
      if (parent === undefined) return root();
      return Object.freeze({ traceId: parent.traceId, spanId: id(8), sampled: parent.sampled });
    }
  });
};