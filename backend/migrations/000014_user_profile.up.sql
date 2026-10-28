-- =============================================================================
-- THC Visitor Management System (VMS) - ISP Edition
-- Migration 000014 : Add users.avatar_url (self-service profile photo)
--
-- SSOT            : docs/1. Entity Relationship Diagram (ERD).mermaid (USER)
-- Business rules  : A signed-in account may set its own profile photo. The
--                   column is NULLable and an empty string is normalised to SQL
--                   NULL by the write path (mirroring users.phone / users.nik),
--                   so "no avatar" has exactly one representation.
-- Target engine   : PostgreSQL 18.6
--
-- The stored value is the ABSOLUTE object URL returned by the storage adapter,
-- never a presigned URL: a presigned link expires, so the read path must mint a
-- fresh one from the object key every time. Replacing or removing an avatar
-- deliberately leaves the previous object in the bucket: IStorageService has no
-- delete port (a KISS decision), so an orphaned object is an accepted tradeoff
-- rather than a cleanup feature this migration introduces.
-- =============================================================================

ALTER TABLE users ADD COLUMN avatar_url text NULL;
