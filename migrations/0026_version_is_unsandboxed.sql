-- An extension may declare extension.isUnsandboxed in twext.yml to tell
-- TurboWarp that it expects no sandbox and wants the real device APIs. The
-- registry records the declaration verbatim so a client can tell an extension
-- that asked for it from one that merely left it out.
--
-- Absent is not the same as false: NULL means the project never declared the
-- field, while false is an explicit "keep it sandboxed". Rows written before
-- this migration did not carry the field at all, so they stay NULL.
ALTER TABLE versions
  ADD COLUMN is_unsandboxed BOOLEAN;