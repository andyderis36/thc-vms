-- Dev-only rollback for migration 000020. Never runs in production
-- (production rolls forward only); drops the whole registration-notice store.
DROP TABLE IF EXISTS vendor_registration_notices;
