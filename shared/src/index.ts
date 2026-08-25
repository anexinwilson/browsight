/**
 * Everything both sides of browsight agree on: the message protocol they speak, and the connection
 * handshake `setup` writes for them. Kept free of Node imports so the extension can bundle it; the
 * on-disk paths live in `@browsight/shared/paths` instead.
 */
export * from "./connection.ts";
export * from "./protocol.ts";
