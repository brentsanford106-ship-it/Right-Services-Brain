import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Parses untrusted input. Reports field paths and issue codes, never the submitted values. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw new HttpError(
    "validation_failed",
    undefined,
    result.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join(".") || "(root)",
      issue: i.code === "unrecognized_keys" ? `unrecognized field(s): ${(i as { keys: string[] }).keys.join(", ")}` : i.message,
    })),
  );
}
