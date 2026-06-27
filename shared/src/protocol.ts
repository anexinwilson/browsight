/**
 * The one typed contract shared by the extension and the server.
 *
 * Every cross-process frame is a member of the `BridgeMessage` discriminated union, keyed by
 * `type`. Schemas are defined once here as zod schemas; the TypeScript types are inferred from
 * them (`z.infer`) so runtime validation and static types can never drift.
 */
import { z } from "zod";

/** A durable, multi-attribute fingerprint used to re-resolve a reference on a changed page. */
export const RecipeSchema = z.object({
  role: z.string(),
  name: z.string(),
  dataAttrs: z.record(z.string(), z.string()).default({}),
  text: z.string().default(""),
  ordinal: z.number().int().default(0),
  ancestorPath: z.string().optional(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

/** One interactive element in a snapshot: an ephemeral id plus its durable recipe. */
export const RefSchema = z.object({
  id: z.number().int(),
  role: z.string(),
  name: z.string(),
  recipe: RecipeSchema,
});
export type Ref = z.infer<typeof RefSchema>;

/** Typed dead-ends returned to the agent instead of a silent empty or a thrown error. */
export const SentinelKindSchema = z.enum([
  "not_signed_in",
  "ambiguous_target",
  "ref_stale",
  "not_actionable",
  "frame_unreachable",
  "not_whitelisted",
]);
export type SentinelKind = z.infer<typeof SentinelKindSchema>;

export const SentinelSchema = z.object({
  kind: SentinelKindSchema,
  hint: z.string(),
});
export type Sentinel = z.infer<typeof SentinelSchema>;

export const ActionSchema = z.enum(["click", "fill", "navigate", "scroll"]);
export type Action = z.infer<typeof ActionSchema>;

export const VerdictSchema = z.enum(["navigated", "dom_changed", "value_set", "no_change"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Auth handshake — the extension's first frame after connecting to the bridge. */
export const AuthSchema = z.object({
  type: z.literal("auth"),
  token: z.string(),
  extensionVersion: z.string(),
});
export type Auth = z.infer<typeof AuthSchema>;

export const ReadRequestSchema = z.object({
  type: z.literal("read.request"),
  id: z.string(),
  url: z.string().nullable().default(null),
  schema: z.unknown().nullable().default(null),
});
export type ReadRequest = z.infer<typeof ReadRequestSchema>;

export const ReadResponseSchema = z.object({
  type: z.literal("read.response"),
  id: z.string(),
  markdown: z.string(),
  refs: z.array(RefSchema),
  tokenEstimate: z.number().int(),
  sentinel: SentinelSchema.optional(),
});
export type ReadResponse = z.infer<typeof ReadResponseSchema>;

export const ActRequestSchema = z.object({
  type: z.literal("act.request"),
  id: z.string(),
  ref: z.string(),
  action: ActionSchema,
  value: z.string().optional(),
});
export type ActRequest = z.infer<typeof ActRequestSchema>;

export const DiffSchema = z.object({
  appeared: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type Diff = z.infer<typeof DiffSchema>;

export const ActResponseSchema = z.object({
  type: z.literal("act.response"),
  id: z.string(),
  verdict: VerdictSchema,
  diff: DiffSchema,
  refs: z.array(RefSchema),
  sentinel: SentinelSchema.optional(),
});
export type ActResponse = z.infer<typeof ActResponseSchema>;

/** Any frame on the bridge, discriminated by `type`. */
export const BridgeMessageSchema = z.discriminatedUnion("type", [
  AuthSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ActRequestSchema,
  ActResponseSchema,
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;
