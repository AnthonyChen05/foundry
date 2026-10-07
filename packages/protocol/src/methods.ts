/**
 * Method names from protocol.md §1.3, plus the idempotency rule (§1.1):
 * side-effecting methods REQUIRE an `idem` idempotency key on the request.
 */

export const METHOD_NAMES = [
  "sys.health",
  "sys.models",
  "chat.list",
  "chat.create",
  "chat.history",
  "chat.send",
  "run.get",
  "run.events",
  "run.cancel",
  "run.approve",
  "term.open",
  "term.input",
  "term.resize",
  "term.close",
  "files.list",
  "files.read",
  "files.write",
  "files.mkdir",
  "files.rm",
  "files.stat",
  "admin.keys",
  "admin.providers",
  "admin.schedules",
  "auth.login",
] as const;

export type MethodName = (typeof METHOD_NAMES)[number];

/** Methods that mutate state and therefore require `idem` on the request. */
export const IDEMPOTENT_METHODS: readonly MethodName[] = [
  "chat.send",
  "run.cancel",
  "run.approve",
  "term.open",
  "term.input",
  "term.resize",
  "term.close",
  "files.write",
  "files.mkdir",
  "files.rm",
];

export function requiresIdempotencyKey(method: string): boolean {
  return IDEMPOTENT_METHODS.includes(method as MethodName);
}